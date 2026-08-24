/**
 * Composer slash helpers — TUI-aligned shortcuts for Desktop.
 * globalThis.GrokSlashCommands
 */
(() => {
  /**
   * @typedef {{
   *   codingDataRetentionOptOut?: boolean|null,
   *   imagineVideoBlocked?: boolean,
   * }} SlashContext
   */

  /**
   * Preflight copy for Imagine video (privacy opt-out / ZDR).
   * @param {SlashContext} [ctx]
   */
  function imagineVideoPreflightNote(ctx) {
    if (ctx?.imagineVideoBlocked || ctx?.codingDataRetentionOptOut === true) {
      return (
        `PREFLIGHT (Desktop): coding_data_retention_opt_out is true on this account. ` +
        `image_to_video will almost certainly fail with HTTP 400 "upload_url" / ZDR. ` +
        `Do NOT invent a .mp4 path. Tell the user to open Grok TUI → /privacy → Opt in to ` +
        `coding data retention, re-login Desktop, then retry. Still create/deliver the still frame if useful.\n\n`
      );
    }
    return "";
  }

  function promptDirective(lead, arg, label = "Request") {
    const note = String(arg || "").trim();
    if (!note) return lead;
    return `${lead}\n${label}: ${note}`;
  }

  /**
   * @typedef {{
   *   id: string,
   *   label: string,
   *   hint?: string,
   *   description?: string,
   *   insert: string,
   *   kind?: string,
   *   aliases?: string[],
   *   expand?: ((arg: string, ctx?: SlashContext) => string)|null
   * }} SlashCommand
   */

  /** @type {SlashCommand[]} */
  const BUILTIN_COMMANDS = [
    { id: "new", label: "/new", hint: "Start a fresh chat", insert: "/new", aliases: ["clear"], expand: null },
    { id: "resume", label: "/resume", hint: "Open chat history", insert: "/resume", expand: null },
    {
      id: "dashboard",
      label: "/dashboard",
      hint: "Open background tasks",
      insert: "/dashboard",
      aliases: ["agents-dashboard", "sessions"],
      expand: null,
    },
    { id: "fork", label: "/fork", hint: "Spawn a parallel agent", insert: "/fork", expand: null },
    {
      id: "session-info",
      label: "/session-info",
      hint: "Session, context and account",
      insert: "/session-info",
      aliases: ["status", "info"],
      expand: null,
    },
    { id: "context", label: "/context", hint: "Show context-window use", insert: "/context", expand: null },
    {
      id: "compact",
      label: "/compact",
      hint: "Compress history to free context",
      insert: "/compact ",
      expand: (arg) => {
        const note = String(arg || "").trim();
        return (
          "Compact this conversation to reclaim context-window space. " +
          "Keep the project goal, current files, unresolved decisions and the last useful turn. " +
          (note ? `Preserve especially: ${note}` : "Drop stale exploration that is no longer needed.")
        );
      },
    },
    {
      id: "recap",
      label: "/recap",
      hint: "Summarize this session",
      insert: "/recap",
      aliases: ["summarize"],
      expand: (arg) => {
        const note = String(arg || "").trim();
        return (
          "Write an on-demand recap of this session in the same language as the conversation. " +
          "Cover: what we decided, the current project context, remaining work, and the last turn's outcome. " +
          "Keep it short enough to restore reasoning later. " +
          (note ? `Focus: ${note}` : "")
        );
      },
    },
    {
      id: "rewind",
      label: "/rewind",
      hint: "Undo later turns (history only)",
      insert: "/rewind",
      aliases: ["undo"],
      expand: (arg) => {
        const note = String(arg || "").trim();
        return (
          "Rewind this conversation to an earlier user turn. " +
          "Truncate conversation history only — do not revert files on disk. " +
          "Ask which turn to keep if I did not name one. " +
          (note ? `Target: ${note}` : "")
        );
      },
    },
    { id: "copy", label: "/copy", hint: "Copy the last reply", insert: "/copy", expand: null },
    { id: "export", label: "/export", hint: "Export this chat", insert: "/export", expand: null },
    {
      id: "rename",
      label: "/rename",
      hint: "Rename this chat",
      insert: "/rename ",
      aliases: ["title"],
      expand: null,
    },
    { id: "delete", label: "/delete", hint: "Delete this chat", insert: "/delete", expand: null },
    { id: "quit", label: "/quit", hint: "Quit Desktop", insert: "/quit", aliases: ["exit"], expand: null },
    { id: "home", label: "/home", hint: "Leave project (Recents)", insert: "/home", aliases: ["welcome"], expand: null },
    { id: "model", label: "/model", hint: "Switch model", insert: "/model ", aliases: ["m"], expand: null },
    { id: "effort", label: "/effort", hint: "Set reasoning effort", insert: "/effort ", expand: null },
    { id: "plan", label: "/plan", hint: "Switch to plan mode", insert: "/plan", expand: null },
    {
      id: "view-plan",
      label: "/view-plan",
      hint: "Open saved plans",
      insert: "/view-plan",
      aliases: ["show-plan", "plan-view"],
      expand: null,
    },
    { id: "history", label: "/history", hint: "Open chat history", insert: "/history", expand: null },
    { id: "compact-mode", label: "/compact-mode", hint: "Toggle compact layout", insert: "/compact-mode", expand: null },
    {
      id: "multiline",
      label: "/multiline",
      hint: "Enter inserts a newline",
      insert: "/multiline",
      aliases: ["ml"],
      expand: null,
    },
    { id: "timestamps", label: "/timestamps", hint: "Toggle message times", insert: "/timestamps", expand: null },
    {
      id: "always-approve",
      label: "/always-approve",
      hint: "Skip permission prompts",
      insert: "/always-approve",
      expand: null,
    },
    { id: "auto", label: "/auto", hint: "Auto-approve safe tools", insert: "/auto", expand: null },
    {
      id: "btw",
      label: "/btw",
      hint: "Side question without derailing",
      insert: "/btw ",
      expand: (arg) => {
        const q = String(arg || "").trim();
        return (
          "This is a side question. Do not abandon the current task. " +
          "Answer briefly, then continue the main work. " +
          (q ? `Question: ${q}` : "Ask me what the aside is if I did not specify one.")
        );
      },
    },
    {
      id: "remember",
      label: "/remember",
      hint: "Save a note to memory",
      insert: "/remember ",
      expand: (arg) => {
        const note = String(arg || "").trim();
        return note
          ? `Save this to memory now, without waiting for an automatic summary:\n${note}`
          : "Ask me what to remember, then save it to memory immediately.";
      },
    },
    {
      id: "memory",
      label: "/memory",
      hint: "Browse or toggle memory",
      insert: "/memory ",
      aliases: ["mem"],
      expand: (arg) =>
        promptDirective(
          "Use Grok memory tools for this request. If I said on/off, enable or disable memory. Otherwise list, show, or manage saved memories.",
          arg,
        ),
    },
    {
      id: "flush",
      label: "/flush",
      hint: "Save session into memory now",
      insert: "/flush",
      expand: () =>
        "Save this session's important knowledge to memory now. Summarize decisions, file paths and remaining work.",
    },
    {
      id: "dream",
      label: "/dream",
      hint: "Consolidate memory topics",
      insert: "/dream",
      expand: () =>
        "Run memory consolidation: merge session notes into organized topics and drop stale duplicates.",
    },
    {
      id: "feedback",
      label: "/feedback",
      hint: "Report a Desktop issue",
      insert: "/feedback ",
      expand: (arg) => {
        const note = String(arg || "").trim();
        return (
          "Collect product feedback about Grok Build Desktop. " +
          "Summarize the issue clearly and suggest the next check. " +
          (note ? `Report: ${note}` : "Ask me what went wrong.")
        );
      },
    },
    {
      id: "imagine",
      label: "/imagine",
      hint: "Generate an image",
      insert: "/imagine ",
      expand: (arg) => {
        const d = String(arg || "").trim();
        if (!d) {
          return (
            "Use the Imagine skill and image_gen tool to create an image. " +
            "Ask me for a short description if needed."
          );
        }
        return (
          `Use the Imagine skill and the image_gen tool to generate an image.\n` +
          `Description: ${d}\n` +
          `Choose a sensible aspect_ratio. After generating, report the saved file path clearly ` +
          `so it can be previewed (prefer writing under the project or a user-visible path; ` +
          `session paths like images/1.jpg are fine).`
        );
      },
    },
    {
      id: "imagine-video",
      label: "/imagine-video",
      hint: "Generate a short video (needs privacy Opt in)",
      insert: "/imagine-video ",
      expand: (arg, ctx) => {
        const d = String(arg || "").trim();
        const pre = imagineVideoPreflightNote(ctx);
        if (!d) {
          return (
            pre +
            "Use the Imagine skill and the image_to_video (or reference_to_video) tools to create a short video. " +
            "Default: ONE 6s clip. Ask me for a short description if needed. Report every saved path (images/… and videos/…)."
          );
        }
        return (
          pre +
          `Use the Imagine skill and available video tools to create a short video.\n` +
          `Description: ${d}\n` +
          `Default: ONE clip only (unless I ask for multi-shot / longer narrative).\n` +
          `Pipeline:\n` +
          `1) Prefer 6s @ 480p. Aspect ratio comes from the source image (e.g. 1:1).\n` +
          `2) Create a strong first frame with image_gen (or image_edit from a reference I already have / attached).\n` +
          `3) Animate with image_to_video (image + short present-tense motion prompt, 1–2 sentences). ` +
          `Use reference_to_video only if I explicitly ask or the shot needs multiple refs.\n` +
          `4) After success, report the full saved paths for the frame and the .mp4 so the desktop can preview ` +
          `(images/… and videos/… are fine).\n` +
          `If image_to_video fails with Zero Data Retention / upload_url / HTTP 400:\n` +
          `- Stop; do not invent multi-shot FFmpeg workarounds or fake .mp4 paths.\n` +
          `- Explain: usually coding data retention is Opt out (/privacy → Opt in) OR team ZDR is Active (Console → Disable).\n` +
          `- Still deliver any still frame path that was created.`
        );
      },
    },
    { id: "usage", label: "/usage", hint: "Open usage in Settings", insert: "/usage", aliases: ["cost"], expand: null },
    { id: "settings", label: "/settings", hint: "Open Settings", insert: "/settings", aliases: ["config", "preferences", "prefs"], expand: null },
    { id: "marketplace", label: "/marketplace", hint: "Open plugin marketplace", insert: "/marketplace", expand: null },
    { id: "plugins", label: "/plugins", hint: "Open plugins panel", insert: "/plugins", expand: null },
    { id: "skills", label: "/skills", hint: "Open skills panel", insert: "/skills", expand: null },
    { id: "mcps", label: "/mcps", hint: "Open MCP servers", insert: "/mcps", expand: null },
    { id: "hooks", label: "/hooks", hint: "Open project trust / MCP", insert: "/hooks", expand: null },
    { id: "hooks-trust", label: "/hooks-trust", hint: "Trust folder for MCP/LSP/hooks", insert: "/hooks-trust", expand: null },
    {
      id: "hooks-untrust",
      label: "/hooks-untrust",
      hint: "Revoke folder trust",
      insert: "/hooks-untrust",
      expand: null,
    },
    { id: "hooks-list", label: "/hooks-list", hint: "Show grok inspect", insert: "/hooks-list", expand: null },
    { id: "hooks-add", label: "/hooks-add", hint: "Open .grok/hooks folder", insert: "/hooks-add", expand: null },
    {
      id: "hooks-remove",
      label: "/hooks-remove",
      hint: "Open .grok/hooks folder",
      insert: "/hooks-remove",
      expand: null,
    },
    {
      id: "loop",
      label: "/loop",
      hint: "Recurring scheduled prompt",
      insert: "/loop ",
      expand: (arg) =>
        promptDirective(
          "Create a recurring scheduled task with scheduler_create (interval like 30m, 1h, 1d; minimum 60s). Confirm the job id so I can cancel it later.",
          arg,
        ),
    },
    {
      id: "goal",
      label: "/goal",
      hint: "Set or manage an autonomous goal",
      insert: "/goal ",
      expand: (arg) =>
        promptDirective(
          "Use the /goal workflow. Arguments may be an objective, or status/pause/resume/clear. Keep the goal active until evidence review can reproduce the result.",
          arg,
        ),
    },
    {
      id: "deep-research",
      label: "/deep-research",
      hint: "Start a research workflow",
      insert: "/deep-research ",
      expand: (arg) =>
        promptDirective(
          "Kick off a deep-research workflow: plan questions, gather sourced claims, cross-check independently, and report only claims that survive with source locators. Mark the report Partial if coverage is incomplete.",
          arg,
          "Query",
        ),
    },
    {
      id: "workflow",
      label: "/workflow",
      hint: "Launch or control a workflow",
      insert: "/workflow ",
      expand: (arg) =>
        promptDirective(
          "Use the workflow tool. Launch a named workflow, or pause/resume/stop/save using the session-unique display name.",
          arg,
        ),
    },
    { id: "workflows", label: "/workflows", hint: "Open running workflows", insert: "/workflows", expand: null },
    { id: "theme", label: "/theme", hint: "Toggle color theme", insert: "/theme ", aliases: ["t"], expand: null },
    {
      id: "tutorial",
      label: "/tutorial",
      hint: "Open Grok Build docs",
      insert: "/tutorial",
      aliases: ["tour", "onboarding"],
      expand: null,
    },
    {
      id: "import-claude",
      label: "/import-claude",
      hint: "How to import Claude settings",
      insert: "/import-claude",
      expand: null,
    },
    {
      id: "config-agents",
      label: "/config-agents",
      hint: "Open agent settings",
      insert: "/config-agents",
      aliases: ["agents"],
      expand: null,
    },
    {
      id: "personas",
      label: "/personas",
      hint: "Create or edit personas",
      insert: "/personas ",
      expand: (arg) =>
        promptDirective(
          "Help me create, edit, or list personas for subagents. Do not invent a Desktop modal — work with files and instructions.",
          arg,
        ),
    },
    { id: "privacy", label: "/privacy", hint: "Coding data retention", insert: "/privacy", expand: null },
    { id: "login", label: "/login", hint: "Sign in to Grok", insert: "/login", expand: null },
    { id: "logout", label: "/logout", hint: "Sign out", insert: "/logout", expand: null },
    { id: "docs", label: "/docs", hint: "Open Grok Build docs", insert: "/docs", aliases: ["howto", "guides"], expand: null },
    {
      id: "changelog",
      label: "/changelog",
      hint: "Open CLI release notes",
      insert: "/changelog",
      aliases: ["release-notes"],
      expand: null,
    },
    {
      id: "doctor",
      label: "/doctor",
      hint: "Run grok doctor",
      insert: "/doctor",
      aliases: ["terminal-setup", "terminal-check", "terminal-info"],
      expand: null,
    },
  ];
  const COMMANDS = [...BUILTIN_COMMANDS];

  function skillPrompt(id, arg) {
    const request = String(arg || "").trim();
    if (!request) return `Use the ${id} skill and follow it for the current request.`;
    return `Use the ${id} skill and follow it.\nUser request: ${request}`;
  }

  function commandAliases(command) {
    return (command?.aliases || []).map((alias) => String(alias).toLowerCase());
  }

  function builtinNameSet() {
    const names = new Set();
    for (const command of BUILTIN_COMMANDS) {
      names.add(command.id);
      for (const alias of commandAliases(command)) names.add(alias);
    }
    return names;
  }

  function findCommand(id) {
    const key = String(id || "").trim().toLowerCase();
    if (!key) return null;
    return (
      COMMANDS.find((command) => command.id === key || commandAliases(command).includes(key)) ||
      null
    );
  }

  function commandMatchesQuery(command, query) {
    if (!query) return true;
    if (command.id.startsWith(query) || command.label.slice(1).startsWith(query)) return true;
    return commandAliases(command).some((alias) => alias.startsWith(query));
  }

  /** Replace commands discovered from the active workspace/profile. */
  function setRuntimeCommands(items) {
    const reserved = builtinNameSet();
    const seen = new Set();
    const runtime = [];
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item?.id || "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || reserved.has(id) || seen.has(id)) continue;
      if (item?.kind !== "skill") continue;
      seen.add(id);
      runtime.push({
        id,
        label: `/${id}`,
        hint: String(item.hint || "Local Grok skill"),
        description: String(item.description || item.hint || "Local Grok skill"),
        insert: `/${id} `,
        kind: "skill",
        expand: (arg) => skillPrompt(id, arg),
      });
    }
    runtime.sort((a, b) => a.id.localeCompare(b.id));
    COMMANDS.splice(BUILTIN_COMMANDS.length, COMMANDS.length, ...runtime);
    return runtime;
  }

  /**
   * Detect `/command rest` at start of prompt.
   * @param {string} text
   * @returns {{ id: string, arg: string, raw: string } | null}
   */
  function parseLeadingSlash(text) {
    const s = String(text || "").trim();
    const m = s.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    return { id: m[1].toLowerCase(), arg: (m[2] || "").trim(), raw: s };
  }

  /**
   * Expand known slash for agent prompt, or return UI action.
   * @param {string} text
   * @param {SlashContext} [ctx]
   * @returns {{ kind: 'prompt', text: string, id?: string } | { kind: 'ui', action: string } | { kind: 'passthrough', text: string }}
   */
  function resolveSlash(text, ctx) {
    const parsed = parseLeadingSlash(text);
    if (!parsed) return { kind: "passthrough", text: String(text || "") };
    const cmd = findCommand(parsed.id);
    if (!cmd) return { kind: "passthrough", text: String(text || "") };
    if (!cmd.expand) {
      return { kind: "ui", action: cmd.id, arg: parsed.arg };
    }
    return {
      kind: "prompt",
      id: cmd.id,
      text: cmd.expand(parsed.arg, ctx || {}),
    };
  }

  /**
   * Slash menu while typing `/...` at start.
   * @param {string} value
   * @param {number} caret
   */
  function menuForInput(value, caret) {
    const text = String(value ?? "");
    const pos = Math.max(0, Math.min(Number(caret) || 0, text.length));
    // Only when line starts with /
    if (!text.startsWith("/")) return null;
    // No menu if caret left the first token area beyond first space + long arg (still show filtered)
    const before = text.slice(0, pos);
    if (before.includes("\n")) return null;
    const m = before.match(/^\/([\w-]*)$/);
    if (!m) return null; // after space, hide menu (user is typing args)
    const q = m[1].toLowerCase();
    const items = COMMANDS.filter((c) => commandMatchesQuery(c, q));
    if (!items.length) return null;
    return { query: q, start: 0, end: pos, items };
  }

  /**
   * Extract image/video file refs from assistant text for preview.
   * @param {string} text
   * @returns {{ kind: 'image'|'video', src: string, alt?: string }[]}
   */
  function extractMediaRefs(text) {
    const s = String(text || "");
    /** @type {{ kind: 'image'|'video', src: string, alt?: string }[]} */
    const out = [];
    const seen = new Set();
    const push = (kind, src, alt) => {
      let u = String(src || "").trim().replace(/^['"`]+|['"`]+$/g, "");
      if (!u) return;
      // Skip doc placeholders (e.g. path.png examples, <project>, ellipsis)
      if (/[<>…]|\.\.\./.test(u)) return;
      if (/^(path|file|image|example)\.(png|jpe?g|gif|webp)$/i.test(u)) return;
      // Keep %3A / %5C in session folder names — main resolves on disk as-is
      u = u.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
      if (!/[\\/]/.test(u) && !u.startsWith("data:") && !/^https?:/i.test(u)) {
        if (
          !/^\d+\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(u) &&
          !/^(images|videos)[\\/]/i.test(u)
        ) {
          return;
        }
      }
      const key = `${kind}:${u}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ kind, src: u, alt: alt || "" });
    };

    // Markdown images ![alt](url) — may also wrap video paths
    const mdImg = /!\[([^\]]*)\]\(([^)\n]+)\)/g;
    let m;
    while ((m = mdImg.exec(s))) {
      const src = m[2].trim().replace(/^<|>$/g, "");
      const isVid = /\.(mp4|webm|mov)(\?|$)/i.test(src);
      push(isVid ? "video" : "image", src, m[1]);
    }

    // Markdown / HTML-ish links to media [label](path.png)
    const mdLink =
      /\[([^\]]*)\]\(([^)\n]+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov)(?:\?[^)\s]*)?)\)/gi;
    while ((m = mdLink.exec(s))) {
      const src = m[2].trim();
      const isVid = /\.(mp4|webm|mov)(\?|$)/i.test(src);
      push(isVid ? "video" : "image", src, m[1]);
    }

    // file:// or absolute / relative paths ending with media ext
    const pathRe =
      /(?:^|[\s`'"(\[])((?:[A-Za-z]:[\\/]|\/|file:\/\/|\.\/|\.\.\/|images[\\/]|videos[\\/]|~\/|\.grok[\\/])[^\s`'")\]]+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov))/gi;
    while ((m = pathRe.exec(s))) {
      const isVid = /\.(mp4|webm|mov)$/i.test(m[1]);
      push(isVid ? "video" : "image", m[1]);
    }

    // Bare session-relative: images/1.jpg, videos/1.mp4
    const relImg =
      /(?:^|[\s`'"(\[])((?:images|\.\/images)[\\/][^\s`'")\]]+\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov))/gi;
    while ((m = relImg.exec(s))) {
      const isVid = /\.(mp4|webm|mov)$/i.test(m[1]);
      push(isVid ? "video" : "image", m[1]);
    }
    const relVid =
      /(?:^|[\s`'"(\[])((?:videos|\.\/videos)[\\/][^\s`'")\]]+\.(?:mp4|webm|mov))/gi;
    while ((m = relVid.exec(s))) {
      push("video", m[1]);
    }

    // data:image
    const dataRe = /(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/g;
    while ((m = dataRe.exec(s))) {
      push("image", m[1]);
    }

    return out.slice(0, 16);
  }

  globalThis.GrokSlashCommands = {
    COMMANDS,
    BUILTIN_COMMANDS,
    setRuntimeCommands,
    skillPrompt,
    promptDirective,
    parseLeadingSlash,
    findCommand,
    resolveSlash,
    menuForInput,
    extractMediaRefs,
    imagineVideoPreflightNote,
  };
})();
