/* global window.electronAPI */
'use strict';

// ── 主题 ────────────────────────────────────────────────────────
const THEMES = ['dark', 'light', 'green'];
const THEME_ICONS  = { dark: '◐', light: '○', green: '◉' };
const THEME_LABELS = { dark: '暗色', light: '亮色', green: '护眼' };
let currentTheme = localStorage.getItem('oc-theme') || 'dark';

// ── Skill 定义 ───────────────────────────────────────────────────
// 内置动作 skill（始终显示）
const ACTION_SKILLS = [
  { name: 'new',      icon: '＋',  desc: '开始新对话',       action: () => newChat() },
  { name: 'clear',    icon: '✕',   desc: '清除上下文与输出', action: () => newChat() },
  { name: 'settings', icon: '⚙',  desc: '提供商与模型设置', action: () => openSettings() },
];
// 内置模板 skill（无外部 skill 时作为兜底）
const FALLBACK_SKILLS = [
  { name: 'explain',  icon: '📖',  desc: '解释代码',               template: '请解释以下代码，说明其功能和实现方式：\n\n' },
  { name: 'fix',      icon: '🔧',  desc: '修复代码问题',            template: '请帮我找出并修复以下代码中的问题：\n\n' },
  { name: 'review',   icon: '🔍',  desc: '代码审查',               template: '请对以下代码进行审查，指出潜在问题并提出改进建议：\n\n' },
  { name: 'test',     icon: '✅',  desc: '编写测试用例',            template: '请为以下代码编写完整的测试用例：\n\n' },
  { name: 'optimize', icon: '⚡',  desc: '优化性能',               template: '请分析并优化以下代码的性能：\n\n' },
  { name: 'document', icon: '📝',  desc: '添加文档注释',            template: '请为以下代码添加详细的文档注释：\n\n' },
  { name: 'refactor', icon: '♻',  desc: '重构代码',               template: '请帮我重构以下代码，提高可读性和可维护性：\n\n' },
  { name: 'git',      icon: '🌿',  desc: '分析 Git diff',          template: '请分析以下 git diff 并总结改动内容：\n\n' },
];
// 从 ~/.claude/skills/ 动态加载的 skill
let loadedSkills = [];

function getAllSkills() {
  const external = loadedSkills.map(s => ({ name: s.name, icon: '◆', desc: s.description, template: s.template, source: s.source }));
  return [...ACTION_SKILLS, ...(external.length ? external : FALLBACK_SKILLS)];
}

async function loadExternalSkills(cwd) {
  try {
    const extra = localStorage.getItem('oc-skills-extra-dir') || null;
    const skills = await window.electronAPI.readSkills(cwd || null, extra);
    loadedSkills = skills || [];
    console.log('[skills] loaded', loadedSkills.length, 'skills:', loadedSkills.map(s => s.name));
  } catch(e) { console.error('[skills] loadExternalSkills failed:', e); loadedSkills = []; }
}

function applyTheme(t) {
  currentTheme = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('oc-theme', t);
  themeBtnEl.textContent = THEME_ICONS[t];
  themeBtnEl.title = '主题：' + THEME_LABELS[t] + '（点击切换）';
}

// ── 模型/提供商 ──────────────────────────────────────────────────
const ALIAS_PREFIXES = {
  anthropic: 'claude', openai: 'gpt', gemini: 'gem', custom: 'mdl',
};

let allModels      = [];   // [{ref, alias, model, providerId, providerName}]
let activeModelRef = null;
let providerDefs   = {};
let providerModels = {};
let settingsDraft  = {};   // working copy of providers during settings editing

function genAlias(providerId, existingAliases) {
  const prefix = ALIAS_PREFIXES[providerId] || 'mdl';
  let alias;
  do { alias = `${prefix}-${String(Math.floor(Math.random() * 900) + 100)}`; }
  while (existingAliases.includes(alias));
  return alias;
}

function populateModelSelect(models, activeRef) {
  allModels = models || [];
  activeModelRef = activeRef || allModels[0]?.ref || null;
  modelSelectEl.innerHTML = '';
  if (!allModels.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '暂无模型';
    modelSelectEl.appendChild(opt);
  } else {
    allModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.ref;
      opt.textContent = m.alias || m.model;
      modelSelectEl.appendChild(opt);
    });
    if (activeModelRef) modelSelectEl.value = activeModelRef;
    activeModelRef = modelSelectEl.value || activeModelRef;
  }
  updateProviderBadge();
}

function updateProviderBadge() {
  const m = allModels.find(x => x.ref === modelSelectEl.value);
  providerBadgeEl.textContent = m ? (m.providerName || m.providerId) : '';
}

function getDraftNames() {
  const list = [];
  for (const prov of Object.values(settingsDraft)) {
    for (const m of (prov.models || [])) { if (m.name) list.push(m.name); }
  }
  return list;
}

// ── 项目管理 ────────────────────────────────────────────────────
let projects = [];
try { projects = JSON.parse(localStorage.getItem('oc-projects') || '[]'); } catch {}

const sessions = new Map();
let activeProjectId = null;
let homeDir = '';
let configDir = '';

function getSession(id) {
  if (!sessions.has(id)) {
    let saved = { messages: [], inputTokens: 0, outputTokens: 0 };
    try {
      const raw = localStorage.getItem('oc-session-' + id);
      if (raw) saved = JSON.parse(raw);
    } catch {}
    sessions.set(id, saved);
  }
  return sessions.get(id);
}
function saveSession(id) {
  if (!id) return;
  const s = sessions.get(id);
  if (!s) return;
  try { localStorage.setItem('oc-session-' + id, JSON.stringify(s)); } catch {}
}
function saveProjects() { localStorage.setItem('oc-projects', JSON.stringify(projects)); }

function shortenPath(p) {
  const norm = p.replace(/\\/g, '/');
  const home = homeDir.replace(/\\/g, '/');
  if (home && norm.startsWith(home)) return '~' + norm.slice(home.length);
  const parts = norm.split('/').filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : norm;
}

async function addProject() {
  const folder = await window.electronAPI.selectFolder();
  if (!folder) return;
  const name = folder.replace(/\\/g, '/').split('/').filter(Boolean).pop() || folder;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  projects.push({ id, name, path: folder });
  saveProjects();
  renderProjectList();
  switchProject(id);
}

function removeProject(id) {
  const proj = projects.find(p => p.id === id);
  if (!proj) return;
  if (!confirm(`移除工程 "${proj.name}"？\n（只移除列表，不会删除文件夹）`)) return;
  projects = projects.filter(p => p.id !== id);
  sessions.delete(id);
  localStorage.removeItem('oc-session-' + id);
  saveProjects();
  if (activeProjectId === id) {
    activeProjectId = null;
    state.messages = []; state.inputTokens = 0; state.outputTokens = 0;
    sidebar.navStack = [];
    folderPathEl.textContent = '未选择'; folderPathEl.title = '';
    fileTreeEl.innerHTML = '';
    messagesEl.innerHTML = '';
    renderWelcome();
    updateStatusBar();
    updateInputState();
  }
  renderProjectList();
}

function switchProject(id) {
  if (state.loading) return;
  if (activeProjectId) {
    const cur = sessions.get(activeProjectId);
    if (cur) { cur.inputTokens = state.inputTokens; cur.outputTokens = state.outputTokens; }
  }
  activeProjectId = id;
  const proj = projects.find(p => p.id === id);
  if (!proj) return;
  const session = getSession(id);
  state.messages = session.messages;
  state.inputTokens = session.inputTokens;
  state.outputTokens = session.outputTokens;
  renderSessionMessages();
  sidebar.navStack = [proj.path];
  renderFileTree();
  renderProjectList();
  updateStatusBar();
  localStorage.setItem('oc-last-project', id);
  loadExternalSkills(proj.path);
  updateInputState();
  inputEl.focus();
}

function renderProjectList() {
  projectListEl.innerHTML = '';
  if (!projects.length) {
    projectListEl.innerHTML = '<div class="proj-empty">暂无工程<br>点击 ＋ 新建</div>';
    return;
  }
  projects.forEach(proj => {
    const el = document.createElement('div');
    el.className = 'project-item' + (proj.id === activeProjectId ? ' active' : '');
    el.title = proj.path + '\n（双击切换）';
    el.innerHTML = `
      <span class="proj-icon"><svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M1 3.5A1.5 1.5 0 012.5 2h3.379a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.12 4H13.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5z"/></svg></span>
      <div class="proj-info">
        <div class="proj-name">${escHtml(proj.name)}</div>
        <div class="proj-path">${escHtml(shortenPath(proj.path))}</div>
      </div>
      <button class="proj-remove" title="移除工程">×</button>`;
    el.addEventListener('dblclick', () => switchProject(proj.id));
    el.addEventListener('click', () => {
      document.querySelectorAll('.project-item').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
    });
    el.querySelector('.proj-remove').addEventListener('click', e => {
      e.stopPropagation(); removeProject(proj.id);
    });
    projectListEl.appendChild(el);
  });
  if (projects.length && !activeProjectId) {
    projectListEl.insertAdjacentHTML('beforeend', '<div class="proj-hint">双击工程切换会话</div>');
  }
}

// ── 聊天状态 ────────────────────────────────────────────────────
const state = { messages: [], loading: false, inputTokens: 0, outputTokens: 0, cleanupChunk: null };
const sessionAlwaysAllowed = new Set();
// 子 Agent 卡片 — taskId → { cardEl, timerInterval }
const agentCards = new Map();
// 输入历史
let inputHistory = [];
let inputHistoryIdx = -1;
let inputHistoryDraft = '';
const sidebar = { navStack: [], collapsed: false };
const slashMenu = { visible: false, selectedIdx: 0, filtered: [] };
let slashMenuEl = null;

// ── DOM 引用 ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const messagesEl          = $('messages');
const inputEl             = $('input');
const sendBtnEl           = $('send-btn');
const modelSelectEl       = $('model-select');
const newChatBtnEl        = $('new-chat-btn');
const statusBarEl         = $('status-bar');
const themeBtnEl          = $('theme-btn');
const settingsBtnEl       = $('settings-btn');
const sidebarToggleEl     = $('sidebar-toggle');
const sidebarEl           = $('sidebar');
const folderPathEl        = $('folder-path');
const fileTreeEl          = $('file-tree');
const filetreeRefreshEl   = $('filetree-refresh');
const projectListEl       = $('project-list');
const newProjectBtnEl     = $('new-project-btn');
const providerBadgeEl     = $('provider-badge');
const settingsOverlay     = $('settings-overlay');
const settingsProvidersEl = $('settings-providers');
const settingsMsgEl       = $('settings-msg');
const searchBarEl         = $('search-bar');
const searchInputEl       = $('search-input');
const searchCountEl       = $('search-count');
const tabBarEl            = $('tab-bar');
const mainEl              = $('main');

