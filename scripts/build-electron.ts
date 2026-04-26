/**
 * Builds src/entrypoints/electron.ts → dist/electron.mjs
 *
 * Uses the same pre-processing (feature flags) and plugin infrastructure
 * as the main build script so all stubs and shims are applied correctly.
 *
 * Run via: bun run scripts/build-electron.ts
 * Or:      npm run build:chat  (called automatically before electron starts)
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { noTelemetryPlugin } from './no-telemetry-plugin'

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))
const version = pkg.version

// ── Feature flags (must match build.ts) ─────────────────────────────────────
const featureFlags: Record<string, boolean> = {
  VOICE_MODE: false, PROACTIVE: false, KAIROS: false, BRIDGE_MODE: false,
  DAEMON: false, AGENT_TRIGGERS: false, ABLATION_BASELINE: false, CONTEXT_COLLAPSE: false,
  COMMIT_ATTRIBUTION: false, UDS_INBOX: false, BG_SESSIONS: false, WEB_BROWSER_TOOL: false,
  CHICAGO_MCP: false, COWORKER_TYPE_TELEMETRY: false,
  COORDINATOR_MODE: true, BUILTIN_EXPLORE_PLAN_AGENTS: true, BUDDY: true,
  MONITOR_TOOL: true, TEAMMEM: true, MESSAGE_ACTIONS: true, DUMP_SYSTEM_PROMPT: true,
  CACHED_MICROCOMPACT: true, AWAY_SUMMARY: true, TRANSCRIPT_CLASSIFIER: true,
  ULTRATHINK: true, TOKEN_BUDGET: true, HISTORY_PICKER: true, QUICK_SEARCH: true,
  SHOT_STATS: true, EXTRACT_MEMORIES: true, FORK_SUBAGENT: true,
  VERIFICATION_AGENT: true, MCP_SKILLS: true, PROMPT_CACHE_BREAK_DETECTION: true,
  HOOK_PROMPTS: true,
}

const featureCallRe = /\bfeature\(\s*['"](\w+)['"][,\s]*\)/gs
const featureImportRe = /import\s*\{[^}]*\bfeature\b[^}]*\}\s*from\s*['"]bun:bundle['"];?\s*\n?/g
const modifiedFiles = new Map<string, string>()

function preProcessFeatureFlags(dir: string) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) { preProcessFeatureFlags(full); continue }
    if (!/\.(ts|tsx)$/.test(ent.name)) continue
    const raw = readFileSync(full, 'utf-8')
    if (!raw.includes('feature(')) continue
    let contents = raw
    contents = contents.replace(featureImportRe, '')
    contents = contents.replace(featureCallRe, (_match, name) =>
      String((featureFlags as Record<string, boolean>)[name] ?? false))
    if (contents !== raw) { modifiedFiles.set(full, raw); writeFileSync(full, contents) }
  }
}

function restoreModifiedFiles() {
  for (const [path, original] of modifiedFiles) writeFileSync(path, original)
  modifiedFiles.clear()
}

preProcessFeatureFlags(join(import.meta.dir, '..', 'src'))
const numModified = modifiedFiles.size

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { restoreModifiedFiles(); process.exit(signal === 'SIGINT' ? 130 : 143) })
}

try {

const result = await Bun.build({
  entrypoints: ['./src/entrypoints/electron.ts'],
  outdir: './dist',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'external',
  minify: false,
  naming: 'electron.mjs',
  define: {
    'MACRO.VERSION': JSON.stringify('99.0.0'),
    'MACRO.DISPLAY_VERSION': JSON.stringify(version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify('report the issue at https://github.com/anthropics/claude-code/issues'),
    'MACRO.PACKAGE_URL': JSON.stringify('@gitlawb/openclaude'),
    'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  },
  plugins: [
    noTelemetryPlugin,
    {
      name: 'electron-build-shim',
      setup(build) {
        // Stub internal feature-disabled modules
        const internalStubs = new Map([
          ['../daemon/workerRegistry.js', 'export async function runDaemonWorker() { throw new Error("unavailable"); }'],
          ['../daemon/main.js', 'export async function daemonMain() { throw new Error("unavailable"); }'],
          ['../cli/bg.js', 'export async function psHandler(){}; export async function logsHandler(){}; export async function attachHandler(){}; export async function killHandler(){}; export async function handleBgFlag(){}'],
          ['../cli/handlers/templateJobs.js', 'export async function templatesMain() { throw new Error("unavailable"); }'],
          ['../environment-runner/main.js', 'export async function environmentRunnerMain() { throw new Error("unavailable"); }'],
          ['../self-hosted-runner/main.js', 'export async function selfHostedRunnerMain() { throw new Error("unavailable"); }'],
        ] as const)

        build.onResolve(
          { filter: /^\.\.\/(daemon\/workerRegistry|daemon\/main|cli\/bg|cli\/handlers\/templateJobs|environment-runner\/main|self-hosted-runner\/main)\.js$/ },
          args => internalStubs.has(args.path as any) ? { path: args.path, namespace: 'internal-feature-stub' } : null,
        )
        build.onLoad({ filter: /.*/, namespace: 'internal-feature-stub' }, args => ({
          contents: internalStubs.get(args.path as any) ?? 'export {}',
          loader: 'js',
        }))

        // react/compiler-runtime shim
        build.onResolve({ filter: /^react\/compiler-runtime$/ }, () => ({
          path: 'react/compiler-runtime', namespace: 'react-compiler-shim',
        }))
        build.onLoad({ filter: /.*/, namespace: 'react-compiler-shim' }, () => ({
          contents: `export function c(size) { return new Array(size).fill(Symbol.for('react.memo_cache_sentinel')); }`,
          loader: 'js',
        }))

        // @aws-sdk/client-bedrock-runtime — needs explicit named exports because
        // @anthropic-ai/bedrock-sdk/AWS_restJson1.mjs statically imports exception
        // classes from it. Bun's static analysis requires them to exist in the stub.
        build.onResolve({ filter: /^@aws-sdk\/client-bedrock-runtime$/ }, () => ({
          path: '@aws-sdk/client-bedrock-runtime', namespace: 'bedrock-runtime-stub',
        }))
        build.onLoad({ filter: /.*/, namespace: 'bedrock-runtime-stub' }, () => ({
          contents: `
const mkErr = (name) => class extends Error {
  constructor(opts) { super(opts?.message ?? name); this.name = name; }
};
export const InternalServerException    = mkErr('InternalServerException');
export const ModelStreamErrorException  = mkErr('ModelStreamErrorException');
export const ThrottlingException        = mkErr('ThrottlingException');
export const ValidationException        = mkErr('ValidationException');
export const ResponseStream             = class {};
export const BedrockRuntimeClient       = class {};
export const InvokeModelCommand         = class {};
export const InvokeModelWithResponseStreamCommand = class {};
export const ConverseCommand            = class {};
export const ConverseStreamCommand      = class {};
const noop = () => null;
export default noop;
`,
          loader: 'js',
        }))

        // Known native addon and missing cloud packages — use comprehensive stub
        for (const mod of [
          '@ant/computer-use-mcp', '@ant/computer-use-mcp/sentinelApps',
          '@ant/computer-use-mcp/types', '@ant/computer-use-swift', '@ant/computer-use-input',
          '@anthropic-ai/sandbox-runtime', 'audio-capture-napi', 'audio-capture.node',
          'image-processor-napi', 'modifiers-napi', 'url-handler-napi', 'color-diff-napi',
          '@anthropic-ai/mcpb', '@ant/claude-for-chrome-mcp', 'asciichart', 'plist',
          'cacache', 'fuse', 'code-excerpt', 'stack-utils',
          // vscode-jsonrpc is nested under vscode-languageserver-protocol and not
          // resolvable from the top-level — stub it since LSP is unused in Electron
          'vscode-jsonrpc/node.js',
          // Cloud provider SDKs: Electron uses OpenAI-compatible endpoints,
          // these native SDKs are not needed at runtime and have no node_modules.
          // Note: @aws-sdk/client-bedrock-runtime has its own stub above (needs
          // explicit named exports for static analysis of @anthropic-ai/bedrock-sdk).
          '@aws-sdk/client-bedrock',
          '@aws-sdk/client-sts', '@aws-sdk/credential-providers',
          '@azure/identity', 'google-auth-library',
          // sharp is a native addon (needs compiled .node) — stub it
          'sharp',
        ]) {
          const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
            path: mod, namespace: 'native-stub',
          }))
        }
        build.onLoad({ filter: /.*/, namespace: 'native-stub' }, () => ({
          contents: `
const noop = () => null;
const noopClass = class {};
const handler = {
  get(_, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return new Proxy({}, handler);
    if (prop === 'ExportResultCode') return { SUCCESS: 0, FAILED: 1 };
    if (prop === 'resourceFromAttributes') return () => ({});
    if (prop === 'SandboxRuntimeConfigSchema') return { parse: () => ({}) };
    return noop;
  }
};
const stub = new Proxy(noop, handler);
export default stub;
export const __stub = true;
export const SandboxViolationStore = null;
export const SandboxManager = new Proxy({}, { get: () => noop });
export const SandboxRuntimeConfigSchema = { parse: () => ({}) };
export const BROWSER_TOOLS = [];
export const getMcpConfigForManifest = noop;
export const ColorDiff = null;
export const ColorFile = null;
export const getSyntaxTheme = noop;
export const plot = noop;
export const createClaudeForChromeMcpServer = noop;
// vscode-jsonrpc exports (used by LSPClient.ts, unused in Electron mode)
export const createMessageConnection = noop;
export const StreamMessageReader = noopClass;
export const StreamMessageWriter = noopClass;
export const Trace = { Off: 0, Messages: 1, Verbose: 2 };
`,
          loader: 'js',
        }))

        // .md / .txt file imports
        build.onResolve({ filter: /\.(md|txt)$/ }, args => ({ path: args.path, namespace: 'text-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'text-stub' }, () => ({
          contents: "export default '';", loader: 'js',
        }))

        // Pre-scan: auto-discover all relative .js imports that have no .ts/.tsx on disk
        // (mirrors the scanForMissingImports logic in build.ts)
        const fs = require('fs')
        const pathMod = require('path')
        const srcDir = pathMod.resolve(__dirname, '..', 'src')
        const missingModules = new Set<string>()
        const missingModuleExports = new Map<string, Set<string>>()

        function checkAndRegister(specifier: string, fileDir: string, namedPart: string) {
          const names = namedPart.split(',')
            .map((s: string) => s.trim().replace(/^type\s+/, ''))
            .filter((s: string) => s && !s.startsWith('type '))

          if (specifier.startsWith('src/tasks/')) {
            const resolved = pathMod.resolve(__dirname, '..', specifier)
            const candidates = [
              resolved, `${resolved}.ts`, `${resolved}.tsx`,
              resolved.replace(/\.js$/, '.ts'), resolved.replace(/\.js$/, '.tsx'),
              pathMod.join(resolved, 'index.ts'), pathMod.join(resolved, 'index.tsx'),
            ]
            if (!candidates.some((c: string) => fs.existsSync(c))) missingModules.add(specifier)
          } else if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
            const resolved = pathMod.resolve(fileDir, specifier)
            const tsVariant = resolved.replace(/\.js$/, '.ts')
            const tsxVariant = resolved.replace(/\.js$/, '.tsx')
            if (!fs.existsSync(resolved) && !fs.existsSync(tsVariant) && !fs.existsSync(tsxVariant)) {
              missingModules.add(specifier)
            }
          }

          if (names.length > 0) {
            if (!missingModuleExports.has(specifier)) missingModuleExports.set(specifier, new Set())
            for (const n of names) missingModuleExports.get(specifier)!.add(n)
          }
        }

        function walk(dir: string) {
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = pathMod.join(dir, ent.name)
            if (ent.isDirectory()) { walk(full); continue }
            if (!/\.(ts|tsx)$/.test(ent.name)) continue
            const rawCode: string = fs.readFileSync(full, 'utf-8')
            const fileDir = pathMod.dirname(full)
            const code = rawCode
              .replace(/\/\*[\s\S]*?\*\//g, '')
              .replace(/\/\/.*$/gm, '')
            for (const m of code.matchAll(/import\s+(?:\{([^}]*)\}|(\w+))?\s*(?:,\s*\{([^}]*)\})?\s*from\s+['"](.*?)['"]/g)) {
              checkAndRegister(m[4], fileDir, m[1] || m[3] || '')
            }
            for (const m of code.matchAll(/require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
              checkAndRegister(m[1], fileDir, '')
            }
            for (const m of code.matchAll(/import\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)) {
              checkAndRegister(m[1], fileDir, '')
            }
          }
        }
        walk(srcDir)

        for (const mod of missingModules) {
          const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          build.onResolve({ filter: new RegExp(`^${escaped}$`) }, () => ({
            path: mod, namespace: 'missing-module-stub',
          }))
        }
        build.onLoad({ filter: /.*/, namespace: 'missing-module-stub' }, (args) => {
          const names = missingModuleExports.get(args.path) ?? new Set()
          const exports = [...names].map(n => `export const ${n} = noop;`).join('\n')
          return {
            contents: `const noop = () => null;\nexport default noop;\n${exports}`,
            loader: 'js',
          }
        })
      },
    },
  ],
  external: [
    '@opentelemetry/api', '@opentelemetry/api-logs', '@opentelemetry/core',
    '@opentelemetry/exporter-trace-otlp-grpc', '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-trace-otlp-proto', '@opentelemetry/exporter-logs-otlp-http',
    '@opentelemetry/exporter-logs-otlp-proto', '@opentelemetry/exporter-logs-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-proto', '@opentelemetry/exporter-metrics-otlp-grpc',
    '@opentelemetry/exporter-metrics-otlp-http', '@opentelemetry/exporter-prometheus',
    '@opentelemetry/resources', '@opentelemetry/sdk-trace-base', '@opentelemetry/sdk-trace-node',
    '@opentelemetry/sdk-logs', '@opentelemetry/sdk-metrics', '@opentelemetry/semantic-conventions',
  ],
})

if (result.success) {
  console.log(`✓ Built electron bridge v${version} → dist/electron.mjs`)
} else {
  console.error('Electron bridge build failed:')
  for (const log of result.logs) console.error(log)
  process.exitCode = 1
}

} finally {
  restoreModifiedFiles()
  console.log(`  🔄 feature-flags: pre-processed ${numModified} files (restored)`)
}
