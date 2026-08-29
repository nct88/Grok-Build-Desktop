export const REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

/** Grok CLI 1.0.5 accepts reasoning effort when an ACP client opens or resumes. */
export function normalizeReasoningEffort(value?: string | null): string {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (raw === "xhigh" || raw === "extrahigh") return "xhigh";
  return (REASONING_EFFORT_VALUES as readonly string[]).includes(raw) ? raw : "";
}

export function normalizePermissionMode(value?: string | null): string {
  const raw = String(value || "").trim();
  const aliases: Record<string, string> = {
    ask: "default",
    full: "bypassPermissions",
    bypass: "bypassPermissions",
    "full-access": "bypassPermissions",
    "dont-ask": "dontAsk",
    "accept-edits": "acceptEdits",
  };
  const mode = aliases[raw] || raw;
  return ["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "plan"].includes(mode)
    ? mode
    : "";
}

/**
 * `_meta` payload for `session/new` and `session/load`.
 * Grok Build 1.0.5 reads reasoning effort here in addition to `--reasoning-effort`.
 */
export function sessionRequestMeta(options: {
  reasoningEffort?: string | null;
  permissionMode?: string | null;
}): Record<string, unknown> | undefined {
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort);
  const permissionMode = normalizePermissionMode(options.permissionMode);
  if (!reasoningEffort && !permissionMode) return undefined;
  return {
    ...(reasoningEffort ? { reasoningEffort, reasoning_effort: reasoningEffort } : {}),
    ...(permissionMode ? { permissionMode, permission_mode: permissionMode } : {}),
  };
}