// ── 初始化 ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  applyTheme(currentTheme);
  initMarked();
  initTabBar();
  renderWelcome();
  renderProjectList();

  const cfg = await window.electronAPI.getConfig();
  homeDir = cfg.homeDir || '';
  configDir = cfg.configDir || '';
  if (cfg.activeModelRef) activeModelRef = cfg.activeModelRef;

  // Hide model selector — routing is now always through QueryEngine
  modelSelectEl.style.display = 'none';
  providerBadgeEl.style.display = 'none';

  const lastProjectId = localStorage.getItem('oc-last-project');
  const lastProj = lastProjectId ? projects.find(p => p.id === lastProjectId) : null;
  if (lastProj) {
    switchProject(lastProjectId);
  } else {
    updateInputState();
    loadExternalSkills(null);
  }

  updateStatusBar();

  window.electronAPI.onOpenSettings(() => openSettings());
  window.electronAPI.onNewChat(() => newChat());
  window.electronAPI.onNewProject(() => addProject());
  window.electronAPI.onConfigReset(() => {
    updateStatusBar({ warning: '配置已重置' });
    closeSettings();
  });
  window.electronAPI.onOpenProxy(() => openProxyPopup());
  window.electronAPI.onOpenSkills(() => openSkillsPopup());
  window.electronAPI.onCycleTheme(() => applyTheme(THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length]));
  window.electronAPI.onToolPermission(({ toolUseId, name, input, sessionKey, agentId, agentType }) => {
    if (sessionAlwaysAllowed.has(name)) {
      window.electronAPI.toolApprove({ sessionKey, toolUseId, allowed: true });
      return;
    }
    appendPermissionCard(name, input, toolUseId, sessionKey, agentId || null, agentType || null);
  });

  newChatBtnEl.addEventListener('click', newChat);
  settingsBtnEl.addEventListener('click', openSettings);
  themeBtnEl.addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length]);
  });
  sidebarToggleEl.addEventListener('click', () => {
    sidebar.collapsed = !sidebar.collapsed;
    sidebarEl.classList.toggle('collapsed', sidebar.collapsed);
    sidebarToggleEl.textContent = sidebar.collapsed ? '›' : '‹';
    sidebarToggleEl.title = sidebar.collapsed ? '展开侧栏' : '折叠侧栏';
  });
  newProjectBtnEl.addEventListener('click', addProject);
  filetreeRefreshEl.addEventListener('click', () => {
    if (sidebar.navStack.length) renderFileTree();
  });

  // slash menu container — sits between messages and input bar
  slashMenuEl = document.createElement('div');
  slashMenuEl.id = 'slash-menu';
  slashMenuEl.className = 'hidden';
  const inputBarEl = $('input-bar');
  inputBarEl.parentNode.insertBefore(slashMenuEl, inputBarEl);

  inputEl.addEventListener('keydown', e => {
    if (slashMenu.visible) {
      if (e.key === 'ArrowUp')   { e.preventDefault(); slashMenu.selectedIdx = (slashMenu.selectedIdx - 1 + slashMenu.filtered.length) % slashMenu.filtered.length; renderSlashMenu(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); slashMenu.selectedIdx = (slashMenu.selectedIdx + 1) % slashMenu.filtered.length; renderSlashMenu(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); selectSkill(slashMenu.filtered[slashMenu.selectedIdx]); return; }
      if (e.key === 'Escape') { e.preventDefault(); hideSlashMenu(); inputEl.value = ''; autoResize(); return; }
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && inputEl.value.indexOf('\n') === -1) {
      if (inputHistory.length === 0) return;
      e.preventDefault();
      if (inputHistoryIdx === -1) inputHistoryDraft = inputEl.value;
      inputHistoryIdx = Math.min(inputHistoryIdx + 1, inputHistory.length - 1);
      inputEl.value = inputHistory[inputHistoryIdx];
      autoResize(); checkSlashMenu();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      return;
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && inputHistoryIdx !== -1) {
      e.preventDefault();
      inputHistoryIdx--;
      inputEl.value = inputHistoryIdx === -1 ? inputHistoryDraft : inputHistory[inputHistoryIdx];
      autoResize(); checkSlashMenu();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  inputEl.addEventListener('input', () => { autoResize(); checkSlashMenu(); inputHistoryIdx = -1; });
  sendBtnEl.addEventListener('click', () => { if (state.loading) cancelChat(); else submit(); });

  document.addEventListener('keydown', async e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newChat(); }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); openSettings(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openSearch(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (activeTabId === CODE_TAB_ID) {
        const t = fileTabs.get(CODE_TAB_ID);
        const filePath = t?.pane.dataset.path;
        const textarea = t?.pane.querySelector('.code-edit-area');
        const statusEl = t?.pane.querySelector('.file-save-status');
        if (filePath && textarea && statusEl) {
          const tailOffset = parseInt(t.pane.dataset.tailOffset || '0', 10);
          let content = textarea.value;
          if (tailOffset > 0) {
            // 大文件：从磁盘读取未加载的尾部并拼接，保证文件完整
            const tail = await window.electronAPI.readFileRange(filePath, tailOffset, 512 * 1024 * 1024);
            content = content + (tail ?? '');
          }
          const ok = await window.electronAPI.writeFile(filePath, content);
          statusEl.textContent = ok ? '✓ 已保存' : '✗ 失败';
          setTimeout(() => { statusEl.textContent = ''; }, 1800);
        }
      }
    }
    if (e.key === 'Escape') {
      if (!settingsOverlay.classList.contains('hidden')) closeSettings();
      if (!searchBarEl.classList.contains('hidden')) closeSearch();
      closeProxyPopup();
      closeSkillsPopup();
    }
    if (e.ctrlKey && e.key === 'c' && state.loading) { e.preventDefault(); cancelChat(); }
  });

  document.addEventListener('click', e => {
    if (!$('proxy-popup').classList.contains('hidden') &&
        !$('proxy-popup').contains(e.target) && !$('proxy-btn').contains(e.target)) {
      closeProxyPopup();
    }
    if (!$('skills-popup').classList.contains('hidden') &&
        !$('skills-popup').contains(e.target) && !$('skills-btn').contains(e.target)) {
      closeSkillsPopup();
    }
  });

  $('settings-close').addEventListener('click',  closeSettings);
  $('settings-cancel').addEventListener('click', closeSettings);
  $('settings-save').addEventListener('click',   saveSettings);

  $('proxy-btn').addEventListener('click', openProxyPopup);
  $('proxy-enabled').addEventListener('change', () =>
    $('proxy-fields').classList.toggle('hidden', !$('proxy-enabled').checked));
  $('proxy-popup-close').addEventListener('click', closeProxyPopup);
  $('proxy-popup-save').addEventListener('click',  saveProxy);

  $('skills-btn').addEventListener('click', openSkillsPopup);
  $('skills-popup-close').addEventListener('click', closeSkillsPopup);
  $('skills-popup-save').addEventListener('click',  saveSkills);

  $('skills-dir-browse').addEventListener('click', async () => {
    const dir = await window.electronAPI.selectSkillsDir();
    if (dir) $('skills-extra-dir').value = dir;
  });
  $('skills-dir-clear').addEventListener('click', () => { $('skills-extra-dir').value = ''; });

  settingsOverlay.addEventListener('click', e => {
    if (e.target === settingsOverlay) closeSettings();
  });

  inputEl.focus();

  // ── 搜索栏事件 ────────────────────────────────────────────────
  let _searchDebounce = null;
  searchInputEl.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => runSearch(searchInputEl.value), 120);
  });
  searchInputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); activateSearchMatch(_searchIdx + 1); }
    if (e.key === 'Enter' && e.shiftKey)  { e.preventDefault(); activateSearchMatch(_searchIdx - 1); }
    if (e.key === 'Escape') closeSearch();
  });
  $('search-prev').addEventListener('click', () => activateSearchMatch(_searchIdx - 1));
  $('search-next').addEventListener('click', () => activateSearchMatch(_searchIdx + 1));
  $('search-close').addEventListener('click', closeSearch);

  // ── 输入框拖拽文件 ─────────────────────────────────────────────
  inputBarEl.addEventListener('dragover', e => {
    e.preventDefault();   // 必须无条件 preventDefault，否则 drop 事件不触发
    inputBarEl.classList.add('drag-over');
  });
  inputBarEl.addEventListener('dragleave', e => {
    if (!inputBarEl.contains(e.relatedTarget)) inputBarEl.classList.remove('drag-over');
  });
  inputBarEl.addEventListener('drop', e => {
    e.preventDefault();
    inputBarEl.classList.remove('drag-over');
    const files = [...e.dataTransfer.files];
    if (!files.length) return;
    // Electron 32+ 移除了 file.path，改用 webUtils.getPathForFile
    const paths = files.map(f => window.electronAPI.getPathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const text  = paths.join('\n');
    const start = inputEl.selectionStart;
    const before = inputEl.value.slice(0, start);
    const after  = inputEl.value.slice(inputEl.selectionEnd);
    const sep    = before && !before.endsWith('\n') ? '\n' : '';
    inputEl.value = before + sep + text + (after ? '\n' + after : '');
    inputEl.selectionStart = inputEl.selectionEnd = (before + sep + text).length;
    inputEl.focus();
    autoResize();
  });

  // ── 链接点击拦截：用系统浏览器打开，避免整页跳转 ────────────────
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    e.preventDefault();
    window.electronAPI.openExternal(href);
  });

  // ── 复制代码按钮（事件委托） ──────────────────────────────────
  messagesEl.addEventListener('click', e => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-wrapper')?.querySelector('code');
    if (!code) return;
    const text = code.textContent || '';
    const finish = (ok) => {
      btn.textContent = ok ? '✓' : '✗';
      btn.classList.toggle('copy-done', ok);
      setTimeout(() => { btn.textContent = '⎘'; btn.classList.remove('copy-done'); }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => finish(true)).catch(() => finish(false));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      finish(document.execCommand('copy'));
      document.body.removeChild(ta);
    }
  });
});

// ── 取消 ─────────────────────────────────────────────────────────
function cancelChat() {
  if (!state.loading) return;
  const sessionKey = activeProjectId || 'default';
  window.electronAPI.chatCancel(sessionKey);
  if (state.cleanupChunk)         { state.cleanupChunk();         state.cleanupChunk = null; }
  if (state.cleanupToolStart)     { state.cleanupToolStart();     state.cleanupToolStart = null; }
  if (state.cleanupToolEnd)       { state.cleanupToolEnd();       state.cleanupToolEnd = null; }
  if (state.cleanupThinkingStart) { state.cleanupThinkingStart(); state.cleanupThinkingStart = null; }
  if (state.cleanupThinkingEnd)   { state.cleanupThinkingEnd();   state.cleanupThinkingEnd = null; }
  if (state.cleanupApiRetry)      { state.cleanupApiRetry();      state.cleanupApiRetry = null; }
  if (state.cleanupCompact)       { state.cleanupCompact();       state.cleanupCompact = null; }
  if (state.cleanupAgentStart)    { state.cleanupAgentStart();    state.cleanupAgentStart = null; }
  if (state.cleanupAgentProgress) { state.cleanupAgentProgress(); state.cleanupAgentProgress = null; }
  if (state.cleanupAgentDone)     { state.cleanupAgentDone();     state.cleanupAgentDone = null; }
  clearAgentCards();
  state.loading = false;
  state.messages.pop();
  setSendBtnMode('send');
  updateStatusBar({ loading: false });
  inputEl.focus();
}

