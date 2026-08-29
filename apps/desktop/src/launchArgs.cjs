/**
 * Launch-flag helpers for `grok agent stdio` (pure — no Electron).
 * Shared by main + AgentSupervisor + tests.
 */
"use strict";

/** Grok CLI: --permission-mode <MODE> */
const CLI_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

/**
 * @param {string} [mode]
 * @returns {string}
 */
function normalizePermissionMode(mode) {
  const raw = String(mode || "default").trim();
  const aliases = {
    ask: "default",
    full: "bypassPermissions",
    bypass: "bypassPermissions",
    "full-access": "bypassPermissions",
    "dont-ask": "dontAsk",
    "accept-edits": "acceptEdits",
  };
  const mapped = aliases[raw] || raw;
  return CLI_PERMISSION_MODES.has(mapped) ? mapped : "default";
}

/**
 * Build CLI args before `agent stdio` (permission, model, worktree, …).
 * @param {object} [options]
 * @returns {string[]}
 */
function buildLaunchArgs(options = {}) {
  const args = [];
  const mode = normalizePermissionMode(options.permissionMode);
  args.push("--permission-mode", mode);
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.effort) {
    args.push("--reasoning-effort", String(options.effort));
  }
  if (
    options.sandbox !== undefined &&
    options.sandbox !== null &&
    String(options.sandbox).trim() !== ""
  ) {
    args.push("--sandbox", String(options.sandbox));
  }
  if (options.tools && String(options.tools).trim()) {
    args.push("--tools", String(options.tools).trim());
  }
  if (options.deniedTools && String(options.deniedTools).trim()) {
    args.push("--denied-tools", String(options.deniedTools).trim());
  }
  // A resumed session already has its own worktree identity. Passing --worktree
  // again asks newer CLIs to create/fork another isolation directory.
  if (!options.resumeSessionId && options.worktree && String(options.worktree).trim()) {
    args.push("--worktree", String(options.worktree).trim());
    if (options.worktreeRef && String(options.worktreeRef).trim()) {
      args.push("--worktree-ref", String(options.worktreeRef).trim());
    }
  }
  if (options.rules && String(options.rules).trim()) {
    args.push("--rules", String(options.rules).trim());
  }
  if (options.maxTurns && Number(options.maxTurns) > 0) {
    args.push("--max-turns", String(Number(options.maxTurns)));
  }
  if (options.disableWebSearch) {
    args.push("--disable-web-search");
  }
  if (options.experimentalMemory) {
    args.push("--experimental-memory");
  }
  if (Array.isArray(options.extraArguments)) {
    for (const a of options.extraArguments) {
      if (a != null && String(a).trim()) args.push(String(a));
    }
  }
  return args;
}

/**
 * Fingerprint launch options for warm-process reuse.
 * @param {object} opts
 * @returns {string}
 */
function launchFingerprint(opts) {
  const o = opts || {};
  return JSON.stringify({
    permissionMode: o.permissionMode || "",
    model: o.model || "",
    effort: o.effort || "",
    sandbox: o.sandbox || "",
    tools: o.tools || "",
    deniedTools: o.deniedTools || "",
    worktree: o.worktree || "",
    worktreeRef: o.worktreeRef || "",
    resumeSessionId: o.resumeSessionId || "",
    rules: o.rules || "",
    maxTurns: o.maxTurns || 0,
    disableWebSearch: Boolean(o.disableWebSearch),
    experimentalMemory: Boolean(o.experimentalMemory),
    allowOutside: Boolean(o.allowOutside),
    extraRoots: Array.isArray(o.extraRoots) ? [...o.extraRoots].sort() : [],
  });
}

module.exports = {
  CLI_PERMISSION_MODES,
  normalizePermissionMode,
  buildLaunchArgs,
  launchFingerprint,
};
