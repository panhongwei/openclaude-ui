/**
 * Electron chat bridge — wraps QueryEngine for the Electron GUI.
 *
 * The Electron main process dynamically imports dist/electron.mjs (compiled
 * from this file) and calls sendMessage() for each user turn. Sessions are
 * keyed by sessionKey and persist across turns so multi-turn context works.
 */

import { QueryEngine } from '../QueryEngine.js'
import { getTools } from '../tools.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { FileStateCache, READ_FILE_STATE_CACHE_SIZE } from '../utils/fileStateCache.js'
import { enableConfigs } from '../utils/config.js'
import { createUserMessage, createAssistantMessage } from '../utils/messages.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { setOriginalCwd, setProjectRoot, setCwdState } from '../bootstrap/state.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import { processSessionStartHooks } from '../utils/sessionStart.js'
import { killAllRunningAgentTasks } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppState.js'

// Must be called before any config reads (QueryEngine, getTools, etc.)
enableConfigs()

// Bypass OAuth/keychain auth — Electron uses user-configured API keys directly.
process.env.CLAUDE_CODE_BYPASS_AUTH = '1'

// ── Provider configuration passed from Electron main process ────────────────

export type ProviderConfig = {
  providerId: string
  apiKey: string
  baseUrl: string
  model: string
} | null

export type HistoryMessage = { role: 'user' | 'assistant'; content: string }

const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI', 'CLAUDE_CODE_USE_GEMINI', 'CLAUDE_CODE_USE_MISTRAL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'GEMINI_MODEL',
  'MISTRAL_API_KEY', 'MISTRAL_BASE_URL', 'MISTRAL_MODEL',
] as const

function applyProviderEnv(config: ProviderConfig) {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
  if (!config) return

  const { providerId, apiKey, baseUrl, model } = config

  if (providerId === 'anthropic') {
    if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey
    if (baseUrl && baseUrl !== 'https://api.anthropic.com') process.env.ANTHROPIC_BASE_URL = baseUrl
  } else if (providerId === 'gemini') {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    if (apiKey) process.env.GEMINI_API_KEY = apiKey
    if (baseUrl) process.env.GEMINI_BASE_URL = baseUrl
    if (model) process.env.GEMINI_MODEL = model
  } else if (providerId === 'mistral') {
    process.env.CLAUDE_CODE_USE_MISTRAL = '1'
    if (apiKey) process.env.MISTRAL_API_KEY = apiKey
    if (baseUrl) process.env.MISTRAL_BASE_URL = baseUrl
    if (model) process.env.MISTRAL_MODEL = model
  } else {
    // openai, deepseek, groq, ollama, openrouter, custom — all OpenAI-compatible
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    if (apiKey) process.env.OPENAI_API_KEY = apiKey
    if (baseUrl) process.env.OPENAI_BASE_URL = baseUrl
    if (model) process.env.OPENAI_MODEL = model
  }
}

// Tools that are safe to auto-approve without user confirmation
const AUTO_APPROVED_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS',
  'NotebookRead', 'NotebookEdit',
  'TodoRead', 'TodoWrite',
])

// ── Session — one QueryEngine per conversation ───────────────────────────────

class Session {
  private engine: QueryEngine
  private appState: AppState
  private _eventQueue: Array<ElectronEvent | null> = []
  private _notify: (() => void) | null = null
  private _pendingApprovals = new Map<string, (allowed: boolean) => void>()
  private _abortController = new AbortController()