// ── 新对话 ───────────────────────────────────────────────────────
function newChat() {
  hideSlashMenu();
  sessionAlwaysAllowed.clear();
  const sessionKey = activeProjectId || 'default';
  window.electronAPI.chatNewSession(sessionKey);
  if (activeProjectId) {
    sessions.set(activeProjectId, { messages: [], inputTokens: 0, outputTokens: 0 });
    saveSession(activeProjectId);
    const s = getSession(activeProjectId);
    state.messages = s.messages;
    state.inputTokens = 0; state.outputTokens = 0;
  } else {
    state.messages = []; state.inputTokens = 0; state.outputTokens = 0;
  }
  messagesEl.innerHTML = '';
  renderWelcome();
  updateStatusBar();
  inputEl.focus();
}

// ── 提交 ─────────────────────────────────────────────────────────
async function submit() {
  if (state.loading) return;
  const rawInput = inputEl.value.trim();
  if (!rawInput) return;

  if (rawInput === '/clear') {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    newChat();
    return;
  }

  const proj = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;
  const cwd = proj?.path || null;

  let sendText = rawInput;
  const skillRef = rawInput.match(/^\/(\S+)([\s\S]*)$/);
  if (skillRef) {
    let skill = getAllSkills().find(s => s.name === skillRef[1] && !s.action && s.template !== undefined);
    if (!skill) {
      // Skills may not have finished loading yet — reload and retry once
      await loadExternalSkills(cwd);
      skill = getAllSkills().find(s => s.name === skillRef[1] && !s.action && s.template !== undefined);
    }
    if (skill) {
      const extra = skillRef[2].trim();
      const preamble = skill.source
        ? 'Execute ALL phases completely in a single response without stopping between phases. Do not wait for user input between phases.\n\n'
        : '';
      sendText = preamble + skill.template + (extra ? '\n' + extra : '');
    }
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  const welcome = $('welcome');
  if (welcome) welcome.remove();

  // Record input history
  if (rawInput && (inputHistory.length === 0 || inputHistory[0] !== rawInput)) {
    inputHistory.unshift(rawInput);
    if (inputHistory.length > 100) inputHistory.length = 100;
  }
  inputHistoryIdx = -1; inputHistoryDraft = '';

  state.messages.push({ role: 'user', content: rawInput });
  saveSession(activeProjectId);
  appendUserMsg(rawInput);
  state.loading = true;
  setSendBtnMode('stop');
  updateStatusBar({ loading: true });

  if (state.cleanupChunk) { state.cleanupChunk(); state.cleanupChunk = null; }
  if (state.cleanupToolStart) { state.cleanupToolStart(); state.cleanupToolStart = null; }
  if (state.cleanupToolEnd) { state.cleanupToolEnd(); state.cleanupToolEnd = null; }
  if (state.cleanupThinkingStart) { state.cleanupThinkingStart(); state.cleanupThinkingStart = null; }
  if (state.cleanupThinkingEnd)   { state.cleanupThinkingEnd();   state.cleanupThinkingEnd = null; }
  if (state.cleanupApiRetry)      { state.cleanupApiRetry();      state.cleanupApiRetry = null; }
  if (state.cleanupCompact)       { state.cleanupCompact();       state.cleanupCompact = null; }
  if (state.cleanupAgentStart)    { state.cleanupAgentStart();    state.cleanupAgentStart = null; }
  if (state.cleanupAgentProgress) { state.cleanupAgentProgress(); state.cleanupAgentProgress = null; }
  if (state.cleanupAgentDone)     { state.cleanupAgentDone();     state.cleanupAgentDone = null; }
  clearAgentCards();
  const assistantDiv = beginAssistantMsg();

  state.cleanupChunk = window.electronAPI.onChunk(({ text: chunk }) => appendChunk(assistantDiv, chunk));

  state.cleanupToolStart = window.electronAPI.onToolStart(({ name, input, toolUseId }) => {
    updateThinkingStatus(assistantDiv, name);
    addToolEntry(assistantDiv, name, input, toolUseId);
  });
  state.cleanupToolEnd = window.electronAPI.onToolEnd(({ toolUseId, output, isError }) => {
    completeToolEntry(assistantDiv, toolUseId, isError, output);
    updateThinkingStatus(assistantDiv, null);
  });

  state.cleanupThinkingStart = window.electronAPI.onThinkingStart(() => {
    const label = assistantDiv.querySelector('.thinking-label');
    if (label) label.textContent = ' 深度思考中';
  });
  state.cleanupThinkingEnd = window.electronAPI.onThinkingEnd(() => {
    updateThinkingStatus(assistantDiv, null);
  });
  state.cleanupApiRetry = window.electronAPI.onApiRetry(({ attempt, maxRetries, delayMs, errorStatus, errorDetail }) => {
    const waitStr = delayMs > 0 ? ` · 等待 ${(delayMs / 1000).toFixed(1)}s` : '';
    const statusStr = errorStatus ? ` [${errorStatus}]` : '';
    const msg = errorDetail ? errorDetail.slice(0, 120) : '';
    const detailStr = msg ? ` — ${msg}` : '';
    addSystemEntry(assistantDiv, '⟳', `API 重试 ${attempt}/${maxRetries}${waitStr}${statusStr}${detailStr}`);
  });
  state.cleanupCompact = window.electronAPI.onCompact(() => {
    addSystemEntry(assistantDiv, '◎', '压缩上下文');
  });

  // ── 子 Agent 事件 ───────────────────────────────────────────────
  state.cleanupAgentStart = window.electronAPI.onAgentStart(({ taskId, description }) => {
    const log = assistantDiv.querySelector('.tool-log');
    createAgentCard(log, taskId, description);
  });
  state.cleanupAgentProgress = window.electronAPI.onAgentProgress(({ taskId, activity, toolCount, tokenCount, durationMs, lastToolName, summary }) => {
    updateAgentCard(taskId, { activity, toolCount, tokenCount, durationMs, lastToolName, summary });
  });
  state.cleanupAgentDone = window.electronAPI.onAgentDone(({ taskId, status, summary, toolCount, tokenCount, durationMs }) => {
    finalizeAgentCard(taskId, { status, summary, toolCount, tokenCount, durationMs });
  });

  function cleanupAllListeners() {
    if (state.cleanupChunk)          { state.cleanupChunk();          state.cleanupChunk = null; }
    if (state.cleanupToolStart)      { state.cleanupToolStart();      state.cleanupToolStart = null; }
    if (state.cleanupToolEnd)        { state.cleanupToolEnd();        state.cleanupToolEnd = null; }
    if (state.cleanupThinkingStart)  { state.cleanupThinkingStart();  state.cleanupThinkingStart = null; }
    if (state.cleanupThinkingEnd)    { state.cleanupThinkingEnd();    state.cleanupThinkingEnd = null; }
    if (state.cleanupApiRetry)       { state.cleanupApiRetry();       state.cleanupApiRetry = null; }
    if (state.cleanupCompact)        { state.cleanupCompact();        state.cleanupCompact = null; }
    if (state.cleanupAgentStart)     { state.cleanupAgentStart();     state.cleanupAgentStart = null; }
    if (state.cleanupAgentProgress)  { state.cleanupAgentProgress();  state.cleanupAgentProgress = null; }
    if (state.cleanupAgentDone)      { state.cleanupAgentDone();      state.cleanupAgentDone = null; }
    clearAgentCards();
  }

  window.electronAPI.onDone(({ inputTokens, outputTokens }) => {
    finishAssistantMsg(assistantDiv);
    cleanupAllListeners();
    state.inputTokens  += inputTokens  || 0;
    state.outputTokens += outputTokens || 0;
    if (activeProjectId) {
      const s = sessions.get(activeProjectId);
      if (s) { s.inputTokens = state.inputTokens; s.outputTokens = state.outputTokens; }
    }
    state.messages.push({ role: 'assistant', content: assistantDiv.dataset.raw || '', providerId: activeModelRef?.split(':')[0] || null });
    saveSession(activeProjectId);
    state.loading = false;
    setSendBtnMode('send');
    updateStatusBar({ loading: false });
    inputEl.focus();
  });

  window.electronAPI.onError(({ message }) => {
    finishAssistantMsg(assistantDiv);
    cleanupAllListeners();
    appendErrorMsg(message);
    state.messages.pop();
    state.loading = false;
    setSendBtnMode('send');
    updateStatusBar({ loading: false, warning: '错误：' + message.split('\n')[0] });
    inputEl.focus();
  });

  const sessionKey = activeProjectId || 'default';

  await window.electronAPI.chatSend({ message: sendText, sessionKey, cwd, history: state.messages.slice(0, -1) });
}

// ── 设置弹窗 ─────────────────────────────────────────────────────
const PROVIDER_ICON_SVG = {
  anthropic:  `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/></svg>`,
  openai:     `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"/></svg>`,
  gemini:     `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>`,
  custom:     `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3" fill="currentColor"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12"/></svg>`,
};
const PROVIDER_ICON_COLOR = {
  anthropic:  '#D97757',
  openai:     '#10A37F',
  gemini:     '#4285F4',
  custom:     '#888888',
};

function providerMsgIconHtml(pid) {
  if (!pid) pid = activeModelRef?.split(':')[0];
  const svg = pid && PROVIDER_ICON_SVG[pid];
  const color = pid && PROVIDER_ICON_COLOR[pid];
  if (svg && color) return `<div class="msg-icon" style="color:${color}">${svg}</div>`;
  return `<div class="msg-icon">◆</div>`;
}
async function openSettings() {
  const fullCfg = await window.electronAPI.getFullConfig();
  providerDefs   = fullCfg.PROVIDER_DEFS   || {};
  providerModels = fullCfg.PROVIDER_MODELS || {};
  if (fullCfg.activeModelRef) activeModelRef = fullCfg.activeModelRef;

  settingsDraft = JSON.parse(JSON.stringify(fullCfg.providers || {}));
  // Ensure new fields exist on each model entry
  for (const [, prov] of Object.entries(settingsDraft)) {
    for (const m of (prov.models || [])) {
      if (m.apiKey  === undefined) m.apiKey  = '';
      if (m.baseUrl === undefined) m.baseUrl = '';
      if (!m.name) m.name = m.alias || '';
    }
  }

  renderSettingsDraft();

  settingsMsgEl.textContent = '';
  settingsOverlay.classList.remove('hidden');
}

function closeSettings() {
  settingsOverlay.classList.add('hidden');
}

function renderSettingsDraft() {
  settingsProvidersEl.innerHTML = '';

  const configuredIds = Object.keys(settingsDraft);

  if (!configuredIds.length) {
    const ph = document.createElement('div');
    ph.className = 'prov-none';
    ph.textContent = '尚未配置任何提供商，请点击下方"添加提供商"';
    settingsProvidersEl.appendChild(ph);
  } else {
    configuredIds.forEach(id => renderProviderBlock(id));
  }

  renderAddProviderSection(configuredIds);
}

function renderProviderBlock(id) {
  const prov = settingsDraft[id] || {};
  const def  = providerDefs[id] || { name: id, baseUrl: '', envKeys: [], defaultModel: '' };

  const block = document.createElement('div');
  block.className = 'provider-block open';
  block.dataset.provider = id;

  // ─ Header
  const header = document.createElement('div');
  header.className = 'provider-block-header';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'provider-block-title';

  const iconEl = document.createElement('span');
  iconEl.className = 'prov-icon';
  iconEl.style.color = PROVIDER_ICON_COLOR[id] || '#888';
  iconEl.innerHTML = PROVIDER_ICON_SVG[id] || PROVIDER_ICON_SVG.custom;

  titleSpan.appendChild(iconEl);
  titleSpan.appendChild(document.createTextNode(def.name || id));

  const rightDiv = document.createElement('div');
  rightDiv.style.cssText = 'display:flex;align-items:center;gap:6px;flex-shrink:0';

  const countSpan = document.createElement('span');
  countSpan.className = 'prov-model-count';

  // 判断此提供商是否正在使用（activeModelRef 以 'id:' 开头）
  const isProvActive = () => !!(activeModelRef && activeModelRef.startsWith(id + ':'));

  const activeBadge = document.createElement('span');
  activeBadge.className = 'model-in-use-badge';
  activeBadge.textContent = '使用中';
  activeBadge.style.display = isProvActive() ? '' : 'none';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'prov-remove-btn';
  removeBtn.textContent = '× 移除';
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!confirm(`确认移除提供商 "${def.name || id}"？`)) return;
    delete settingsDraft[id];
    renderSettingsDraft();
  });

  const chevron = document.createElement('span');
  chevron.className = 'provider-block-chevron';
  chevron.textContent = '›';

  rightDiv.appendChild(activeBadge);
  rightDiv.appendChild(countSpan);
  rightDiv.appendChild(removeBtn);
  rightDiv.appendChild(chevron);
  header.appendChild(titleSpan);
  header.appendChild(rightDiv);
  header.addEventListener('click', e => {
    if (removeBtn.contains(e.target)) return;
    block.classList.toggle('open');
  });

  // ─ Body
  const body = document.createElement('div');
  body.className = 'provider-block-body';

  const miniDivider = document.createElement('div');
  miniDivider.className = 'settings-mini-divider';
  body.appendChild(miniDivider);

  const sectionLabel = document.createElement('div');
  sectionLabel.className = 'models-section-label';
  sectionLabel.textContent = '模型列表';
  body.appendChild(sectionLabel);

  // Datalist for model name autocomplete
  const datalist = document.createElement('datalist');
  datalist.id = `dl-${id}`;
  (providerModels[id] || []).forEach(m => {
    const o = document.createElement('option'); o.value = m; datalist.appendChild(o);
  });
  body.appendChild(datalist);

  const configsContainer = document.createElement('div');
  configsContainer.className = 'prov-configs';
  body.appendChild(configsContainer);

  const addCfgBtn = document.createElement('button');
  addCfgBtn.className = 'add-model-btn';
  addCfgBtn.textContent = '＋ 添加模型';
  addCfgBtn.addEventListener('click', async () => {
    if (!settingsDraft[id]) settingsDraft[id] = { models: [] };
    if (!settingsDraft[id].models) settingsDraft[id].models = [];
    const isFirst = settingsDraft[id].models.length === 0;
    const name    = genAlias(id, getDraftNames());
    const modelId = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
    settingsDraft[id].models.push({ id: modelId, name, model: def.defaultModel || '', apiKey: '', baseUrl: '' });
    // Auto-activate the first model added to a provider when nothing is active
    if (isFirst && !activeModelRef) {
      activeModelRef = `${id}:${modelId}`;
      await window.electronAPI.setActiveModel(activeModelRef);
    }
    renderConfigs();
  });
  body.appendChild(addCfgBtn);

  block.appendChild(header);
  block.appendChild(body);
  settingsProvidersEl.appendChild(block);

  function renderConfigs() {
    configsContainer.innerHTML = '';
    const ms = settingsDraft[id]?.models || [];
    countSpan.textContent = `${ms.length} 个模型`;

    ms.forEach(m => {
      const entry = document.createElement('div');
      entry.className = 'config-entry';
      entry.dataset.configId = m.id;

      const isModelActive = activeModelRef === `${id}:${m.id}`;

      // Row 1: name + model + active-status + delete
      const row1 = document.createElement('div');
      row1.className = 'config-entry-header';

      const nameInp = document.createElement('input');
      nameInp.type = 'text'; nameInp.className = 'form-input config-name-input';
      nameInp.placeholder = '名称'; nameInp.value = m.name || '';
      nameInp.title = '显示名称（出现在模型下拉菜单中）';
      nameInp.addEventListener('input', () => {
        const e = settingsDraft[id]?.models?.find(x => x.id === m.id);
        if (e) e.name = nameInp.value;
      });

      const modelInp = document.createElement('input');
      modelInp.type = 'text'; modelInp.className = 'form-input config-model-input';
      modelInp.placeholder = def.defaultModel || '模型名称';
      modelInp.value = m.model || '';
      modelInp.setAttribute('list', `dl-${id}`);
      modelInp.addEventListener('input', () => {
        const e = settingsDraft[id]?.models?.find(x => x.id === m.id);
        if (e) e.model = modelInp.value.trim();
      });

      // Per-model active badge or switch button
      if (isModelActive) {
        const chip = document.createElement('span');
        chip.className = 'model-active-chip';
        chip.textContent = '使用中';
        row1.appendChild(nameInp);
        row1.appendChild(modelInp);
        row1.appendChild(chip);
      } else {
        const mSwitch = document.createElement('button');
        mSwitch.className = 'btn-ghost btn-sm model-row-switch-btn';
        mSwitch.textContent = '切换';
        mSwitch.title = '切换为此模型';
        mSwitch.addEventListener('click', async e => {
          e.stopPropagation();
          activeModelRef = `${id}:${m.id}`;
          await window.electronAPI.setActiveModel(activeModelRef);
          window.electronAPI.chatNewSession(activeProjectId || 'default');
          renderSettingsDraft();
        });
        row1.appendChild(nameInp);
        row1.appendChild(modelInp);
        row1.appendChild(mSwitch);
      }

      const delBtn = document.createElement('button');
      delBtn.className = 'model-del-btn'; delBtn.textContent = '×'; delBtn.title = '删除此配置';
      delBtn.addEventListener('click', () => {
        if (!settingsDraft[id]) return;
        settingsDraft[id].models = settingsDraft[id].models.filter(x => x.id !== m.id);
        renderConfigs();
      });
      row1.appendChild(delBtn);
      entry.appendChild(row1);

      // Row 2: API Key
      const row2 = document.createElement('div');
      row2.className = 'form-row config-key-row';
      const keyWrap = document.createElement('div');
      keyWrap.className = 'apikey-wrap';
      const keyInp = document.createElement('input');
      keyInp.type = 'password'; keyInp.className = 'form-input';
      keyInp.placeholder = def.envKeys?.[0] || 'API Key';
      keyInp.value = m.apiKey || '';
      keyInp.addEventListener('input', () => {
        const e = settingsDraft[id]?.models?.find(x => x.id === m.id);
        if (e) e.apiKey = keyInp.value.trim();
      });
      const keyToggle = document.createElement('button');
      keyToggle.className = 'key-toggle'; keyToggle.textContent = '显示';
      keyToggle.addEventListener('click', () => {
        const show = keyInp.type === 'password';
        keyInp.type = show ? 'text' : 'password';
        keyToggle.textContent = show ? '隐藏' : '显示';
      });
      keyWrap.appendChild(keyInp); keyWrap.appendChild(keyToggle);
      row2.appendChild(keyWrap);
      entry.appendChild(row2);

      // Row 3: Base URL
      const row3 = document.createElement('div');
      row3.className = 'form-row config-url-row';
      const urlInp = document.createElement('input');
      urlInp.type = 'text'; urlInp.className = 'form-input';
      urlInp.placeholder = def.baseUrl || '留空使用默认地址';
      urlInp.value = m.baseUrl || '';
      urlInp.addEventListener('input', () => {
        const e = settingsDraft[id]?.models?.find(x => x.id === m.id);
        if (e) e.baseUrl = urlInp.value.trim();
      });
      row3.appendChild(urlInp);
      entry.appendChild(row3);

      configsContainer.appendChild(entry);
    });
  }

  renderConfigs();
}

