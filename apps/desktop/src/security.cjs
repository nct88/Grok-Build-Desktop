/**
 * Desktop security helpers — workspace path sandbox, URL allowlist, CLI gates.
 * Local product: still treat renderer as untrusted (XSS / compromised content).
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");

function normalizePath(p) {
  return path.resolve(String(p || "").trim());
}

function isAbsoluteUserPath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return false;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  if (raw.startsWith("\\\\") || raw.startsWith("//")) return true;
  return path.isAbsolute(raw);
}

/** Resolve review/tool paths against the project folder, not Electron cwd. */
function resolveInWorkspace(filePath, workspaceRoot) {
  const raw = String(filePath || "").trim();
  if (!raw) return raw;
  if (isAbsoluteUserPath(raw)) return normalizePath(raw);
  if (!workspaceRoot) return normalizePath(raw);
  return path.resolve(normalizePath(workspaceRoot), raw);
}

/** Case-aware path containment (Windows). */
function isPathInside(root, target) {
  if (!root || !target) return false;
  let r = normalizePath(root);
  let t = normalizePath(target);
  if (process.platform === "win32") {
    r = r.toLowerCase();
    t = t.toLowerCase();
  }
  if (t === r) return true;
  const sep = path.sep;
  const prefix = r.endsWith(sep) ? r : r + sep;
  return t.startsWith(prefix);
}

/**
 * Block credential / secret files under ~/.grok even when allowOutside is on.
 * @param {string} resolved
 * @param {string} grokHome
 */
function isCredentialPath(resolved, grokHome) {
  if (!resolved) return false;
  const base = path.basename(resolved).toLowerCase();
  if (
    /^(auth\.json|credentials\.json|\.env|.*\.pem|.*\.key|id_rsa|id_ed25519)$/i.test(base)
  ) {
    return true;
  }
  if (grokHome && isPathInside(grokHome, resolved)) {
    if (/auth|credential|token|secret|keyring/i.test(resolved)) return true;
  }
  return false;
}

/**
 * @param {object} ctx
 * @param {string} filePath
 * @param {{ write?: boolean, allowOutside?: boolean, workspaceRoot?: string|null, extraRoots?: string[], grokHome?: string }} opts
 */
function assertWorkspacePath(filePath, opts = {}) {
  // Reject null bytes / weird control chars
  if (/[\u0000]/.test(String(filePath))) {
    throw new Error("Invalid path characters");
  }

  const root = opts.workspaceRoot ? normalizePath(opts.workspaceRoot) : null;
  const extraRoots = Array.isArray(opts.extraRoots)
    ? opts.extraRoots.map((p) => normalizePath(p)).filter(Boolean)
    : [];
  const allowOutside = Boolean(opts.allowOutside);
  const resolved = resolveInWorkspace(filePath, root);
  if (!resolved || resolved === path.parse(resolved).root) {
    throw new Error("Invalid path");
  }

  const grokHome = opts.grokHome || "";
  if (isCredentialPath(resolved, grokHome)) {
    throw new Error("Access to credential or secret files is blocked.");
  }

  if (!root) {
    throw new Error("Open a project folder before accessing files.");
  }
  if (!fs.existsSync(root)) {
    throw new Error("Project folder is missing.");
  }
  const allowed = [root, ...extraRoots];
  if (!allowOutside && !allowed.some((r) => isPathInside(r, resolved))) {
    throw new Error("Path outside workspace is not allowed.");
  }
  return resolved;
}

const MEDIA_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".mp4",
  ".webm",
  ".mov",
]);

function isMediaExtension(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return MEDIA_EXT.has(ext);
}

/**
 * Clean file:// and quotes WITHOUT full decodeURIComponent.
 * Session dirs on disk keep encoded names like E%3A%5Cprojects%5C… —
 * decoding the whole path breaks them (E%3A → E: → invalid).
 * @param {string} filePath
 */
