/**
 * Grok Build Desktop — main process
 * Full ACP host shell over official `grok agent stdio`.
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  Menu,
  session,
  systemPreferences,
  clipboard,
  nativeImage,
} = require("electron");
// nativeImage used for reliable window icon on Windows
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { TerminalHost, runUserShell, InteractiveShell } = require("./terminalHost.cjs");
const { getGitStatus, getPullRequest, createPullRequest } = require("./gitStatus.cjs");
const { JobRunner } = require("./jobRunner.cjs");
const { ArtifactStore } = require("./artifactStore.cjs");
const { Telemetry } = require("./telemetry.cjs");
const { ControlPlane } = require("./controlPlane.cjs");
const {
  assertWorkspacePath,
  assertMediaPreviewPath,
  sanitizeMediaPathInput,
  assertSafeExternalUrl,
  assertSafeGrokCliArgs,
  assertSafeWorktreeName,
  assertSafeJobSpec,
  isPathInside,
  normalizePath,
} = require("./security.cjs");
const { normalizePermissionMode } = require("./launchArgs.cjs");
const {
  PRODUCT_PATHS,
  resolveIdeInstall: resolveIdeInstallMod,
  openIdeApp: openIdeAppMod,
} = require("./productPaths.cjs");
const { AgentSupervisor } = require("./agentSupervisor.cjs");
const { loadMarketplaceCatalog } = require("./marketplaceCatalog.cjs");
const { loadLocalSlashCommands } = require("./slashCatalog.cjs");
const { getFolderTrust, setFolderTrust } = require("./folderTrust.cjs");
const { execFile } = require("node:child_process");

/** @type {import('electron').BrowserWindow | null} */
let mainWindow = null;
const terminalHost = new TerminalHost();
const userShell = new InteractiveShell();

/** @type {AgentSupervisor|null} */
let supervisor = null;

/** @type {any} cached ACP module for host factory after loadAcp */
let acpModuleCache = null;

function getSupervisor() {
  if (supervisor) return supervisor;
  supervisor = new AgentSupervisor({
    maxSlots: 2,
    send,
    async loadAcp() {
      acpModuleCache = await loadAcp();
      return acpModuleCache;
    },
    resolveExecutable: resolveGrokExecutable,
    grokEnv,
    ensureTelemetry,
    createHost(slot, mode) {
      if (!acpModuleCache) {
        throw new Error("ACP module not loaded before createHost");
      }
      return connectAgentHost(acpModuleCache, slot, mode);
    },
    onConnected(slot) {
      const mode = normalizePermissionMode(slot.connectOptions.permissionMode);
      const recents = isRecentsWorkspace(slot.workspace);
      const state = loadState();
      /** @type {Record<string, unknown>} */
      const patch = {
        lastConnectedAt: new Date().toISOString(),
        permissionMode: mode,
        model: slot.connectOptions.model || "",
        effort: slot.connectOptions.effort || "",
        sandbox: slot.connectOptions.sandbox || "",
        tools: slot.connectOptions.tools || "",
        deniedTools: slot.connectOptions.deniedTools || "",
        worktree: slot.connectOptions.worktree || "",
        worktreeRef: slot.connectOptions.worktreeRef || "",
        rules: slot.connectOptions.rules || "",
        maxTurns: slot.connectOptions.maxTurns || 0,
        disableWebSearch: Boolean(slot.connectOptions.disableWebSearch),
        experimentalMemory: Boolean(slot.connectOptions.experimentalMemory),
        autoConnect: Boolean(
          slot.connectOptions.autoConnect ?? state.autoConnect,
        ),
        allowOutside: Boolean(slot.connectOptions.allowOutside),
      };
      if (recents) {
        // UI "No project" — agent cwd is desktop-recents, do not list as a project
        patch.workspaceRoot = null;
      } else {
        patch.workspaceRoot = slot.workspace;
        // First open → append (bottom); already listed → keep order
        patch.recentProjects = touchRecentProject(state.recentProjects, slot.workspace);
      }
      saveState(patch);
    },
  });
  return supervisor;
}

/**
 * Virtual workspace for chats with no project selected (sidebar Recents).
 * Sessions land under ~/.grok/sessions/<encoded-path>/… like any other cwd.
 */
function getRecentsWorkspace() {
  const d = path.join(grokHomeDir(), "desktop-recents");
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    // ignore
  }
  return d;
}

function isRecentsWorkspace(p) {
  if (!p || typeof p !== "string") return true;
  try {
    const a = path.resolve(p);
    const b = path.resolve(getRecentsWorkspace());
    if (process.platform === "win32") {
      return a.toLowerCase() === b.toLowerCase();
    }
    return a === b;
  } catch {
    return false;
  }
}

function pathsEqual(a, b) {
  if (!a || !b) return false;
  try {
    const x = path.resolve(a);
    const y = path.resolve(b);
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch {
    return a === b;
  }
}

/**
 * Project list order: first opened stays on top; new projects append at bottom.
 * Re-opening an existing project does not move it (drag-and-drop owns reorder).
 * @param {string[]} list
 * @param {string} root
 * @returns {string[]}
 */
function touchRecentProject(list, root) {
  const r = path.resolve(root);
  if (isRecentsWorkspace(r)) {
    return (list || []).filter((p) => p && !isRecentsWorkspace(p));
  }
  const cleaned = (list || []).filter(
    (p) => typeof p === "string" && p && !isRecentsWorkspace(p),
  );
  if (cleaned.some((p) => pathsEqual(p, r))) return cleaned.slice(0, 24);
  return [...cleaned, r].slice(0, 24);
}

/**
 * @param {unknown} list
 * @returns {string[]}
 */
function sanitizeRecentProjects(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== "string" || !p || isRecentsWorkspace(p)) continue;
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    const resolved = path.resolve(p);
    if (out.some((x) => pathsEqual(x, resolved))) continue;
    out.push(resolved);
  }
  return out.slice(0, 24);
}

/**
 * @param {string} [workspaceRoot]
 * @returns {{ root: string, isRecents: boolean }}
 */
function resolveConnectWorkspace(workspaceRoot) {
  const raw = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
  if (!raw || isRecentsWorkspace(raw)) {
    return { root: getRecentsWorkspace(), isRecents: true };
  }
  if (!fs.existsSync(raw)) {
    throw new Error(
      `Project folder not found: ${raw}. Open a different folder or choose No project.`,
    );
  }
  let st;
  try {
    st = fs.statSync(raw);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    throw new Error(`Not a folder: ${raw}. Choose a project directory.`);
  }
  return { root: path.resolve(raw), isRecents: false };
}

/** Back-compat accessors used throughout handlers */
function getClient() {
  return getSupervisor().client;
}
function getConnectedWorkspace() {
  return getSupervisor().connectedWorkspace;
}
function getConnectOptions() {
  return getSupervisor().connectOptions;
}

/** Phase C — jobs + artifacts (lazy init after app ready for userData path) */
/** @type {JobRunner|null} */
let jobRunner = null;
/** @type {ArtifactStore|null} */
let artifactStore = null;
/** @type {Telemetry|null} Phase D4 */
let telemetry = null;
/** @type {ControlPlane|null} Phase D2 */
let controlPlane = null;

function ensureTelemetry() {
  if (telemetry) return telemetry;
  const dir = path.join(app.getPath("userData"), "telemetry");
  fs.mkdirSync(dir, { recursive: true });
  telemetry = new Telemetry({
    stateDir: dir,
    loadEnabled: () => Boolean(loadState().telemetryOptIn),
    saveEnabled: (v) => saveState({ telemetryOptIn: Boolean(v) }),
  });
  return telemetry;
}

function ensureControlPlane() {
  if (controlPlane) return controlPlane;
  ensureTelemetry();
  controlPlane = new ControlPlane({
    getClient: () => getClient(),
    getWorkspace: () => getConnectedWorkspace() || loadState().workspaceRoot || null,
    resolveExecutable: resolveGrokExecutable,
    getConnectOptions: () => getConnectOptions() || {},
    getVersion: () => app.getVersion() || "0.5.21",
    getSlots: () => getSupervisor().listSlots(),
    telemetry,
  });
  return controlPlane;
}

function ensurePhaseC() {
  if (jobRunner && artifactStore) return;
  const dir = path.join(app.getPath("userData"), "manager");
  fs.mkdirSync(dir, { recursive: true });
  artifactStore = new ArtifactStore(dir);
  jobRunner = new JobRunner({
    resolveExecutable: resolveGrokExecutable,
    grokEnv,
    stateDir: dir,
  });
  jobRunner.on("update", (job) => {
    send("manager:job", job);
    // Promote job artifacts into global store once
    if (
      (job.status === "done" || job.status === "failed") &&
      !job._artifactsPromoted &&
      (job.artifacts || []).length
    ) {
      job._artifactsPromoted = true;
      for (const a of job.artifacts || []) {
        const item = artifactStore.add({
          type: a.type || "job_output",
          title: a.title || job.title,
          content: a.content || "",
          meta: { jobId: job.id, worktree: job.worktree || "", status: job.status },
        });
        send("manager:artifact", item);
      }
    }
    // D4 job duration
    if (
      (job.status === "done" || job.status === "failed" || job.status === "cancelled") &&
      job.startedAt &&
      !job._telemetryRecorded
    ) {
      job._telemetryRecorded = true;
      try {
        const ms = Date.now() - new Date(job.startedAt).getTime();
        ensureTelemetry().record("job_ms", ms, {
          status: job.status,
          worktree: job.worktree || "",
        });
      } catch {
        // ignore
      }
    }
  });
  jobRunner.on("inbox", (job) => {
    send("manager:inbox", {
      id: job.id,
      title: job.title,
      status: job.status,
      error: job.error,
      finishedAt: job.finishedAt,
    });
  });
}

const STATE_FILE = path.join(app.getPath("userData"), "desktop-state.json");

/** Strip UTF-8 BOM (PowerShell Set-Content -Encoding UTF8 often adds it). */
function stripBom(text) {
  const s = String(text ?? "");
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJsonFile(filePath) {
  return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
}

function loadState() {
  try {
    return readJsonFile(STATE_FILE);
  } catch {
    return {};
  }
}
function saveState(partial) {
  const next = { ...loadState(), ...partial };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), "utf8");
}