function renderAddProviderSection(configuredIds) {
  const unconfigured = Object.keys(providerDefs).filter(id => !configuredIds.includes(id));

  const divider = document.createElement('div');
  divider.className = 'settings-divider';
  settingsProvidersEl.appendChild(divider);

  const section = document.createElement('div');
  section.className = 'add-provider-section';

  const hdr = document.createElement('div');
  hdr.className = 'add-prov-header';
  const hdrLabel = document.createElement('span');
  hdrLabel.className = 'settings-label-sm';
  hdrLabel.textContent = '添加提供商';
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn-ghost btn-sm';
  toggleBtn.textContent = '＋ 添加';
  hdr.appendChild(hdrLabel); hdr.appendChild(toggleBtn);
  section.appendChild(hdr);

  const form = document.createElement('div');
  form.className = 'add-prov-form hidden';

  if (!unconfigured.length) {
    form.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:6px 0">所有提供商均已添加，可在对应区块内添加更多配置</div>';
    toggleBtn.addEventListener('click', () => form.classList.toggle('hidden'));
    section.appendChild(form);
    settingsProvidersEl.appendChild(section);
    return;
  }

  const selRow = document.createElement('div');
  selRow.className = 'form-row';
  selRow.innerHTML = '<span class="form-label">提供商</span>';
  const provSel = document.createElement('select');
  provSel.className = 'form-input'; provSel.style.cursor = 'pointer';
  unconfigured.forEach(id => {
    const o = document.createElement('option');
    o.value = id; o.textContent = providerDefs[id]?.name || id;
    provSel.appendChild(o);
  });
  selRow.appendChild(provSel);
  form.appendChild(selRow);

  const keyRow = document.createElement('div');
  keyRow.className = 'form-row';
  keyRow.innerHTML = '<span class="form-label">API Key</span>';
  const keyWrap = document.createElement('div');
  keyWrap.className = 'apikey-wrap';
  const keyInp = document.createElement('input');
  keyInp.type = 'password'; keyInp.className = 'form-input'; keyInp.placeholder = 'API Key';
  const keyToggle = document.createElement('button');
  keyToggle.className = 'key-toggle'; keyToggle.textContent = '显示';
  keyToggle.addEventListener('click', () => {
    const show = keyInp.type === 'password';
    keyInp.type = show ? 'text' : 'password';
    keyToggle.textContent = show ? '隐藏' : '显示';
  });
  keyWrap.appendChild(keyInp); keyWrap.appendChild(keyToggle);
  keyRow.appendChild(keyWrap);
  form.appendChild(keyRow);

  const urlRow = document.createElement('div');
  urlRow.className = 'form-row';
  urlRow.innerHTML = '<span class="form-label">API 地址</span>';
  const urlInp = document.createElement('input');
  urlInp.type = 'text'; urlInp.className = 'form-input';
  urlInp.placeholder = '留空使用默认地址';
  urlRow.appendChild(urlInp);
  form.appendChild(urlRow);

  const modelRow = document.createElement('div');
  modelRow.className = 'form-row';
  modelRow.innerHTML = '<span class="form-label">模型名称</span>';
  const modelInp = document.createElement('input');
  modelInp.type = 'text'; modelInp.className = 'form-input';
  modelInp.placeholder = '留空使用默认模型';
  modelRow.appendChild(modelInp);
  form.appendChild(modelRow);

  function updateAddProvFormPlaceholders() {
    const d = providerDefs[provSel.value] || {};
    urlInp.placeholder = d.baseUrl || '留空使用默认地址';
    modelInp.placeholder = d.defaultModel || '留空使用默认模型';
  }
  provSel.addEventListener('change', updateAddProvFormPlaceholders);
  updateAddProvFormPlaceholders();

  const btnRow = document.createElement('div');
  btnRow.className = 'form-row';
  btnRow.innerHTML = '<span class="form-label"></span>';
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'btn-primary btn-sm'; confirmBtn.textContent = '确认添加';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-ghost btn-sm'; cancelBtn.style.marginLeft = '6px';
  cancelBtn.textContent = '取消';
  btnRow.appendChild(confirmBtn); btnRow.appendChild(cancelBtn);
  form.appendChild(btnRow);

  toggleBtn.addEventListener('click', () => form.classList.toggle('hidden'));
  cancelBtn.addEventListener('click', () => form.classList.add('hidden'));

  confirmBtn.addEventListener('click', () => {
    const provId  = provSel.value;
    const apiKey  = keyInp.value.trim();
    if (!apiKey && provId !== 'custom') { keyInp.focus(); return; }

    const def     = providerDefs[provId] || {};
    const baseUrl = urlInp.value.trim();
    const model   = modelInp.value.trim() || def.defaultModel || '';
    const name    = genAlias(provId, getDraftNames());
    const modelId = 'm' + Date.now().toString(36);
    settingsDraft[provId] = {
      apiKey,
      baseUrl,
      models: [{ id: modelId, name, model, apiKey, baseUrl }],
    };
    renderSettingsDraft();
  });

  section.appendChild(form);
  settingsProvidersEl.appendChild(section);
}

