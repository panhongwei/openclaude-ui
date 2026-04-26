'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 基础配置
  getConfig:            () => ipcRenderer.invoke('get-config'),
  getFullConfig:        () => ipcRenderer.invoke('get-full-config'),
  saveProviderSettings: (s) => ipcRenderer.invoke('save-provider-settings', s),
  setActiveModel:       (ref) => ipcRenderer.invoke('set-active-model', ref),

  // 聊天 — 路由到 QueryEngine (dist/electron.mjs)
  chatSend:       (payload) => ipcRenderer.invoke('chat-send', payload),
  chatNewSession: (key)     => ipcRenderer.invoke('chat-new-session', key),
  chatCancel:     (key)     => ipcRenderer.invoke('chat-cancel', key),

  // 流式事件
  onChunk: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-chunk', h);
    return () => ipcRenderer.removeListener('chat-chunk', h);
  },
  onDone:  (cb) => { ipcRenderer.once('chat-done',  (_e, d) => cb(d)); },
  onError: (cb) => { ipcRenderer.once('chat-error', (_e, d) => cb(d)); },

  onToolStart: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-tool-start', h);
    return () => ipcRenderer.removeListener('chat-tool-start', h);
  },
  onToolEnd: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-tool-end', h);
    return () => ipcRenderer.removeListener('chat-tool-end', h);
  },

  onThinkingStart: (cb) => {
    const h = (_e) => cb();
    ipcRenderer.on('chat-thinking-start', h);
    return () => ipcRenderer.removeListener('chat-thinking-start', h);
  },
  onThinkingEnd: (cb) => {
    const h = (_e) => cb();
    ipcRenderer.on('chat-thinking-end', h);
    return () => ipcRenderer.removeListener('chat-thinking-end', h);
  },
  onApiRetry: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-api-retry', h);
    return () => ipcRenderer.removeListener('chat-api-retry', h);
  },
  onCompact: (cb) => {
    const h = (_e) => cb();
    ipcRenderer.on('chat-compact', h);
    return () => ipcRenderer.removeListener('chat-compact', h);
  },

  onAgentStart: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-agent-start', h);
    return () => ipcRenderer.removeListener('chat-agent-start', h);
  },
  onAgentProgress: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-agent-progress', h);
    return () => ipcRenderer.removeListener('chat-agent-progress', h);
  },
  onAgentDone: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('chat-agent-done', h);
    return () => ipcRenderer.removeListener('chat-agent-done', h);
  },

  // 工具权限
  onToolPermission: (cb) => {
    const h = (_e, data) => cb(data);
    ipcRenderer.on('tool-permission', h);
    return () => ipcRenderer.removeListener('tool-permission', h);
  },
  toolApprove: (payload) => ipcRenderer.invoke('tool-approve', payload),

  // 主进程 → 渲染层 事件
  onProviderChanged: (cb) => { ipcRenderer.on('provider-changed', (_e, d) => cb(d)); },
  onOpenSettings:    (cb) => { ipcRenderer.on('open-settings',    ()      => cb()); },
  onNewChat:         (cb) => { ipcRenderer.on('new-chat',         ()      => cb()); },
  onNewProject:      (cb) => { ipcRenderer.on('new-project',      ()      => cb()); },
  onConfigReset:     (cb) => { ipcRenderer.on('config-reset',     ()      => cb()); },
  onOpenProxy:       (cb) => { ipcRenderer.on('open-proxy',       ()      => cb()); },
  onOpenSkills:      (cb) => { ipcRenderer.on('open-skills',      ()      => cb()); },
  onCycleTheme:      (cb) => { ipcRenderer.on('cycle-theme',      ()      => cb()); },

  // 文件系统
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  readDir:      (p) => ipcRenderer.invoke('read-dir', p),
  readSkills:   (cwd, extra) => ipcRenderer.invoke('read-skills', cwd, extra),
  selectSkillsDir: () => ipcRenderer.invoke('select-skills-dir'),
  readFile:     (p) => ipcRenderer.invoke('read-file', p),
  writeFile:    (p, c) => ipcRenderer.invoke('write-file', p, c),

  openExternal:    (url)          => ipcRenderer.send('open-external', url),
  openPath:        (p)            => ipcRenderer.invoke('open-path', p),
  getFileSize:     (p)            => ipcRenderer.invoke('get-file-size', p),
  readFileRange:   (p, off, len)  => ipcRenderer.invoke('read-file-range', p, off, len),
  // Electron 32+ 移除了 file.path，必须通过 webUtils 获取本地路径
  getPathForFile:  (file)         => webUtils.getPathForFile(file),
});