function resolveGrokExecutable() {
  if (process.env.GROK_EXECUTABLE && fs.existsSync(process.env.GROK_EXECUTABLE)) {
    return process.env.GROK_EXECUTABLE;
  }
  const home = process.env.GROK_HOME || path.join(os.homedir(), ".grok");
  for (const c of [
    path.join(home, "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    path.join(os.homedir(), ".local", "bin", "grok"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return "grok";
}

function grokEnv() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: process.env.USERPROFILE || home,
    GROK_HOME: process.env.GROK_HOME || path.join(os.homedir(), ".grok"),
  };
}

function resolveIdeInstall() {
  return resolveIdeInstallMod({ loadState });
}

/** @deprecated prefer resolveIdeInstall().executable */
function findIdePath() {
  const r = resolveIdeInstall();
  return r.executable || r.installDir;
}

/**
 * Launch IDE app (not open folder). Phase C4: deep-link file:line:col.
 * @param {{ workspace?: string, file?: string, line?: number, column?: number } | string} [opts]
 */
async function openIdeApp(opts) {
  return openIdeAppMod(opts, {
    loadState,
    getWorkspace: () => getConnectedWorkspace(),
    getAllowOutside: () =>
      Boolean(getConnectOptions().allowOutside || loadState().allowOutside),
    assertWorkspacePath,
    grokHome: grokHomeDir,
  });
}

/**
 * ACP host for a supervisor slot (FS + reverse terminal + permissions).
 * @param {any} acp
 * @param {object} slot
 * @param {string} mode
 */
function connectAgentHost(acp, slot, mode) {
  const isFullAccess =
    mode === "bypassPermissions" ||
    mode === "dontAsk" ||
    mode === "auto" ||
    slot.connectOptions.permissionMode === "bypassPermissions" ||
    slot.connectOptions.permissionMode === "dontAsk" ||
    slot.connectOptions.permissionMode === "auto";
  const fsHost = acp.createNodeFsHost({
    workspaceRoot: slot.workspace,
    extraRoots: sanitizeExtraRoots(slot.connectOptions.extraRoots, slot.workspace),
    allowOutside: Boolean(
      slot.connectOptions.allowOutside ||
      isFullAccess ||
      isRecentsWorkspace(slot.workspace)
    ),
    requestPermission: sup.createPermissionHandler(slot, mode),
    onFileWrite(change) {
      send("agent:event", {
        type: "workspace_edit",
        path: change.path,
        oldText: change.oldText,
        newText: change.newText,
        source: "filesystem",
        slotId: slot.id,
      });
    },
  });
  return Object.assign(fsHost, {
    createTerminal: (request) => terminalHost.createTerminal(request),
    terminalOutput: (request) => terminalHost.terminalOutput(request),
    releaseTerminal: (request) => terminalHost.releaseTerminal(request),
    waitForTerminalExit: (request) => terminalHost.waitForExit(request),
    killTerminal: (request) => terminalHost.killTerminal(request),
  });
}

/** Parse `grok worktree list` text into rows (best-effort). */
function parseWorktreeList(stdout) {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  for (const line of lines) {
    // common shapes: "name  path  branch" or JSON-ish — keep raw line
    if (/^name\b/i.test(line) || /^---/.test(line) || /^id\b/i.test(line)) continue;
    const parts = line.split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length >= 1) {
      rows.push({
        id: parts[0],
        path: parts[1] || "",
        branch: parts[2] || "",
        raw: line,
      });
    }
  }
  return rows;
}