async function saveSettings() {
  // Collect latest DOM values
  settingsProvidersEl.querySelectorAll('.provider-block').forEach(block => {
    const id = block.dataset.provider;
    if (!settingsDraft[id]) return;

    const newModels = [];
    block.querySelectorAll('.config-entry').forEach(entry => {
      const configId = entry.dataset.configId;
      if (!configId) return;
      const name   = entry.querySelector('.config-name-input')?.value  ?? '';
      const model  = entry.querySelector('.config-model-input')?.value.trim() ?? '';
      const apiKey = entry.querySelector('.config-key-row input')?.value.trim()  ?? '';
      const baseUrl = entry.querySelector('.config-url-row input')?.value.trim() ?? '';
      newModels.push({ id: configId, name: name.trim(), model, apiKey, baseUrl });
    });
    settingsDraft[id].models = newModels;
  });

  // Auto-generate missing names
  const usedNames = [];
  for (const [, prov] of Object.entries(settingsDraft)) {
    for (const m of (prov.models || [])) { if (m.name) usedNames.push(m.name); }
  }
  for (const [id, prov] of Object.entries(settingsDraft)) {
    for (const m of (prov.models || [])) {
      if (!m.name) { m.name = genAlias(id, usedNames); usedNames.push(m.name); }
    }
  }

  // Remove empty providers
  for (const id of Object.keys(settingsDraft)) {
    if (!(settingsDraft[id].models?.length)) delete settingsDraft[id];
  }

  // Auto-assign activeModelRef when it's absent or points to a removed model
  const validRefs = Object.entries(settingsDraft).flatMap(([pid, prov]) =>
    (prov.models || []).map(m => `${pid}:${m.id}`)
  );
  if (validRefs.length > 0 && !validRefs.includes(activeModelRef)) {
    activeModelRef = validRefs[0];
  }

  const result = await window.electronAPI.saveProviderSettings({
    providers: settingsDraft,
    activeModelRef: activeModelRef,
  });

  if (result?.ok) {
    const prevRef = activeModelRef;
    populateModelSelect(result.allModels || [], result.activeModelRef);
    // If active provider changed, reset backend session
    if (prevRef?.split(':')[0] !== activeModelRef?.split(':')[0]) {
      window.electronAPI.chatNewSession(activeProjectId || 'default');
    }
    updateStatusBar();
    settingsMsgEl.textContent = '✓ 已保存';
    setTimeout(closeSettings, 800);
  }
}

// ── 代理弹出面板 ─────────────────────────────────────────────────
function positionPopup(popupEl, btnEl) {
  const rect = btnEl.getBoundingClientRect();
  popupEl.style.top  = (rect.bottom + 6) + 'px';
  popupEl.style.right = Math.max(8, window.innerWidth - rect.right) + 'px';
  popupEl.style.left  = 'auto';
}

async function openProxyPopup() {
  closeSkillsPopup();
  const popup = $('proxy-popup');
  if (!popup.classList.contains('hidden')) { closeProxyPopup(); return; }
  const fullCfg = await window.electronAPI.getFullConfig();
  const proxy = fullCfg.proxy || {};
  $('proxy-enabled').checked = !!proxy.enabled;
  $('proxy-url').value    = proxy.url    || '';
  $('proxy-bypass').value = proxy.bypass || '';
  $('proxy-fields').classList.toggle('hidden', !proxy.enabled);
  $('proxy-popup-msg').textContent = '';
  positionPopup(popup, $('proxy-btn'));
  popup.classList.remove('hidden');
  $('proxy-btn').classList.add('active');
}
function closeProxyPopup() {
  $('proxy-popup').classList.add('hidden');
  $('proxy-btn').classList.remove('active');
}
async function saveProxy() {
  const proxy = {
    enabled: !!$('proxy-enabled').checked,
    url:     $('proxy-url').value.trim(),
    bypass:  $('proxy-bypass').value.trim(),
  };
  const result = await window.electronAPI.saveProviderSettings({ proxy });
  if (result?.ok) {
    $('proxy-popup-msg').textContent = '✓ 已保存';
    setTimeout(() => { $('proxy-popup-msg').textContent = ''; closeProxyPopup(); }, 800);
  }
}

// ── Skill 目录弹出面板 ────────────────────────────────────────────
function openSkillsPopup() {
  closeProxyPopup();
  const popup = $('skills-popup');
  if (!popup.classList.contains('hidden')) { closeSkillsPopup(); return; }
  $('skills-extra-dir').value = localStorage.getItem('oc-skills-extra-dir') || '';
  $('skills-popup-msg').textContent = '';
  // Update tip to show actual config dir path
  const tipEl = popup.querySelector('.proxy-tip');
  if (tipEl && configDir) {
    const skillsDir = configDir.replace(/\\/g, '/') + '/skills/';
    tipEl.textContent = `默认扫描 ${skillsDir} 及项目 .claude/skills/，此处可追加一个额外目录。`;
  }
  positionPopup(popup, $('skills-btn'));
  popup.classList.remove('hidden');
  $('skills-btn').classList.add('active');
}
function closeSkillsPopup() {
  $('skills-popup').classList.add('hidden');
  $('skills-btn').classList.remove('active');
}
function saveSkills() {
  const val = $('skills-extra-dir').value.trim();
  if (val) localStorage.setItem('oc-skills-extra-dir', val);
  else localStorage.removeItem('oc-skills-extra-dir');
  $('skills-popup-msg').textContent = '✓ 已保存';
  setTimeout(() => { $('skills-popup-msg').textContent = ''; closeSkillsPopup(); }, 800);
}



// ── 文件树 ───────────────────────────────────────────────────────
async function renderFileTree() {
  if (!sidebar.navStack.length) {
    folderPathEl.textContent = '未选择'; folderPathEl.title = '';
    fileTreeEl.innerHTML = ''; return;
  }
  const cur = sidebar.navStack[sidebar.navStack.length - 1];
  folderPathEl.textContent = shortenPath(cur);
  folderPathEl.title = cur;

  const entries = await window.electronAPI.readDir(cur);
  fileTreeEl.innerHTML = '';

  if (sidebar.navStack.length > 1) {
    const up = document.createElement('div');
    up.className = 'tree-entry up';
    up.innerHTML = '<span class="icon">↩</span><span class="name">..</span>';
    up.addEventListener('click', () => { sidebar.navStack.pop(); renderFileTree(); });
    fileTreeEl.appendChild(up);
  }
  entries.forEach(({ name, isDir }) => {
    const el = document.createElement('div');
    el.className = 'tree-entry' + (isDir ? ' folder' : '');
    el.innerHTML = `<span class="icon">${isDir ? '📁' : '📄'}</span>`
      + `<span class="name" title="${escHtml(name)}">${escHtml(name)}</span>`;
    if (isDir) {
      el.addEventListener('click', () => {
        const sep = cur.includes('\\') ? '\\' : '/';
        sidebar.navStack.push(cur + sep + name);
        renderFileTree();
      });
    } else {
      el.addEventListener('dblclick', () => {
        const sep = cur.includes('\\') ? '\\' : '/';
        openFileTab(cur + sep + name);
      });
    }
    fileTreeEl.appendChild(el);
  });
}