function sanitizeMediaPathInput(filePath) {
  let p = String(filePath || "").trim();
  p = p.replace(/^['"`]+|['"`]+$/g, "");
  p = p.replace(/^file:\/\//i, "");
  p = p.replace(/^\/([A-Za-z]:)/, "$1");
  // Only decode percent-encoding that is NOT part of a sessions segment folder name.
  // Safe: space %20 in filename. Unsafe: %3A / %5C in the sessions project key.
  // Strategy: never bulk-decode; try as-is on disk.
  return p;
}

/**
 * Build candidate absolute paths for a media ref (absolute, relative, session images).
 * @param {string} filePath
 * @param {{ workspaceRoot?: string|null, grokHome?: string }} opts
 * @returns {string[]}
 */
function mediaPreviewCandidates(filePath, opts = {}) {
  const raw = sanitizeMediaPathInput(filePath);
  if (!raw || /[<>…]|\.\.\./.test(raw)) return [];

  const candidates = [];
  const push = (p) => {
    if (!p) return;
    const n = path.normalize(p);
    if (!candidates.includes(n)) candidates.push(n);
  };

  push(raw);
  // Also try with forward slashes normalized on Windows
  if (process.platform === "win32" && raw.includes("/")) {
    push(raw.replace(/\//g, "\\"));
  }

  // Optional full decode as alternate only if different (may help non-session URLs)
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) push(decoded);
  } catch {
    // ignore
  }

  const ws = opts.workspaceRoot ? path.resolve(String(opts.workspaceRoot)) : "";
  const grokHome = opts.grokHome ? path.resolve(String(opts.grokHome)) : "";
  const baseName = path.basename(raw);
  const isRel =
    !/^[A-Za-z]:[\\/]/.test(raw) && !raw.startsWith("\\\\") && !path.isAbsolute(raw);

  if (ws && isRel) {
    push(path.join(ws, raw.replace(/^\.?[\\/]/, "")));
    push(path.join(ws, "images", baseName));
    push(path.join(ws, "videos", baseName));
  }
  if (ws && /^(images|videos)[\\/]/i.test(raw)) {
    push(path.join(ws, raw));
  }

  // Session store: ~/.grok/sessions/<urlencoded-cwd>/<sessionId>/images/N.jpg
  if (grokHome && baseName && isMediaExtension(baseName)) {
    const sessionsRoot = path.join(grokHome, "sessions");
    if (fs.existsSync(sessionsRoot)) {
      // Prefer project folder matching workspace
      let projectDirs = [];
      try {
        projectDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch {
        projectDirs = [];
      }
      const wsKey = ws
        ? encodeURIComponent(ws).replace(/%3A/gi, "%3A").replace(/%5C/gi, "%5C")
        : "";
      // Windows encodeURIComponent uses %3A for : and %5C for \
      const matchDirs = projectDirs.filter((d) => {
        if (!ws) return true;
        const name = d.name;
        if (wsKey && name.toLowerCase() === wsKey.toLowerCase()) return true;
        // Loose match: decoded name contains project path segments
        try {
          const dec = decodeURIComponent(name).toLowerCase().replace(/\//g, "\\");
          return dec === ws.toLowerCase() || dec.includes(path.basename(ws).toLowerCase());
        } catch {
          return name.toLowerCase().includes("grok-build");
        }
      });
      const dirsToScan = matchDirs.length ? matchDirs : projectDirs.slice(0, 6);
      for (const pd of dirsToScan) {
        const projPath = path.join(sessionsRoot, pd.name);
        // session uuid folders
        let sessions = [];
        try {
          sessions = fs
            .readdirSync(projPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
            .reverse(); // newer-ish last; still scan a few
        } catch {
          sessions = [];
        }
        for (const sid of sessions.slice(0, 12)) {
          push(path.join(projPath, sid, "images", baseName));
          push(path.join(projPath, sid, "videos", baseName));
          push(path.join(projPath, sid, "assets", baseName));
          if (isRel || /^(images|videos)[\\/]/i.test(raw)) {
            push(path.join(projPath, sid, raw.replace(/^\.?[\\/]/, "")));
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * Read-only media preview paths (timeline inline images).
 * Allows workspace + safe Grok session image dirs + OS temp — never credentials.
 * @param {string} filePath
 * @param {{ workspaceRoot?: string|null, grokHome?: string, allowOutside?: boolean }} opts
 */
function assertMediaPreviewPath(filePath, opts = {}) {
  const candidates = mediaPreviewCandidates(filePath, opts);
  const grokHome = opts.grokHome ? normalizePath(opts.grokHome) : "";
  const tmp = normalizePath(require("node:os").tmpdir());
  const allowedRoots = [];
  if (opts.workspaceRoot) allowedRoots.push(normalizePath(opts.workspaceRoot));
  if (Array.isArray(opts.extraRoots)) {
    for (const extra of opts.extraRoots) {
      if (extra) allowedRoots.push(normalizePath(extra));
    }
  }
  if (grokHome) {
    allowedRoots.push(path.join(grokHome, "sessions"));
    allowedRoots.push(path.join(grokHome, "downloads"));
    allowedRoots.push(path.join(grokHome, "cache"));
  }
  if (tmp) allowedRoots.push(tmp);
  if (process.env.LOCALAPPDATA) {
    allowedRoots.push(path.join(process.env.LOCALAPPDATA, "Temp"));
  }

  let lastErr = "Media file not found";
  for (const cand of candidates) {
    try {
      if (!isMediaExtension(cand)) continue;
      if (isCredentialPath(cand, grokHome)) {
        lastErr = "Access to credential or secret files is blocked.";
        continue;
      }
      if (!fs.existsSync(cand) || !fs.statSync(cand).isFile()) continue;

      const resolved = normalizePath(cand);
      // Workspace path always ok for media
      if (opts.workspaceRoot && isPathInside(normalizePath(opts.workspaceRoot), resolved)) {
        return resolved;
      }
      if (opts.allowOutside) {
        return resolved;
      }
      for (const root of allowedRoots) {
        if (root && isPathInside(root, resolved)) {
          if (isCredentialPath(resolved, grokHome)) {
            lastErr = "Access to credential or secret files is blocked.";
            break;
          }
          return resolved;
        }
      }
      lastErr = "Media path not in allowed preview dirs";
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

/** Only http(s) for openExternal — blocks file:, javascript:, etc. */
function assertSafeExternalUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) throw new Error("Empty URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) links are allowed.");
  }
  // Never hand credentials embedded in a URL to the OS browser.
  if (parsed.username || parsed.password) {
    throw new Error("Credentials in URLs are not allowed.");
  }
  return parsed.toString();
}

/** First-arg allowlist for `grok <cmd>` power-user panel. */
const ALLOWED_GROK_CLI_HEAD = new Set([
  "login",
  "logout",
  "doctor",
  "help",
  "version",
  "--version",
  "-V",
  "mcp",
  "worktree",
  "plugin",
  "auth",
  "config",
  "session",
  "sessions",
  "models",
  "model",
  "usage",
  "update",
  "skills",
  "whoami",
]);

function assertSafeGrokCliArgs(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  if (!list.length) throw new Error("No CLI arguments");
  const head = list[0];
  // allow `grok --version` style
  if (head.startsWith("-") && !ALLOWED_GROK_CLI_HEAD.has(head)) {
    // flags-only without subcommand — only safe version/help flags
    if (!/^--?(version|help|V|h)$/.test(head)) {
      throw new Error(`CLI command not allowed from UI: ${head}`);
    }
  } else if (!head.startsWith("-") && !ALLOWED_GROK_CLI_HEAD.has(head)) {
    throw new Error(
      `CLI command not allowed from UI: ${head}. Use Connect / chat for agent work.`,
    );
  }
  // Block spawning interactive agent / arbitrary -p from Tools panel
  const joined = list.join(" ");
  if (/\bagent\b/i.test(joined) && /\bstdio\b/i.test(joined)) {
    throw new Error("Spawning agent stdio from Tools panel is blocked.");
  }
  if (list.includes("-p") || list.includes("--single")) {
    throw new Error("Use Manager → Queue task for headless prompts.");
  }
  // No shell metacharacter injection vectors (we spawn without shell, still sanitize)
  for (const a of list) {
    if (/[\u0000]/.test(a)) throw new Error("Invalid CLI argument");
  }
  return list;
}

/** Worktree id: no path traversal */
function assertSafeWorktreeName(name) {
  const n = String(name || "").trim();
  if (!n) throw new Error("Worktree name required");
  if (n.length > 120) throw new Error("Worktree name too long");
  if (/[\\/]|\.\./.test(n) || /[\u0000]/.test(n)) {
    throw new Error("Invalid worktree name");
  }
  return n;
}

/** Cap job prompt size to reduce accidental secret dumps to disk */
const MAX_JOB_PROMPT = 32_000;

function assertSafeJobSpec(spec, workspaceRoot) {
  const prompt = String(spec?.prompt || "").trim();
  if (!prompt) throw new Error("Job prompt is required");
  if (prompt.length > MAX_JOB_PROMPT) {
    throw new Error(`Job prompt too long (max ${MAX_JOB_PROMPT} chars)`);
  }
  const root = normalizePath(workspaceRoot || "");
  if (!root) throw new Error("Open a project first.");
  // Jobs always run in the open project (ignore client-supplied cwd escapes)
  const cwd = root;
  if (spec?.worktree) assertSafeWorktreeName(spec.worktree);
  return {
    ...spec,
    prompt,
    cwd,
  };
}

module.exports = {
  normalizePath,
  isAbsoluteUserPath,
  resolveInWorkspace,
  isPathInside,
  isCredentialPath,
  isMediaExtension,
  sanitizeMediaPathInput,
  mediaPreviewCandidates,
  assertWorkspacePath,
  assertMediaPreviewPath,
  assertSafeExternalUrl,
  assertSafeGrokCliArgs,
  assertSafeWorktreeName,
  assertSafeJobSpec,
  ALLOWED_GROK_CLI_HEAD,
  MAX_JOB_PROMPT,
};
