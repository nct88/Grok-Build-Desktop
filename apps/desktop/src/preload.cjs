const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grokBuild", {
  getBootstrap: () => ipcRenderer.invoke("app:getBootstrap"),
  openMicSettings: () => ipcRenderer.invoke("app:openMicSettings"),
  getAuthProfile: () => ipcRenderer.invoke("app:getAuthProfile"),
  getUsage: () => ipcRenderer.invoke("app:getUsage"),
  getSessionInfo: () => ipcRenderer.invoke("app:getSessionInfo"),
  slashCommands: (workspaceRoot) =>
    ipcRenderer.invoke("app:getSlashCommands", workspaceRoot ?? null),
  getFolderTrust: (folder) => ipcRenderer.invoke("app:getFolderTrust", folder ?? null),
  setFolderTrust: (folder, trusted) =>
    ipcRenderer.invoke("app:setFolderTrust", folder ?? null, Boolean(trusted)),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  login: () => ipcRenderer.invoke("app:login"),
  logout: () => ipcRenderer.invoke("app:logout"),
  saveSettings: (settings) => ipcRenderer.invoke("app:saveSettings", settings),
  setTheme: (theme) => ipcRenderer.invoke("app:setTheme", theme),
  /** Custom titlebar menus (File / Edit / View / …) */
  popupMenu: (label, x, y) => ipcRenderer.invoke("menu:popup", label, x, y),
  checkUpdate: (feedUrl) => ipcRenderer.invoke("app:checkUpdate", feedUrl),
  pickWorkspace: () => ipcRenderer.invoke("app:pickWorkspace"),
  pickFiles: () => ipcRenderer.invoke("app:pickFiles"),
  saveExport: (markdown, defaultName) =>
    ipcRenderer.invoke("app:saveExport", markdown, defaultName),
  // ── Agent IPC surface (Phase A6 — keep renderer free of process logic) ──
  connect: (workspaceRoot, options) =>
    ipcRenderer.invoke("agent:connect", workspaceRoot ?? "", options || {}),
  setWorkspace: (workspaceRoot, extraRoots) =>
    ipcRenderer.invoke("app:setWorkspace", workspaceRoot ?? null, extraRoots),
  setRecentProjects: (paths) =>
    ipcRenderer.invoke("app:setRecentProjects", paths || []),
  disconnect: () => ipcRenderer.invoke("agent:disconnect"),
  reconnect: () => ipcRenderer.invoke("agent:reconnect"),
  agentStatus: () => ipcRenderer.invoke("agent:status"),
  /** P1 multi-slot supervisor (max 2: primary + parallel) */
  agentSlots: () => ipcRenderer.invoke("agent:slots"),
  spawnAgentSlot: (workspaceRoot, options, label) =>
    ipcRenderer.invoke("agent:spawnSlot", workspaceRoot, options || {}, label),
  setActiveAgentSlot: (slotId) => ipcRenderer.invoke("agent:setActiveSlot", slotId),
  stopAgentSlot: (slotId) => ipcRenderer.invoke("agent:stopSlot", slotId),
  prompt: (text, attachments) =>
    ipcRenderer.invoke("agent:prompt", text, attachments || []),
  cancel: () => ipcRenderer.invoke("agent:cancel"),
  resolvePermission: (requestId, optionId) =>
    ipcRenderer.invoke("agent:resolvePermission", requestId, optionId),
  newSession: () => ipcRenderer.invoke("agent:newSession"),
  setSessionConfig: (configId, value) =>
    ipcRenderer.invoke("agent:setSessionConfig", configId, value),
  setSessionMode: (modeId) => ipcRenderer.invoke("agent:setSessionMode", modeId),
  setPermissionMode: (mode) => ipcRenderer.invoke("agent:setPermissionMode", mode),
  listSessions: (cwd) => ipcRenderer.invoke("agent:listSessions", cwd),
  moveSession: (sessionId, targetWorkspace) =>
    ipcRenderer.invoke("agent:moveSession", sessionId, targetWorkspace ?? ""),
  loadSession: (sessionId, workspaceRoot, options) =>
    ipcRenderer.invoke("agent:loadSession", sessionId, workspaceRoot, options || {}),
  deleteSession: (sessionId) => ipcRenderer.invoke("agent:deleteSession", sessionId),
  renameSession: (sessionId, title) =>
    ipcRenderer.invoke("agent:renameSession", sessionId, title ?? ""),
  runCli: (args) => ipcRenderer.invoke("agent:runCli", args),
  pluginCatalog: () => ipcRenderer.invoke("plugin:catalog"),
  readTranscript: (sessionId) => ipcRenderer.invoke("agent:readTranscript", sessionId),
  exportSession: (sessionId) => ipcRenderer.invoke("agent:exportSession", sessionId),
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
  showItemInFolder: (p) => ipcRenderer.invoke("shell:showItemInFolder", p),
  writeClipboardImage: (p) => ipcRenderer.invoke("clipboard:writeImage", p),
  writeClipboardText: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  openIde: (opts) => ipcRenderer.invoke("app:openIde", opts || {}),
  getIdeStatus: () => ipcRenderer.invoke("app:getIdeStatus"),
  // Models (CLI `grok models`) + CLI self-update
  listModels: () => ipcRenderer.invoke("app:listModels"),
  cliStatus: () => ipcRenderer.invoke("app:cliStatus"),
  updateCli: () => ipcRenderer.invoke("app:updateCli"),
  // Phase D
  health: () => ipcRenderer.invoke("app:health"),
  controlPlane: () => ipcRenderer.invoke("app:controlPlane"),
  telemetrySummary: () => ipcRenderer.invoke("telemetry:getSummary"),
  telemetrySetEnabled: (on) => ipcRenderer.invoke("telemetry:setEnabled", on),
  telemetryIsEnabled: () => ipcRenderer.invoke("telemetry:isEnabled"),
  // Phase C — manager
  jobsList: () => ipcRenderer.invoke("jobs:list"),
  jobsEnqueue: (spec) => ipcRenderer.invoke("jobs:enqueue", spec || {}),
  jobsCancel: (id) => ipcRenderer.invoke("jobs:cancel", id),
  jobsGet: (id) => ipcRenderer.invoke("jobs:get", id),
  jobsMarkRead: (id) => ipcRenderer.invoke("jobs:markRead", id),
  jobsClearFinished: () => ipcRenderer.invoke("jobs:clearFinished"),
  jobsInbox: (unreadOnly) => ipcRenderer.invoke("jobs:inbox", unreadOnly),
  artifactsList: () => ipcRenderer.invoke("artifacts:list"),
  artifactsAdd: (input) => ipcRenderer.invoke("artifacts:add", input || {}),
  artifactsRemove: (id) => ipcRenderer.invoke("artifacts:remove", id),
  artifactsClear: () => ipcRenderer.invoke("artifacts:clear"),
  worktreeList: (cwd) => ipcRenderer.invoke("worktree:list", cwd),
  worktreeShow: (name, cwd) => ipcRenderer.invoke("worktree:show", name, cwd),
  worktreeRm: (name, cwd) => ipcRenderer.invoke("worktree:rm", name, cwd),
  worktreeGc: (cwd) => ipcRenderer.invoke("worktree:gc", cwd),
  onManagerJob: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on("manager:job", listener);
    return () => ipcRenderer.removeListener("manager:job", listener);
  },
  onManagerInbox: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on("manager:inbox", listener);
    return () => ipcRenderer.removeListener("manager:inbox", listener);
  },
  onManagerArtifact: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on("manager:artifact", listener);
    return () => ipcRenderer.removeListener("manager:artifact", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  readText: (filePath) => ipcRenderer.invoke("fs:readText", filePath),
  writeText: (filePath, content) => ipcRenderer.invoke("fs:writeText", filePath, content),
  listDir: (dirPath) => ipcRenderer.invoke("fs:listDir", dirPath),
  gitStatus: (workspaceRoot) => ipcRenderer.invoke("git:status", workspaceRoot),
  gitCreatePr: (workspaceRoot, opts) =>
    ipcRenderer.invoke("git:createPr", workspaceRoot, opts || {}),
  readFileBase64: (filePath) => ipcRenderer.invoke("fs:readFileBase64", filePath),
  /** Imagine / timeline: read image|video even under ~/.grok/sessions (safe preview) */
  readMediaPreview: (filePath) => ipcRenderer.invoke("fs:readMediaPreview", filePath),
  runTerminal: (command, cwd) => ipcRenderer.invoke("term:run", command, cwd),
  startShell: (cwd) => ipcRenderer.invoke("term:startShell", cwd),
  writeShell: (line, cwd) => ipcRenderer.invoke("term:writeShell", line, cwd),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke("term:resize", cols, rows),
  stopShell: () => ipcRenderer.invoke("term:stopShell"),
  termStatus: () => ipcRenderer.invoke("term:status"),
  termInterrupt: () => ipcRenderer.invoke("term:interrupt"),
  openExternalTerminal: (cwd) => ipcRenderer.invoke("term:openExternal", cwd),
  onEvent: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("agent:event", listener);
    return () => ipcRenderer.removeListener("agent:event", listener);
  },
  onTermChunk: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("term:chunk", listener);
    return () => ipcRenderer.removeListener("term:chunk", listener);
  },
  onMenuCommand: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("menu:command", listener);
    return () => ipcRenderer.removeListener("menu:command", listener);
  },
});