// ── 会话消息渲染 ─────────────────────────────────────────────────
function renderSessionMessages() {
  messagesEl.innerHTML = '';
  if (!state.messages.length) { renderWelcome(); return; }
  state.messages.forEach(msg => {
    if (msg.role === 'user') {
      appendUserMsg(msg.content);
    } else {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.dataset.raw = msg.content;
      div.innerHTML = `${providerMsgIconHtml(msg.providerId)}<div class="msg-body"><div class="md-content">${renderContent(msg.content)}</div></div>`;
      messagesEl.appendChild(div);
    }
  });
  scrollBottom();
}

// ── 渲染辅助 ─────────────────────────────────────────────────────
function renderWelcome() {
  const proj = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;
  messagesEl.innerHTML = `
    <div id="welcome">
      <div class="welcome-icon"><svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4Z"/></svg></div>
      <h2>openclaude chat</h2>
      <p>${proj
        ? `当前工程：<strong style="color:var(--accent)">${escHtml(proj.name)}</strong><br>开始输入，或双击左侧工程切换会话。`
        : '左侧点击 ＋ 新建工程，<br>或双击已有工程切换会话。'
      }</p>
    </div>`;
}

function showNoApiKey() {
  const el = document.createElement('div');
  el.id = 'no-key-msg';
  el.textContent = '⚠  未配置任何模型。\n请通过顶部 ⚙ 按钮添加提供商和模型。';
  messagesEl.appendChild(el);
}

function appendUserMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg user';
  div.innerHTML = `<div class="msg-icon">❯</div><div class="msg-body">${escHtml(text)}</div>`;
  messagesEl.appendChild(div);
  scrollBottom();
}

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
const DRIP_NORMAL = 5;   // chars per rAF frame at normal speed
const DRIP_FAST   = 60;  // chars per frame when queue > 120 (catch-up)
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

function beginAssistantMsg() {
  const div = document.createElement('div');
  div.className = 'msg assistant'; div.dataset.raw = '';
  div._startTime = Date.now(); div._charCount = 0; div._spinFrame = 0;
  div.innerHTML = `${providerMsgIconHtml()}<div class="msg-body"><div class="tool-log"></div><span class="thinking-bar"><span class="thinking-spinner">⠋</span><span class="thinking-label"> 思考中</span><span class="thinking-timer"> · 0.0s</span></span></div>`;
  div._timerInterval = setInterval(() => {
    const sp = div.querySelector('.thinking-spinner');
    const tm = div.querySelector('.thinking-timer');
    if (sp) sp.textContent = SPINNER_FRAMES[div._spinFrame++ % SPINNER_FRAMES.length];
    if (tm) tm.textContent = ' · ' + ((Date.now() - div._startTime) / 1000).toFixed(1) + 's';
  }, 100);
  messagesEl.appendChild(div);
  scrollBottom();
  return div;
}

const TOOL_ICONS = {
  Read: '📄', Write: '✏️', Edit: '✏️', Glob: '🔍', Grep: '🔍',
  Bash: '⚡', Agent: '🤖', NotebookRead: '📓', NotebookEdit: '📓',
  TodoRead: '📋', TodoWrite: '📋', TaskCreate: '📋', TaskUpdate: '📋', TaskList: '📋', TaskGet: '📋',
  WebFetch: '🌐', WebSearch: '🌐', Skill: '🎯', AskUserQuestion: '❓',
};
const TOOL_LABELS = {
  Read: '读取文件', Write: '写入文件', Edit: '编辑文件',
  Glob: '搜索文件', Grep: '搜索内容', Bash: '执行命令',
  Agent: '子 Agent', NotebookRead: '读取 Notebook', NotebookEdit: '编辑 Notebook',
  TodoRead: '读取任务', TodoWrite: '更新任务', WebFetch: '网络请求', WebSearch: '网络搜索',
  Skill: '执行 Skill', AskUserQuestion: '询问用户',
};
function getToolSummary(name, inputJson) {
  try {
    const inp = typeof inputJson === 'string' ? JSON.parse(inputJson) : (inputJson || {});
    if (name === 'Read') return inp.file_path || '';
    if (name === 'Write' || name === 'Edit') return inp.file_path || '';
    if (name === 'Glob') return inp.pattern || '';
    if (name === 'Grep') return inp.pattern || '';
    if (name === 'Bash') return (inp.command || '').slice(0, 60);
    if (name === 'Agent') return (inp.prompt || inp.description || inp.message || '').slice(0, 70);
    if (name === 'WebFetch') return inp.url || '';
    if (name === 'WebSearch') return inp.query || '';
    if (name === 'Skill') return inp.skill || inp.name || '';
    const first = Object.values(inp).find(v => typeof v === 'string');
    return first ? first.slice(0, 50) : '';
  } catch { return ''; }
}

function updateThinkingStatus(div, toolName) {
  const label = div.querySelector('.thinking-label');
  if (!label) return;
  if (toolName === null) {
    label.textContent = div._streaming ? ' 生成中' : ' 思考中';
  } else if (toolName === 'Agent') {
    label.textContent = ' 调用子 Agent';
  } else {
    label.textContent = ` 调用 ${TOOL_LABELS[toolName] || toolName}`;
  }
}

function addToolEntry(div, name, inputJson, toolUseId) {
  const log = div.querySelector('.tool-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'tool-entry running';
  entry.dataset.toolUseId = toolUseId;
  entry._startTime = Date.now();
  const icon = TOOL_ICONS[name] || '⚙';
  const label = TOOL_LABELS[name] || name;
  const summary = getToolSummary(name, inputJson);
  entry.innerHTML = `<span class="te-icon">${icon}</span><span class="te-name">${escHtml(label)}</span>${summary ? `<span class="te-summary">${escHtml(summary)}</span>` : ''}<span class="te-time"></span>`;
  log.appendChild(entry);
  scrollIfNearBottom();
}

function completeToolEntry(div, toolUseId, isError, output) {
  const entry = div.querySelector(`.tool-entry[data-tool-use-id="${toolUseId}"]`);
  if (!entry) return;
  entry.classList.remove('running');
  entry.classList.add(isError ? 'error' : 'done');
  const icon = entry.querySelector('.te-icon');
  if (icon) icon.textContent = isError ? '✗' : '✓';
  const elapsed = ((Date.now() - entry._startTime) / 1000).toFixed(2);
  const time = entry.querySelector('.te-time');
  if (time) time.textContent = elapsed + 's';
  if (isError && output) {
    const errEl = document.createElement('div');
    errEl.className = 'te-error-output';
    errEl.textContent = output.slice(0, 300);
    entry.appendChild(errEl);
  }
}

function addSystemEntry(div, icon, text) {
  const log = div.querySelector('.tool-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'tool-entry system';
  entry.innerHTML = `<span class="te-icon">${icon}</span><span class="te-name">${escHtml(text)}</span>`;
  log.appendChild(entry);
  scrollIfNearBottom();
}

// ── 子 Agent 卡片 ─────────────────────────────────────────────────

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0);
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
}

const AGENT_TOOL_ICONS = {
  Read: '📖', Write: '✏', Edit: '✏', Bash: '⌨', Grep: '🔍',
  Glob: '🔍', Agent: '◈', Task: '◈', TodoRead: '📋', TodoWrite: '📋',
};

function createAgentCard(toolLog, taskId, description) {
  if (!toolLog) return;
  const card = document.createElement('div');
  card.className = 'agent-card';
  card.dataset.taskId = taskId;
  card.dataset.description = description || '';
  card.innerHTML = `
    <div class="ac-header">
      <span class="ac-icon">◈</span>
      <span class="ac-desc">${escHtml(description || '子 Agent')}</span>
      <span class="ac-badge">运行中</span>
      <span class="ac-timer">0:00</span>
    </div>
    <div class="ac-activity">初始化中…</div>
    <div class="ac-stats">— 工具 · — tokens</div>
  `;
  toolLog.appendChild(card);
  scrollIfNearBottom();

  const startMs = Date.now();
  const timerEl = card.querySelector('.ac-timer');
  const interval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
  }, 1000);

  agentCards.set(taskId, { cardEl: card, timerInterval: interval, startMs });
}

function updateAgentCard(taskId, { activity, toolCount, tokenCount, lastToolName, summary }) {
  const entry = agentCards.get(taskId);
  if (!entry) return;
  const { cardEl } = entry;
  const activityEl = cardEl.querySelector('.ac-activity');
  const statsEl    = cardEl.querySelector('.ac-stats');
  if (activityEl) {
    const icon = AGENT_TOOL_ICONS[lastToolName] || '⚙';
    const text = activity || summary || '处理中…';
    activityEl.textContent = `${icon} ${text}`;
  }
  if (statsEl) {
    statsEl.textContent = `${toolCount || 0} 工具 · ${fmtTokens(tokenCount)} tokens`;
  }
}

function finalizeAgentCard(taskId, { status, summary, toolCount, tokenCount, durationMs }) {
  const entry = agentCards.get(taskId);
  if (!entry) return;
  const { cardEl, timerInterval, startMs } = entry;
  clearInterval(timerInterval);
  agentCards.delete(taskId);

  cardEl.dataset.status = status;
  const iconEl     = cardEl.querySelector('.ac-icon');
  const badgeEl    = cardEl.querySelector('.ac-badge');
  const timerEl    = cardEl.querySelector('.ac-timer');
  const activityEl = cardEl.querySelector('.ac-activity');
  const statsEl    = cardEl.querySelector('.ac-stats');

  const elapsed = durationMs || (Date.now() - startMs);
  if (timerEl) timerEl.textContent = fmtDuration(elapsed);

  const icons   = { completed: '✓', failed: '✗', stopped: '■' };
  const labels  = { completed: '完成', failed: '失败', stopped: '已停止' };
  if (iconEl)  iconEl.textContent  = icons[status]  || '■';
  if (badgeEl) { badgeEl.textContent = labels[status] || status; badgeEl.className = `ac-badge ${status}`; }
  if (activityEl && summary) activityEl.textContent = summary;
  if (statsEl) {
    const dur = fmtDuration(elapsed);
    statsEl.textContent = `${toolCount || 0} 工具 · ${fmtTokens(tokenCount)} tokens${dur ? ` · ${dur}` : ''}`;
  }
}

function clearAgentCards() {
  for (const { timerInterval } of agentCards.values()) clearInterval(timerInterval);
  agentCards.clear();
}

function appendChunk(div, chunk) {
  div.dataset.raw += chunk;
  div._charCount = (div._charCount || 0) + chunk.length;
  if (!div._queue) div._queue = '';
  div._queue += chunk;
  if (!div._dripping) startDrip(div);
}