  constructor(
    cwd: string,
    model?: string,
    history: HistoryMessage[] = [],
    agents: any[] = [],
    mcpClients: MCPServerConnection[] = [],
    mcpTools: any[] = [],
    hookMessages: any[] = [],
  ) {
    this.appState = getDefaultAppState()
    // Set bootstrap state so CLAUDE.md, git context, memory files, and
    // getProjectRoot() all resolve relative to the user's project folder.
    setOriginalCwd(cwd)
    setProjectRoot(cwd)
    setCwdState(cwd)
    const historyMessages = history.flatMap(msg =>
      msg.role === 'user'
        ? [createUserMessage({ content: msg.content })]
        : [createAssistantMessage({ content: msg.content })]
    )
    const initialMessages = [...hookMessages, ...historyMessages]
    const shellUnavailable = process.env.OPENCLAUDE_SHELL_UNAVAILABLE === '1'
    const isNonClaude = process.env.CLAUDE_CODE_USE_OPENAI === '1' ||
                        process.env.CLAUDE_CODE_USE_GEMINI === '1' ||
                        process.env.CLAUDE_CODE_USE_MISTRAL === '1'
    const baseTools = getTools(this.appState.toolPermissionContext)
    const allTools = mcpTools.length > 0 ? [...baseTools, ...mcpTools] : baseTools
    // Non-Claude models (OpenAI, Gemini, Mistral) get two tools removed:
    //   - Skill: renderer already does template expansion; calling Skill recursively
    //            creates a forked sub-agent that also fails (same model, same problem).
    //   - Agent: sub-agents inherit the same non-Claude model and consistently fail
    //            to complete multi-phase tasks; filtering forces inline execution which
    //            works better with our "complete all phases" system prompt.
    const tools = isNonClaude
      ? allTools.filter((t: any) => t.name !== 'Skill' && t.name !== 'Agent')
      : allTools
    const appendSystemPrompt = shellUnavailable
      ? '\n\nIMPORTANT: The bash/shell environment is NOT available on this system. Do NOT use the Bash tool or any shell commands. Use file tools instead: Read (read any file), Write (create OR overwrite any file — works for both new and existing files), Edit (modify part of an existing file), Glob (find files by pattern), Grep (search in files). The Write tool can CREATE NEW FILES — it is not limited to existing files.'
      : isNonClaude
      ? '\n\nYou are an AI coding assistant. IMPORTANT: You MUST use tools to accomplish tasks — do NOT describe or simulate tool actions in text. Actually call the tools. For file operations use Read/Write/Edit/Glob/Grep. For shell commands use Bash. Always call tools rather than writing text descriptions of what you would do.\n\nWhen the message contains multi-phase instructions (Phase 0, Phase 1, Phase 2, etc.), you MUST execute EVERY phase completely in the same response by calling the appropriate tools. Do not stop between phases, do not ask for confirmation, do not skip phases. Complete all phases before finishing your response.\n\nIf instructions tell you to delegate work to a sub-agent or to read an instruction file and execute it: do NOT use the Agent tool. Instead use Read to read the referenced file, then execute its instructions directly yourself — you are the sub-agent.\n\nWhen using Bash on Windows, always use forward slashes in paths (C:/Users/... not C:\\\\Users\\\\...).'
      : process.platform === 'win32'
      ? '\n\nIMPORTANT: You are running on Windows. When using Bash (Git bash), always use forward slashes in all paths (C:/Users/... not C:\\\\Users\\\\...). The Write tool can create parent directories automatically — prefer it over mkdir for new directories.'
      : undefined
    this.engine = new QueryEngine({
      cwd,
      tools,
      abortController: this._abortController,
      commands: [],
      mcpClients,
      agents,
      readFileCache: new FileStateCache(READ_FILE_STATE_CACHE_SIZE, 25 * 1024 * 1024),
      includePartialMessages: true,
      initialMessages,
      appendSystemPrompt,
      canUseTool: async (tool, input, ctx, _msg, toolUseID) => {
        const name = (tool as any).name ?? (tool as any).type ?? 'tool'
        if (AUTO_APPROVED_TOOLS.has(name)) {
          return { behavior: 'allow' as const }
        }
        // agentId / agentType are only set when a sub-agent is calling the tool
        const agentId   = (ctx as any)?.agentId   ?? null
        const agentType = (ctx as any)?.agentType  ?? null
        this._pushEvent({ type: 'tool_permission', toolUseId: toolUseID, name, input: JSON.stringify(input, null, 2), agentId, agentType })
        const allowed = await new Promise<boolean>(resolve => {
          this._pendingApprovals.set(toolUseID, resolve)
        })
        return allowed
          ? { behavior: 'allow' as const }
          : { behavior: 'deny' as const, message: '用户拒绝了此操作' }
      },
      getAppState: () => this.appState,
      setAppState: (f) => { this.appState = f(this.appState) },
      userSpecifiedModel: model,
    })
  }

  private _pushEvent(evt: ElectronEvent | null) {
    this._eventQueue.push(evt)
    const n = this._notify; this._notify = null; n?.()
  }

  private _waitForEvent(): Promise<void> {
    if (this._eventQueue.length > 0) return Promise.resolve()
    return new Promise(resolve => { this._notify = resolve })
  }

  approveToolUse(toolUseId: string, allowed: boolean) {
    const cb = this._pendingApprovals.get(toolUseId)
    if (cb) { this._pendingApprovals.delete(toolUseId); cb(allowed) }
  }

