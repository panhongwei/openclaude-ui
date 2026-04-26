'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { pathToFileURL } = require('url');
const { execSync } = require('child_process');


// ── Windows shell 检测 ────────────────────────────────────────────
if (process.platform === 'win32' && !process.env.CLAUDE_CODE_SHELL && !process.env.SHELL) {
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  let found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!found) {
    try {
      const out = execSync('where.exe bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      found = out.trim().split(/\r?\n/)[0] || null;
    } catch {}
  }
  if (found) {
    process.env.CLAUDE_CODE_SHELL = found;
    console.log('[main] Windows shell:', found);
  } else {
    process.env.OPENCLAUDE_SHELL_UNAVAILABLE = '1';
    console.warn('[main] No bash found on Windows. Shell tools will be unavailable.');
  }
}

const undici = (() => { try { return require('undici'); } catch { return null; } })();

let mainWindow;

// ── 提供商定义 ────────────────────────────────────────────────────
const PROVIDER_DEFS = {
  anthropic:  { name: 'Anthropic Claude', envKeys: ['ANTHROPIC_API_KEY'],                          baseUrl: 'https://api.anthropic.com',                               defaultModel: 'claude-sonnet-4-6' },
  openai:     { name: 'OpenAI',           envKeys: ['OPENAI_API_KEY'],                             baseUrl: 'https://api.openai.com/v1',                               defaultModel: 'gpt-4o' },
  gemini:     { name: 'Google Gemini',    envKeys: ['GEMINI_API_KEY','GOOGLE_API_KEY'],            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
  custom:     { name: '自定义',            envKeys: [],                                             baseUrl: '',                                                        defaultModel: '' },
};

const PROVIDER_MODELS = {
  anthropic:  ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai:     ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini', 'gpt-4-turbo'],
  gemini:     ['gemini-2.0-flash', 'gemini-2.0-pro-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  custom:     [],
};

// alias 前缀
const ALIAS_PREFIXES = {
  anthropic: 'claude', openai: 'gpt', gemini: 'gem', custom: 'mdl',
};

function genAlias(providerId, existingAliases) {
  const prefix = ALIAS_PREFIXES[providerId] || 'mdl';
  let alias;
  do {
    alias = `${prefix}-${String(Math.floor(Math.random() * 900) + 100)}`;
  } while (existingAliases.includes(alias));
  return alias;
}

function collectAliases(cfg) {
  const list = [];
  for (const prov of Object.values(cfg.providers || {})) {
    for (const m of (prov.models || [])) {
      if (m.name)  list.push(m.name);
      if (m.alias) list.push(m.alias);
    }
  }
  return list;
}

// ── 配置文件 ─────────────────────────────────────────────────────
const CHAT_CONFIG_PATH = path.join(os.homedir(), '.openclaude-chat.json');

function readChatConfig() {
  try { return JSON.parse(fs.readFileSync(CHAT_CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeChatConfig(cfg) {
  fs.writeFileSync(CHAT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

// 配置迁移（三阶段）
// v1: providers[id].model (string)
// v2: providers[id].models[].{id,model,alias}  +  providers[id].apiKey/baseUrl
// v3: providers[id].models[].{id,name,model,apiKey,baseUrl}  (no provider-level keys)
function migrateCfg(cfg) {
  if (!cfg.providers) return;
  let needsSave = false;
  const usedNames = collectAliases(cfg);

  for (const [id, prov] of Object.entries(cfg.providers)) {
    // v1 → v2: single model string
    if (typeof prov.model === 'string' && !Array.isArray(prov.models)) {
      const name = genAlias(id, usedNames);
      usedNames.push(name);
      prov.models = [{
        id:     'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
        name,
        model:  prov.model,
        apiKey: prov.apiKey  || '',
        baseUrl: prov.baseUrl || '',
      }];
      delete prov.model;
      needsSave = true;
    }
    if (!Array.isArray(prov.models)) { prov.models = []; needsSave = true; }

    // v2 → v3: push provider-level keys into each model entry
    for (const m of prov.models) {
      if (m.apiKey  === undefined) { m.apiKey  = prov.apiKey  || ''; needsSave = true; }
      if (m.baseUrl === undefined) { m.baseUrl = prov.baseUrl !== undefined ? prov.baseUrl : ''; needsSave = true; }
      if (!m.name) {
        m.name = m.alias || genAlias(id, usedNames);
        usedNames.push(m.name);
        needsSave = true;
      }
      if (m.alias !== undefined) { delete m.alias; needsSave = true; }
    }

    // Remove provider-level keys
    if ('apiKey' in prov || 'baseUrl' in prov) {
      delete prov.apiKey;
      delete prov.baseUrl;
      needsSave = true;
    }
  }
  if (needsSave) writeChatConfig(cfg);
}

function resolveModelRef(cfg, ref) {
  if (!ref) return null;
  const colon = ref.indexOf(':');
  if (colon < 0) return null;
  const provId  = ref.slice(0, colon);
  const modelId = ref.slice(colon + 1);
  const prov    = cfg.providers?.[provId];
  if (!prov) return null;
  const entry = prov.models?.find(m => m.id === modelId);
  if (!entry) return null;
  return {
    providerId: provId,
    apiKey:     entry.apiKey  || '',
    baseUrl:    entry.baseUrl || PROVIDER_DEFS[provId]?.baseUrl || '',
    model:      entry.model,
  };
}

// ── API Key 解析 ─────────────────────────────────────────────────
// Explicit saved key takes priority; env vars / claude config are fallbacks.
// Only accept tokens that look like real API keys (sk-ant-…) — Claude Code
// session/OAuth tokens stored in ~/.claude/config.json are NOT API keys.
function resolveProviderKey(id, savedKey) {
  if (savedKey) return savedKey;
  const def = PROVIDER_DEFS[id];
  for (const envVar of (def?.envKeys || [])) {
    if (process.env[envVar]) return process.env[envVar];
  }
  if (id === 'anthropic') {
    const cc = path.join(os.homedir(), '.claude', 'config.json');
    try { const c = JSON.parse(fs.readFileSync(cc, 'utf8')); if (c.apiKey?.startsWith('sk-ant-')) return c.apiKey; } catch {}
    const ac = path.join(os.homedir(), '.anthropic', 'config.json');
    try { const c = JSON.parse(fs.readFileSync(ac, 'utf8')); if (c.api_key?.startsWith('sk-ant-')) return c.api_key; } catch {}
  }
  return '';
}

// ── 错误消息格式化 ───────────────────────────────────────────────
function friendlyError(err) {
  const raw = err.message || String(err);
  if (/403|Forbidden/i.test(raw)) {
    return `API 请求被拒绝（403 Forbidden）\n\n可能原因：\n• API Key 无效、已过期或无权限\n• 使用了 Claude Code 认证令牌而非 API Key\n\n请前往 console.anthropic.com 创建 API Key（格式：sk-ant-api03-…），将其填入"设置 → 提供商与模型"中。`;
  }
  if (/401|Unauthorized/i.test(raw)) {
    return `API Key 认证失败（401 Unauthorized）\n\n请检查"设置 → 提供商与模型"中的 API Key 是否正确。`;
  }
  return raw;
}

// ── 代理 ─────────────────────────────────────────────────────────
function getProxyConfig() {
  const cfg = readChatConfig();
  return cfg.proxy || { enabled: false, url: '', bypass: '' };
}
function makeProxyFetch(proxyUrl) {
  if (!proxyUrl || !undici) return undefined;
  try {
    const dispatcher = new undici.ProxyAgent(proxyUrl);
    return (url, init) => undici.fetch(url, { ...init, dispatcher });
  } catch { return undefined; }
}
function apiFetch(url, options, proxyUrl) {
  if (proxyUrl && undici) {
    try {
      const dispatcher = new undici.ProxyAgent(proxyUrl);
      return undici.fetch(url, { ...options, dispatcher });
    } catch {}
  }
  return fetch(url, options);
}

// ── QueryEngine bridge ────────────────────────────────────────────
// Lazily import dist/electron.mjs (built from src/entrypoints/electron.ts).
// Uses dynamic ESM import because electron/main.cjs is CommonJS.
//
// Packaged app: asarUnpack extracts dist/electron.mjs to app.asar.unpacked/.
// app.getAppPath() returns the ASAR path, so +'.unpacked' gives the real dir.
// Development: app.getAppPath() returns the project root, file is at dist/.
let _electronBridge = null;
async function getElectronBridge() {
  if (!_electronBridge) {
    let bridgePath;
    if (app.isPackaged) {
      // Packaged: file is in app.asar.unpacked/dist/ (asarUnpack)
      const unpackedBase = app.getAppPath() + '.unpacked';
      bridgePath = path.join(unpackedBase, 'dist', 'electron.mjs');
      if (!fs.existsSync(bridgePath)) {
        // Fallback: package built without asarUnpack — file still inside ASAR
        bridgePath = path.join(app.getAppPath(), 'dist', 'electron.mjs');
      }
    } else {
      // Development: app.getAppPath() = project root
      bridgePath = path.join(app.getAppPath(), 'dist', 'electron.mjs');
    }
    console.log('[main] loading bridge:', bridgePath, '| exists:', fs.existsSync(bridgePath));
    _electronBridge = await import(pathToFileURL(bridgePath).href);
  }
  return _electronBridge;
}

// Apply proxy settings from UI config to process env so the API SDK uses them.
function applyProxyEnv(cfg) {
  const proxy = cfg.proxy || {};
  if (proxy.enabled && proxy.url) {
    process.env.HTTP_PROXY  = proxy.url;
    process.env.HTTPS_PROXY = proxy.url;
    if (proxy.bypass) process.env.NO_PROXY = proxy.bypass;
    else delete process.env.NO_PROXY;
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  }
}

// ── 窗口 ─────────────────────────────────────────────────────────
function createSplash() {
  const splash = new BrowserWindow({
    width: 360, height: 260, frame: false, resizable: false, center: true,
    backgroundColor: '#111111', alwaysOnTop: true, skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  return splash;
}

function createWindow() {
  const splash = createSplash();
  mainWindow = new BrowserWindow({
    width: 980, height: 720, minWidth: 640, minHeight: 480,
    backgroundColor: '#111111', title: 'openclaude chat', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: false, webviewTag: true },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    setTimeout(() => { if (!splash.isDestroyed()) splash.close(); mainWindow.show(); mainWindow.focus(); }, 120);
  });
  if (process.env.ELECTRON_DEV || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ── 菜单 ─────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const isDev = process.env.ELECTRON_DEV || process.argv.includes('--dev');
  const send  = (ch, ...a) => mainWindow?.webContents.send(ch, ...a);

  const template = [
    ...(isMac ? [{ label: app.name, submenu: [
      { label: '关于 openclaude', role: 'about' },
      { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
      { type: 'separator' },
      { label: '服务', role: 'services' }, { type: 'separator' },
      { label: '隐藏 openclaude', role: 'hide' }, { label: '隐藏其他', role: 'hideOthers' }, { label: '显示全部', role: 'unhide' },
      { type: 'separator' },
      { label: '退出 openclaude', role: 'quit' },
    ]}] : []),
    { label: '文件', submenu: [
      { label: '新对话', accelerator: 'CmdOrCtrl+N', click: () => send('new-chat') },
      { label: '新建工程', click: () => send('new-project') },
      { type: 'separator' },
      isMac ? { label: '关闭窗口', role: 'close' } : { label: '退出', role: 'quit' },
    ]},
    { label: '编辑', submenu: [
      { label: '撤销', role: 'undo', accelerator: 'CmdOrCtrl+Z' },
      { label: '重做', role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z' },
      { type: 'separator' },
      { label: '剪切', role: 'cut', accelerator: 'CmdOrCtrl+X' },
      { label: '复制', role: 'copy', accelerator: 'CmdOrCtrl+C' },
      { label: '粘贴', role: 'paste', accelerator: 'CmdOrCtrl+V' },
      { label: '全选', role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
    ]},
    { label: '设置', submenu: [
      { label: '提供商与模型…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
      { label: '代理设置…',                                  click: () => send('open-proxy') },
      { label: 'Skill 目录…',                                click: () => send('open-skills') },
      { type: 'separator' },
      { label: '切换主题',                                   click: () => send('cycle-theme') },
      { type: 'separator' },
      { label: '重置所有配置', click: () => {
        const btn = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning', title: '确认重置',
          message: '将清空所有保存的 API 密钥、模型和配置，确定吗？',
          buttons: ['取消', '确认重置'], defaultId: 0,
        });
        if (btn === 1) { writeChatConfig({}); send('config-reset'); }
      }},
    ]},
    { label: '帮助', submenu: [
      { label: '项目主页', click: () => shell.openExternal('https://github.com/Gitlawb/openclaude') },
      { label: '报告问题', click: () => shell.openExternal('https://github.com/Gitlawb/openclaude/issues') },
    ]},
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App ───────────────────────────────────────────────────────────
app.whenReady().then(() => {
  initConfigDir();
  createWindow();
  buildMenu();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── IPC ───────────────────────────────────────────────────────────

ipcMain.handle('get-config', () => {
  const cfg = readChatConfig();
  migrateCfg(cfg);
  const allModels = buildAllModels(cfg);
  return {
    hasModels:   allModels.length > 0,
    platform:    process.platform,
    homeDir:     os.homedir(),
    configDir:   getClaudeConfigHomeDir(),
    activeModelRef: cfg.activeModelRef || (allModels[0]?.ref ?? null),
    allModels,
  };
});

function buildAllModels(cfg) {
  const list = [];
  for (const [id, prov] of Object.entries(cfg.providers || {})) {
    const def = PROVIDER_DEFS[id];
    const hasEnvKey = (def?.envKeys || []).some(k => process.env[k]);
    for (const m of (prov.models || [])) {
      if (!m.apiKey && !hasEnvKey && id !== 'ollama') continue;
      list.push({
        ref:          `${id}:${m.id}`,
        alias:        m.name || m.model,
        model:        m.model,
        providerId:   id,
        providerName: def?.name || id,
      });
    }
  }
  return list;
}

ipcMain.handle('get-full-config', () => {
  const cfg = readChatConfig();
  migrateCfg(cfg);
  return {
    activeModelRef: cfg.activeModelRef || null,
    providers:      cfg.providers || {},
    allModels:      buildAllModels(cfg),
    proxy:          cfg.proxy || { enabled: false, url: '', bypass: '' },
    PROVIDER_DEFS,
    PROVIDER_MODELS,
    ALIAS_PREFIXES,
  };
});

ipcMain.handle('save-provider-settings', (_event, { providers, activeModelRef, proxy }) => {
  const cfg = readChatConfig();
  if (activeModelRef !== undefined) cfg.activeModelRef = activeModelRef;
  if (providers !== undefined) cfg.providers = providers;
  if (proxy !== undefined) cfg.proxy = proxy;
  writeChatConfig(cfg);
  const allModels = buildAllModels(cfg);
  return { ok: true, allModels, activeModelRef: cfg.activeModelRef };
});

ipcMain.handle('set-active-model', (_event, modelRef) => {
  const cfg = readChatConfig();
  cfg.activeModelRef = modelRef;
  writeChatConfig(cfg);
  return { ok: true };
});

ipcMain.handle('chat-send', async (event, { message, sessionKey, cwd, history }) => {
  try {
    const cfg = readChatConfig();
    migrateCfg(cfg);
    applyProxyEnv(cfg);
    const allModels = buildAllModels(cfg);
    const activeRef = cfg.activeModelRef || allModels[0]?.ref || null;
    const providerConfig = activeRef ? resolveModelRef(cfg, activeRef) : null;

    console.log('[chat-send] activeRef:', activeRef);
    console.log('[chat-send] providerConfig:', providerConfig ? { ...providerConfig, apiKey: providerConfig.apiKey ? providerConfig.apiKey.slice(0, 8) + '...' : '(empty)' } : null);

    if (!providerConfig) {
      if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: '未配置模型，请先在"设置 → 提供商与模型"中添加并选择一个模型。' });
      return;
    }
    if (!providerConfig.model) {
      if (!event.sender.isDestroyed()) event.sender.send('chat-error', { message: '当前模型未填写模型名称，请在设置中补全。' });
      return;
    }
    const bridge = await getElectronBridge();
    for await (const evt of bridge.sendMessage(sessionKey, message, cwd || os.homedir(), providerConfig, history || [])) {
      if (event.sender.isDestroyed()) break;
      console.log('[bridge]', evt.type, evt.type === 'text_delta' ? `(${evt.text?.length ?? 0} chars)` : JSON.stringify(evt).slice(0, 120));
      switch (evt.type) {
        case 'text_delta':
          event.sender.send('chat-chunk', { text: evt.text });
          break;
        case 'tool_permission':
          event.sender.send('tool-permission', { toolUseId: evt.toolUseId, name: evt.name, input: evt.input, sessionKey, agentId: evt.agentId, agentType: evt.agentType });
          break;
        case 'tool_start':
          event.sender.send('chat-tool-start', { name: evt.name, input: evt.input, toolUseId: evt.toolUseId });
          break;
        case 'tool_end':
          event.sender.send('chat-tool-end', { toolUseId: evt.toolUseId, output: evt.output, isError: evt.isError });
          break;
        case 'thinking_start':
          event.sender.send('chat-thinking-start', {});
          break;
        case 'thinking_end':
          event.sender.send('chat-thinking-end', {});
          break;
        case 'api_retry':
          event.sender.send('chat-api-retry', { attempt: evt.attempt, maxRetries: evt.maxRetries, delayMs: evt.delayMs, errorStatus: evt.errorStatus ?? null, errorDetail: evt.errorDetail ?? '' });
          break;
        case 'compact':
          event.sender.send('chat-compact', {});
          break;
        case 'agent_start':
          event.sender.send('chat-agent-start', { taskId: evt.taskId, toolUseId: evt.toolUseId, description: evt.description, agentType: evt.agentType, prompt: evt.prompt });
          break;
        case 'agent_progress':
          event.sender.send('chat-agent-progress', { taskId: evt.taskId, activity: evt.activity, toolCount: evt.toolCount, tokenCount: evt.tokenCount, durationMs: evt.durationMs, lastToolName: evt.lastToolName, summary: evt.summary });
          break;
        case 'agent_done':
          event.sender.send('chat-agent-done', { taskId: evt.taskId, status: evt.status, summary: evt.summary, toolCount: evt.toolCount, tokenCount: evt.tokenCount, durationMs: evt.durationMs });
          break;
        case 'result':
          event.sender.send('chat-done', { inputTokens: evt.inputTokens, outputTokens: evt.outputTokens });
          break;
        case 'error':
          event.sender.send('chat-error', { message: evt.message });
          break;
      }
    }
  } catch (err) {
    if (!event.sender.isDestroyed()) {
      const raw = err.message || String(err);
      const msg = err.code === 'ERR_MODULE_NOT_FOUND'
        ? `bridge 加载失败：${raw}\n\n` +
          (app.isPackaged
            ? '请重新打包（npm run build:chat）以确保 dist/electron.mjs 被正确打入包内。'
            : '请先运行: npm run build:electron')
        : raw;
      event.sender.send('chat-error', { message: msg });
    }
  }
});

ipcMain.handle('chat-new-session', (_event, sessionKey) => {
  getElectronBridge().then(b => b.destroySession(sessionKey)).catch(() => {});
  return { ok: true };
});

ipcMain.handle('chat-cancel', (_event, sessionKey) => {
  getElectronBridge().then(b => b.cancelSession(sessionKey)).catch(() => {});
  return { ok: true };
});

ipcMain.handle('tool-approve', async (_event, { sessionKey, toolUseId, allowed }) => {
  try {
    const bridge = await getElectronBridge();
    bridge.approveToolUse(sessionKey, toolUseId, allowed);
  } catch {}
  return { ok: true };
});

ipcMain.on('open-external', (_event, url) => shell.openExternal(url));

ipcMain.handle('open-path', (_event, filePath) => shell.openPath(filePath));

ipcMain.handle('get-file-size', (_e, filePath) => {
  try { return fs.statSync(filePath).size; } catch { return -1; }
});

ipcMain.handle('read-file-range', (_e, filePath, byteOffset, byteLength) => {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(byteLength);
    const n   = fs.readSync(fd, buf, 0, byteLength, byteOffset);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8');
  } catch { return null; }
});

ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择工作文件夹', buttonLabel: '选择' });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('read-dir', (_event, dirPath) => {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  } catch { return []; }
});

// ── Config home ───────────────────────────────────────────────────

// 镜像 src/utils/envUtils.ts 的逻辑：
//   ~/.openclaude 存在 → 用它；只有 ~/.claude 存在 → 用 ~/.claude（兼容旧装）；否则 ~/.openclaude
function getClaudeConfigHomeDir() {
  const home = os.homedir();
  const openClaudeDir  = path.join(home, '.openclaude');
  const legacyClaudeDir = path.join(home, '.claude');
  if (!fs.existsSync(openClaudeDir) && fs.existsSync(legacyClaudeDir)) {
    return legacyClaudeDir;
  }
  return openClaudeDir;
}

/**
 * 在 UI 启动时确保 ~/.openclaude 的基本目录结构存在。
 *
 * 镜像 Claude Code 引擎的懒创建逻辑，但在首次打开 UI 时就把骨架建好，
 * 避免引擎第一次写入时因父目录缺失而报错。
 *
 * 创建规则（不存在则建，存在则跳过）：
 *   ~/.openclaude/                settings.json 等全局配置的根
 *   ~/.openclaude/projects/       会话 transcript 存储 (src/utils/sessionStorage.ts)
 *   ~/.openclaude/skills/         用户级 skill 目录 (src/skills/loadSkillsDir.ts)
 *   ~/.openclaude/commands/       用户级 command 目录（legacy，仍被读取）
 *   ~/.openclaude/settings.json   用户级 settings（userSettings），空对象即可
 *
 * 不创建的文件（让引擎或用户自行管理）：
 *   ~/.openclaude.json    — 全局 config，带 lock/backup 机制，由 saveGlobalConfig() 负责
 *   ~/.openclaude/CLAUDE.md — 用户记忆，用户主动创建或通过 /init 创建
 *   ~/.openclaude/backups/ — 由 saveConfigWithLock() 按需创建
 *   ~/.openclaude/plans/   — plan mode 首次使用时创建
 */
function initConfigDir() {
  const configDir = getClaudeConfigHomeDir();
  const dirs = [
    configDir,
    path.join(configDir, 'projects'),
    path.join(configDir, 'skills'),
    path.join(configDir, 'commands'),
  ];
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); } catch {}
  }
  const settingsPath = path.join(configDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    try { fs.writeFileSync(settingsPath, '{}', { encoding: 'utf8', mode: 0o600 }); } catch {}
  }
}

// ── Skills ────────────────────────────────────────────────────────

function parseSkillFrontmatter(content) {
  const fm = {};
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([a-zA-Z-]+)\s*:\s*(.+)$/);
      if (kv) fm[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return fm;
}

function loadSkillsFromDir(dir, source) {
  const skills = [];
  if (!fs.existsSync(dir)) return skills;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      let mdPath = null;
      let skillName = entry.name;
      if (entry.isDirectory()) {
        for (const candidate of ['SKILL.md', 'skill.md']) {
          const p = path.join(dir, entry.name, candidate);
          if (fs.existsSync(p)) { mdPath = p; break; }
        }
      } else if (/\.md$/i.test(entry.name) && !/^skill\.md$/i.test(entry.name)) {
        mdPath = path.join(dir, entry.name);
        skillName = entry.name.replace(/\.md$/i, '');
      }
      if (!mdPath) continue;
      try {
        const raw = fs.readFileSync(mdPath, 'utf8');
        const fm = parseSkillFrontmatter(raw);
        const body = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim();
        const name = fm['name'] || skillName;
        const rawDesc = fm['description'] || fm['when-to-use'] ||
          body.split('\n').find(l => l.trim()) || '';
        const desc = rawDesc.replace(/^#+\s*/, '').slice(0, 80);
        skills.push({ name, description: desc, template: body, source });
      } catch {}
    }
  } catch {}
  return skills;
}

ipcMain.handle('read-skills', (_event, cwd, extraDirs) => {
  const results = [];
  const seen = new Set();
  const add = (dir, source) => {
    for (const s of loadSkillsFromDir(dir, source)) {
      if (!seen.has(s.name)) { seen.add(s.name); results.push(s); }
    }
  };

  const configHomeDir  = getClaudeConfigHomeDir();           // ~/.openclaude 或 ~/.claude
  const legacyClaudeDir = path.join(os.homedir(), '.claude'); // 永远指向 ~/.claude

  // 主用户 skill 目录（CLI 行为一致）
  add(path.join(configHomeDir, 'skills'),   'user');
  add(path.join(configHomeDir, 'commands'), 'user');

  // 若 configHomeDir 是 ~/.openclaude，额外检查 ~/.claude（兼容旧装同时存在两个目录的情况）
  if (configHomeDir !== legacyClaudeDir) {
    add(path.join(legacyClaudeDir, 'skills'),   'user');
    add(path.join(legacyClaudeDir, 'commands'), 'user');
  }

  // 项目级
  if (cwd) {
    add(path.join(cwd, '.claude', 'skills'),   'project');
    add(path.join(cwd, '.claude', 'commands'), 'project');
  }

  // 自定义额外目录
  if (Array.isArray(extraDirs)) {
    for (const d of extraDirs) { if (d) add(d, '自定义'); }
  } else if (extraDirs) {
    add(extraDirs, '自定义');
  }

  return results;
});

ipcMain.handle('select-skills-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择 Skill 目录',
    buttonLabel: '选择',
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle('read-file', (_event, filePath) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
});

ipcMain.handle('write-file', (_event, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf8'); return true; } catch { return false; }
});