function startDrip(div) {
  div._dripping = true;
  function tick() {
    if (!div._queue || div._queue.length === 0) { div._dripping = false; return; }
    const amount = div._queue.length > 120 ? DRIP_FAST : DRIP_NORMAL;
    if (!div._displayed) div._displayed = '';
    div._displayed += div._queue.slice(0, amount);
    div._queue    = div._queue.slice(amount);
    const body = div.querySelector('.msg-body');
    if (body) {
      const tb = body.querySelector('.thinking-bar');
      // On first text chunk: mark as streaming, update label — keep thinking-bar in DOM
      if (tb && !div._streaming) {
        div._streaming = true;
        const label = tb.querySelector('.thinking-label');
        if (label) label.textContent = ' 生成中';
      }
      // Create text-stream area before thinking-bar so layout is:
      // .tool-log → .text-stream → .thinking-bar
      let textArea = body.querySelector('.text-stream');
      if (!textArea) {
        textArea = document.createElement('div');
        textArea.className = 'text-stream';
        if (tb) body.insertBefore(textArea, tb);
        else body.appendChild(textArea);
      }
      textArea.innerHTML = renderContent(div._displayed) + `<span class="cursor"></span>`;
      scrollIfNearBottom();
    }
    if (div._queue && div._queue.length > 0) requestAnimationFrame(tick);
    else div._dripping = false;
  }
  requestAnimationFrame(tick);
}

function finishAssistantMsg(div) {
  if (div._timerInterval) { clearInterval(div._timerInterval); div._timerInterval = null; }
  div._dripping = false;
  div._queue = '';
  const body = div.querySelector('.msg-body');
  const toolLog = body.querySelector('.tool-log');
  const toolLogHtml = (toolLog && toolLog.children.length > 0) ? toolLog.outerHTML : '';
  body.innerHTML = toolLogHtml + '<div class="md-content">' + renderContent(div.dataset.raw) + '</div>';
  scrollBottom();
}

function appendErrorMsg(message) {
  const div = document.createElement('div');
  div.className = 'msg error';
  div.innerHTML = `<div class="msg-icon">✗</div><div class="msg-body">${escHtml(message)}</div>`;
  messagesEl.appendChild(div);
  scrollBottom();
}

function appendPermissionCard(name, input, toolUseId, sessionKey, agentId, agentType) {
  const card = document.createElement('div');
  card.className = 'tool-permission';
  card.dataset.toolUseId = toolUseId;

  const isSubAgent = !!agentType;

  // Look up sub-agent description from running agent cards
  let agentDesc = null;
  if (agentId && agentCards.has(agentId)) {
    agentDesc = agentCards.get(agentId).cardEl?.dataset?.description || null;
  }

  const header = document.createElement('div');
  header.className = 'tool-perm-header';

  const titleSpan = document.createElement('span');
  titleSpan.className = 'tool-perm-title';
  titleSpan.textContent = isSubAgent ? `子 Agent 权限请求：${name}` : `工具权限请求：${name}`;
  header.appendChild(titleSpan);

  if (isSubAgent) {
    const badge = document.createElement('span');
    badge.className = 'tool-perm-agent-badge';
    badge.textContent = agentType;
    header.appendChild(badge);
  }

  if (agentDesc) {
    const desc = document.createElement('div');
    desc.className = 'tool-perm-agent-desc';
    desc.textContent = agentDesc;
    header.appendChild(desc);
  }

  const inputPre = document.createElement('pre');
  inputPre.className = 'tool-perm-input';
  inputPre.textContent = input || '(无参数)';

  const actions = document.createElement('div');
  actions.className = 'tool-perm-actions';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'btn-allow';
  allowBtn.textContent = '允许';

  const alwaysBtn = document.createElement('button');
  alwaysBtn.className = 'btn-allow-always';
  alwaysBtn.textContent = '本次会话不再询问';
  alwaysBtn.title = '本次会话中 ' + name + ' 工具的请求将自动允许';

  const denyBtn = document.createElement('button');
  denyBtn.className = 'btn-deny';
  denyBtn.textContent = '拒绝';

  function decide(allowed, always) {
    card.remove();
    if (always) sessionAlwaysAllowed.add(name);
    window.electronAPI.toolApprove({ sessionKey, toolUseId, allowed });
  }

  allowBtn.addEventListener('click', () => decide(true, false));
  alwaysBtn.addEventListener('click', () => decide(true, true));
  denyBtn.addEventListener('click', () => decide(false, false));

  actions.appendChild(allowBtn);
  actions.appendChild(alwaysBtn);
  actions.appendChild(denyBtn);
  card.appendChild(header);
  card.appendChild(inputPre);
  card.appendChild(actions);
  messagesEl.appendChild(card);
  scrollBottom();
}

// ── Ctrl+F 搜索 ───────────────────────────────────────────────────
let _searchMatches = [], _searchIdx = 0;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function openSearch() {
  searchBarEl.classList.remove('hidden');
  searchInputEl.focus();
  searchInputEl.select();
}
function closeSearch() {
  clearSearchMarks();
  searchBarEl.classList.add('hidden');
  _searchMatches = []; _searchIdx = 0;
  searchCountEl.textContent = '';
}
function clearSearchMarks() {
  const container = activeTabId === 'chat' ? messagesEl : (fileTabs.get(activeTabId)?.pane ?? messagesEl);
  container.querySelectorAll('mark.search-match').forEach(m => m.replaceWith(...m.childNodes));
}
function runSearch(query) {
  clearSearchMarks();
  _searchMatches = []; _searchIdx = 0;
  if (!query.trim()) { searchCountEl.textContent = ''; return; }
  const container = activeTabId === 'chat' ? messagesEl : (fileTabs.get(activeTabId)?.pane ?? messagesEl);
  const re = new RegExp(escapeRe(query), 'gi');
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    const tag = node.parentElement?.tagName;
    if (!tag || ['SCRIPT','STYLE','TEXTAREA'].includes(tag)) continue;
    let m;
    while ((m = re.exec(node.textContent)) !== null) {
      const range = document.createRange();
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      ranges.push(range);
    }
  }
  for (const r of ranges.reverse()) {
    try {
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      r.surroundContents(mark);
      _searchMatches.unshift(mark);
    } catch {}
  }
  activateSearchMatch(0);
}
function activateSearchMatch(idx) {
  if (!_searchMatches.length) { searchCountEl.textContent = '无结果'; return; }
  _searchIdx = (idx + _searchMatches.length) % _searchMatches.length;
  _searchMatches.forEach((m, i) => m.classList.toggle('search-match-active', i === _searchIdx));
  _searchMatches[_searchIdx]?.scrollIntoView({ block: 'nearest' });
  searchCountEl.textContent = `${_searchIdx + 1} / ${_searchMatches.length}`;
}

// ── Tab 系统 ──────────────────────────────────────────────────────
const fileTabs = new Map(); // path → { tabBtn, pane }
let activeTabId = 'chat';

const EXT_LANG_MAP = {
  js:'javascript', mjs:'javascript', cjs:'javascript',
  ts:'typescript', tsx:'typescript', jsx:'javascript',
  py:'python', rb:'ruby', go:'go', rs:'rust',
  java:'java', cs:'csharp', cpp:'cpp', c:'c', h:'c',
  css:'css', scss:'scss', less:'less',
  html:'html', htm:'html', xml:'xml',
  json:'json', yaml:'yaml', yml:'yaml',
  sh:'bash', bash:'bash', zsh:'bash', ps1:'powershell',
  sql:'sql', php:'php', kt:'kotlin', swift:'swift', dart:'dart',
  toml:'ini', ini:'ini', conf:'ini',
};

function initTabBar() {
  const btn = document.createElement('button');
  btn.className = 'tab-btn active';
  btn.dataset.tabId = 'chat';
  btn.innerHTML = '<svg class="tab-svg" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M0 2.5A2.5 2.5 0 012.5 0h11A2.5 2.5 0 0116 2.5v7A2.5 2.5 0 0113.5 12H9.06l-2.56 3.36a.5.5 0 01-.8 0L3.14 12H2.5A2.5 2.5 0 010 9.5v-7z"/></svg><span>Chat</span>';
  btn.addEventListener('click', () => activateTab('chat'));
  tabBarEl.appendChild(btn);
}

function activateTab(id) {
  if (id !== 'chat') closeSearch();   // clear marks before activeTabId changes
  activeTabId = id;
  const chatPane = $('chat-pane');
  chatPane.classList.toggle('active', id === 'chat');
  tabBarEl.querySelector('[data-tab-id="chat"]')?.classList.toggle('active', id === 'chat');
  for (const [path, { tabBtn, pane }] of fileTabs) {
    const active = path === id;
    pane.classList.toggle('active', active);
    tabBtn.classList.toggle('active', active);
  }
}

// 用系统默认程序打开的扩展名（二进制/富文本/媒体等）
const SYSTEM_OPEN_EXTS = new Set([
  'html','htm',
  'doc','docx','xls','xlsx','ppt','pptx','odt','ods','odp',
  'pdf',
  'png','jpg','jpeg','gif','bmp','webp','svg','ico','tiff','tif',
  'mp4','mp3','wav','avi','mov','mkv','flv','wmv',
  'zip','rar','7z','tar','gz',
  'exe','msi','dmg','pkg',
]);

const CODE_TAB_ID  = '__code__';
const CHUNK_SIZE   = 200 * 1024;  // 200 KB per chunk

async function openFileTab(fullPath) {
  const ext = fullPath.split('.').pop().toLowerCase();

  if (SYSTEM_OPEN_EXTS.has(ext)) {
    await window.electronAPI.openPath(fullPath);
    return;
  }

  // 文本/代码 → 单一 code tab
  if (!fileTabs.has(CODE_TAB_ID)) {
    const pane = document.createElement('div');
    pane.className = 'tab-pane file-pane';
    pane.innerHTML = `
      <div class="file-toolbar">
        <span class="file-path-label"></span>
        <span class="file-chunk-info"></span>
        <button class="file-load-more btn-ghost btn-sm hidden">加载更多</button>
        <span class="file-save-status"></span>
      </div>
      <textarea class="code-edit-area" spellcheck="false"></textarea>`;
    mainEl.appendChild(pane);
    fileTabs.set(CODE_TAB_ID, { tabBtn: makeTabButton(fullPath, CODE_TAB_ID), pane });
    tabBarEl.appendChild(fileTabs.get(CODE_TAB_ID).tabBtn);
  }
  await refreshCodePane(fullPath);
}