  abort() {
    killAllRunningAgentTasks(this.appState.tasks, (f) => { this.appState = f(this.appState) })
    this._abortController.abort()
    // Reject all pending tool approvals so canUseTool promises resolve
    for (const [id, cb] of this._pendingApprovals) {
      this._pendingApprovals.delete(id)
      cb(false)
    }
  }

  updateModel(model: string) { this.engine.setModel(model) }

  async *send(message: string): AsyncGenerator<ElectronEvent> {
    void this._runEngine(message)
    while (true) {
      while (this._eventQueue.length > 0) {
        const evt = this._eventQueue.shift()!
        if (evt === null) return
        yield evt
      }
      await this._waitForEvent()
    }
  }

  private async _runEngine(message: string) {
    try {
      let didStream = false
      let inThinkingBlock = false
      for await (const msg of this.engine.submitMessage(message)) {
        if (msg.type === 'stream_event') {
          const e = (msg as any).event
          if (e?.type === 'content_block_start') {
            if (e.content_block?.type === 'thinking') {
              inThinkingBlock = true
              this._pushEvent({ type: 'thinking_start' })
            }
          } else if (e?.type === 'content_block_stop') {
            if (inThinkingBlock) {
              inThinkingBlock = false
              this._pushEvent({ type: 'thinking_end' })
            }
          } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
            didStream = true
            this._pushEvent({ type: 'text_delta', text: e.delta.text })
          }
        } else if (msg.type === 'system') {
          const s = msg as any
          if (s.subtype === 'api_retry') {
            // Prefer the raw server error message; fall back to the categorized label.
            const detail = String(s.error_message ?? s.error ?? '')
            this._pushEvent({ type: 'api_retry', attempt: s.attempt ?? 1, maxRetries: s.max_retries ?? 3, delayMs: s.retry_delay_ms ?? 0, errorStatus: s.error_status ?? null, errorDetail: detail })
          } else if (s.subtype === 'compact_boundary') {
            this._pushEvent({ type: 'compact' })
          } else if (s.subtype === 'task_started') {
            this._pushEvent({ type: 'agent_start', taskId: s.task_id, toolUseId: s.tool_use_id ?? null, description: s.description ?? '', agentType: s.task_type ?? 'local_agent', prompt: s.prompt ?? null })
          } else if (s.subtype === 'task_progress') {
            this._pushEvent({ type: 'agent_progress', taskId: s.task_id, toolUseId: s.tool_use_id ?? null, activity: s.description ?? '', toolCount: s.usage?.tool_uses ?? 0, tokenCount: s.usage?.total_tokens ?? 0, durationMs: s.usage?.duration_ms ?? 0, lastToolName: s.last_tool_name ?? null, summary: s.summary ?? null })
          } else if (s.subtype === 'task_notification') {
            this._pushEvent({ type: 'agent_done', taskId: s.task_id, toolUseId: s.tool_use_id ?? null, status: s.status, summary: s.summary ?? '', toolCount: s.usage?.tool_uses ?? 0, tokenCount: s.usage?.total_tokens ?? 0, durationMs: s.usage?.duration_ms ?? 0 })
          }
        } else if (msg.type === 'assistant') {
          for (const block of (msg.message.content as any[]) ?? []) {
            if (block.type === 'tool_use') {
              this._pushEvent({
                type: 'tool_start',
                name: block.name,
                input: JSON.stringify(block.input, null, 2),
                toolUseId: block.id,
              })
            }
          }
        } else if (msg.type === 'user') {
          for (const block of (msg.message.content as any[]) ?? []) {
            if (block.type === 'tool_result') {
              let output = ''
              if (typeof block.content === 'string') output = block.content
              else if (Array.isArray(block.content))
                output = block.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
              this._pushEvent({
                type: 'tool_end',
                name: block.tool_use_id,
                toolUseId: block.tool_use_id,
                output: output.length > 3000 ? output.slice(0, 3000) + '\n…(truncated)' : output,
                isError: block.is_error ?? false,
              })
            }
          }
        } else if (msg.type === 'result') {
          const r = msg as any
          if (!didStream && r.subtype === 'success' && r.result)
            this._pushEvent({ type: 'text_delta', text: r.result })
          if (r.is_error && r.subtype !== 'success') {
            // Suppress execution errors caused by user-initiated abort (cancel button).
            // When aborted mid-stream the engine detects an inconsistent state and
            // yields error_during_execution — that's expected, not a real error.
            if (!this._abortController.signal.aborted) {
              const subtypeMessages: Record<string, string> = {
                error_max_turns: `已达到最大对话轮次限制`,
                error_max_budget_usd: `已超出费用预算限制`,
                error_max_structured_output_retries: `结构化输出重试次数已达上限`,
                error_during_execution: `执行过程中发生错误`,
              }
              const detail = (r.errors as string[] | undefined)?.[0] ?? ''
              const base = subtypeMessages[r.subtype] ?? `执行终止 (${r.subtype})`
              this._pushEvent({ type: 'error', message: detail ? `${base}: ${detail}` : base })
            }
          }
          this._pushEvent({
            type: 'result',
            inputTokens: r.usage?.input_tokens ?? 0,
            outputTokens: r.usage?.output_tokens ?? 0,
          })
        }
      }
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || err?.code === 'ERR_CANCELED' || err?.message?.includes('abort')
      if (!isAbort) this._pushEvent({ type: 'error', message: err?.message ?? String(err) })
    } finally {
      this._pushEvent(null)
    }
  }
}

