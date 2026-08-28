/**
 * IPC channel contract — preload surface ↔ main handlers.
 * Used by e2e + architecture checks. Keep in sync with preload.cjs.
 */
"use strict";

/** Invoke channels (renderer → main via ipcRenderer.invoke) */
const INVOKE_CHANNELS = [
  "app:getBootstrap",
  "app:openMicSettings",
  "app:getAuthProfile",
  "app:getUsage",
  "app:getSlashCommands",
  "app:getFolderTrust",
  "app:setFolderTrust",
  "app:quit",
  "app:login",
  "app:logout",
  "app:saveSettings",
  "app:setTheme",
  "menu:popup",
  "app:checkUpdate",
  "app:pickWorkspace",
  "app:setWorkspace",
  "app:setRecentProjects",
  "app:pickFiles",
  "app:saveExport",
  "app:openIde",
  "app:getIdeStatus",
  "app:listModels",
  "app:cliStatus",
  "app:updateCli",
  "app:health",
  "app:controlPlane",
  "agent:connect",
  "agent:disconnect",
  "agent:reconnect",
  "agent:status",
  "agent:prompt",
  "agent:cancel",
  "agent:resolvePermission",
  "agent:newSession",
  "agent:setSessionConfig",
  "agent:setSessionMode",
  "agent:setPermissionMode",
  "agent:listSessions",
  "agent:loadSession",
  "agent:deleteSession",
  "agent:renameSession",
  "agent:runCli",
  "plugin:catalog",
  "agent:readTranscript",
  "agent:exportSession",
  "agent:slots",
  "agent:spawnSlot",
  "agent:setActiveSlot",
  "agent:stopSlot",
  "shell:openPath",
  "shell:showItemInFolder",
  "shell:openExternal",
  "clipboard:writeImage",
  "clipboard:writeText",
  "fs:readText",
  "fs:writeText",
  "fs:listDir",
  "fs:readFileBase64",
  "fs:readMediaPreview",
  "git:status",
  "git:createPr",
  "term:run",
  "term:startShell",
  "term:writeShell",
  "term:stopShell",
  "term:status",
  "term:interrupt",
  "term:openExternal",
  "jobs:list",
  "jobs:enqueue",
  "jobs:cancel",
  "jobs:get",
  "jobs:markRead",
  "jobs:clearFinished",
  "jobs:inbox",
  "artifacts:list",
  "artifacts:add",
  "artifacts:remove",
  "artifacts:clear",
  "worktree:list",
  "worktree:show",
  "worktree:rm",
  "worktree:gc",
  "telemetry:getSummary",
  "telemetry:setEnabled",
  "telemetry:isEnabled",
];

/** Push channels (main → renderer via webContents.send) */
const EVENT_CHANNELS = [
  "agent:event",
  "term:chunk",
  "menu:command",
  "manager:job",
  "manager:inbox",
  "manager:artifact",
];

/**
 * Extract invoke channel strings from preload source.
 * @param {string} preloadSrc
 * @returns {string[]}
 */
function extractInvokeFromPreload(preloadSrc) {
  const found = new Set();
  const re = /invoke\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(preloadSrc))) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * Extract event channel strings from preload (ipcRenderer.on).
 * @param {string} preloadSrc
 * @returns {string[]}
 */
function extractEventsFromPreload(preloadSrc) {
  const found = new Set();
  const re = /\.on\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(preloadSrc))) {
    found.add(m[1]);
  }
  return [...found].sort();
}

/**
 * @param {string} preloadSrc
 * @returns {{ ok: boolean, missing: string[], extra: string[], missingEvents: string[] }}
 */
function validatePreloadContract(preloadSrc) {
  const present = new Set(extractInvokeFromPreload(preloadSrc));
  const missing = INVOKE_CHANNELS.filter((c) => !present.has(c));
  // Preload may intentionally omit some until UI wires them; report extras only as info
  const contractSet = new Set(INVOKE_CHANNELS);
  const extra = [...present].filter((c) => !contractSet.has(c));
  const events = new Set(extractEventsFromPreload(preloadSrc));
  const missingEvents = EVENT_CHANNELS.filter((c) => !events.has(c));
  return {
    ok: missing.length === 0 && missingEvents.length === 0,
    missing,
    extra,
    missingEvents,
  };
}

module.exports = {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  extractInvokeFromPreload,
  extractEventsFromPreload,
  validatePreloadContract,
};