function runGrokWorktree(args, cwd) {
  return new Promise((resolve) => {
    const exe = resolveGrokExecutable();
    execFile(
      exe,
      ["worktree", ...args],
      {
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...grokEnv() },
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err && err.code != null ? err.code : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

function grokHomeDir() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

/** Fallback when `grok models` unavailable — IDs only; live CLI is source of truth. */
const FALLBACK_MODELS = {
  defaultModel: "grok-4.6",
  models: [
    { value: "grok-4.6", name: "grok-4.6" },
    { value: "grok-4.5", name: "grok-4.5" },
  ],
};

/**
 * Parse `grok models` stdout → { defaultModel, models: [{value,name,default}] }.
 * Example:
 *   Default model: grok-4.6
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 */
function parseGrokModelsOutput(stdout) {
  const text = String(stdout || "");
  let defaultModel = FALLBACK_MODELS.defaultModel;
  const mDef = text.match(/Default model:\s*(\S+)/i);
  if (mDef) defaultModel = mDef[1].trim();

  const models = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    // * id  OR  - id  OR  id (default)
    const m =
      line.match(/^\s*[\*\-•]\s+([a-zA-Z0-9._-]+)/) ||
      line.match(/^\s+([a-zA-Z0-9._-]+)\s*(\(default\))?/i);
    if (!m) continue;
    const id = m[1];
    if (!id || /^(available|default|models?)$/i.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const isDefault = /\(default\)/i.test(line) || id === defaultModel;
    models.push({
      value: id,
      name: id,
      default: isDefault,
    });
  }
  if (!models.length) {
    models.push({
      value: defaultModel,
      name: defaultModel,
      default: true,
    });
  } else if (!seen.has(defaultModel)) {
    models.unshift({
      value: defaultModel,
      name: defaultModel,
      default: true,
    });
  }
  return { defaultModel, models };
}

function parseGrokVersionOutput(text) {
  const m = String(text || "").match(/\bgrok\s+v?(\d+\.\d+\.\d+[^\s]*)/i);
  return m ? m[1] : "";
}

function getGrokCliVersion() {
  try {
    const out = execFileSync(resolveGrokExecutable(), ["--version"], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, ...grokEnv() },
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return parseGrokVersionOutput(out);
  } catch (e) {
    return parseGrokVersionOutput(
      (e && (e.stdout || e.stderr || e.message)) || "",
    );
  }
}

function parseCliUpdateCheck(stdout, stderr) {
  const text = `${stdout || ""}\n${stderr || ""}`;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Live model list from CLI (cached briefly). */
let modelsCache = null;
let modelsCacheAt = 0;

function listAvailableModels(force = false) {
  const now = Date.now();
  if (!force && modelsCache && now - modelsCacheAt < 60_000) {
    return modelsCache;
  }
  try {
    const out = execFileSync(resolveGrokExecutable(), ["models"], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, ...grokEnv() },
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    modelsCache = parseGrokModelsOutput(out);
    modelsCacheAt = now;
    return modelsCache;
  } catch (e) {
    // try stderr-only login message still may list default
    const msg = e && (e.stdout || e.stderr || e.message) ? String(e.stdout || e.stderr || e.message) : "";
    if (/grok-[\w.]+/i.test(msg)) {
      modelsCache = parseGrokModelsOutput(msg);
      modelsCacheAt = now;
      return modelsCache;
    }
    modelsCache = { ...FALLBACK_MODELS, models: [...FALLBACK_MODELS.models] };
    modelsCacheAt = now;
    return modelsCache;
  }
}

/** Shared path policy for IPC FS / IDE file args. */
function sanitizeExtraRoots(list, primary) {
  const out = [];
  const primaryN = primary ? path.resolve(primary) : "";
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const resolved = path.resolve(raw.trim());
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
      if (primaryN && pathsEqual(resolved, primaryN)) continue;
      if (out.some((p) => pathsEqual(p, resolved))) continue;
      out.push(resolved);
    } catch {
      // skip
    }
  }
  return out.slice(0, 8);
}

function extrasForProject(primary) {
  if (!primary) return [];
  const state = loadState();
  const map = state.workspaceExtrasByProject || {};
  const key = path.resolve(primary);
  const found =
    map[key] ||
    Object.entries(map).find(([k]) => pathsEqual(k, key))?.[1] ||
    [];
  return sanitizeExtraRoots(found, primary);
}

function workspacePathContext() {
  const root = getConnectedWorkspace() || loadState().workspaceRoot || null;
  const extras =
    getConnectOptions().extraRoots ||
    loadState().workspaceExtraRoots ||
    extrasForProject(root);
  return {
    workspaceRoot: root,
    extraRoots: sanitizeExtraRoots(extras, root),
    allowOutside: Boolean(
      getConnectOptions().allowOutside || loadState().allowOutside,
    ),
    grokHome: grokHomeDir(),
  };
}

/** Project Files / preview: the sidebar-selected folder, not the live agent cwd. Also allows exploring any project in recentProjects. */
function explorerPathContext(targetPath) {
  const state = loadState();
  const raw = state.workspaceRoot || null;
  const root = raw && !isRecentsWorkspace(raw) ? raw : null;
  const recentProjects = Array.isArray(state.recentProjects) ? state.recentProjects : [];
  const candidateRoot = targetPath && !isRecentsWorkspace(targetPath) ? targetPath : null;
  const primaryRoot = root || candidateRoot;
  const combinedExtras = [
    ...extrasForProject(primaryRoot),
    ...recentProjects.filter((p) => p && !isRecentsWorkspace(p)),
  ];
  return {
    workspaceRoot: primaryRoot,
    extraRoots: sanitizeExtraRoots(combinedExtras, primaryRoot),
    allowOutside: Boolean(state.allowOutside),
    grokHome: grokHomeDir(),
  };
}

function guardedPath(filePath, { write = false } = {}) {
  return assertWorkspacePath(filePath, { ...workspacePathContext(), write });
}

function guardedExplorerPath(filePath, { write = false } = {}) {
  return assertWorkspacePath(filePath, { ...explorerPathContext(filePath), write });
}

/** Newest auth entry from ~/.grok/auth.json (includes secrets — main only). */
function readAuthEntry() {
  try {
    const authPath = path.join(grokHomeDir(), "auth.json");
    if (!fs.existsSync(authPath)) return { authPath, entry: null, issuerKey: null };
    const raw = readJsonFile(authPath);
    const entries = Object.entries(raw || {}).filter(
      ([, v]) => v && typeof v === "object" && !Array.isArray(v),
    );
    if (!entries.length) return { authPath, entry: null, issuerKey: null };
    entries.sort((a, b) => {
      const ta = Date.parse(a[1].create_time || 0) || 0;
      const tb = Date.parse(b[1].create_time || 0) || 0;
      return tb - ta;
    });
    const [issuerKey, entry] = entries[0];
    return { authPath, entry, issuerKey };
  } catch {
    return { authPath: path.join(grokHomeDir(), "auth.json"), entry: null, issuerKey: null };
  }
}

/**
 * Safe profile from ~/.grok/auth.json — never returns tokens or auth file paths.
 *
 * Imagine video (image_to_video) needs hosted output. When the account has
 * coding_data_retention_opt_out === true, the API often returns the same error as
 * team ZDR ("must provide output.upload_url"). Desktop surfaces this as
 * imagineVideoBlocked so /imagine-video can preflight before spending a turn.
 */
function readAuthProfile() {
  try {
    const { entry } = readAuthEntry();
    if (!entry) {
      return {
        loggedIn: false,
        codingDataRetentionOptOut: null,
        imagineVideoBlocked: false,
        imagineVideoReady: false,
      };
    }
    const email = typeof entry.email === "string" ? entry.email.trim() : "";
    const firstName = typeof entry.first_name === "string" ? entry.first_name.trim() : "";
    const lastName = typeof entry.last_name === "string" ? entry.last_name.trim() : "";
    const hasToken = Boolean(entry.key || entry.refresh_token || entry.access_token);
    const loggedIn = Boolean(hasToken || email || entry.user_id);
    // Explicit false = opted in (video OK). true = opted out (video usually blocked).
    // Missing field → null (unknown); treat as not blocked for preflight.
    const optOut =
      entry.coding_data_retention_opt_out === true
        ? true
        : entry.coding_data_retention_opt_out === false
          ? false
          : null;
    const imagineVideoBlocked = optOut === true;
    return {
      loggedIn,
      email: email || null,
      firstName: firstName || null,
      lastName: lastName || null,
      displayName:
        [firstName, lastName].filter(Boolean).join(" ") ||
        (email ? email.split("@")[0] : null) ||
        null,
      userId: entry.user_id || entry.principal_id || null,
      teamId: entry.team_id || null,
      authMode: entry.auth_mode || null,
      expiresAt: entry.expires_at || null,
      oidcIssuer: entry.oidc_issuer || null,
      codingDataRetentionOptOut: optOut,
      /** Hosted image_to_video likely fails until user opts in via Grok /privacy */
      imagineVideoBlocked,
      imagineVideoReady: Boolean(loggedIn && !imagineVideoBlocked),
      imagineVideoHint: imagineVideoBlocked
        ? "Coding data retention is opted out. Run /privacy in Grok CLI (or TUI Settings → Coding data) and Opt in, then re-login. image_to_video fails with upload_url/ZDR while opted out."
        : loggedIn
          ? "Privacy retention opted in — Imagine video should work (unless team ZDR is Active)."
          : "Sign in to use Imagine video.",
    };
  } catch (e) {
    return {
      loggedIn: false,
      codingDataRetentionOptOut: null,
      imagineVideoBlocked: false,
      imagineVideoReady: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Nested API values often use { val: n }. */
function unwrapVal(v) {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v) && "val" in v) {
    const n = Number(v.val);
    return Number.isFinite(n) ? n : v.val;
  }
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

function cliChatProxyBase() {
  return (
    process.env.GROK_CLI_CHAT_PROXY_BASE_URL ||
    "https://cli-chat-proxy.grok.com/v1"
  ).replace(/\/+$/, "");
}

/** 1 USD = 10^10 ticks (same as grok headless total_cost_usd_ticks). */
const USD_TICKS = 10_000_000_000;

function listSessionProjectDirs(sessionsRoot) {
  try {
    return fs
      .readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "session_search.sqlite")
      .map((d) => ({ name: d.name, full: path.join(sessionsRoot, d.name) }));
  } catch {
    return [];
  }
}

/** Match encoded cwd folder case-insensitively (Windows drive letter case varies). */
function resolveSessionProjectDir(sessionsRoot, workspaceRoot) {
  if (!workspaceRoot) return null;
  const enc = encodeURIComponent(path.resolve(workspaceRoot));
  const exact = path.join(sessionsRoot, enc);
  if (fs.existsSync(exact)) return exact;
  const lower = enc.toLowerCase();
  for (const p of listSessionProjectDirs(sessionsRoot)) {
    if (p.name.toLowerCase() === lower) return p.full;
  }
  // Fallback: decode names and compare resolved paths
  const want = path.resolve(workspaceRoot).toLowerCase();
  for (const p of listSessionProjectDirs(sessionsRoot)) {
    try {
      const decoded = decodeURIComponent(p.name).toLowerCase();
      if (decoded === want || path.resolve(decoded).toLowerCase() === want) return p.full;
    } catch {
      // ignore bad encoding
    }
  }
  return null;
}

function findSessionDirCandidates(workspaceRoot, sessionId) {
  const sessionsRoot = path.join(grokHomeDir(), "sessions");
  const out = [];
  const projDir = resolveSessionProjectDir(sessionsRoot, workspaceRoot);

  if (sessionId && projDir) {
    out.push(path.join(projDir, sessionId));
  }
  if (sessionId) {
    // Search any project folder for this session id
    for (const proj of listSessionProjectDirs(sessionsRoot)) {
      const p = path.join(proj.full, sessionId);
      if (fs.existsSync(path.join(p, "updates.jsonl")) || fs.existsSync(path.join(p, "summary.json"))) {
        out.push(p);
      }
    }
  }
  if (projDir) {
    try {
      const dirs = fs
        .readdirSync(projDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const full = path.join(projDir, d.name);
          let mtime = 0;
          try {
            mtime = fs.statSync(path.join(full, "updates.jsonl")).mtimeMs;
          } catch {
            try {
              mtime = fs.statSync(full).mtimeMs;
            } catch {
              mtime = 0;
            }
          }
          return { full, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const d of dirs.slice(0, 8)) out.push(d.full);
    } catch {
      // ignore
    }
  }
  // Fallback: most recent session dirs under GROK_HOME/sessions
  try {
    const all = [];
    for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!proj.isDirectory() || proj.name === "session_search.sqlite") continue;
      const projPath = path.join(sessionsRoot, proj.name);
      let children = [];
      try {
        children = fs.readdirSync(projPath, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        continue;
      }
      for (const d of children) {
        const full = path.join(projPath, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(path.join(full, "updates.jsonl")).mtimeMs;
        } catch {
          try {
            mtime = fs.statSync(full).mtimeMs;
          } catch {
            mtime = 0;
          }
        }
        all.push({ full, mtime });
      }
    }
    all.sort((a, b) => b.mtime - a.mtime);
    for (const d of all.slice(0, 6)) out.push(d.full);
  } catch {
    // ignore
  }
  return [...new Set(out)];
}

/**
 * Read cumulative session usage from updates.jsonl (same counters TUI /usage shows).
 * Usage objects appear on session/update entries with params.update.usage.
 */
function readSessionUsageFromDisk(workspaceRoot, sessionId) {
  const candidates = findSessionDirCandidates(workspaceRoot, sessionId);
  for (const dir of candidates) {
    const updatesPath = path.join(dir, "updates.jsonl");
    if (!fs.existsSync(updatesPath)) continue;
    let last = null;
    try {
      // Read tail only — usage is cumulative and the latest object is enough.
      const st = fs.statSync(updatesPath);
      const maxTail = 2 * 1024 * 1024;
      let raw;
      if (st.size > maxTail) {
        const fd = fs.openSync(updatesPath, "r");
        try {
          const buf = Buffer.alloc(maxTail);
          fs.readSync(fd, buf, 0, maxTail, st.size - maxTail);
          raw = buf.toString("utf8");
          const nl = raw.indexOf("\n");
          if (nl >= 0) raw = raw.slice(nl + 1);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        raw = fs.readFileSync(updatesPath, "utf8");
      }
      for (const line of raw.split("\n")) {
        if (!line || (!line.includes("inputTokens") && !line.includes("totalTokens"))) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const u = o?.params?.update?.usage;
        if (u && typeof u === "object" && (u.totalTokens != null || u.inputTokens != null)) {
          last = u;
        }
      }
    } catch {
      continue;
    }
    if (!last) continue;

    const costUsdTicks = Number(last.costUsdTicks) || 0;
    const apiDurationMs = Number(last.apiDurationMs) || 0;
    return {
      source: "session",
      sessionId: path.basename(dir),
      sessionDir: dir,
      inputTokens: Number(last.inputTokens) || 0,
      outputTokens: Number(last.outputTokens) || 0,
      totalTokens: Number(last.totalTokens) || 0,
      cachedReadTokens: Number(last.cachedReadTokens) || 0,
      cacheCreationTokens: Number(last.cacheCreationTokens) || 0,
      reasoningTokens: Number(last.reasoningTokens) || 0,
      modelCalls: Number(last.modelCalls) || 0,
      apiDurationMs,
      costUsdTicks,
      costUsd: costUsdTicks / USD_TICKS,
      numTurns: last.numTurns != null ? Number(last.numTurns) : null,
      modelUsage: last.modelUsage || null,
    };
  }
  return null;
}

/**
 * Build the safe, local half of Grok CLI 1.0.3 `/session-info`.
 *
 * The ACP SDK does not expose the private `x.ai/session/info` extension, so the
 * desktop derives the same stable fields from the session summary, cumulative
 * usage update, model cache, launch options, and auth metadata. Secret values
 * from auth/config files never cross IPC.
 */
function readPackageSessionInfo() {
  const workspaceRoot = getConnectedWorkspace() || loadState().workspaceRoot || null;
  const client = getClient();
  const sessionId = client?.sessionId || null;
  const connectOptions = getConnectOptions() || {};
  const state = loadState();
  const usage = readSessionUsageFromDisk(workspaceRoot, sessionId);
  const candidates = findSessionDirCandidates(workspaceRoot, sessionId);
  let summary = null;
  for (const candidate of candidates) {
    try {
      const summaryPath = path.join(candidate, "summary.json");
      if (!fs.existsSync(summaryPath)) continue;
      summary = readJsonFile(summaryPath);
      break;
    } catch {
      // Active sessions can briefly have a locked/incomplete summary. Keep the
      // runtime fields and retry on the next refresh.
    }
  }

  const model =
    summary?.current_model_id ||
    connectOptions.model ||
    state.model ||
    null;
  let modelInfo = null;
  try {
    const cache = readJsonFile(path.join(grokHomeDir(), "models_cache.json"));
    const cached = model && cache?.models && cache.models[model];
    modelInfo = cached?.info && typeof cached.info === "object" ? cached.info : null;
  } catch {
    modelInfo = null;
  }

  const auth = readAuthProfile();
  const authMethod = process.env.XAI_API_KEY
    ? "API key (XAI_API_KEY)"
    : auth.authMode
      ? String(auth.authMode).toLowerCase().includes("oauth")
        ? "OAuth"
        : String(auth.authMode)
      : auth.loggedIn
        ? "OAuth"
        : "Not signed in";
  const contextSize = Number(modelInfo?.context_window) || null;
  const contextUsed = usage?.totalTokens != null ? Number(usage.totalTokens) : null;
  const contextPercent =
    contextSize && contextUsed != null
      ? Math.min(100, Math.max(0, Math.round((contextUsed / contextSize) * 1000) / 10))
      : null;
  const title =
    summary?.generated_title ||
    summary?.session_title ||
    summary?.session_summary ||
    null;

  return {
    ok: Boolean(sessionId),
    state: client?.connectionState || "disconnected",
    title,
    shellVersion: getGrokCliVersion() || null,
    authMethod,
    sessionId,
    workingDirectory: summary?.info?.cwd || workspaceRoot || null,
    model,
    modelHash: null,
    apiBackend: modelInfo?.api_backend || null,
    sandbox: summary?.sandbox_profile || connectOptions.sandbox || state.sandbox || "CLI default",
    turns: usage?.numTurns != null ? Number(usage.numTurns) : null,
    reasoningEffort:
      summary?.reasoning_effort || connectOptions.effort || state.effort || "CLI default",
    permissionMode:
      connectOptions.permissionMode || state.permissionMode || "default",
    agentName: summary?.agent_name || "Grok Build",
    createdAt: summary?.created_at || null,
    updatedAt: summary?.updated_at || null,
    lastTurnSummary: summary?.last_turn_summary || null,
    lastRecap: summary?.last_recap || null,
    titleIsManual: Boolean(summary?.title_is_manual),
    context: {
      used: contextUsed,
      size: contextSize,
      percent: contextPercent,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cachedReadTokens: usage?.cachedReadTokens ?? null,
      cacheCreationTokens: usage?.cacheCreationTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      modelCalls: usage?.modelCalls ?? null,
      apiDurationMs: usage?.apiDurationMs ?? null,
      costUsd: usage?.costUsd ?? null,
    },
  };
}

function periodTypeLabel(periodType, startIso, endIso) {
  const t = String(periodType || "");
  if (/WEEKLY|week/i.test(t)) return "Weekly limit";
  if (/MONTHLY|month/i.test(t)) return "Monthly limit";
  if (/DAILY|day/i.test(t)) return "Daily limit";
  const a = Date.parse(startIso || 0);
  const b = Date.parse(endIso || 0);
  if (a && b && b > a) {
    const days = (b - a) / (24 * 3600 * 1000);
    if (days >= 5 && days <= 9) return "Weekly limit";
    if (days >= 25 && days <= 35) return "Monthly limit";
  }
  return "Plan limit";
}

function productLabel(name) {
  const n = String(name || "");
  if (/grokbuild|grok_build|grok-build/i.test(n)) return "Grok Build";
  if (/supergrok/i.test(n)) return "SuperGrok";
  return n || "Product";
}

/**
 * TUI `/usage` data:
 *  1) Session usage — tokens/cost/model calls from local session updates
 *  2) Plan limit — SuperGrok weekly % from GET /billing?format=credits (same as CLI)
 *     (plain /billing is a different monthly credit pool — do not use for SuperGrok %)
 * Auth token never leaves main process.
 */
async function fetchPackageUsage() {
  const manageUrl = "https://grok.com?_s=usage";
  const workspaceRoot = loadState().workspaceRoot || null;
  const sessionId = getClient()?.sessionId || null;
  const session = readSessionUsageFromDisk(workspaceRoot, sessionId);

  const { entry } = readAuthEntry();
  if (!entry) {
    return {
      ok: Boolean(session),
      error: session ? null : "Not signed in. Login first (Settings → Login).",
      manageUrl,
      session,
      plan: null,
      account: null,
    };
  }
  const token = entry.key || entry.access_token;
  if (!token) {
    return {
      ok: Boolean(session),
      error: session ? null : "No session token. Run Login again.",
      manageUrl,
      session,
      plan: null,
      account: null,
    };
  }

  const base = cliChatProxyBase();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": `grok/${app.getVersion?.() || "0.5"}`,
  };

  async function getJson(path) {
    const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, { method: "GET", headers });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return { status: res.status, body };
  }

  try {
    // CLI uses /billing?format=credits for SuperGrok weekly % (see grok billing.rs).
    // Plain /billing returns monthly pool (used/monthlyLimit) — different metric.
    const [creditsRes, userRes, settingsRes] = await Promise.all([
      getJson("/billing?format=credits"),
      getJson("/user?include=subscription"),
      getJson("/settings"),
    ]);

    if (creditsRes.status === 401) {
      return {
        ok: Boolean(session),
        error: "Session expired or invalid. Login again.",
        manageUrl,
        session,
        plan: null,
        account: null,
      };
    }

    const cfg =
      creditsRes.status >= 200 && creditsRes.status < 300
        ? creditsRes.body?.config || creditsRes.body || {}
        : {};
    const settings =
      settingsRes.status >= 200 && settingsRes.status < 300 ? settingsRes.body || {} : {};
    const user = userRes.status >= 200 && userRes.status < 300 ? userRes.body || {} : {};

    const periodObj =
      cfg.currentPeriod && typeof cfg.currentPeriod === "object" ? cfg.currentPeriod : null;
    const periodType = periodObj?.type || cfg.currentPeriod || null;
    const periodStart = periodObj?.start || cfg.billingPeriodStart || null;
    const periodEnd = periodObj?.end || cfg.billingPeriodEnd || null;

    // Server percent for SuperGrok weekly (do NOT recompute from monthly used/limit)
    let creditUsagePercent = cfg.creditUsagePercent;
    if (creditUsagePercent != null) creditUsagePercent = Number(creditUsagePercent);
    if (!Number.isFinite(creditUsagePercent)) {
      const monthlyLimit = unwrapVal(cfg.monthlyLimit);
      const used = unwrapVal(cfg.used);
      if (monthlyLimit != null && monthlyLimit > 0 && used != null) {
        creditUsagePercent = Math.min(
          100,
          Math.round((Number(used) / Number(monthlyLimit)) * 1000) / 10,
        );
      } else {
        creditUsagePercent = null;
      }
    }

    const onDemandCap = unwrapVal(cfg.onDemandCap);
    const onDemandUsed = unwrapVal(cfg.onDemandUsed);
    const prepaidBalance = unwrapVal(cfg.prepaidBalance);
    const monthlyLimit = unwrapVal(cfg.monthlyLimit);
    const used = unwrapVal(cfg.used);
    const remaining =
      monthlyLimit != null && used != null
        ? Math.max(0, Number(monthlyLimit) - Number(used))
        : null;

    const subscriptionTier =
      settings.subscription_tier_display ||
      user.subscriptionTier ||
      user.subscription_tier ||
      null;

    const limitKind = periodTypeLabel(periodType, periodStart, periodEnd);
    // Match account UI: "SuperGrok weekly limit" when tier + weekly
    let limitLabel = limitKind;
    if (subscriptionTier && /week/i.test(limitKind)) {
      limitLabel = `${subscriptionTier} weekly limit`;
    } else if (subscriptionTier && /month/i.test(limitKind)) {
      limitLabel = `${subscriptionTier} monthly limit`;
    }

    const productUsage = Array.isArray(cfg.productUsage)
      ? cfg.productUsage.map((p) => ({
          product: p?.product || p?.name || null,
          label: productLabel(p?.product || p?.name),
          usagePercent:
            p?.usagePercent != null
              ? Number(p.usagePercent)
              : p?.percent != null
                ? Number(p.percent)
                : null,
        }))
      : [];

    const planOk = creditsRes.status >= 200 && creditsRes.status < 300;
    const plan = planOk
      ? {
          limitLabel,
          limitKind,
          currentPeriod: periodType,
          creditUsagePercent,
          monthlyLimit,
          used,
          remaining,
          onDemandCap,
          onDemandUsed,
          prepaidBalance,
          isUnifiedBillingUser: cfg.isUnifiedBillingUser ?? null,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          nextReset: periodEnd,
          productUsage,
          topUpMethod: cfg.topUpMethod || null,
          source: "billing?format=credits",
        }
      : null;

    return {
      ok: planOk || Boolean(session),
      error: planOk
        ? null
        : creditsRes.status
          ? `Billing API HTTP ${creditsRes.status}`
          : null,
      fetchedAt: new Date().toISOString(),
      manageUrl: settings.usage_billing_redirect_url || manageUrl,
      upgradeUrl: "https://grok.com/supergrok?referrer=grok-build",
      account: {
        email: user.email || entry.email || null,
        firstName: user.firstName || entry.first_name || null,
        lastName: user.lastName || entry.last_name || null,
        teamName: user.teamName || null,
        hasGrokCodeAccess: user.hasGrokCodeAccess ?? null,
        principalType: user.principalType || entry.principal_type || null,
        subscriptionTier,
      },
      session,
      plan,
      billing: plan,
    };
  } catch (e) {
    return {
      ok: Boolean(session),
      error: e instanceof Error ? e.message : String(e),
      manageUrl,
      session,
      plan: null,
      account: null,
    };
  }
}

async function runGrokCliArgs(list, { timeoutMs = 60_000, loginFlow = false } = {}) {
  const mod = await loadSessions();
  const args = Array.isArray(list) ? list.map(String) : [];
  if (!loginFlow) {
    return mod.runGrokCli({
      executable: resolveGrokExecutable(),
      args,
      cwd: loadState().workspaceRoot || undefined,
      environment: grokEnv(),
      timeoutMs,
    });
  }
  // Login: open device/OAuth URL; wait up to 5 min
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(resolveGrokExecutable(), args.length ? args : ["login"], {
      cwd: loadState().workspaceRoot || undefined,
      env: grokEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let openedAuthUrl = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const tryOpen = (chunk) => {
      const m = String(chunk).match(/https:\/\/[^\s]+/g);
      if (!m || openedAuthUrl) return;
      for (const u of m) {
        if (/oauth|device|auth|x\.ai|accounts/i.test(u)) {
          try {
            const safe = assertSafeExternalUrl(u.replace(/[)\].,]+$/, ""));
            openedAuthUrl = true;
            void shell.openExternal(safe);
          } catch {
            // ignore non-https
          }
          break;
        }
      }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c) => {
      stdout = `${stdout}${c}`.slice(-200_000);
      tryOpen(c);
    });
    child.stderr?.on("data", (c) => {
      stderr = `${stderr}${c}`.slice(-50_000);
      tryOpen(c);
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: "", stderr: err.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, openedAuthUrl });
    });
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function packageFile(name, file) {
  // Prefer bundled single-file for acp-client (includes @agentclientprotocol/sdk).
  // Dev: monorepo packages/<name>/dist
  // Packaged: process.resourcesPath/packages/<name>/dist
  const candidates = [
    path.join(process.resourcesPath || "", "packages", name, "dist", file),
    path.join(__dirname, "..", "..", "..", "packages", name, "dist", file),
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function loadAcp() {
  const bundled = packageFile("acp-client", "bundle.mjs");
  const plain = packageFile("acp-client", "index.js");
  const target = bundled || plain;
  if (!target) {
    throw new Error(
      "ACP client package not found (bundle.mjs / index.js). Rebuild packages/acp-client.",
    );
  }
  return import(pathToFileURL(target).href);
}

async function loadSessions() {
  const target = packageFile("sessions", "index.js");
  if (!target) throw new Error("Sessions package dist not found");
  return import(pathToFileURL(target).href);
}

function isClientWarm() {
  return getSupervisor().isClientWarm();
}

async function connectAgent(workspaceRoot, options = {}, meta = {}) {
  return getSupervisor().connect(workspaceRoot, options || {}, meta || {});
}

async function disconnectAgent() {
  await getSupervisor().disconnectAll();
  terminalHost.dispose();
  userShell.stop();
}

function applyNativeTheme(theme) {
  // theme: system | dark | light
  if (theme === "light") nativeTheme.themeSource = "light";
  else if (theme === "dark") nativeTheme.themeSource = "dark";
  else nativeTheme.themeSource = "system";
}

function resolveAppIcon() {
  // Packaged: resources next to app.asar; dev: apps/desktop/build
  const candidates = [
    path.join(process.resourcesPath || "", "build", "icon.ico"),
    path.join(process.resourcesPath || "", "icon.ico"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(__dirname, "..", "build", "icon.png"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return path.resolve(p);
    } catch {
      // ignore
    }
  }
  return undefined;
}

/** Load multi-size ICO/PNG for window chrome + taskbar (dev + packaged). */
function loadAppNativeIcon() {
  const p = resolveAppIcon();
  if (!p) return { path: undefined, image: undefined };
  try {
    const image = nativeImage.createFromPath(p);
    if (!image || image.isEmpty()) {
      return { path: p, image: undefined };
    }
    return { path: p, image };
  } catch {
    return { path: p, image: undefined };
  }
}

function applyWindowIcon(win) {
  if (!win || win.isDestroyed()) return;
  const { path: iconPath, image } = loadAppNativeIcon();
  if (image) {
    try {
      win.setIcon(image);
    } catch {
      // ignore
    }
  } else if (iconPath) {
    try {
      win.setIcon(iconPath);
    } catch {
      // ignore
    }
  }
}

function titleBarOverlayOpts(isDark) {
  return {
    color: isDark ? "#0e0e0e" : "#f4f5f7",
    symbolColor: isDark ? "#c8c8c8" : "#333333",
    height: 36,
  };
}

function createWindow() {
  const state = loadState();
  applyNativeTheme(state.theme || "system");
  const isDark = nativeTheme.shouldUseDarkColors;
  const { path: iconPath, image: iconImage } = loadAppNativeIcon();
  mainWindow = new BrowserWindow({
    width: state.windowWidth || 1440,
    height: state.windowHeight || 900,
    minWidth: 1000,
    minHeight: 640,
    title: "Grok Build",
    backgroundColor: isDark ? "#0e0e0e" : "#f4f5f7",
    show: false,
    // Codex-style: content under title bar; OS min/max/close via overlay
    titleBarStyle: "hidden",
    titleBarOverlay: titleBarOverlayOpts(isDark),
    autoHideMenuBar: true,
    // Prefer nativeImage for Windows; path fallback for others
    ...(iconImage
      ? { icon: iconImage }
      : iconPath
        ? { icon: iconPath }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Needed so renderer can call getUserMedia / speech recognition
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  applyWindowIcon(mainWindow);
  try {
    installMediaPermissionHandlers(mainWindow.webContents.session);
  } catch {
    // ignore
  }
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("resize", () => {
    if (!mainWindow) return;
    const [w, h] = mainWindow.getSize();
    saveState({ windowWidth: w, windowHeight: h });
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** @type {Electron.MenuItemConstructorOptions[]} */
let appMenuTemplate = [];

function buildAppMenu() {
  appMenuTemplate = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => send("menu:command", { cmd: "openProject" }),
        },
        {
          label: "New Conversation",
          accelerator: "CmdOrCtrl+N",
          click: () => send("menu:command", { cmd: "newSession" }),
        },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: () => send("menu:command", { cmd: "settings" }),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Theme",
          accelerator: "CmdOrCtrl+Shift+T",
          click: () => send("menu:command", { cmd: "toggleTheme" }),
        },
        {
          label: "Focus Prompt",
          accelerator: "CmdOrCtrl+L",
          click: () => send("menu:command", { cmd: "focusPrompt" }),
        },
        {
          label: "Toggle Left Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => send("menu:command", { cmd: "sidebar" }),
        },
        {
          label: "Toggle Right Panel",
          accelerator: "CmdOrCtrl+P",
          click: () => send("menu:command", { cmd: "panel" }),
        },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+T",
          click: () => send("menu:command", { cmd: "terminal" }),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Agent",
      submenu: [
        {
          label: "Connect",
          click: () => send("menu:command", { cmd: "connect" }),
        },
        {
          label: "Disconnect",
          click: () => send("menu:command", { cmd: "disconnect" }),
        },
        {
          label: "Cancel Turn",
          accelerator: "Escape",
          click: () => send("menu:command", { cmd: "cancel" }),
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About Grok Build",
          click: () => send("menu:command", { cmd: "about" }),
        },
        {
          label: "Open Grok Build IDE",
          click: async () => {
            const res = await openIdeApp();
            if (res.ok) return;
            if (res.reason === "not_installed") {
              const box = await dialog.showMessageBox(mainWindow, {
                type: "info",
                title: res.productName || "Grok Build IDE",
                message: `${res.productName || "Grok Build IDE"} is not installed`,
                detail:
                  `Expected install:\n${res.expectedDir || PRODUCT_PATHS.ide.installDir}\n\n` +
                  `Executable: Grok Build IDE.exe\n\n` +
                  `You can install from the download page (placeholder until landing is ready), ` +
                  `or set Settings → IDE path / GROK_BUILD_IDE to your install.`,
                buttons: ["Open download page", "Cancel"],
                defaultId: 0,
                cancelId: 1,
              });
              if (box.response === 0 && res.downloadUrl) {
                void shell.openExternal(res.downloadUrl);
              }
            } else {
              void dialog.showMessageBox(mainWindow, {
                type: "error",
                message: "Could not launch IDE",
                detail: res.message || String(res.reason || "unknown"),
              });
            }
          },
        },
      ],
    },
  ];
  // Keep accelerators; bar is hidden (titleBar hosts custom File/Edit/… + layout icons)
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate));
}

/** Popup a top-level menu by label (custom titlebar menus). */
function popupAppMenu(label, x, y) {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return { ok: false };
  const item = appMenuTemplate.find(
    (t) => t && typeof t === "object" && "label" in t && t.label === label,
  );
  if (!item || !item.submenu) return { ok: false, message: "menu not found" };
  const menu = Menu.buildFromTemplate(
    Array.isArray(item.submenu) ? item.submenu : [],
  );
  menu.popup({
    window: win,
    x: Number.isFinite(x) ? Math.round(x) : undefined,
    y: Number.isFinite(y) ? Math.round(y) : undefined,
  });
  return { ok: true };
}

// Windows taskbar / Jump List identity (must match package.json build.appId)
if (process.platform === "win32") {
  app.setAppUserModelId("local.grok.build.desktop");
}

/**
 * Allow microphone / media for voice input (Web Speech + getUserMedia).
 * Without this, Chromium reports permission denied ("not-allowed").
 */
function installMediaPermissionHandlers(ses) {
  const s = ses || session.defaultSession;
  s.setPermissionRequestHandler((_wc, permission, callback, details) => {
    // Electron: "media" covers mic/camera; some builds also surface "mediaKeySystem"
    if (permission === "media" || permission === "mediaKeySystem") {
      const types = details?.mediaTypes || [];
      // Allow audio-only or unspecified media (speech recognition)
      if (!types.length || types.includes("audio") || types.includes("video")) {
        callback(true);
        return;
      }
    }
    // Deny everything else by default (secure baseline)
    if (
      permission === "clipboard-sanitized-write" ||
      permission === "clipboard-read" ||
      permission === "notifications" ||
      permission === "fullscreen"
    ) {
      callback(true);
      return;
    }
    callback(false);
  });
  s.setPermissionCheckHandler((_wc, permission, _origin, details) => {
    if (permission === "media" || permission === "mediaKeySystem") {
      const types = details?.mediaTypes || [];
      if (!types.length || types.includes("audio") || types.includes("video")) {
        return true;
      }
    }
    if (
      permission === "clipboard-sanitized-write" ||
      permission === "clipboard-read" ||
      permission === "notifications" ||
      permission === "fullscreen"
    ) {
      return true;
    }
    return false;
  });
  // Display capture not needed; leave default
}

/** Open OS microphone privacy settings (Windows / macOS). */
async function openOsMicrophoneSettings() {
  try {
    if (process.platform === "win32") {
      await shell.openExternal("ms-settings:privacy-microphone");
      return { ok: true, platform: "win32" };
    }
    if (process.platform === "darwin") {
      await shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      );
      return { ok: true, platform: "darwin" };
    }
    return { ok: false, message: "Open your system privacy settings and allow microphone access." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

app.whenReady().then(() => {
  installMediaPermissionHandlers(session.defaultSession);
  // macOS: ask for mic entitlement early (no-op on Windows)
  try {
    if (process.platform === "darwin" && systemPreferences?.askForMediaAccess) {
      void systemPreferences.askForMediaAccess("microphone");
    }
  } catch {
    // ignore
  }

  buildAppMenu();
  createWindow();
  // Also bind on the window session (same as default for loadFile, but explicit)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      installMediaPermissionHandlers(mainWindow.webContents.session);
    }
  } catch {
    // ignore
  }
  try {
    ensurePhaseC();
  } catch {
    // handlers call ensurePhaseC lazily
  }

  ipcMain.handle("app:openMicSettings", async () => openOsMicrophoneSettings());

  ipcMain.handle("app:getBootstrap", () => {
    const state = loadState();
    // Drop stale paths (moved/deleted drives) so auto-connect does not spam errors.
    let workspaceRoot = state.workspaceRoot || null;
    if (workspaceRoot && !fs.existsSync(workspaceRoot)) {
      workspaceRoot = null;
      saveState({ workspaceRoot: null });
    }
    const recentsWs = getRecentsWorkspace();
    const recentProjects = (state.recentProjects || []).filter(
      (p) =>
        typeof p === "string" &&
        p &&
        fs.existsSync(p) &&
        !isRecentsWorkspace(p),
    );
    if (recentProjects.length !== (state.recentProjects || []).length) {
      saveState({ recentProjects });
    }
    // Never treat desktop-recents as the restored "open project"
    if (workspaceRoot && isRecentsWorkspace(workspaceRoot)) {
      workspaceRoot = null;
      saveState({ workspaceRoot: null });
    }
    const modelInfo = listAvailableModels(false);
    // Prefer saved model if still offered; else CLI default (never empty "system default")
    let model = state.model || "";
    if (model && !modelInfo.models.some((m) => m.value === model)) {
      model = modelInfo.defaultModel;
    }
    if (!model) model = modelInfo.defaultModel;

    return {
      product: "Grok Build",
      version: app.getVersion() || "0.5.0",
      executable: resolveGrokExecutable(),
      cliVersion: getGrokCliVersion(),
      workspaceRoot,
      extraRoots: extrasForProject(workspaceRoot),
      permissionMode: normalizePermissionMode(state.permissionMode),
      model,
      defaultModel: modelInfo.defaultModel,
      models: modelInfo.models,
      effort: state.effort || "",
      sandbox: state.sandbox || "",
      tools: state.tools || "",
      deniedTools: state.deniedTools || "",
      worktree: state.worktree || "",
      worktreeRef: state.worktreeRef || "",
      rules: state.rules || "",
      maxTurns: state.maxTurns || 0,
      disableWebSearch: Boolean(state.disableWebSearch),
      experimentalMemory: Boolean(state.experimentalMemory),
      autoConnect: state.autoConnect !== false,
      allowOutside: Boolean(state.allowOutside),
      showReasoning: state.showReasoning !== false,
      telemetryOptIn: Boolean(state.telemetryOptIn),
      theme: state.theme || "system",
      updateUrl: state.updateUrl || "",
      /** P2 — local feed path when no remote URL (dev / published dist) */
      localUpdateFeed: resolveLocalUpdateFeedPath(),
      idePath: (() => {
        const ide = resolveIdeInstall();
        return state.idePath || ide.executable || ide.installDir || "";
      })(),
      ideInstall: (() => {
        const ide = resolveIdeInstall();
        return {
          installed: ide.installed,
          executable: ide.executable,
          installDir: ide.installDir,
          productName: ide.productName,
          downloadUrl: ide.downloadUrl,
          desktopInstallDir: PRODUCT_PATHS.desktop.installDir,
          desktopExe: PRODUCT_PATHS.desktop.exeNames[0],
        };
      })(),
      recentProjects,
      /** Agent cwd when UI has no project (Recents chats) */
      recentsWorkspace: recentsWs,
      platform: process.platform,
      isPackaged: app.isPackaged,
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      auth: readAuthProfile(),
    };
  });

  ipcMain.handle("app:getAuthProfile", () => readAuthProfile());

  /** Package usage (/usage) — same billing data as Grok TUI. Never returns tokens. */
  ipcMain.handle("app:getUsage", async () => fetchPackageUsage());

  /** Safe local metadata matching Grok CLI 1.0.3 `/session-info`. */
  ipcMain.handle("app:getSessionInfo", () => readPackageSessionInfo());

  /** Workspace/profile skills exposed as Desktop slash shortcuts. */
  ipcMain.handle("app:getSlashCommands", async (_e, requestedWorkspace) => {
    const raw = typeof requestedWorkspace === "string" ? requestedWorkspace.trim() : "";
    const workspaceRoot =
      raw && fs.existsSync(raw) && fs.statSync(raw).isDirectory()
        ? path.resolve(raw)
        : loadState().workspaceRoot || "";
    return loadLocalSlashCommands({
      executable: resolveGrokExecutable(),
      workspaceRoot,
      cwd: workspaceRoot || getRecentsWorkspace(),
      grokHome: grokHomeDir(),
      environment: grokEnv(),
    });
  });

  function resolveTrustFolder(folder) {
    const raw = typeof folder === "string" ? folder.trim() : "";
    const candidate = raw || loadState().workspaceRoot || "";
    if (!candidate || !fs.existsSync(candidate)) return "";
    try {
      if (!fs.statSync(candidate).isDirectory()) return "";
    } catch {
      return "";
    }
    const resolved = path.resolve(candidate);
    const recents = getRecentsWorkspace();
    if (recents && path.resolve(recents).toLowerCase() === resolved.toLowerCase()) return "";
    return resolved;
  }

  ipcMain.handle("app:getFolderTrust", async (_e, folder) => {
    const root = resolveTrustFolder(folder);
    if (!root) return { ok: false, error: "Open a project folder first." };
    return { ok: true, ...getFolderTrust(grokHomeDir(), root) };
  });

  ipcMain.handle("app:setFolderTrust", async (_e, folder, trusted) => {
    const root = resolveTrustFolder(folder);
    if (!root) return { ok: false, error: "Open a project folder first." };
    return { ok: true, ...setFolderTrust(grokHomeDir(), root, Boolean(trusted)) };
  });

  ipcMain.handle("app:quit", async () => {
    app.quit();
    return { ok: true };
  });

  ipcMain.handle("app:login", async () => {
    const result = await runGrokCliArgs(["login"], {
      timeoutMs: 5 * 60_000,
      loginFlow: true,
    });
    const profile = readAuthProfile();
    return {
      ok: profile.loggedIn || result.code === 0,
      code: result.code,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      openedAuthUrl: Boolean(result.openedAuthUrl),
      profile,
    };
  });

  ipcMain.handle("app:logout", async () => {
    const result = await runGrokCliArgs(["logout"], { timeoutMs: 30_000 });
    const profile = readAuthProfile();
    return {
      ok: !profile.loggedIn || result.code === 0,
      code: result.code,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      profile,
    };
  });

  ipcMain.handle("app:saveSettings", async (_e, settings) => {
    const s = settings || {};
    const theme = s.theme || "system";
    applyNativeTheme(theme);
    saveState({
      permissionMode: normalizePermissionMode(s.permissionMode),
      model: s.model || "",
      effort: s.effort || "",
      sandbox: s.sandbox || "",
      tools: s.tools || "",
      deniedTools: s.deniedTools || "",
      worktree: s.worktree || "",
      worktreeRef: s.worktreeRef || "",
      rules: s.rules || "",
      maxTurns: Number(s.maxTurns) || 0,
      disableWebSearch: Boolean(s.disableWebSearch),
      experimentalMemory: Boolean(s.experimentalMemory),
      autoConnect: Boolean(s.autoConnect),
      allowOutside: Boolean(s.allowOutside),
      showReasoning: s.showReasoning !== false,
      telemetryOptIn: Boolean(s.telemetryOptIn),
      theme,
      updateUrl: s.updateUrl || "",
      idePath: typeof s.idePath === "string" ? s.idePath.trim() : loadState().idePath || "",
    });
    return { ok: true, shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
  });

  ipcMain.handle("app:setTheme", async (_e, theme) => {
    const t = theme || "system";
    applyNativeTheme(t);
    saveState({ theme: t });
    const dark = nativeTheme.shouldUseDarkColors;
    try {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.setTitleBarOverlay) {
        mainWindow.setTitleBarOverlay(titleBarOverlayOpts(dark));
      }
    } catch {
      // ignore (older electron / non-win)
    }
    return { ok: true, theme: t, shouldUseDarkColors: dark };
  });

  /** Custom titlebar: popup File/Edit/View/… under cursor */
  ipcMain.handle("menu:popup", async (_e, label, x, y) =>
    popupAppMenu(String(label || ""), x, y),
  );

  function resolveLocalUpdateFeedPath() {
    const candidates = [
      path.join(process.resourcesPath || "", "latest.json"),
      path.join(app.getAppPath(), "latest.json"),
      path.join(__dirname, "..", "..", "..", "dist", "latest.json"),
      path.join(__dirname, "..", "..", "..", "dist", app.getVersion() || "", "latest.json"),
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      } catch {
        // ignore
      }
    }
    return "";
  }

  function compareSemver(a, b) {
    const pa = String(a).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function parseUpdateFeedData(data, current) {
    const latest = String(data.version || data.latest || "").trim();
    const download = data.url || data.downloadUrl || data.href || data.path || "";
    const notes = data.notes || data.changelog || "";
    if (!latest) {
      return { ok: true, current, update: false, message: "Feed has no version field." };
    }
    const newer = compareSemver(latest, current) > 0;
    return {
      ok: true,
      current,
      latest,
      update: newer,
      url: download,
      notes,
      message: newer
        ? `Update available: ${latest} (you have ${current})`
        : `Up to date (${current})`,
    };
  }

  ipcMain.handle("app:checkUpdate", async (_e, feedUrl) => {
    const url = String(feedUrl || loadState().updateUrl || "").trim();
    const current = app.getVersion() || "0.5.0";
    // P2: fall back to local dist/latest.json when no remote feed
    if (!url) {
      const local = resolveLocalUpdateFeedPath();
      if (local) {
        try {
          const data = readJsonFile(local);
          const parsed = parseUpdateFeedData(data, current);
          return { ...parsed, source: "local", feedPath: local };
        } catch (e) {
          return {
            ok: false,
            current,
            update: false,
            message: e instanceof Error ? e.message : String(e),
            source: "local",
          };
        }
      }
      return {
        ok: true,
        current,
        update: false,
        message:
          "No update feed configured. Set Update feed URL in Settings, or publish dist/latest.json.",
        source: "none",
      };
    }
    try {
      // file:// or absolute path
      if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("\\\\") || url.startsWith("file:")) {
        const filePath = url.startsWith("file:")
          ? decodeURIComponent(url.replace(/^file:\/\//i, "").replace(/^\/([a-zA-Z]:)/, "$1"))
          : url;
        const data = readJsonFile(filePath);
        return { ...parseUpdateFeedData(data, current), source: "file" };
      }
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = stripBom(await res.text());
      const data = JSON.parse(text);
      return { ...parseUpdateFeedData(data, current), source: "remote" };
    } catch (e) {
      return {
        ok: false,
        current,
        update: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });

  ipcMain.handle("app:pickWorkspace", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory"],
      title: "Open project",
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = path.resolve(result.filePaths[0]);
    if (isRecentsWorkspace(root)) {
      // Don't open the internal recents folder as a "project"
      saveState({ workspaceRoot: null });
      return null;
    }
    const state = loadState();
    const recent = touchRecentProject(state.recentProjects, root);
    saveState({ workspaceRoot: root, recentProjects: recent });
    return root;
  });

  /** Set UI project (null = No project / Recents). Does not connect agent. */
  ipcMain.handle("app:setWorkspace", async (_e, workspaceRoot, extraRoots) => {
    const raw = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!raw || isRecentsWorkspace(raw)) {
      saveState({ workspaceRoot: null, workspaceExtraRoots: [] });
      return {
        ok: true,
        workspaceRoot: null,
        extraRoots: [],
        isRecents: true,
        recentsWorkspace: getRecentsWorkspace(),
        recentProjects: sanitizeRecentProjects(loadState().recentProjects),
      };
    }
    if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) {
      throw new Error(`Not a folder: ${raw}`);
    }
    const root = path.resolve(raw);
    const state = loadState();
    const extras =
      extraRoots === undefined ? extrasForProject(root) : sanitizeExtraRoots(extraRoots, root);
    const extrasMap = { ...(state.workspaceExtrasByProject || {}) };
    extrasMap[root] = extras;
    const recent = touchRecentProject(state.recentProjects, root);
    saveState({
      workspaceRoot: root,
      recentProjects: recent,
      workspaceExtraRoots: extras,
      workspaceExtrasByProject: extrasMap,
    });
    return {
      ok: true,
      workspaceRoot: root,
      extraRoots: extras,
      isRecents: false,
      recentsWorkspace: getRecentsWorkspace(),
      recentProjects: recent,
    };
  });

  /** Persist drag-and-drop project order (sidebar). */
  ipcMain.handle("app:setRecentProjects", async (_e, paths) => {
    const recent = sanitizeRecentProjects(paths);
    saveState({ recentProjects: recent });
    return { ok: true, recentProjects: recent };
  });

  ipcMain.handle("app:pickFiles", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      title: "Attach files",
    });
    if (result.canceled) return [];
    return result.filePaths.map((p) => ({
      uri: pathToFileURL(p).href,
      name: path.basename(p),
      path: p,
    }));
  });

  ipcMain.handle("agent:connect", async (_e, workspaceRoot, options) => {
    // Empty / null → Recents workspace (chat without opening a project)
    const { root, isRecents } = resolveConnectWorkspace(workspaceRoot);
    const result = await connectAgent(root, options || {});
    return {
      ok: true,
      reused: Boolean(result?.reused),
      sessionId: result?.sessionId || getClient()?.sessionId,
      slotId: result?.slotId || "primary",
      workspace: root,
      isRecents,
    };
  });

  /** Phase A3 / A6 — status + explicit reconnect without full UI dance */
  ipcMain.handle("agent:status", async () => getSupervisor().status());

  ipcMain.handle("agent:reconnect", async () => {
    const sup = getSupervisor();
    if (!sup.connectedWorkspace && !loadState().workspaceRoot) {
      throw new Error("No workspace to reconnect.");
    }
    const root = sup.connectedWorkspace || loadState().workspaceRoot;
    return connectAgent(root, { ...sup.connectOptions, forceRestart: true });
  });

  ipcMain.handle("agent:disconnect", async () => {
    await disconnectAgent();
    return { ok: true };
  });

  /** Marketplace catalog from ~/.grok/marketplace-cache */
  ipcMain.handle("plugin:catalog", async () => {
    try {
      return loadMarketplaceCatalog();
    } catch (e) {
      return {
        ok: false,
        marketplaces: [],
        plugins: [],
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });

  /** P1 — multi-slot supervisor API */
  ipcMain.handle("agent:slots", async () => getSupervisor().status());
  ipcMain.handle("agent:spawnSlot", async (_e, workspaceRoot, options, label) => {
    const preferred =
      (typeof workspaceRoot === "string" && workspaceRoot.trim()) ||
      getConnectedWorkspace() ||
      loadState().workspaceRoot ||
      "";
    const { root } = resolveConnectWorkspace(preferred);
    return getSupervisor().spawnSlot(root, options || {}, label);
  });
  ipcMain.handle("agent:setActiveSlot", async (_e, slotId) =>
    getSupervisor().setActive(String(slotId || "primary")),
  );
  ipcMain.handle("agent:stopSlot", async (_e, slotId) => {
    const id = String(slotId || "");
    if (!id || id === "primary") {
      await getSupervisor().disconnect("primary");
      return { ok: true, slotId: "primary" };
    }
    return getSupervisor().disconnect(id, { remove: true });
  });

  ipcMain.handle("agent:prompt", async (_e, text, attachments) => {
    const client = getClient();
    if (!client) throw new Error("Not connected.");
    ensureTelemetry().mark("prompt_turn");
    ensureTelemetry().mark("first_token");
    if (client.__desktopTelemetry) {
      client.__desktopTelemetry.setPromptMarkActive(true);
      client.__desktopTelemetry.resetFirstToken();
    }
    try {
      await client.prompt(String(text || ""), Array.isArray(attachments) ? attachments : []);
      return { ok: true };
    } catch (err) {
      ensureTelemetry().clearMark("prompt_turn");
      ensureTelemetry().clearMark("first_token");
      throw err;
    }
  });

  /** Phase D2/D4 — control plane + telemetry */
  ipcMain.handle("app:listModels", async () => listAvailableModels(true));
  ipcMain.handle("app:cliStatus", async () => {
    const currentVersion = getGrokCliVersion();
    const models = listAvailableModels(true);
    let check = null;
    try {
      const r = await runGrokCliArgs(["update", "--check", "--json"], {
        timeoutMs: 30_000,
      });
      check = parseCliUpdateCheck(r.stdout, r.stderr);
    } catch {
      check = null;
    }
    const latestVersion = String(check?.latestVersion || currentVersion || "").trim();
    const current = String(check?.currentVersion || currentVersion || "").trim();
    return {
      ok: true,
      executable: resolveGrokExecutable(),
      currentVersion: current,
      latestVersion,
      updateAvailable: Boolean(check?.updateAvailable),
      channel: check?.channel || "stable",
      defaultModel: models.defaultModel,
      models: models.models,
      error: check?.error || null,
    };
  });
  ipcMain.handle("app:updateCli", async () => {
    const before = getGrokCliVersion();
    const r = await runGrokCliArgs(["update"], { timeoutMs: 5 * 60_000 });
    modelsCache = null;
    modelsCacheAt = 0;
    const models = listAvailableModels(true);
    const version = getGrokCliVersion() || before;
    return {
      ok: r.code === 0 || r.code == null,
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      version,
      previousVersion: before,
      defaultModel: models.defaultModel,
      models: models.models,
    };
  });
  ipcMain.handle("app:health", async () => ensureControlPlane().health());
  ipcMain.handle("app:controlPlane", async () => ensureControlPlane().snapshot());
  ipcMain.handle("telemetry:getSummary", async () => ensureTelemetry().summary());
  ipcMain.handle("telemetry:setEnabled", async (_e, enabled) => {
    ensureTelemetry().setEnabled(Boolean(enabled));
    return { ok: true, enabled: ensureTelemetry().enabled };
  });
  ipcMain.handle("telemetry:isEnabled", async () => ({
    enabled: ensureTelemetry().enabled,
  }));

  ipcMain.handle("agent:cancel", async () => {
    const client = getClient();
    if (client) await client.cancel();
    return { ok: true };
  });

  /** Phase B5 — resolve inline permission from renderer */
  ipcMain.handle("agent:resolvePermission", async (_e, requestId, optionId) =>
    getSupervisor().resolvePermission(requestId, optionId),
  );

  /** Phase B7 — git strip */
  ipcMain.handle("git:status", async (_e, workspaceRoot) => {
    const root = workspaceRoot || getConnectedWorkspace() || loadState().workspaceRoot;
    const status = await getGitStatus(root);
    if (status.isRepo) {
      const pr = await getPullRequest(root);
      if (pr) status.pr = pr;
    }
    return status;
  });

  /** P2 — create PR via gh (optional) */
  ipcMain.handle("git:createPr", async (_e, workspaceRoot, opts) => {
    const root = workspaceRoot || getConnectedWorkspace() || loadState().workspaceRoot;
    if (!root) throw new Error("Open a project first.");
    return createPullRequest(root, opts || {});
  });

  ipcMain.handle("agent:newSession", async () => {
    const client = getClient();
    if (!client) throw new Error("Not connected.");
    client.setReasoningEffort?.(getConnectOptions()?.effort);
    await client.newSession();
    return { ok: true, sessionId: client.sessionId };
  });

  ipcMain.handle("agent:setSessionConfig", async (_e, configId, value) => {
    const client = getClient();
    if (!client) throw new Error("Not connected.");
    await client.setSessionConfigOption(String(configId), value);
    return { ok: true };
  });

  ipcMain.handle("agent:listSessions", async (_e, cwd) => {
    const mod = await loadSessions();
    return mod.listLocalSessions({
      ...(cwd ? { cwd } : {}),
      limit: 40,
      grokHome: grokEnv().GROK_HOME,
    });
  });

  ipcMain.handle("agent:moveSession", async (_e, sessionId, targetWorkspace) => {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("Session id is required.");
    const requested = typeof targetWorkspace === "string" ? targetWorkspace.trim() : "";
    const { root, isRecents } = resolveConnectWorkspace(requested);
    const active = getClient()?.sessionId === id;
    // The Grok process can keep *.lock handles open on Windows. Stop it before
    // relocating the active session, then let the renderer resume at the new cwd.
    if (active) await getSupervisor().disconnectAll();
    const mod = await loadSessions();
    const result = await mod.moveLocalSession({
      sessionId: id,
      targetCwd: root,
      grokHome: grokEnv().GROK_HOME,
    });
    return { ...result, active, isRecents, workspace: root };
  });

  ipcMain.handle("agent:loadSession", async (_e, sessionId, workspaceRoot, options) => {
    // Prefer session's own cwd when provided; else recents / saved project
    const preferred =
      (typeof workspaceRoot === "string" && workspaceRoot.trim()) ||
      loadState().workspaceRoot ||
      "";
    const { root, isRecents } = resolveConnectWorkspace(preferred);
    await connectAgent(root, { ...(options || {}), resumeSessionId: sessionId });
    try {
      const client = getClient();
      if (client) {
        client.setReasoningEffort?.(
          options?.effort || getConnectOptions()?.effort,
        );
        await client.loadSession(String(sessionId));
      }
    } catch {
      // resume via --resume on connect may already have loaded
    }
    return { ok: true, sessionId, workspace: root, isRecents };
  });

  ipcMain.handle("agent:runCli", async (_e, args) => {
    const list = assertSafeGrokCliArgs(Array.isArray(args) ? args.map(String) : []);
    const isLogin = list[0] === "login";
    return runGrokCliArgs(list, {
      timeoutMs: isLogin ? 5 * 60_000 : 60_000,
      loginFlow: isLogin,
    });
  });

  ipcMain.handle("app:openIde", async (_e, opts) => openIdeApp(opts || {}));
  ipcMain.handle("app:getIdeStatus", async () => resolveIdeInstall());

  // ── Phase C: Manager jobs / artifacts / worktrees ──
  ipcMain.handle("jobs:list", async () => {
    ensurePhaseC();
    // Redact bulky stdout/stderr from board list (use jobs:get for detail)
    return jobRunner.list().map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      worktree: j.worktree,
      error: j.error,
      code: j.code,
      read: j.read,
      inbox: j.inbox,
      promptPreview: String(j.prompt || "").slice(0, 120),
    }));
  });
  ipcMain.handle("jobs:enqueue", async (_e, spec) => {
    ensurePhaseC();
    const workspace = getConnectedWorkspace() || loadState().workspaceRoot;
    if (!workspace) throw new Error("Open a project first.");
    const safe = assertSafeJobSpec(spec || {}, workspace);
    const co = getConnectOptions();
    const job = jobRunner.enqueue({
      ...safe,
      permissionMode: safe.permissionMode || co.permissionMode || "auto",
      model: safe.model || co.model || "",
      effort: safe.effort || co.effort || "",
    });
    // Don't bounce full prompt to renderer in list payloads later — ok for create return
    return {
      id: job.id,
      title: job.title,
      status: job.status,
      createdAt: job.createdAt,
      worktree: job.worktree,
      cwd: job.cwd,
    };
  });
  ipcMain.handle("jobs:cancel", async (_e, id) => {
    ensurePhaseC();
    return jobRunner.cancel(String(id || ""));
  });
  ipcMain.handle("jobs:get", async (_e, id) => {
    ensurePhaseC();
    return jobRunner.get(String(id || ""));
  });
  ipcMain.handle("jobs:markRead", async (_e, id) => {
    ensurePhaseC();
    return jobRunner.markRead(String(id || ""));
  });
  ipcMain.handle("jobs:clearFinished", async () => {
    ensurePhaseC();
    jobRunner.clearFinished();
    return { ok: true };
  });
  ipcMain.handle("jobs:inbox", async (_e, unreadOnly) => {
    ensurePhaseC();
    return jobRunner.inbox(Boolean(unreadOnly));
  });

  ipcMain.handle("artifacts:list", async () => {
    ensurePhaseC();
    return artifactStore.list();
  });
  ipcMain.handle("artifacts:add", async (_e, input) => {
    ensurePhaseC();
    const raw = input || {};
    // Cap size; strip path escapes outside workspace if path provided
    let artPath = "";
    if (raw.path) {
      try {
        artPath = guardedPath(String(raw.path));
      } catch {
        artPath = "";
      }
    }
    const item = artifactStore.add({
      type: String(raw.type || "note").slice(0, 40),
      title: String(raw.title || "Artifact").slice(0, 120),
      content: String(raw.content || "").slice(0, 50_000),
      path: artPath,
      meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
    });
    send("manager:artifact", item);
    return item;
  });
  ipcMain.handle("artifacts:remove", async (_e, id) => {
    ensurePhaseC();
    return { ok: artifactStore.remove(String(id || "")) };
  });
  ipcMain.handle("artifacts:clear", async () => {
    ensurePhaseC();
    artifactStore.clear();
    return { ok: true };
  });

  ipcMain.handle("worktree:list", async (_e, cwd) => {
    const root = cwd || getConnectedWorkspace() || loadState().workspaceRoot;
    if (!root) return { ok: false, rows: [], message: "No workspace" };
    const res = await runGrokWorktree(["list"], root);
    return {
      ok: res.ok,
      rows: parseWorktreeList(res.stdout),
      raw: res.stdout || res.stderr,
      message: res.ok ? "" : res.stderr || "worktree list failed",
    };
  });
  ipcMain.handle("worktree:show", async (_e, name, cwd) => {
    const root = cwd || getConnectedWorkspace() || loadState().workspaceRoot;
    const id = assertSafeWorktreeName(name);
    const res = await runGrokWorktree(["show", id], root);
    return { ok: res.ok, raw: res.stdout || res.stderr, message: res.stderr };
  });
  ipcMain.handle("worktree:rm", async (_e, name, cwd) => {
    const root = cwd || getConnectedWorkspace() || loadState().workspaceRoot;
    const id = assertSafeWorktreeName(name);
    const res = await runGrokWorktree(["rm", id], root);
    return { ok: res.ok, raw: res.stdout || res.stderr, message: res.stderr };
  });
  ipcMain.handle("worktree:gc", async (_e, cwd) => {
    const root = cwd || getConnectedWorkspace() || loadState().workspaceRoot;
    const res = await runGrokWorktree(["gc"], root);
    return { ok: res.ok, raw: res.stdout || res.stderr, message: res.stderr };
  });

  ipcMain.handle("shell:openPath", async (_e, target) => {
    if (!target) return { ok: false };
    let resolved;
    try {
      resolved = guardedPath(target);
    } catch {
      // Imagine session media lives under ~/.grok/sessions (outside workspace)
      resolved = assertMediaPreviewPath(normalizeIncomingMediaPath(target), workspacePathContext());
    }
    if (!fs.existsSync(resolved)) throw new Error("Path not found");
    const message = await shell.openPath(resolved);
    if (message) return { ok: false, path: resolved, message };
    return { ok: true, path: resolved };
  });

  /** Reveal media/file in Explorer / Finder (session images allowed). */
  ipcMain.handle("shell:showItemInFolder", async (_e, target) => {
    if (!target) return { ok: false, message: "No path" };
    let resolved;
    try {
      resolved = assertMediaPreviewPath(normalizeIncomingMediaPath(target), workspacePathContext());
    } catch (e) {
      try {
        resolved = guardedPath(target);
      } catch {
        return {
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        };
      }
    }
    if (!fs.existsSync(resolved)) {
      return { ok: false, message: "Path not found" };
    }
    if (fs.statSync(resolved).isDirectory()) {
      const message = await shell.openPath(resolved);
      if (message) return { ok: false, message };
      return { ok: true, path: resolved, openedDirectory: true };
    }
    shell.showItemInFolder(resolved);
    return { ok: true, path: resolved, openedDirectory: false };
  });

  ipcMain.handle("shell:openExternal", async (_e, url) => {
    const safe = assertSafeExternalUrl(url);
    await shell.openExternal(safe);
    return { ok: true };
  });

  /** Copy image bytes to system clipboard (timeline right-click). */
  ipcMain.handle("clipboard:writeImage", async (_e, filePath) => {
    const resolved = assertMediaPreviewPath(
      normalizeIncomingMediaPath(filePath),
      workspacePathContext(),
    );
    const img = nativeImage.createFromPath(resolved);
    if (!img || img.isEmpty()) {
      // Fallback: load buffer (webp etc. some platforms)
      const buf = fs.readFileSync(resolved);
      const fromBuf = nativeImage.createFromBuffer(buf);
      if (!fromBuf || fromBuf.isEmpty()) {
        return { ok: false, message: "Could not load image for clipboard" };
      }
      clipboard.writeImage(fromBuf);
      return { ok: true, path: resolved };
    }
    clipboard.writeImage(img);
    return { ok: true, path: resolved };
  });

  ipcMain.handle("clipboard:writeText", async (_e, text) => {
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  });

  /** Phase B3 — write file after accept/reject diff */
  ipcMain.handle("fs:writeText", async (_e, filePath, content) => {
    const resolved = guardedPath(filePath, { write: true });
    // Cap write size (diff accept) — 8MB
    const text = String(content ?? "");
    if (text.length > 8_000_000) throw new Error("Content too large to write (max 8MB)");
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, text, "utf8");
    return { ok: true, path: resolved };
  });

  ipcMain.handle("fs:readText", async (_e, filePath) => {
    let resolved;
    try {
      resolved = guardedExplorerPath(filePath);
    } catch {
      resolved = guardedPath(filePath);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > 2_000_000) {
      return {
        path: resolved,
        content: `// File too large (${stat.size} bytes)`,
        truncated: true,
      };
    }
    return { path: resolved, content: fs.readFileSync(resolved, "utf8"), truncated: false };
  });

  ipcMain.handle("fs:listDir", async (_e, dirPath) => {
    const base = dirPath || loadState().workspaceRoot;
    if (!base) throw new Error("Open a project first.");
    const resolved = guardedExplorerPath(base);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const hiddenNoise = new Set([
      ".git",
      ".hg",
      ".svn",
      "node_modules",
      "__pycache__",
      ".venv",
      ".next",
      ".nuxt",
      "coverage",
    ]);
    const sensitiveNames = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|.*\.pem|.*\.key|id_rsa|id_ed25519)$/i;
    return entries
      // Keep useful dot-folders such as .project-memory and .grok visible, but
      // never surface repository internals, dependency caches, symlinks, or
      // common credential files in the renderer explorer.
      .filter((e) => !hiddenNoise.has(e.name) && !sensitiveNames.test(e.name) && !e.isSymbolicLink())
      .slice(0, 400)
      .map((e) => ({
        name: e.name,
        path: path.join(resolved, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
  });

  function mimeForMediaExt(ext) {
    return (
      {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".svg": "image/svg+xml",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
      }[String(ext || "").toLowerCase()] || "application/octet-stream"
    );
  }

  /** Normalize file:// and quotes — do NOT bulk-decode %3A session folder names. */
  function normalizeIncomingMediaPath(filePath) {
    return sanitizeMediaPathInput(filePath);
  }

  ipcMain.handle("fs:readFileBase64", async (_e, filePath) => {
    // Attachments still workspace-only (write-related UX)
    const resolved = guardedPath(normalizeIncomingMediaPath(filePath));
    const buf = fs.readFileSync(resolved);
    if (buf.length > 4_000_000) throw new Error("File too large for attachment (max 4MB)");
    const mime = mimeForMediaExt(path.extname(resolved));
    if (!mime.startsWith("image/")) {
      throw new Error("Only image attachments are supported via this path.");
    }
    return {
      uri: pathToFileURL(resolved).href,
      name: path.basename(resolved),
      mimeType: mime,
      data: buf.toString("base64"),
      path: resolved,
    };
  });

  /**
   * Timeline / Imagine preview — session image dirs under ~/.grok + workspace + temp.
   * Resolves relative images/N.jpg against the current project session store.
   */
  ipcMain.handle("fs:readMediaPreview", async (_e, filePath) => {
    try {
      const raw = String(filePath || "").trim();
      if (!raw || /[<>…]|\.\.\./.test(raw)) {
        return { ok: false, message: "placeholder path" };
      }
      const resolved = assertMediaPreviewPath(raw, {
        ...workspacePathContext(),
        grokHome: grokHomeDir(),
      });
      const st = fs.statSync(resolved);
      if (!st.isFile()) {
        return { ok: false, message: "not a file" };
      }
      const mime = mimeForMediaExt(path.extname(resolved));
      if (!mime.startsWith("image/") && !mime.startsWith("video/")) {
        return { ok: false, message: "Not a previewable media type" };
      }
      // Videos are larger; images stay modest for timeline memory
      const maxBytes = mime.startsWith("video/") ? 64_000_000 : 12_000_000;
      if (st.size > maxBytes) {
        return {
          ok: false,
          path: resolved,
          message: `Media too large to preview inline (max ${Math.round(maxBytes / 1e6)}MB)`,
        };
      }
      const buf = fs.readFileSync(resolved);
      const data = buf.toString("base64");
      return {
        ok: true,
        path: resolved,
        name: path.basename(resolved),
        mimeType: mime,
        data,
        dataUrl: `data:${mime};base64,${data}`,
        bytes: st.size,
        kind: mime.startsWith("video/") ? "video" : "image",
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      };
    }
  });

  function resolveTerminalCwd(preferred) {
    const candidates = [
      preferred,
      getConnectedWorkspace(),
      loadState().workspaceRoot,
    ];
    for (const c of candidates) {
      const p = typeof c === "string" ? c.trim() : "";
      if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) return path.resolve(p);
    }
    return null;
  }

  /** One-shot shell command — always project folder. */
  ipcMain.handle("term:run", async (_e, command, workspaceRoot) => {
    const cwd = resolveTerminalCwd(workspaceRoot);
    if (!cwd) throw new Error("Open a project folder first.");
    const line = String(command || "").trim();
    if (!line) throw new Error("Empty command");
    if (line.length > 8000) throw new Error("Command too long");
    send("term:chunk", { type: "start", command: line, cwd });
    const result = await runUserShell(line, cwd, (chunk) => {
      send("term:chunk", { type: "data", text: chunk });
    });
    send("term:chunk", { type: "end", code: result.code });
    return { ...result, cwd };
  });

  /**
   * Long-lived interactive shell in the open project directory.
   * @param {_e} _
   * @param {string} [workspaceRoot] optional explicit project path from renderer
   */
  ipcMain.handle("term:startShell", async (_e, workspaceRoot) => {
    const cwd = resolveTerminalCwd(workspaceRoot);
    if (!cwd) throw new Error("Open a project folder first.");
    userShell.start(cwd, (text) => send("term:chunk", { type: "data", text }));
    return { ok: true, cwd, running: true };
  });

  ipcMain.handle("term:writeShell", async (_e, line, workspaceRoot) => {
    const cwd = resolveTerminalCwd(workspaceRoot);
    if (!cwd) throw new Error("Open a project folder first.");
    // If cwd changed or shell dead, restart in project dir
    if (!userShell.running || (userShell.cwd && path.resolve(userShell.cwd) !== cwd)) {
      userShell.start(cwd, (text) => send("term:chunk", { type: "data", text }));
    }
    const text = String(line ?? "");
    if (text.length > 8000) throw new Error("Input too long");
    userShell.write(text);
    return { ok: true, cwd };
  });

  ipcMain.handle("term:stopShell", async () => {
    userShell.stop();
    return { ok: true };
  });

  ipcMain.handle("term:status", async () => ({
    running: userShell.running,
    cwd: userShell.cwd || null,
  }));

  ipcMain.handle("term:interrupt", async () => {
    userShell.interrupt?.();
    return { ok: true };
  });

  /** Open a real system terminal in the project folder (for TUI apps like `grok`). */
  ipcMain.handle("term:openExternal", async (_e, workspaceRoot) => {
    const cwd = resolveTerminalCwd(workspaceRoot);
    if (!cwd) throw new Error("Open a project folder first.");
    const { spawn } = require("node:child_process");
    const det = { detached: true, stdio: "ignore", windowsHide: true, cwd };
    if (process.platform === "win32") {
      // Prefer Windows Terminal; fall back to cmd
      const tryWt = spawn("wt.exe", ["-d", cwd], det);
      tryWt.on("error", () => {
        // Avoid trailing \" quote bugs: JSON.stringify path for the shell fragment
        const cd = `cd /d ${JSON.stringify(cwd)}`;
        spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", cd], det).unref();
      });
      tryWt.unref?.();
    } else if (process.platform === "darwin") {
      spawn("open", ["-a", "Terminal", cwd], det).unref();
    } else {
      const term = process.env.TERMINAL || "x-terminal-emulator";
      spawn(term, ["--working-directory", cwd], det).unref();
    }
    return { ok: true, cwd };
  });

  ipcMain.handle("agent:readTranscript", async (_e, sessionId) => {
    const mod = await loadSessions();
    return mod.readSessionTranscript({
      sessionId: String(sessionId),
      grokHome: grokEnv().GROK_HOME,
      // Reasoning summaries add multiple items per turn. The virtual timeline
      // can handle a longer tail and Codex-style session review needs it.
      limit: 600,
    });
  });

  ipcMain.handle("agent:exportSession", async (_e, sessionId) => {
    const mod = await loadSessions();
    const result = await mod.runGrokCli({
      executable: resolveGrokExecutable(),
      args: ["export", String(sessionId)],
      cwd: loadState().workspaceRoot || undefined,
      environment: grokEnv(),
      timeoutMs: 60_000,
    });
    if ((result.code ?? 1) !== 0 && !result.stdout.trim()) {
      throw new Error(result.stderr.trim() || "export failed");
    }
    return result.stdout;
  });

  ipcMain.handle("agent:renameSession", async (_e, sessionId, title) => {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("Session id is required.");
    const mod = await loadSessions();
    return mod.updateLocalSessionTitle({
      sessionId: id,
      title: String(title || ""),
      grokHome: grokEnv().GROK_HOME,
    });
  });

  ipcMain.handle("agent:deleteSession", async (_e, sessionId) => {
    const mod = await loadSessions();
    const result = await mod.runGrokCli({
      executable: resolveGrokExecutable(),
      args: ["sessions", "delete", String(sessionId)],
      cwd: loadState().workspaceRoot || undefined,
      environment: grokEnv(),
      timeoutMs: 30_000,
    });
    if ((result.code ?? 1) !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "delete failed");
    }
    return { ok: true };
  });

  ipcMain.handle("agent:setSessionMode", async (_e, modeId) => {
    const client = getClient();
    if (!client) throw new Error("Not connected.");
    await client.setSessionMode(String(modeId));
    return { ok: true };
  });

  ipcMain.handle("agent:setPermissionMode", async (_e, mode) => {
    const normalized = normalizePermissionMode(mode);
    saveState({ permissionMode: normalized });
    getSupervisor().setPermissionMode(normalized);
    return { ok: true, permissionMode: normalized };
  });

  ipcMain.handle("app:saveExport", async (_e, markdown, defaultName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export session",
      defaultPath: defaultName || "session.md",
      filters: [{ name: "Markdown", extensions: ["md"] }, { name: "All", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePath) return { ok: false };
    fs.writeFileSync(result.filePath, String(markdown || ""), "utf8");
    return { ok: true, path: result.filePath };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  void disconnectAgent().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});
app.on("before-quit", () => {
  void disconnectAgent();
});