// ── Public event types emitted to the Electron main process ─────────────────

export type ElectronEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_permission'; toolUseId: string; name: string; input: string; agentId: string | null; agentType: string | null }
  | { type: 'tool_start'; name: string; input: string; toolUseId: string }
  | { type: 'tool_end'; name: string; toolUseId: string; output: string; isError: boolean }
  | { type: 'thinking_start' }
  | { type: 'thinking_end' }
  | { type: 'api_retry'; attempt: number; maxRetries: number; delayMs: number; errorStatus: number | null; errorDetail: string }
  | { type: 'compact' }
  | { type: 'agent_start'; taskId: string; toolUseId: string | null; description: string; agentType: string; prompt: string | null }
  | { type: 'agent_progress'; taskId: string; toolUseId: string | null; activity: string; toolCount: number; tokenCount: number; durationMs: number; lastToolName: string | null; summary: string | null }
  | { type: 'agent_done'; taskId: string; toolUseId: string | null; status: 'completed' | 'failed' | 'stopped'; summary: string; toolCount: number; tokenCount: number; durationMs: number }
  | { type: 'result'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }

// ── Session store ────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>()
const sessionProviders = new Map<string, string>()

export function destroySession(sessionKey: string): void {
  sessions.get(sessionKey)?.abort()
  sessions.delete(sessionKey)
  sessionProviders.delete(sessionKey)
}

export function cancelSession(sessionKey: string): void {
  const session = sessions.get(sessionKey)
  if (session) { session.abort(); sessions.delete(sessionKey); sessionProviders.delete(sessionKey) }
}

export function approveToolUse(sessionKey: string, toolUseId: string, allowed: boolean): void {
  sessions.get(sessionKey)?.approveToolUse(toolUseId, allowed)
}

export async function* sendMessage(
  sessionKey: string,
  message: string,
  cwd: string,
  providerConfig: ProviderConfig = null,
  history: HistoryMessage[] = [],
): AsyncGenerator<ElectronEvent> {
  applyProviderEnv(providerConfig)

  const currentProvider = providerConfig?.providerId ?? ''

  // Destroy stale session when provider changes so the new session is initialized
  // with fresh env vars and a model-appropriate QueryEngine.
  const prevProvider = sessionProviders.get(sessionKey)
  if (prevProvider !== undefined && prevProvider !== currentProvider) {
    sessions.get(sessionKey)?.abort()
    sessions.delete(sessionKey)
    sessionProviders.delete(sessionKey)
  }

  let session = sessions.get(sessionKey)
  if (!session) {
    // Load agents, MCP servers, and session hooks in parallel.
    const mcpClients: MCPServerConnection[] = []
    const mcpTools: any[] = []
    const [agentDefs, hookMessages] = await Promise.all([
      getAgentDefinitionsWithOverrides(cwd),
      processSessionStartHooks('startup', { model: providerConfig?.model }).catch(() => []),
      getMcpToolsCommandsAndResources(({ client, tools }) => {
        mcpClients.push(client)
        mcpTools.push(...tools)
      }).catch(() => {}),
    ])
    session = new Session(cwd, providerConfig?.model, history, agentDefs.activeAgents, mcpClients, mcpTools, hookMessages)
    sessions.set(sessionKey, session)
    sessionProviders.set(sessionKey, currentProvider)
  } else if (providerConfig?.model) {
    session.updateModel(providerConfig.model)
  }

  yield* session.send(message)
}