async function refreshCodePane(fullPath) {
  const t = fileTabs.get(CODE_TAB_ID);
  if (!t) return;
  const label = fullPath.replace(/\\/g, '/').split('/').pop();
  t.tabBtn.querySelector('.tab-label').textContent = label;
  t.pane.dataset.path = fullPath;
  t.pane.querySelector('.file-path-label').textContent = fullPath;
  t.pane.querySelector('.file-save-status').textContent = '';
  const ta       = t.pane.querySelector('.code-edit-area');
  const infoEl   = t.pane.querySelector('.file-chunk-info');
  const moreBtn  = t.pane.querySelector('.file-load-more');

  const fileSize = await window.electronAPI.getFileSize(fullPath);

  if (fileSize < 0 || fileSize <= CHUNK_SIZE) {
    // 小文件：全量加载
    const content = await window.electronAPI.readFile(fullPath);
    ta.value = content ?? '';
    delete t.pane.dataset.tailOffset;
    infoEl.textContent = '';
    moreBtn.classList.add('hidden');
  } else {
    // 大文件：按需加载第一块
    const chunk = await window.electronAPI.readFileRange(fullPath, 0, CHUNK_SIZE);
    ta.value = chunk ?? '';
    t.pane.dataset.tailOffset = String(CHUNK_SIZE);
    t.pane.dataset.fileSize   = String(fileSize);
    _updateChunkInfo(infoEl, CHUNK_SIZE, fileSize);
    moreBtn.classList.remove('hidden');
    moreBtn.onclick = () => loadMoreCode(t.pane);
  }

  activateTab(CODE_TAB_ID);
  ta.focus();
}

function _updateChunkInfo(el, loaded, total) {
  const fmt = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
  el.textContent = `已加载 ${fmt(loaded)} / ${fmt(total)}`;
}

async function loadMoreCode(pane) {
  const ta        = pane.querySelector('.code-edit-area');
  const infoEl    = pane.querySelector('.file-chunk-info');
  const moreBtn   = pane.querySelector('.file-load-more');
  const fullPath  = pane.dataset.path;
  const tailOff   = parseInt(pane.dataset.tailOffset || '0', 10);
  const fileSize  = parseInt(pane.dataset.fileSize   || '0', 10);
  if (!fullPath || tailOff <= 0) return;

  moreBtn.disabled = true;
  const chunk = await window.electronAPI.readFileRange(fullPath, tailOff, CHUNK_SIZE);
  if (chunk) {
    ta.value += chunk;
    const newTail = tailOff + CHUNK_SIZE;
    if (newTail >= fileSize) {
      // 全部加载完毕
      delete pane.dataset.tailOffset;
      infoEl.textContent = '';
      moreBtn.classList.add('hidden');
    } else {
      pane.dataset.tailOffset = String(newTail);
      _updateChunkInfo(infoEl, newTail, fileSize);
    }
  }
  moreBtn.disabled = false;
}

function makeTabButton(fullPath, tabId) {
  const label = fullPath.replace(/\\/g, '/').split('/').pop();
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tabId = tabId;
  const labelSpan = document.createElement('span');
  labelSpan.className = 'tab-label';
  labelSpan.textContent = label;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = '✕';
  closeBtn.title = '关闭';
  closeBtn.addEventListener('click', e => { e.stopPropagation(); closeFileTab(tabId); });
  btn.appendChild(labelSpan);
  btn.appendChild(closeBtn);
  btn.addEventListener('click', () => activateTab(tabId));
  return btn;
}

function closeFileTab(path) {
  const t = fileTabs.get(path);
  if (!t) return;
  t.tabBtn.remove();
  t.pane.remove();
  fileTabs.delete(path);
  if (activeTabId === path) activateTab('chat');
}

// ── Markdown 渲染 ─────────────────────────────────────────────────
function initMarked() {
  if (!window.marked || !window.hljs) return;
  window.hljs.configure({ ignoreUnescapedHTML: true });
  window.marked.use({
    gfm: true, breaks: false,
    renderer: {
      code({ text, lang }) {
        const language = (lang || '').split(/\s/)[0].toLowerCase();
        let highlighted;
        try {
          highlighted = language && window.hljs.getLanguage(language)
            ? window.hljs.highlight(text, { language, ignoreIllegals: true }).value
            : window.hljs.highlightAuto(text).value;
        } catch { highlighted = escHtml(text); }

        const lines = text.split('\n');
        const langAttr  = language ? ` language-${escHtml(language)}` : '';
        const codeEl    = `<code class="hljs${langAttr}">${highlighted}</code>`;
        const langLabel = language ? `<span class="code-lang">${escHtml(language)}</span>` : '<span></span>';
        const copyBtn   = `<button class="copy-btn" title="复制代码">⎘</button>`;
        const header    = `<div class="code-header">${langLabel}${copyBtn}</div>`;

        const wrapCode = `<div class="code-wrapper">${header}<pre>${codeEl}</pre></div>`;

        if (lines.length > 20) {
          const preview = escHtml((lines.find(l => l.trim()) || lines[0]).slice(0, 80));
          return `<details class="code-collapsible">` +
            `<summary class="code-summary">` +
            (language ? `<span class="code-lang-tag">${escHtml(language)}</span>` : '') +
            `<span class="code-summary-lines">${lines.length} 行</span>` +
            `<span class="code-summary-preview">${preview}</span>` +
            `</summary>${wrapCode}</details>`;
        }
        return wrapCode;
      },
    },
  });
}

function renderContent(raw) {
  if (!raw) return '';
  try {
    return window.marked ? window.marked.parse(raw) : renderContentLegacy(raw);
  } catch { return renderContentLegacy(raw); }
}

function renderContentLegacy(raw) {
  const parts = [];
  const codeRe = /```([^\n]*)\n([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = codeRe.exec(raw)) !== null) {
    if (m.index > last) parts.push(renderInline(raw.slice(last, m.index)));
    const lang = m[1].trim();
    const body = m[2];
    const lines = body.split('\n');
    const codeEl    = `<code>${escHtml(body)}</code>`;
    const langLabel = lang ? `<span class="code-lang">${escHtml(lang)}</span>` : '<span></span>';
    const copyBtn   = `<button class="copy-btn" title="复制代码">⎘</button>`;
    const codeHeader = `<div class="code-header">${langLabel}${copyBtn}</div>`;
    if (lines.length > 20) {
      const preview = escHtml(lines.find(l => l.trim()) || lines[0]).slice(0, 80);
      parts.push(
        `<details class="code-collapsible">` +
        `<summary class="code-summary">` +
        (lang ? `<span class="code-lang-tag">${escHtml(lang)}</span>` : '') +
        `<span class="code-summary-lines">${lines.length} 行</span>` +
        `<span class="code-summary-preview">${preview}</span>` +
        `</summary><div class="code-wrapper">${codeHeader}<pre>${codeEl}</pre></div></details>`
      );
    } else {
      parts.push(`<div class="code-wrapper">${codeHeader}<pre>${codeEl}</pre></div>`);
    }
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push(renderInline(raw.slice(last)));
  return parts.join('');
}

function renderInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Slash 菜单 ───────────────────────────────────────────────────
const SKILL_KEYWORD_RE = /^(?:skill|skills|技能|使用技能|使用\s*skill|用\s*skill|use\s*skills?)\s*/i;

function checkSlashMenu() {
  const val = inputEl.value;
  if (val.includes('\n')) { hideSlashMenu(); return; }

  let filter = '';
  if (val.startsWith('/')) {
    filter = val.slice(1).toLowerCase();
  } else {
    const m = val.match(SKILL_KEYWORD_RE);
    if (!m) { hideSlashMenu(); return; }
    filter = val.slice(m[0].length).toLowerCase().trim();
  }

  const filtered = getAllSkills().filter(s => s.name.startsWith(filter));
  if (!filtered.length) { hideSlashMenu(); return; }
  slashMenu.filtered = filtered;
  if (!slashMenu.visible) slashMenu.selectedIdx = 0;
  slashMenu.selectedIdx = Math.min(slashMenu.selectedIdx, filtered.length - 1);
  slashMenu.visible = true;
  renderSlashMenu();
}

function hideSlashMenu() {
  slashMenu.visible = false;
  if (slashMenuEl) slashMenuEl.classList.add('hidden');
}

function renderSlashMenu() {
  slashMenuEl.innerHTML = '';
  slashMenu.filtered.forEach((skill, i) => {
    const item = document.createElement('div');
    item.className = 'slash-item' + (i === slashMenu.selectedIdx ? ' selected' : '');
    item.innerHTML =
      `<span class="slash-icon">${skill.icon}</span>` +
      `<span class="slash-name">/${escHtml(skill.name)}</span>` +
      `<span class="slash-desc">${escHtml(skill.desc)}</span>` +
      (skill.source ? `<span class="slash-source">${escHtml(skill.source)}</span>` : '');
    item.addEventListener('mousedown', e => { e.preventDefault(); selectSkill(skill); });
    item.addEventListener('mouseenter', () => { slashMenu.selectedIdx = i; renderSlashMenu(); });
    slashMenuEl.appendChild(item);
  });
  slashMenuEl.classList.remove('hidden');
}

function selectSkill(skill) {
  if (!skill) return;
  hideSlashMenu();
  if (skill.action) {
    inputEl.value = '';
    autoResize();
    skill.action();
  } else {
    inputEl.value = '/' + skill.name;
    autoResize();
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }
}

// ── 输入状态 ─────────────────────────────────────────────────────
function setSendBtnMode(mode) {
  if (mode === 'stop') {
    sendBtnEl.classList.add('stop-mode');
    sendBtnEl.disabled = false;
    sendBtnEl.title = '取消 (Ctrl+C)';
  } else {
    sendBtnEl.classList.remove('stop-mode');
    sendBtnEl.title = '发送 (Enter)';
  }
}
function updateInputState() {
  const hasProject = !!activeProjectId;
  inputEl.disabled = !hasProject;
  if (!state.loading) sendBtnEl.disabled = !hasProject;
  inputEl.placeholder = hasProject ? '输入消息，Enter 发送，Shift+Enter 换行' : '请先双击左侧工程以开始对话';
}

// ── 状态栏 ───────────────────────────────────────────────────────
function updateStatusBar({ loading = false, warning, info } = {}) {
  const dot   = `<span class="status-dot${loading ? ' loading' : ''}"></span>`;
  const mode  = `<span>Claude Code</span>`;
  const turns = state.messages.length
    ? `<span>${Math.floor(state.messages.length / 2)} 轮对话</span>` : '';
  const tokens = (state.inputTokens || state.outputTokens)
    ? `<span>↑${state.inputTokens} ↓${state.outputTokens} 令牌</span>` : '';
  const proj = activeProjectId ? projects.find(p => p.id === activeProjectId) : null;
  const projLabel = proj ? `<span style="color:var(--accent-green)">📁 ${escHtml(proj.name)}</span>` : '';
  const warn  = warning ? `<span style="color:var(--accent-warn)">${escHtml(warning)}</span>` : '';
  const infoL = info    ? `<span style="color:var(--accent-green)">${escHtml(info)}</span>`   : '';
  statusBarEl.innerHTML = `${dot}${mode}${projLabel}${turns}${tokens}${warn}${infoL}`;
}

// ── 工具 ─────────────────────────────────────────────────────────
function autoResize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px';
}
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
}
function scrollIfNearBottom() { if (isNearBottom()) scrollBottom(); }
