(() => {
  const api = window.grokBuild;
  const md = globalThis.GrokMarkdown;
  if (!api) {
    document.body.innerHTML = '<p style="padding:24px;color:#aaa">Preload missing — run desktop.cmd</p>';
    return;
  }

  const $ = (id) => document.getElementById(id);
  const appEl = $("app");
  const timeline = $("messages");
  const status = $("status");
  const workspaceLabel = $("workspaceLabel");
  const prompt = $("prompt");
  const convTitle = $("convTitle");
  const planDock = $("planDock");
  const selModel = $("selModel");
  const selEffort = $("selEffort");
  const selPermission = $("selPermission");
  const selMode = $("selMode");
  const settingsModal = $("settingsModal");
  const projectList = $("projectList");
  const recentsList = $("recentsList");
  /** @type {Array<{id:string,title:string,cwd:string,messageCount?:number}>} */
  let cachedRecentsSessions = [];
  /** Sessions keyed by resolved project path (lowercase on win) */
  /** @type {Map<string, Array<{id:string,title:string,cwd:string,messageCount?:number}>>} */
  const cachedSessionsByProject = new Map();
  const attachBar = $("attachBar");
  const reviewList = $("reviewList");
  const fileTree = $("fileTree");
  const editorBody = $("editorBody");
  const editorPath = $("editorPath");
  const editorRelativePath = $("editorRelativePath");
  const editorLanguage = $("editorLanguage");
  const filePreviewEmpty = $("filePreviewEmpty");
  const diffBody = $("diffBody");
  const cliOut = $("cliOut");
  const filesRoot = $("filesRoot");
  const usageChip = $("usageChip");
  const usageText = $("usageText");
  const composerEl = document.querySelector(".composer");
  let fileTreeRequest = 0;
  let selectedFilePath = "";

  let workspaceRoot = null;
  /** Extra source folders attached to the current project (multi-root chat). */
  let extraRoots = [];
  /** Last cwd the agent process actually connected to */
  let agentWorkspace = null;
  /** Agent cwd for "No project" chats — from bootstrap.recentsWorkspace */
  let recentsWorkspace = null;
  let busy = false;
  let turnStartedAt = 0;
  /** @type {"idle"|"waiting"|"thinking"|"tools"|"responding"|"permission"|"done"|"error"} */
  let turnPhase = "idle";
  /** @type {number|null} legacy activity row id (hidden; status is footer) */
  let activityId = null;
  /** @type {ReturnType<typeof setInterval>|0} */
  let activityTimer = 0;
  /** When current phase started (CLI phase timer) */
  let phaseStartedAt = 0;
  /** When current thought stream started */
  let thoughtStartedAt = 0;
  /** Last usage text for footer (e.g. ↓169k) */
  let lastUsageFooter = "";
  let editCount = 0;
  let bootstrap = null;
  let applyingConfig = false;
  let showReasoning = true;
  let activeSessionId = null;
  /** @type {Array<{uri:string,name:string,path?:string,mimeType?:string,data?:string}>} */
  let attachments = [];
  /** @type {Array<{path:string,oldText?:string,newText?:string}>} */
  let reviews = [];
  /** @type {Array<{text:string,attachments:any[]}>} */
  const promptQueue = [];
  let drainingQueue = false;
  let termBuffer = "";

  // ── Phase A: event store + batched stream + virtual timeline ──
  const eventStore =
    globalThis.GrokEventStore?.create?.() ||
    (() => {
      const items = [];
      return {
        items,
        get length() {
          return items.length;
        },
        subscribe() {
          return () => {};
        },
        clear() {
          items.length = 0;
        },
        append(kind, text, meta) {
          const it = { id: items.length + 1, kind, text, meta: meta || {} };
          items.push(it);
          return it;
        },
        prepend(kind, text, meta) {
          const it = { id: items.length + 1, kind, text, meta: meta || {} };
          items.unshift(it);
          return it;
        },
        pushDelta() {
          return null;
        },
        endStream() {},
        removeKind() {},
        loadTurns() {
          return 0;
        },
      };
    })();

  const streamBatcher = globalThis.GrokStreamBatcher?.create?.({
    intervalMs: 40,
    onFlush(pending) {
      if (pending.segments?.length) {
        for (const segment of pending.segments) {
          if (segment.kind === "assistant") eventStore.pushDelta("assistant", segment.text);
          else if (segment.kind === "thought" && showReasoning) {
            eventStore.pushDelta("thought", segment.text);
          }
        }
        return;
      }
      // Backward-compatible fallback for older batcher payloads.
      if (pending.assistant) eventStore.pushDelta("assistant", pending.assistant);
      if (pending.thought && showReasoning) eventStore.pushDelta("thought", pending.thought);
    },
  });

  /** @type {{ path?: string, oldText?: string, newText?: string } | null} */
  let activeDiff = null;
  let diffSideBySide = false;

  /** Cache local file → { url, path, mimeType, kind } for timeline media preview */
  const mediaSrcCache = new Map();
  /** @type {string[]} blob: URLs to revoke on navigation */
  const mediaBlobUrls = [];

  /**
   * Pass path to main mostly as-is. Do NOT decodeURIComponent whole path —
   * Grok session dirs keep names like E%3A%5Cprojects%5C… on disk.
   */
  function normalizeMediaPathClient(src) {
    let p = String(src || "").trim().replace(/^['"`]+|['"`]+$/g, "");
    if (!p) return "";
    if (p.startsWith("data:") || /^https?:\/\//i.test(p)) return p;
    p = p.replace(/^file:\/\//i, "");
    p = p.replace(/^\/([A-Za-z]:)/, "$1");
    return p;
  }

  function base64ToBlobUrl(b64, mime) {
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: mime || "application/octet-stream" }));
      mediaBlobUrls.push(url);
      return url;
    } catch {
      return null;
    }
  }

  /**
   * @returns {Promise<{url:string,path?:string,mimeType?:string,kind?:string}|null>}
   */
  async function resolveMedia(src) {
    const raw = String(src || "").trim();
    if (!raw) return null;
    if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
      return {
        url: raw,
        path: "",
        mimeType: raw.startsWith("data:video") ? "video/mp4" : "image/png",
        kind: raw.startsWith("data:video") || /\.(mp4|webm|mov)(\?|$)/i.test(raw) ? "video" : "image",
      };
    }
    const p = normalizeMediaPathClient(raw);
    if (!p || /[<>…]|\.\.\./.test(p)) return null;
    if (mediaSrcCache.has(p)) return mediaSrcCache.get(p);

    const tryRead = async (pathTry) => {
      if (!pathTry || /[<>…]|\.\.\./.test(pathTry)) return null;
      if (!api.readMediaPreview) return null;
      try {
        const res = await api.readMediaPreview(pathTry);
        if (res?.ok === false) {
          // Still surface path when oversized so "Open folder" can work if we know it
          if (res?.path) {
            return { url: null, path: res.path, mimeType: "", kind: "", error: res.message };
          }
          return null;
        }
        const mime = res?.mimeType || "application/octet-stream";
        const kind = res?.kind || (mime.startsWith("video/") ? "video" : "image");
        let url = res?.dataUrl || null;
        // Prefer blob: for video (Chromium handles large data: video poorly)
        if (kind === "video" && res?.data) {
          url = base64ToBlobUrl(res.data, mime) || url;
        } else if (!url && res?.data && mime) {
          url = `data:${mime};base64,${res.data}`;
        }
        if (!url) return null;
        return {
          url,
          path: res.path || "",
          mimeType: mime,
          kind,
        };
      } catch {
        return null;
      }
    };

    let meta = await tryRead(p);
    if ((!meta || !meta.url) && workspaceRoot && !/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith("\\\\")) {
      meta = await tryRead(
        `${workspaceRoot.replace(/[\\/]+$/, "")}\\${p.replace(/^\.?[\\/]/, "")}`,
      );
    }
    if ((!meta || !meta.url) && /^\d+\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(p)) {
      const folder = /\.(mp4|webm|mov)$/i.test(p) ? "videos" : "images";
      meta = await tryRead(`${folder}/${p}`);
      if ((!meta || !meta.url) && folder === "videos") meta = await tryRead(`images/${p}`);
    }
    if (meta?.url) mediaSrcCache.set(p, meta);
    return meta?.url ? meta : null;
  }

  async function resolveMediaSrc(src) {
    const m = await resolveMedia(src);
    return m?.url || null;
  }

  // ── Media lightbox + context menu (Imagine previews) ──
  const mediaLightbox = document.createElement("div");
  mediaLightbox.id = "mediaLightbox";
  mediaLightbox.className = "media-lightbox hidden";
  mediaLightbox.setAttribute("role", "dialog");
  mediaLightbox.setAttribute("aria-modal", "true");
  mediaLightbox.innerHTML = `
    <div class="media-lb-backdrop" data-lb-close="1"></div>
    <div class="media-lb-panel">
      <button type="button" class="media-lb-close" data-lb-close="1" aria-label="Close">×</button>
      <img class="media-lb-img hidden" alt="Preview" />
      <video class="media-lb-video hidden" controls playsinline></video>
      <div class="media-lb-bar">
        <span class="media-lb-name"></span>
        <div class="media-lb-actions">
          <button type="button" class="btn sm" data-lb-act="copy">Copy image</button>
          <button type="button" class="btn sm" data-lb-act="copy-path">Copy path</button>
          <button type="button" class="btn sm" data-lb-act="folder">Open folder</button>
          <button type="button" class="btn sm" data-lb-act="open">Open file</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(mediaLightbox);

  const mediaCtx = document.createElement("div");
  mediaCtx.id = "mediaCtx";
  mediaCtx.className = "media-ctx hidden";
  mediaCtx.setAttribute("role", "menu");
  mediaCtx.innerHTML = `
    <button type="button" role="menuitem" data-ctx="copy">Copy image</button>
    <button type="button" role="menuitem" data-ctx="copy-path">Copy path</button>
    <button type="button" role="menuitem" data-ctx="folder">Open containing folder</button>
    <button type="button" role="menuitem" data-ctx="open">Open file</button>`;
  document.body.appendChild(mediaCtx);

  const pathCtx = document.createElement("div");
  pathCtx.id = "pathCtx";
  pathCtx.className = "media-ctx path-ctx hidden";
  pathCtx.setAttribute("role", "menu");
  pathCtx.innerHTML = `
    <button type="button" role="menuitem" data-path-act="folder" data-i18n="pathOpenContaining">Open containing folder</button>
    <button type="button" role="menuitem" data-path-act="open" data-i18n="pathOpenTarget">Open file or folder</button>
    <button type="button" role="menuitem" data-path-act="copy" data-i18n="pathCopy">Copy path</button>`;
  document.body.appendChild(pathCtx);

  const sessionMoveMenu = document.createElement("div");
  sessionMoveMenu.id = "sessionMoveMenu";
  sessionMoveMenu.className = "media-ctx session-move-menu hidden";
  sessionMoveMenu.setAttribute("role", "menu");
  document.body.appendChild(sessionMoveMenu);

  const sessionCtx = document.createElement("div");
  sessionCtx.id = "sessionCtx";
  sessionCtx.className = "media-ctx session-context-menu hidden";
  sessionCtx.setAttribute("role", "menu");
  document.body.appendChild(sessionCtx);

  /** @type {{ kind?: string, displayUrl?: string, filePath?: string, rawSrc?: string } | null} */
  let mediaActive = null;
  /** @type {{ path?: string, label?: string } | null} */
  let pathActive = null;
  /** @type {{ id:string, title?:string, cwd?:string } | null} */
  let sessionMoveActive = null;
  let sessionContextText = "";

  function hideMediaCtx() {
    mediaCtx.classList.add("hidden");
  }

  function hidePathCtx() {
    pathCtx.classList.add("hidden");
  }

  function hideSessionMoveMenu() {
    sessionMoveMenu.classList.add("hidden");
    sessionMoveActive = null;
  }

  function hideSessionCtx() {
    sessionCtx.classList.add("hidden");
    sessionContextText = "";
  }

  function showSessionCtx(pos, itemText) {
    hideMediaCtx();
    hidePathCtx();
    hideSessionMoveMenu();
    const selection = String(globalThis.getSelection?.()?.toString() || "").trim();
    sessionContextText = selection || String(itemText || "").trim();
    sessionCtx.innerHTML = `
      <button type="button" role="menuitem" data-session-act="copy">${escapeHtml(selection ? tt("copySelection", "Copy selection") : tt("copyContent", "Copy content"))}</button>
      <button type="button" role="menuitem" data-session-act="copy-all">${escapeHtml(tt("copySession", "Copy session"))}</button>
      <button type="button" role="menuitem" data-session-act="select-all">${escapeHtml(tt("selectAll", "Select all"))}</button>`;
    sessionCtx.classList.remove("hidden");
    const pad = 8;
    const width = sessionCtx.offsetWidth || 210;
    const height = sessionCtx.offsetHeight || 120;
    let x = pos?.x ?? 0;
    let y = pos?.y ?? 0;
    if (x + width > window.innerWidth - pad) x = window.innerWidth - width - pad;
    if (y + height > window.innerHeight - pad) y = window.innerHeight - height - pad;
    sessionCtx.style.left = `${Math.max(pad, x)}px`;
    sessionCtx.style.top = `${Math.max(pad, y)}px`;
  }

  function showSessionMoveMenu(sessionInfo, pos) {
    hideMediaCtx();
    hidePathCtx();
    sessionMoveActive = sessionInfo || null;
    sessionMoveMenu.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "context-menu-heading";
    heading.textContent = tt("moveChatTo", "Move chat to");
    sessionMoveMenu.appendChild(heading);
    const destinations = [
      { label: tt("noProject", "No project"), value: "", cwd: getRecentsWorkspace() || "" },
      ...projectListItems().map((p) => ({ label: basen(p), value: p, cwd: p })),
    ];
    for (const destination of destinations) {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.textContent = destination.label;
      button.title = destination.cwd || destination.label;
      const currentCwd = sessionInfo?.cwd || "";
      button.disabled = samePath(currentCwd, destination.cwd);
      button.onclick = () => {
        hideSessionMoveMenu();
        void moveSessionToProject(sessionInfo, destination.value);
      };
      sessionMoveMenu.appendChild(button);
    }
    sessionMoveMenu.classList.remove("hidden");
    const pad = 8;
    const width = sessionMoveMenu.offsetWidth || 230;
    const height = sessionMoveMenu.offsetHeight || 180;
    let x = pos?.x ?? 0;
    let y = pos?.y ?? 0;
    if (x + width > window.innerWidth - pad) x = window.innerWidth - width - pad;
    if (y + height > window.innerHeight - pad) y = window.innerHeight - height - pad;
    sessionMoveMenu.style.left = `${Math.max(pad, x)}px`;
    sessionMoveMenu.style.top = `${Math.max(pad, y)}px`;
  }

  async function moveSessionToProject(sessionInfo, targetProject) {
    if (!sessionInfo?.id || !api.moveSession) return;
    try {
      const result = await api.moveSession(sessionInfo.id, targetProject || "");
      const movedCwd = result?.workspace || result?.cwd || getRecentsWorkspace() || "";
      sessionTabs?.updateSession?.(sessionInfo.id, { cwd: movedCwd });
      if (activeSessionId === sessionInfo.id) {
        const noProject = Boolean(result?.isRecents) || isRecentsPath(movedCwd);
        await alignProjectWorkspace(noProject ? null : movedCwd);
        setStatus("starting", tt("movingChat", "Moving chat…"));
        await api.loadSession(sessionInfo.id, movedCwd, connectOpts());
        agentConnected = true;
        await paintTranscript(sessionInfo.id);
        setStatus("connected");
      }
      await refreshHistory();
      addStep(
        tt("chatMoved", "Chat moved to {project}").replace(
          "{project}",
          result?.isRecents ? tt("noProject", "No project") : basen(movedCwd),
        ),
      );
    } catch (error) {
      addMsg("error", error?.message || String(error));
      setStatus("error");
    }
  }

  function resolveSessionPath(rawPath) {
    let value = String(rawPath || "").trim().replace(/^['"`]+|['"`]+$/g, "");
    value = value.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
    // Keep encoded Grok session directory names (for example E%3A%5Cprojects)
    // intact. Decode only spaces commonly introduced by file links.
    value = value.replace(/%20/gi, " ");
    // Markdown file links may carry a source location suffix (:line or
    // :line:column). Explorer/openPath needs the underlying filesystem path.
    value = value.replace(/:(\d+)(?::\d+)?$/, "");
    if (!value || /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value)) return value;
    if (!workspaceRoot) return value;
    const root = String(workspaceRoot).replace(/[\\/]+$/, "");
    const relative = value.replace(/^\.{1,2}[\\/]/, "").replace(/\//g, "\\");
    return `${root}\\${relative}`;
  }

  function showPathCtx(info, pos) {
    hideMediaCtx();
    hideSessionCtx();
    hideSessionMoveMenu();
    pathActive = info || null;
    pathCtx.classList.remove("hidden");
    const pad = 8;
    const width = pathCtx.offsetWidth || 220;
    const height = pathCtx.offsetHeight || 110;
    let x = pos?.x ?? 0;
    let y = pos?.y ?? 0;
    if (x + width > window.innerWidth - pad) x = window.innerWidth - width - pad;
    if (y + height > window.innerHeight - pad) y = window.innerHeight - height - pad;
    pathCtx.style.left = `${Math.max(pad, x)}px`;
    pathCtx.style.top = `${Math.max(pad, y)}px`;
  }

  async function pathAct(action, info) {
    const current = info || pathActive;
    const resolved = resolveSessionPath(current?.path);
    if (!resolved) return;
    try {
      if (action === "folder") {
        const result = await api.showItemInFolder?.(resolved);
        if (result?.ok === false) addStep(result.message || "Could not open containing folder");
      } else if (action === "open") {
        const result = await api.openPath?.(resolved);
        if (result?.ok === false) addStep(result.message || "Could not open path");
      } else if (action === "copy") {
        if (api.writeClipboardText) await api.writeClipboardText(resolved);
        else await navigator.clipboard?.writeText?.(resolved);
      }
    } catch (error) {
      addStep(error?.message || String(error));
    }
  }

  function hideMediaLightbox() {
    mediaLightbox.classList.add("hidden");
    const v = mediaLightbox.querySelector(".media-lb-video");
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      v.removeAttribute("src");
      v.load?.();
    }
    const img = mediaLightbox.querySelector(".media-lb-img");
    if (img) img.removeAttribute("src");
    mediaActive = null;
  }

  function showMediaLightbox(info) {
    hideMediaCtx();
    mediaActive = info || null;
    const kind = info?.kind === "video" ? "video" : "image";
    const img = mediaLightbox.querySelector(".media-lb-img");
    const vid = mediaLightbox.querySelector(".media-lb-video");
    const name = mediaLightbox.querySelector(".media-lb-name");
    const copyBtn = mediaLightbox.querySelector('[data-lb-act="copy"]');
    if (img) img.classList.add("hidden");
    if (vid) {
      vid.classList.add("hidden");
      try {
        vid.pause();
      } catch {
        /* ignore */
      }
    }
    const url = info?.displayUrl || "";
    const pathLabel = info?.filePath || info?.rawSrc || "";
    if (name) {
      name.textContent = pathLabel.replace(/\\/g, "/").split("/").pop() || "Media";
      name.title = pathLabel;
    }
    if (copyBtn) copyBtn.classList.toggle("hidden", kind === "video");
    if (kind === "video" && vid && url) {
      vid.classList.remove("hidden");
      vid.src = url;
      void vid.play?.().catch(() => {});
    } else if (img && url) {
      img.classList.remove("hidden");
      img.src = url;
    }
    mediaLightbox.classList.remove("hidden");
  }

  function showMediaCtx(info, pos) {
    hidePathCtx();
    hideSessionCtx();
    hideSessionMoveMenu();
    mediaActive = info || null;
    const copyBtn = mediaCtx.querySelector('[data-ctx="copy"]');
    if (copyBtn) {
      // Video: copy path (no image clipboard). Image: copy bitmap when path known.
      copyBtn.classList.remove("hidden");
      copyBtn.textContent = info?.kind === "video" ? "Copy path" : "Copy image";
    }
    mediaCtx.classList.remove("hidden");
    const pad = 8;
    const w = mediaCtx.offsetWidth || 200;
    const h = mediaCtx.offsetHeight || 140;
    let x = pos?.x ?? 0;
    let y = pos?.y ?? 0;
    if (x + w > window.innerWidth - pad) x = window.innerWidth - w - pad;
    if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
    mediaCtx.style.left = `${Math.max(pad, x)}px`;
    mediaCtx.style.top = `${Math.max(pad, y)}px`;
  }

  async function mediaAct(action, info) {
    const i = info || mediaActive;
    if (!i) return;
    const filePath = i.filePath || (!/^https?:|^data:|^blob:/i.test(i.rawSrc || "") ? i.rawSrc : "");
    const toast = (msg) => {
      try {
        addStep(msg);
      } catch {
        /* ignore */
      }
    };
    try {
      if (action === "copy") {
        if (i.kind === "video") {
          if (filePath && api.writeClipboardText) {
            await api.writeClipboardText(filePath);
            toast("Path copied");
          }
          return;
        }
        if (filePath && api.writeClipboardImage) {
          const res = await api.writeClipboardImage(filePath);
          if (res?.ok) {
            toast("Image copied");
            return;
          }
        }
        // Fallback: draw display URL to canvas → not always possible for blob; try clipboard write of path
        if (filePath && api.writeClipboardText) {
          await api.writeClipboardText(filePath);
          toast("Path copied (image clipboard failed)");
        } else if (i.displayUrl?.startsWith("data:image") && navigator.clipboard?.write) {
          const blob = await (await fetch(i.displayUrl)).blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          toast("Image copied");
        }
      } else if (action === "copy-path") {
        const t = filePath || i.rawSrc || i.displayUrl || "";
        if (api.writeClipboardText) await api.writeClipboardText(t);
        else await navigator.clipboard?.writeText?.(t);
        toast("Path copied");
      } else if (action === "folder") {
        if (!filePath) {
          toast("No local file path");
          return;
        }
        if (api.showItemInFolder) {
          const res = await api.showItemInFolder(filePath);
          if (!res?.ok) toast(res?.message || "Could not open folder");
        } else if (api.openPath) {
          // open parent via path dirname is main-side only — fall back open file
          await api.openPath(filePath);
        }
      } else if (action === "open") {
        if (filePath && api.openPath) {
          await api.openPath(filePath);
        } else if (i.displayUrl && /^https?:/i.test(i.displayUrl)) {
          await api.openExternal?.(i.displayUrl);
        } else {
          toast("No local file path");
        }
      }
    } catch (e) {
      toast(e?.message || String(e));
    }
  }

  mediaLightbox.addEventListener("click", (e) => {
    const t = e.target;
    if (t?.closest?.("[data-lb-close]")) {
      hideMediaLightbox();
      return;
    }
    const act = t?.closest?.("[data-lb-act]")?.getAttribute("data-lb-act");
    if (act) void mediaAct(act === "copy" ? "copy" : act === "copy-path" ? "copy-path" : act === "folder" ? "folder" : "open");
  });
  mediaCtx.addEventListener("click", (e) => {
    const act = e.target?.closest?.("[data-ctx]")?.getAttribute("data-ctx");
    if (!act) return;
    hideMediaCtx();
    void mediaAct(act);
  });
  pathCtx.addEventListener("click", (e) => {
    const action = e.target?.closest?.("[data-path-act]")?.getAttribute("data-path-act");
    if (!action) return;
    hidePathCtx();
    void pathAct(action);
  });
  sessionCtx.addEventListener("click", (event) => {
    const action = event.target?.closest?.("[data-session-act]")?.getAttribute("data-session-act");
    if (!action) return;
    const itemText = sessionContextText;
    hideSessionCtx();
    if (action === "select-all") {
      const range = document.createRange();
      range.selectNodeContents(timeline.querySelector(".tl-window") || timeline);
      const selection = globalThis.getSelection?.();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    const value =
      action === "copy-all"
        ? eventStore.items
            .filter((item) => item.kind !== "empty" && item.kind !== "activity")
            .map((item) => String(item.text || "").trim())
            .filter(Boolean)
            .join("\n\n")
        : itemText;
    if (value) void api.writeClipboardText?.(value);
  });
  timeline.addEventListener("contextmenu", (event) => {
    if (event.target?.closest?.(".md-path-link, .media-interactive, .media-card")) return;
    event.preventDefault();
    const item = event.target?.closest?.(".tl-item");
    showSessionCtx({ x: event.clientX, y: event.clientY }, item?.innerText || item?.textContent || "");
  });
  document.addEventListener(
    "click",
    (e) => {
      if (!mediaCtx.classList.contains("hidden") && !mediaCtx.contains(e.target)) hideMediaCtx();
      if (!pathCtx.classList.contains("hidden") && !pathCtx.contains(e.target)) hidePathCtx();
      if (!sessionMoveMenu.classList.contains("hidden") && !sessionMoveMenu.contains(e.target)) {
        hideSessionMoveMenu();
      }
      if (!sessionCtx.classList.contains("hidden") && !sessionCtx.contains(e.target)) hideSessionCtx();
    },
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!pathCtx.classList.contains("hidden")) hidePathCtx();
      else if (!mediaCtx.classList.contains("hidden")) hideMediaCtx();
      else if (!sessionMoveMenu.classList.contains("hidden")) hideSessionMoveMenu();
      else if (!sessionCtx.classList.contains("hidden")) hideSessionCtx();
      else if (!mediaLightbox.classList.contains("hidden")) hideMediaLightbox();
    }
  });

  const timelineView = globalThis.GrokTimelineView?.create?.(timeline, {
    store: eventStore,
    showReasoning: () => showReasoning,
    t: (key, fallback) => tt(key, fallback),
    openExternal: (href) => {
      const h = String(href || "");
      if (/^https?:\/\//i.test(h) || h.startsWith("data:")) void api.openExternal(h);
      else if (h) void api.openPath?.(h.replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1"));
    },
    resolveMediaSrc,
    resolveMedia,
    onMediaActivate: (info) => showMediaLightbox(info),
    onMediaContext: (info, pos) => showMediaCtx(info, pos),
    onPathActivate: (info) => void pathAct("folder", info),
    onPathContext: (info, pos) => showPathCtx(info, pos),
    onReview: (meta) => {
      if (meta?.path) void showDiff(meta);
    },
    onPermission: (requestId, optionId) => {
      void resolvePermissionInline(requestId, optionId);
    },
    emptyTitle: () => (workspaceRoot ? basen(workspaceRoot) : "project"),
    emptyBody: () => tt("typeToStart", "Type a message below to start. Try /imagine …"),
  });

  // ── Phase B1 session tabs ──
  function restoreStoreItems(items) {
    stopActivityTimer();
    activityId = null;
    turnPhase = "idle";
    turnStartedAt = 0;
    streamBatcher?.clear?.();
    eventStore.clear();
    for (const it of items || []) {
      eventStore.append(it.kind, it.text || "", it.meta || {});
    }
    if (!eventStore.length) showEmpty();
  }

  function captureTabRuntime(tab) {
    if (!tab) return;
    tab.busy = Boolean(busy);
    tab.turnPhase = turnPhase || "idle";
    tab.turnStartedAt = Number(turnStartedAt) || 0;
    tab.phaseStartedAt = Number(phaseStartedAt) || 0;
    tab.lastUsageFooter = lastUsageFooter || "";
  }

  function restoreTabRuntime(tab) {
    busy = Boolean(tab?.busy);
    turnPhase = tab?.turnPhase || "idle";
    turnStartedAt = Number(tab?.turnStartedAt) || 0;
    phaseStartedAt = Number(tab?.phaseStartedAt) || 0;
    lastUsageFooter = tab?.lastUsageFooter || "";
    if (busy && turnStartedAt) startActivityTimer();
    else stopActivityTimer();
    paintTurnStatus();
  }

  const sessionTabs = globalThis.GrokSessionTabs?.create?.({
    root: $("sessionTabs"),
    onActivate: (tab, prev) => {
      tab.activating = true;
      const skipPrevSnapshot = Boolean(tab.skipPrevSnapshot);
      tab.skipPrevSnapshot = false;
      if (prev && !skipPrevSnapshot) {
        // Commit the last coalesced stream chunk before persisting the hidden
        // tab. Otherwise a quick sidebar switch can show the chunk once but
        // lose it from the tab snapshot on the next navigation.
        streamBatcher?.flushNow?.();
        prev.items = sessionTabs.snapshotItems(eventStore.items);
        captureTabRuntime(prev);
      }
      activeSessionId = tab.sessionId;
      syncConvTitle();
      // A tab owns its project. Align composer + sidebar before painting its
      // cache so an old UI selection cannot show it under a different cwd.
      void (async () => {
        const tabCwd = tab.cwd || "";
        const noProject = isRecentsPath(tabCwd);
        if (noProject) {
          if (workspaceRoot) {
            await alignProjectWorkspace(null);
          }
        } else if (!samePath(tabCwd, workspaceRoot)) {
          await alignProjectWorkspace(tabCwd);
        }
        // A fast second tab click supersedes this activation.
        if (sessionTabs.getActive() !== tab) {
          tab.activating = false;
          return;
        }
        restoreStoreItems(tab.items || []);
        restoreTabRuntime(tab);
        updateQueueBar();
        scrollEnd(true);
        // Tab activation must never resume/replace an ACP session. It only
        // selects an already-bound slot and replays events cached while hidden.
        if (tab.slotId && api.setActiveAgentSlot) {
          try {
            await api.setActiveAgentSlot(tab.slotId);
            const state = await api.agentSlots?.();
            const slot = state?.slots?.find?.((s) => s.id === tab.slotId);
            if (sessionTabs.getActive() !== tab) {
              tab.activating = false;
              return;
            }
            agentConnected = Boolean(slot?.warm);
            agentWorkspace = slot?.workspace || null;
          } catch {
            tab.slotId = null;
            agentConnected = false;
            agentWorkspace = null;
          }
        } else {
          agentConnected = false;
          agentWorkspace = null;
          if (!tab.busy) {
            setStatus(
              "disconnected",
              tab.sessionId
                ? tt("cachedChatReady", "Cached · send to resume")
                : tt("newConversation", "New conversation"),
            );
          }
        }
        tab.activating = false;
        const pending = sessionTabs.takePendingEvents?.(tab.id) || [];
        for (const event of pending) handleAgentEvent(event);
        captureTabRuntime(tab);
        sessionTabs.render?.();
      })().catch(() => {
        tab.activating = false;
      });
    },
    onNew: () => {
      void newChatTab(true);
    },
    onClose: (tab) => {
      if (tab?.slotId) {
        void Promise.resolve(api.stopAgentSlot?.(tab.slotId)).finally(() => void refreshAgentSlots());
      }
    },
    onRename: (tab) => {
      void renameActiveChat("", tab);
    },
  });

  function conversationHeading() {
    if (workspaceRoot) return basen(workspaceRoot);
    return tt("newConversation", "New chat");
  }

  function syncConvTitle(explicit) {
    if (!convTitle) return;
    void explicit;
    const projectName = workspaceRoot ? basen(workspaceRoot) : tt("noProject", "No project");
    convTitle.textContent = projectName;
    convTitle.title = workspaceRoot || projectName;
  }

  /** Latest recap / last-turn summary for the open chat (Grok CLI 1.0.5). */
  let activeSessionMeta = { lastRecap: "", lastTurnSummary: "", titleIsManual: false };

  function applySessionRecap(meta) {
    const recap = String(meta?.lastRecap || "").trim();
    const lastTurn = String(meta?.lastTurnSummary || "").trim();
    activeSessionMeta = {
      lastRecap: recap,
      lastTurnSummary: lastTurn,
      titleIsManual: Boolean(meta?.titleIsManual),
    };
    if (!eventStore.prepend) {
      paintSessionFlowStrip();
      return;
    }
    eventStore.removeKind?.("recap");
    if (recap || lastTurn) {
      eventStore.prepend("recap", recap || lastTurn, {
        lastTurnSummary: lastTurn,
        open: false,
      });
    }
    paintSessionFlowStrip();
  }

  function paintSessionFlowStrip() {
    const el = $("sessionFlowStrip");
    if (!el) return;
    const effort = selEffort?.value || lastSessionInfo?.reasoningEffort || "";
    const pct = lastSessionInfo?.context?.percent;
    const lastTurn = activeSessionMeta.lastTurnSummary || lastSessionInfo?.lastTurnSummary || "";
    const recap = activeSessionMeta.lastRecap || lastSessionInfo?.lastRecap || "";
    const parts = [];
    if (effort) parts.push(effort);
    if (pct != null && Number.isFinite(Number(pct))) parts.push(`${Number(pct)}%`);
    if (lastTurn) parts.push(lastTurn);
    else if (recap) parts.push(recap);
    const text = parts.filter(Boolean).join(" · ");
    el.textContent = text;
    el.title = recap || lastTurn || text;
    el.hidden = !text;
    el.classList.toggle("hidden", !text);
  }

  function rememberSessionMeta(session) {
    if (!session || session.id !== activeSessionId) return;
    activeSessionMeta = {
      lastRecap: String(session.lastRecap || activeSessionMeta.lastRecap || "").trim(),
      lastTurnSummary: String(session.lastTurnSummary || activeSessionMeta.lastTurnSummary || "").trim(),
      titleIsManual: Boolean(session.titleIsManual),
    };
    if (
      session.title &&
      !session.titleIsManual &&
      session.title !== sessionTabs?.getActive?.()?.title &&
      !looksLikeSessionIdTitle(session)
    ) {
      sessionTabs?.updateActive?.({ title: session.title });
      syncConvTitle(session.title);
    }
    paintSessionFlowStrip();
  }

  async function newChatTab(viaAgent) {
    const current = sessionTabs.getActive?.();
    sessionTabs.saveSnapshot(eventStore.items);
    captureTabRuntime(current);
    const title = conversationHeading();
    const pristine = current && !current.sessionId && !(current.items || []).length && !current.busy;
    const next = pristine
      ? sessionTabs.updateActive?.({
          title,
          sessionId: null,
          slotId: current.slotId || null,
          cwd: effectiveWorkspace() || null,
          items: [],
          skipPrevSnapshot: true,
        }) || current
      : sessionTabs.addTab?.(
          {
            title,
            sessionId: null,
            cwd: effectiveWorkspace() || null,
            items: [],
            skipPrevSnapshot: true,
          },
          true,
        );
    if (pristine) {
      restoreStoreItems([]);
      restoreTabRuntime(next);
      showEmpty();
    }
    activeSessionMeta = { lastRecap: "", lastTurnSummary: "", titleIsManual: false };
    paintSessionFlowStrip();
    syncConvTitle(title);
    // Creating a tab is local and instant. A fresh ACP session is allocated on
    // first send so an already-running tab cannot be interrupted by this click.
    activeSessionId = null;
    editCount = 0;
    reviews = [];
    renderReviewList();
    planDock.classList.add("hidden");
    unlockChatInput();
    return sessionTabs.getActive?.();
  }

  async function resolvePermissionInline(requestId, optionId) {
    const item = eventStore.findLast?.(
      (it) => it.kind === "permission" && it.meta?.requestId === requestId,
    );
    try {
      await api.resolvePermission(requestId, optionId);
      if (item) {
        const label =
          optionId === "__cancel__"
            ? tt("labelCancelled", "Cancelled")
            : (item.meta?.options || []).find((o) => o.optionId === optionId)?.name ||
              tt("labelResolved", "Resolved");
        eventStore.update(item.id, {
          meta: { resolved: true, resultLabel: label },
        });
      }
      // Resume waiting for model after permission answer
      if (busy) setTurnPhase("waiting");
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  const I = () => (typeof GrokI18n !== "undefined" ? GrokI18n : null);
  const tt = (key, fallback) => (I()?.t(key) ?? fallback ?? key);

  function statusLabels() {
    return {
      disconnected: tt("disconnected", "Disconnected"),
      starting: tt("connecting", "Connecting…"),
      connected: tt("connected", "Ready"),
      running: tt("statusWorking", "Working…"),
      stopping: tt("stopping", "Stopping…"),
      error: tt("error", "Error"),
    };
  }

  // ── Turn activity phase (CLI-like: Waiting / Thinking / Tools / Responding) ──

  function formatElapsed(ms) {
    const sec = Math.max(0, Math.floor(Number(ms) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  /** CLI-style short duration: 0.7s / 12s / 1.2s */
  function formatPhaseSecs(ms) {
    const sec = Math.max(0.1, Number(ms) / 1000);
    if (sec < 10) return `${sec.toFixed(1)}s`;
    return `${Math.round(sec)}s`;
  }

  function paintTurnStatus() {
    const bar = $("turnStatus");
    if (!bar) return;
    const active =
      busy &&
      turnPhase &&
      turnPhase !== "idle" &&
      turnPhase !== "done" &&
      turnPhase !== "error";
    bar.classList.toggle("hidden", !active);
    if (!active) return;
    const labelEl = $("turnStatusLabel");
    const phaseEl = $("turnStatusPhaseTime");
    const totalEl = $("turnStatusTotal");
    const tokEl = $("turnStatusTokens");
    if (labelEl) labelEl.textContent = phaseLabel(turnPhase);
    if (phaseEl) {
      phaseEl.textContent = phaseStartedAt
        ? formatPhaseSecs(Date.now() - phaseStartedAt)
        : "";
    }
    if (totalEl) {
      totalEl.textContent = turnStartedAt
        ? formatPhaseSecs(Date.now() - turnStartedAt)
        : "";
    }
    if (tokEl) tokEl.textContent = lastUsageFooter || "";
    const icon = bar.querySelector(".turn-status-icon");
    icon?.classList.toggle("spin", true);
  }

  function phaseLabel(phase) {
    switch (phase) {
      case "waiting":
        return tt("phaseWaiting", "Waiting for response");
      case "thinking":
        return tt("phaseThinking", "Thinking");
      case "tools":
        return tt("phaseTools", "Using tools");
      case "responding":
        return tt("phaseResponding", "Responding");
      case "permission":
        return tt("phasePermission", "Waiting for permission");
      case "done":
        return tt("phaseDone", "Done");
      case "error":
        return tt("phaseError", "Stopped with error");
      case "reconnect":
        return tt("phaseReconnect", "Reconnecting…");
      default:
        return tt("statusWorking", "Working…");
    }
  }

  function stopActivityTimer() {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = 0;
    }
  }

  function startActivityTimer() {
    stopActivityTimer();
    activityTimer = setInterval(() => tickActivity(), 250);
  }

  function findActivityItem() {
    if (activityId == null) return null;
    return eventStore.items.find((it) => it.id === activityId) || null;
  }

  function tickActivity() {
    if (!turnStartedAt) return;
    if (
      turnPhase === "idle" ||
      turnPhase === "done" ||
      turnPhase === "error"
    ) {
      return;
    }
    paintTurnStatus();
  }

  /**
   * CLI phase machine → footer strip + header chip (no mid-timeline activity spam).
   * @param {"waiting"|"thinking"|"tools"|"responding"|"permission"|"reconnect"} phase
   */
  function setTurnPhase(phase) {
    if (!phase || phase === "idle") return;
    if ((turnPhase === "done" || turnPhase === "error") && phase !== "waiting") return;

    if (turnPhase === phase) {
      if (busy) setStatus("running", phaseLabel(phase));
      paintTurnStatus();
      if (!activityTimer) startActivityTimer();
      return;
    }

    const now = Date.now();
    if (!turnStartedAt) turnStartedAt = now;
    turnPhase = phase;
    phaseStartedAt = now;
    const label = phaseLabel(phase);
    activityId = null; // do not append timeline activity chips
    if (
      busy ||
      phase === "waiting" ||
      phase === "thinking" ||
      phase === "tools" ||
      phase === "responding" ||
      phase === "permission"
    ) {
      setStatus("running", label);
    }
    paintTurnStatus();
    if (!activityTimer) startActivityTimer();
  }

  /** Start a new turn: Waiting + timer (call right after user message is shown). */
  function beginTurnActivity() {
    activityId = null;
    turnPhase = "idle";
    thoughtStartedAt = 0;
    phaseStartedAt = Date.now();
    if (!turnStartedAt) turnStartedAt = Date.now();
    setTurnPhase("waiting");
    startActivityTimer();
  }

  /**
   * End turn: hide footer, stamp compact "Worked for Ns".
   * @param {{ error?: boolean }} [opts]
   */
  function endTurnActivity(opts) {
    stopActivityTimer();
    stampThoughtDuration();
    if (!turnStartedAt) {
      if (
        turnPhase === "waiting" ||
        turnPhase === "thinking" ||
        turnPhase === "tools" ||
        turnPhase === "responding" ||
        turnPhase === "permission"
      ) {
        turnPhase = opts?.error ? "error" : "done";
      }
      paintTurnStatus();
      $("turnStatus")?.classList.add("hidden");
      return;
    }
    const err = Boolean(opts?.error);
    const started = turnStartedAt;
    const sec = Math.max(1, Math.round((Date.now() - started) / 1000));
    turnPhase = err ? "error" : "done";
    activityId = null;
    turnStartedAt = 0;
    phaseStartedAt = 0;
    thoughtStartedAt = 0;
    $("turnStatus")?.classList.add("hidden");
    // Compact CLI foot note (not a raw end_turn string)
    eventStore.append(
      "foot",
      err
        ? phaseLabel("error")
        : tt("workedFor", "Worked for {n}s").replace("{n}", String(sec)),
      { elapsedSec: sec },
    );
    setStatus(err ? "error" : "connected");
  }

  function stampThoughtDuration() {
    if (!thoughtStartedAt) return;
    const dur = formatPhaseSecs(Date.now() - thoughtStartedAt);
    const item = eventStore.findLast?.(
      (it) => it.kind === "thought" && (it.streaming || !it.meta?.durationLabel),
    );
    if (item) {
      eventStore.update(item.id, {
        meta: { durationLabel: dur, open: false },
        streaming: false,
      });
    }
    thoughtStartedAt = 0;
  }

  /** After language switch: re-label activity / foot rows and rebuild timeline chrome. */
  function relocalizeTimeline() {
    for (const it of eventStore.items) {
      if (it.kind === "activity") {
        const phase = it.meta?.phase || "waiting";
        eventStore.update(it.id, {
          text: phaseLabel(phase),
          meta: { ...(it.meta || {}), phase },
        });
      } else if (it.kind === "foot" && it.meta?.elapsedSec != null) {
        eventStore.update(it.id, {
          text: tt("workedFor", "Worked for {n}s").replace("{n}", String(it.meta.elapsedSec)),
        });
      }
    }
    timelineView?.relocalize?.();
  }

  const LAYOUT_KEY = "grokBuild.layout.v2";
  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}"); } catch { return {}; }
  }
  function saveLayout(p) {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ ...loadLayout(), ...p }));
  }

  let composerMultiline = false;

  function applyComposerChrome() {
    const layout = loadLayout();
    composerMultiline = Boolean(layout.composerMultiline);
    document.documentElement.dataset.timestamps = layout.showTimestamps ? "on" : "off";
    document.documentElement.dataset.compact = layout.compactMode ? "on" : "off";
  }
  applyComposerChrome();

  function toggleLayoutFlag(key, onMsg, offMsg) {
    const next = !loadLayout()[key];
    saveLayout({ [key]: next });
    applyComposerChrome();
    addStep(tt(next ? onMsg.key : offMsg.key, next ? onMsg.fallback : offMsg.fallback));
    return next;
  }

  function projectHooksDir() {
    if (!workspaceRoot) return "";
    const sep = String(workspaceRoot).includes("\\") ? "\\" : "/";
    return `${String(workspaceRoot).replace(/[\\/]+$/, "")}${sep}.grok${sep}hooks`;
  }

  async function refreshFolderTrustUi() {
    const status = $("folderTrustStatus");
    if (!status) return;
    if (!workspaceRoot || isRecentsPath(workspaceRoot)) {
      status.textContent = tt("folderTrustNeedProject", "Open a project folder first.");
      return;
    }
    try {
      const res = await api.getFolderTrust?.(workspaceRoot);
      if (res?.trusted) {
        status.textContent = tt(
          "folderTrustOn",
          "This project is trusted. Repo-local MCP, LSP and hooks can run.",
        );
      } else {
        status.textContent = tt(
          "folderTrustOff",
          "This project is not trusted. Repo-local MCP will not start.",
        );
      }
    } catch {
      status.textContent = tt(
        "folderTrustHint",
        "Repo-local MCP, LSP and hooks run only after this folder is trusted.",
      );
    }
  }

  async function setProjectFolderTrust(trusted) {
    if (!workspaceRoot || isRecentsPath(workspaceRoot)) {
      addMsg("error", tt("folderTrustNeedProject", "Open a project folder first."));
      return;
    }
    try {
      const res = await api.setFolderTrust?.(workspaceRoot, trusted);
      if (!res?.ok) {
        addMsg("error", res?.error || tt("folderTrustNeedProject", "Open a project folder first."));
        return;
      }
      addStep(
        trusted
          ? tt("folderTrusted", "Project folder trusted for MCP, LSP and hooks")
          : tt("folderUntrusted", "Project folder trust revoked"),
      );
      void refreshFolderTrustUi();
      if (agentConnected) {
        await connect(effectiveWorkspace(), { forceRestart: true });
      }
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function forkParallelAgent() {
    if (!workspaceRoot) {
      addMsg("error", tt("chooseProject", "Choose a project first."));
      return;
    }
    try {
      sessionTabs?.saveSnapshot?.(eventStore.items);
      captureTabRuntime(sessionTabs?.getActive?.());
      const tab = sessionTabs?.addTab?.(
        {
          title: tt("forkedAgentTab", "Forked agent"),
          cwd: workspaceRoot,
          items: [],
        },
        true,
      );
      const spawned = await api.spawnAgentSlot?.(workspaceRoot, connectOpts(), tab?.title || "Forked agent");
      if (tab) {
        tab.slotId = spawned?.slotId || tab.slotId || null;
        tab.sessionId = spawned?.sessionId || tab.sessionId || null;
        activeSessionId = tab.sessionId;
        sessionTabs?.render?.();
      }
      await refreshAgentSlots();
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function openProjectHooksDir() {
    const dir = projectHooksDir();
    if (!dir) {
      addMsg("error", tt("folderTrustNeedProject", "Open a project folder first."));
      return;
    }
    try {
      const opened = await api.openPath?.(dir);
      if (opened && opened.ok === false) {
        addStep(tt("hooksDirMissing", "No .grok/hooks folder yet. Create it in this project to add hooks."));
        return;
      }
      addStep(tt("hooksDirHint", "Project hooks live in .grok/hooks. Add or remove JSON hook files there."));
    } catch {
      addStep(tt("hooksDirMissing", "No .grok/hooks folder yet. Create it in this project to add hooks."));
    }
  }

  function basen(p) {
    if (globalThis.GrokDom?.basen) {
      // Prefer path-aware helper; normalize slashes for Windows
      const n = globalThis.GrokDom.basen(String(p || "").replace(/\\/g, "/"));
      return n || p;
    }
    if (!p) return "";
    const s = String(p).replace(/\\/g, "/").split("/");
    return s[s.length - 1] || p;
  }

  /** Sidebar nav: history | tools | null (Connect button removed — status lives in header chip) */
  let sideNav = null;
  let agentConnected = false;

  function setSideNav(id) {
    // Exclusive selection among History / Tools (null = none)
    sideNav = id === "history" || id === "tools" ? id : null;
    const map = {
      history: $("btnHistory"),
      tools: $("btnTools"),
    };
    for (const [key, btn] of Object.entries(map)) {
      if (!btn) continue;
      const on = sideNav === key;
      btn.classList.toggle("active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    }
  }

  /**
   * Humanize status details from agent/main.
   * Session IDs (e.g. 019fd790-…) are internal Grok CLI keys under ~/.grok — never show raw.
   */
  function humanizeStatusDetail(state, detail) {
    if (detail == null || detail === "") return "";
    let s = String(detail).trim();
    // Strip UUIDs / long hex ids
    s = s.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "",
    );
    s = s.replace(/\b[0-9a-f]{8,}\b/gi, "");
    s = s.replace(/\s{2,}/g, " ").replace(/[·|]\s*$/g, "").trim();
    // Map known technical phrases — never show raw ACP/stopReason strings
    if (/resumed|resume/i.test(s) || /session\s*$/i.test(s)) {
      return tt("chatResumed", "Chat resumed");
    }
    if (/reused|warm agent|warm process/i.test(s)) {
      return tt("connected", "Ready");
    }
    if (/acp session ready|new acp|session ready/i.test(s)) {
      return tt("connected", "Ready");
    }
    if (/reconnect/i.test(s)) {
      return tt("connecting", "Connecting…");
    }
    // "Turn completed: end_turn" / stopReason noise from agent
    if (/end_turn|turn\s*complet|stop_?reason|max_turn|cancelled|canceled/i.test(s)) {
      return "";
    }
    if (/^end[_ ]?turn$/i.test(s) || /^stop$/i.test(s)) {
      return "";
    }
    // If nothing left after stripping ids, fall back to state label
    if (!s || s.length < 2) return "";
    // Drop leftover "Resumed session …" style fragments
    if (/^resumed/i.test(s) || /^session\b/i.test(s)) {
      return tt("chatResumed", "Chat resumed");
    }
    return s.length < 48 ? s : s.slice(0, 45) + "…";
  }

  function setStatus(state, detail) {
    const key = state || "disconnected";
    status.dataset.state = key;
    const t = status.querySelector(".status-text");
    const labels = statusLabels();
    const cleaned = humanizeStatusDetail(key, detail);
    // Prefer phase-aware running label when a turn is live
    let label = cleaned || labels[key] || key;
    if (
      key === "running" &&
      turnPhase &&
      turnPhase !== "idle" &&
      turnPhase !== "done" &&
      turnPhase !== "error" &&
      !cleaned
    ) {
      label = phaseLabel(turnPhase);
    }
    if (t) t.textContent = label;
    if (status) status.title = label;
    // Track live connection for auto-send / prompt
    if (key === "connected" || key === "running") {
      agentConnected = true;
    } else if (key === "disconnected" || key === "stopping") {
      agentConnected = false;
    }
  }

  function getRecentsWorkspace() {
    return (
      recentsWorkspace ||
      bootstrap?.recentsWorkspace ||
      null
    );
  }

  /** True when UI has no project selected (chats go to Recents). */
  function isNoProject() {
    return !workspaceRoot;
  }

  /**
   * Agent process cwd: open project, or desktop-recents for no-project chats.
   * @param {string|null|undefined} [preferred]
   */
  function effectiveWorkspace(preferred) {
    const p = preferred != null ? preferred : workspaceRoot;
    if (p && String(p).trim()) return String(p).trim();
    return getRecentsWorkspace() || "";
  }

  function samePath(a, b) {
    if (!a || !b) return !a && !b;
    const na = String(a).replace(/[/\\]+$/, "").toLowerCase();
    const nb = String(b).replace(/[/\\]+$/, "").toLowerCase();
    return na === nb;
  }

  function isRecentsPath(p) {
    const r = getRecentsWorkspace();
    return !p || (r && samePath(p, r));
  }

  function updateProjectChip() {
    const label = $("projectChipLabel");
    const extraCount = extraRoots.filter((p) => p && !samePath(p, workspaceRoot)).length;
    if (label) {
      if (!workspaceRoot) {
        label.textContent = tt("chooseProject", "Choose project");
        label.title = tt("recentsHint", "Chats without a project go to Recents");
      } else {
        const name = basen(workspaceRoot);
        label.textContent = extraCount ? `${name} +${extraCount}` : name;
        label.title = [workspaceRoot, ...extraRoots].filter(Boolean).join("\n");
      }
    }
    const btn = $("btnProject");
    if (btn) {
      btn.classList.toggle("has-project", Boolean(workspaceRoot));
      btn.title = workspaceRoot || tt("chooseProject", "Choose project");
    }
  }

  function setWorkspace(root) {
    const prev = workspaceRoot;
    workspaceRoot = root || null;
    if (!root) extraRoots = [];
    workspaceLabel.textContent = root || tt("noProject", "No project");
    workspaceLabel.title = root || "";
    syncConvTitle();
    if ($("inpWorkspace")) $("inpWorkspace").value = root || "";
    if (filesRoot) {
      filesRoot.textContent = root ? basen(root) : "—";
      filesRoot.title = root || "";
    }
    resetFilePreview();
    if (root) void refreshFileTree(root);
    else void refreshFileTree(null);
    renderProjects();
    renderProjectMenu();
    updateProjectChip();
    void refreshSlashCommands();
    void refreshFolderTrustUi();
    void refreshGitStrip();
    // Terminal follows project folder (not recents sandbox)
    updateTermCwdLabel(root || "");
    const termOpen = isTermOpen();
    if (!root) {
      setTermEmpty(true);
      termReady = false;
      void api.stopShell?.();
    } else if (termOpen && prev !== root) {
      setTermEmpty(false);
      void ensureProjectShell({ force: true, silent: true });
    }
  }

  function currentChatIsEmpty() {
    const tab = sessionTabs?.getActive?.();
    if (tab?.sessionId) return false;
    const items = eventStore.items || [];
    return items.every((it) => it.kind === "empty" || it.kind === "step");
  }

  function bindActiveTabWorkspace(root) {
    sessionTabs?.updateActive?.({
      cwd: root ? effectiveWorkspace(root) : getRecentsWorkspace() || null,
    });
  }

  /**
   * Align project-owned UI and persisted workspace state without touching any
   * agent slot or conversation tab. Sidebar navigation must remain purely
   * presentational so a running task in another project keeps its owner.
   * @param {string|null} root
   * @param {{ extraRoots?: string[] }} [opts]
   * @returns {Promise<boolean>}
   */
  async function alignProjectWorkspace(root, opts = {}) {
    const next = root ? String(root).trim() : null;
    const extrasIn = Array.isArray(opts.extraRoots) ? opts.extraRoots : undefined;
    if (samePath(next, workspaceRoot) && extrasIn === undefined) {
      renderProjects();
      renderProjectMenu();
      updateProjectChip();
      return true;
    }
    try {
      if (api.setWorkspace) {
        const res = await api.setWorkspace(next, extrasIn);
        if (res?.recentsWorkspace) recentsWorkspace = res.recentsWorkspace;
        if (res?.recentProjects && bootstrap) {
          bootstrap.recentProjects = res.recentProjects;
        }
        extraRoots = Array.isArray(res?.extraRoots) ? res.extraRoots : extrasIn || [];
      }
    } catch (e) {
      addMsg("error", e?.message || String(e));
      return false;
    }
    setWorkspace(next);
    if (bootstrap) {
      bootstrap.workspaceRoot = next;
      // Order: first open on top — only append if missing (main already did this)
      if (next && Array.isArray(bootstrap.recentProjects)) {
        if (!bootstrap.recentProjects.some((p) => samePath(p, next))) {
          bootstrap.recentProjects = [...bootstrap.recentProjects, next];
        }
      }
    }
    void refreshHistory();
    return true;
  }

  /** Open or restore the project-owned conversation selected in the sidebar. */
  async function openProjectTab(root, opts = {}) {
    const next = root ? String(root).trim() : null;
    if (!(await alignProjectWorkspace(next, opts))) return null;

    const cwd = effectiveWorkspace(next) || null;
    const current = sessionTabs?.getActive?.();
    const tabs = sessionTabs?.tabs || [];
    const existing = [...tabs].reverse().find((tab) => samePath(tab.cwd, cwd));
    if (existing) {
      if (existing !== current) sessionTabs.activate(existing.id);
      else bindActiveTabWorkspace(next);
      return existing;
    }

    const title = next ? basen(next) : tt("newConversation", "New chat");
    const pristine = Boolean(current && !current.sessionId && !current.busy && currentChatIsEmpty());
    if (pristine) {
      const reused = sessionTabs.updateActive?.({
        title,
        sessionId: null,
        cwd,
        items: [],
        pendingEvents: [],
        promptQueue: [],
        turnPhase: "idle",
        turnStartedAt: 0,
        phaseStartedAt: 0,
        lastUsageFooter: "",
        skipPrevSnapshot: true,
      }) || current;
      activeSessionId = null;
      restoreStoreItems([]);
      restoreTabRuntime(reused);
      updateQueueBar();
      showEmpty();
      syncConvTitle(title);
      return reused;
    }

    return sessionTabs?.addTab?.(
      {
        title,
        sessionId: null,
        cwd,
        items: [],
      },
      true,
    ) || null;
  }

  /**
   * @param {boolean} [force=false] true = jump to bottom and re-stick (send / turn done).
   *   false = soft follow only when the user is already at the live tail (tools/stream).
   */
  function scrollEnd(force = false) {
    if (timelineView) timelineView.scrollEnd(Boolean(force));
    else if (force || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 96) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }

  function clearEmpty() {
    eventStore.removeKind("empty");
    timeline.querySelector(".empty-hero")?.remove();
  }

  function showEmpty() {
    if (eventStore.length > 0) return;
    eventStore.append("empty", "", {});
  }

  function resetTimeline() {
    stopActivityTimer();
    activityId = null;
    turnPhase = "idle";
    turnStartedAt = 0;
    streamBatcher?.clear?.();
    eventStore.clear();
    eventStore.endStream("all");
  }

  /** Keep chat input always usable after connect / new session / clear */
  function unlockChatInput() {
    document.body.classList.remove("resizing");
    if (!prompt) return;
    prompt.disabled = false;
    prompt.readOnly = false;
    prompt.removeAttribute("disabled");
    prompt.removeAttribute("readonly");
    prompt.tabIndex = 0;
    // Clear any collapsed inline height from old autoSize
    prompt.style.height = "";
    prompt.style.minHeight = "";
    prompt.style.pointerEvents = "auto";
    prompt.style.userSelect = "text";
    prompt.style.opacity = "1";
    const term = $("termInput");
    if (term) {
      term.disabled = false;
      term.readOnly = false;
      term.removeAttribute("disabled");
      term.removeAttribute("readonly");
      term.style.pointerEvents = "auto";
      term.style.userSelect = "text";
    }
    // Never leave modal style.display stuck as none after open
    for (const m of document.querySelectorAll(".modal.hidden")) {
      m.style.pointerEvents = "";
      m.style.display = "";
    }
    setTimeout(() => {
      try {
        prompt.focus({ preventScroll: true });
      } catch {
        prompt.focus();
      }
    }, 0);
  }

  function escapeHtml(s) {
    if (globalThis.GrokDom?.escapeHtml) return globalThis.GrokDom.escapeHtml(s);
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function addStep(text) {
    clearEmpty();
    eventStore.append("step", text);
    scrollEnd();
  }

  function addMsg(kind, text) {
    clearEmpty();
    const k = kind === "error" ? "error" : kind === "user" ? "user" : "assistant";
    eventStore.append(k, text || "");
    scrollEnd();
    return null;
  }

  /** Flush pending deltas and seal open assistant/thought bubbles before status rows. */
  function sealLiveStreams() {
    streamBatcher?.flushNow?.();
    stampThoughtDuration();
    eventStore.endStream?.("all");
  }

  /** Close expanded running tools when model starts writing prose again. */
  function closeOpenToolGroup() {
    for (const it of eventStore.items) {
      if (it.kind !== "tool") continue;
      const st = it.meta?.status;
      if (st === "running" || st === "pending") continue;
      if (it.meta?.open) {
        eventStore.update(it.id, { meta: { open: false } });
      }
    }
  }

  /**
   * CLI-style: one row per tool (◇ title), expand for detail + red/green diff.
   * @param {{ toolId: string, title: string, status: string, kind?: string, detail?: string, path?: string, oldText?: string, newText?: string, diffs?: any[], locations?: any[] }} tool
   */
  function upsertToolInGroup(tool) {
    sealLiveStreams();
    clearEmpty();
    setTurnPhase("tools");
    const existing = eventStore.findLast?.(
      (it) => it.kind === "tool" && it.meta?.toolId === tool.toolId,
    );
    const running = tool.status === "running" || tool.status === "pending";
    const diffs =
      tool.diffs ||
      (tool.path
        ? [{ path: tool.path, oldText: tool.oldText, newText: tool.newText }]
        : existing?.meta?.diffs);
    const meta = {
      toolId: tool.toolId,
      status: tool.status,
      kind: tool.kind || existing?.meta?.kind || "",
      detail: tool.detail != null ? tool.detail : existing?.meta?.detail || "",
      path: tool.path || existing?.meta?.path,
      oldText: tool.oldText != null ? tool.oldText : existing?.meta?.oldText,
      newText: tool.newText != null ? tool.newText : existing?.meta?.newText,
      diffs,
      locations: tool.locations || existing?.meta?.locations,
      open: running || Boolean(tool.path || (diffs && diffs.length)),
    };
    if (existing) {
      eventStore.update(existing.id, {
        text: tool.title || existing.text,
        meta,
      });
    } else {
      eventStore.append("tool", tool.title || tt("labelTools", "Tools"), meta);
    }
    scrollEnd();
  }

  function appendAssistant(chunk) {
    if (!chunk) return;
    clearEmpty();
    // A thought→answer boundary must materialize the thought before we stamp
    // its duration; otherwise batching can leave a generic Thinking row after
    // the final answer.
    if (streamBatcher?.hasPending?.("thought")) streamBatcher.flushNow();
    stampThoughtDuration();
    setTurnPhase("responding");
    // New prose after tools → seal previous streams so answer is BELOW tools
    closeOpenToolGroup();
    if (streamBatcher) streamBatcher.pushAssistant(chunk);
    else eventStore.pushDelta("assistant", chunk);
  }

  function resetAssistant() {
    streamBatcher?.flushNow?.();
    stampThoughtDuration();
    eventStore.endStream("all");
    closeOpenToolGroup();
  }

  function appendThought(chunk) {
    if (!showReasoning || !chunk) return;
    clearEmpty();
    if (!thoughtStartedAt) thoughtStartedAt = Date.now();
    setTurnPhase("thinking");
    if (streamBatcher) streamBatcher.pushThought(chunk);
    else eventStore.pushDelta("thought", chunk);
  }

  function addReview(change) {
    clearEmpty();
    editCount += 1;
    reviews.unshift(change);
    eventStore.append("review", change.path || "", {
      path: change.path,
      oldText: change.oldText,
      newText: change.newText,
      editCount,
    });
    renderReviewList();
    scrollEnd();
  }

  function renderReviewList() {
    if (!reviews.length) {
      reviewList.innerHTML = `<p class="muted-pad">${escapeHtml(tt("agentEdits", "Agent edits appear here when files change."))}</p>`;
      return;
    }
    reviewList.innerHTML = "";
    for (const r of reviews.slice(0, 30)) {
      const row = document.createElement("div");
      row.className = "item";
      row.innerHTML = `<span class="truncate">${escapeHtml(basen(r.path))}</span>`;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "review-btn";
      b.textContent = tt("openReview", "Open");
      b.onclick = () => showDiff(r);
      row.appendChild(b);
      reviewList.appendChild(row);
    }
  }

  /** Phase A4: LCS line diff off main thread when possible. */
  async function lineDiffAsync(oldText, newText) {
    if (globalThis.GrokOffthread?.computeLineDiff) {
      return globalThis.GrokOffthread.computeLineDiff(oldText, newText);
    }
    return [];
  }

  /** @type {object|null} last git status for strip actions */
  let lastGitStatus = null;

  function paintDiffUnified(rows, pathLabel) {
    const code = diffBody.querySelector("code");
    if (!code) return;
    const html = [
      `<span class="ln-ctx">// ${escapeHtml(pathLabel || "")}</span>`,
      ...rows.slice(0, 1200).map((r) => {
        const cls = r.t === "add" ? "ln-add" : r.t === "del" ? "ln-del" : "ln-ctx";
        const mark = r.t === "add" ? "+" : r.t === "del" ? "-" : " ";
        return `<span class="${cls}">${mark} ${escapeHtml(r.l)}</span>`;
      }),
    ].join("\n");
    code.innerHTML = html;
  }

  function paintDiffSide(change) {
    const oldEl = $("diffOld");
    const newEl = $("diffNew");
    if (oldEl) oldEl.textContent = change.oldText ?? "";
    if (newEl) newEl.textContent = change.newText ?? "";
  }

  function setDiffMode(side) {
    diffSideBySide = Boolean(side);
    $("diffBody")?.classList.toggle("hidden", diffSideBySide);
    $("diffSide")?.classList.toggle("hidden", !diffSideBySide);
    const btn = $("btnDiffSide");
    if (btn) {
      btn.textContent = diffSideBySide ? tt("diffUnified", "Unified") : tt("diffSide", "Side");
    }
    // Side-by-side needs the full-file view; hide hunk-only mode while active
    const panel = $("panelReview");
    if (diffSideBySide) panel?.classList.remove("has-hunks");
    else if (activeDiff?.hunks?.length) panel?.classList.add("has-hunks");
  }

  function renderHunkList() {
    const host = $("hunkList");
    const panel = $("panelReview");
    const HD = globalThis.GrokDiffHunks;
    if (!host || !activeDiff?.hunks?.length || !HD) {
      if (host) {
        host.classList.add("hidden");
        host.innerHTML = "";
      }
      panel?.classList.remove("has-hunks");
      return;
    }
    host.classList.remove("hidden");
    panel?.classList.add("has-hunks");
    host.innerHTML = "";
    const decisions = activeDiff.decisions || {};
    for (const h of activeDiff.hunks) {
      const card = document.createElement("div");
      card.className = "hunk-card";
      const dec = decisions[h.id] || "pending";
      card.dataset.decision = dec;
      const addN = h.rows.filter((r) => r.t === "add").length;
      const delN = h.rows.filter((r) => r.t === "del").length;
      const decLabel =
        dec === "accept"
          ? tt("accept", "Accept")
          : dec === "reject"
            ? tt("reject", "Reject")
            : "";
      const head = document.createElement("div");
      head.className = "hunk-card-head";
      head.innerHTML = `<span>${escapeHtml(tt("hunkN", "Change {n}").replace("{n}", String(h.id + 1)))} · +${addN} −${delN}${decLabel ? ` · ${escapeHtml(decLabel)}` : ""}</span>`;
      const actions = document.createElement("div");
      actions.className = "hunk-card-actions";
      if (dec === "pending") {
        const bAcc = document.createElement("button");
        bAcc.type = "button";
        bAcc.className = "pill-btn accent";
        bAcc.textContent = tt("accept", "Accept");
        bAcc.onclick = () => void decideHunk(h.id, "accept");
        const bRej = document.createElement("button");
        bRej.type = "button";
        bRej.className = "pill-btn";
        bRej.textContent = tt("reject", "Reject");
        bRej.onclick = () => void decideHunk(h.id, "reject");
        actions.append(bAcc, bRej);
      }
      head.appendChild(actions);
      const pre = document.createElement("pre");
      pre.innerHTML = h.rows
        .slice(0, 80)
        .map((r) => {
          const cls = r.t === "add" ? "ln-add" : r.t === "del" ? "ln-del" : "ln-ctx";
          const mark = r.t === "add" ? "+" : r.t === "del" ? "-" : " ";
          return `<span class="${cls}">${mark} ${escapeHtml(r.l)}</span>`;
        })
        .join("\n");
      card.append(head, pre);
      host.appendChild(card);
    }
  }

  async function writeDiffFromDecisions() {
    if (!activeDiff?.path || !activeDiff.rows || !globalThis.GrokDiffHunks) return;
    const text = globalThis.GrokDiffHunks.applyHunkDecisions(
      activeDiff.rows,
      activeDiff.hunks,
      activeDiff.decisions || {},
    );
    await api.writeText(activeDiff.path, text);
    activeDiff.newText = text;
    paintDiffSide(activeDiff);
  }

  async function decideHunk(hunkId, decision) {
    if (!activeDiff) return;
    activeDiff.decisions = activeDiff.decisions || {};
    activeDiff.decisions[hunkId] = decision;
    renderHunkList();
    try {
      await writeDiffFromDecisions();
      addStep(
        `${decision === "accept" ? "Accepted" : "Rejected"} hunk ${hunkId + 1} · ${basen(activeDiff.path)}`,
      );
      void refreshGitStrip();
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function showDiff(change) {
    setPanelVisible(true);
    switchPanel("review");
    activeDiff = {
      path: change.path,
      oldText: change.oldText,
      newText: change.newText,
      rows: [],
      hunks: [],
      decisions: {},
    };
    const toolbar = $("diffToolbar");
    const pathLabel = $("diffPathLabel");
    const statsEl = $("diffStats");
    const panel = $("panelReview");
    if (toolbar) toolbar.classList.remove("hidden");
    if (pathLabel) {
      pathLabel.textContent = basen(change.path) || change.path || "—";
      pathLabel.title = change.path || "";
    }

    if (change.oldText != null || change.newText != null) {
      const rows = await lineDiffAsync(change.oldText, change.newText);
      activeDiff.rows = rows;
      const HD = globalThis.GrokDiffHunks;
      activeDiff.hunks = HD ? HD.groupHunks(rows) : [];
      activeDiff.decisions = {};
      const st = HD ? HD.diffStats(rows) : { add: 0, del: 0 };
      const hunkN = activeDiff.hunks.length;
      if (statsEl) {
        statsEl.textContent =
          hunkN > 0
            ? `+${st.add} −${st.del} · ${tt("hunkCount", "{n} changes").replace("{n}", String(hunkN))}`
            : `+${st.add} −${st.del}`;
      }
      paintDiffUnified(rows, change.path);
      paintDiffSide(change);
      setDiffMode(diffSideBySide);
      renderHunkList();
      // Hunk cards = primary; full file only when no hunks / side-by-side requested
      if (hunkN > 0 && !diffSideBySide) panel?.classList.add("has-hunks");
      else panel?.classList.remove("has-hunks");
    } else {
      if (toolbar) toolbar.classList.add("hidden");
      $("hunkList")?.classList.add("hidden");
      panel?.classList.remove("has-hunks");
      void openInEditor(change.path);
      switchPanel("files");
    }
  }

  async function acceptDiff() {
    if (!activeDiff?.path || activeDiff.newText == null) return;
    try {
      if (activeDiff.hunks?.length && globalThis.GrokDiffHunks) {
        activeDiff.decisions = globalThis.GrokDiffHunks.decideAll(
          activeDiff.hunks.length,
          "accept",
        );
        await writeDiffFromDecisions();
        renderHunkList();
      } else {
        await api.writeText(activeDiff.path, activeDiff.newText);
      }
      addStep(`Accepted all · ${basen(activeDiff.path)}`);
      void refreshGitStrip();
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function rejectDiff() {
    if (!activeDiff?.path) return;
    try {
      if (activeDiff.oldText != null) {
        if (activeDiff.hunks?.length && globalThis.GrokDiffHunks) {
          activeDiff.decisions = globalThis.GrokDiffHunks.decideAll(
            activeDiff.hunks.length,
            "reject",
          );
          await writeDiffFromDecisions();
          renderHunkList();
        } else {
          await api.writeText(activeDiff.path, activeDiff.oldText);
        }
        addStep(`Rejected all · restored ${basen(activeDiff.path)}`);
        void refreshGitStrip();
      } else {
        addStep(`Reject skipped (no original) · ${basen(activeDiff.path)}`);
      }
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function refreshGitStrip() {
    const strip = $("gitStrip");
    if (!strip || !api.gitStatus) return;
    if (!workspaceRoot) {
      strip.classList.add("hidden");
      return;
    }
    try {
      const st = await api.gitStatus(workspaceRoot);
      lastGitStatus = st;
      if (!st?.ok || !st.isRepo) {
        strip.classList.add("hidden");
        return;
      }
      strip.classList.remove("hidden");
      const br = $("gitBranch");
      const hash = $("gitHash");
      const dirty = $("gitDirty");
      const sync = $("gitSync");
      const pr = $("gitPr");
      const prCreate = $("gitPrCreate");
      if (br) br.textContent = st.branch || "HEAD";
      if (hash) {
        if (st.shortHash) {
          hash.classList.remove("hidden");
          hash.textContent = st.shortHash;
          hash.title = st.headSubject || st.shortHash;
        } else {
          hash.classList.add("hidden");
        }
      }
      if (dirty) {
        if (st.dirty > 0) {
          dirty.classList.remove("hidden");
          const files = (st.dirtyFiles || []).slice(0, 6).join("\n");
          dirty.textContent = `· ${st.dirty} changed`;
          dirty.title = files || `${st.dirty} changed files`;
        } else {
          dirty.classList.add("hidden");
          dirty.textContent = "";
          dirty.title = "";
        }
      }
      if (sync) {
        const parts = [];
        if (st.ahead) parts.push(`↑${st.ahead}`);
        if (st.behind) parts.push(`↓${st.behind}`);
        if (st.upstream) parts.push(st.upstream);
        if (parts.length) {
          sync.classList.remove("hidden");
          sync.textContent = parts.join(" ");
          sync.title = st.upstream ? `Upstream ${st.upstream}` : "";
        } else {
          sync.classList.add("hidden");
        }
      }
      if (pr) {
        if (st.pr?.url) {
          pr.classList.remove("hidden");
          pr.textContent = `PR #${st.pr.number || ""}`;
          pr.href = st.pr.url;
          pr.title = st.pr.title || pr.textContent;
          pr.onclick = (e) => {
            e.preventDefault();
            void api.openExternal(st.pr.url);
          };
        } else {
          pr.classList.add("hidden");
          pr.removeAttribute("href");
        }
      }
      if (prCreate) {
        if (!st.pr?.url && st.createPrUrl) {
          prCreate.classList.remove("hidden");
          prCreate.onclick = () => {
            void api.openExternal(st.createPrUrl);
          };
        } else {
          prCreate.classList.add("hidden");
          prCreate.onclick = null;
        }
      }
    } catch {
      strip.classList.add("hidden");
    }
  }

  // ── P2 agent slots (process strip — NOT conversation tabs; hidden when only primary) ──
  async function refreshAgentSlots() {
    const host = $("agentSlots");
    if (!host || !api.agentSlots || !globalThis.GrokAgentSlotsUi) return;
    try {
      const st = await api.agentSlots();
      globalThis.GrokAgentSlotsUi.render(host, {
        slots: st.slots || [],
        activeId: st.activeSlotId || "primary",
        maxSlots: st.maxSlots || 2,
        labels: {
          primary: tt("primaryAgent", "Primary agent"),
          parallel: tt("parallelAgent", "Parallel agent"),
          stop: tt("stopSlot", "Stop parallel agent"),
        },
        onSelect: async (id) => {
          try {
            const owner = sessionTabs?.findBySlot?.(id);
            if (owner) sessionTabs.activate?.(owner.id);
            else await api.setActiveAgentSlot(id);
            await refreshAgentSlots();
          } catch (e) {
            addMsg("error", e.message || String(e));
          }
        },
        onSpawn: async () => {
          if (!workspaceRoot) {
            addMsg("error", tt("chooseProject", "Choose a project first."));
            return;
          }
          try {
            sessionTabs?.saveSnapshot?.(eventStore.items);
            captureTabRuntime(sessionTabs?.getActive?.());
            const tab = sessionTabs?.addTab?.(
              {
                title: tt("parallelAgent", "Parallel agent"),
                cwd: workspaceRoot,
                items: [],
              },
              true,
            );
            const spawned = await api.spawnAgentSlot(workspaceRoot, connectOpts(), tab?.title || "Parallel agent");
            if (tab) {
              tab.slotId = spawned?.slotId || null;
              tab.sessionId = spawned?.sessionId || null;
              activeSessionId = tab.sessionId;
              sessionTabs?.render?.();
            }
            await refreshAgentSlots();
          } catch (e) {
            addMsg("error", e.message || String(e));
          }
        },
        onStop: async (id) => {
          try {
            await api.stopAgentSlot(id);
            const owner = sessionTabs?.findBySlot?.(id);
            if (owner) {
              owner.slotId = null;
              owner.busy = false;
              owner.turnPhase = "done";
              sessionTabs?.render?.();
            }
            await refreshAgentSlots();
            addStep(`Stopped slot · ${id}`);
          } catch (e) {
            addMsg("error", e.message || String(e));
          }
        },
      });
    } catch {
      host.classList.add("hidden");
      host.innerHTML = "";
    }
  }

  // ── P2 @file mentions ──
  let mentionPathsCache = [];
  let mentionActiveIndex = 0;

  async function ensureMentionPaths() {
    if (!workspaceRoot || !api.listDir) return [];
    try {
      const entries = await api.listDir(workspaceRoot);
      const FM = globalThis.GrokFileMentions;
      mentionPathsCache = FM
        ? FM.entriesToRelPaths(entries, workspaceRoot)
        : (entries || []).filter((e) => !e.isDirectory).map((e) => e.name);
      // shallow second level for common folders
      for (const e of (entries || []).filter((x) => x.isDirectory).slice(0, 12)) {
        try {
          const sub = await api.listDir(e.path);
          const rels = FM
            ? FM.entriesToRelPaths(sub, workspaceRoot)
            : (sub || []).filter((s) => !s.isDirectory).map((s) => `${e.name}/${s.name}`);
          mentionPathsCache.push(...rels);
        } catch {
          // ignore
        }
      }
    } catch {
      mentionPathsCache = [];
    }
    return mentionPathsCache;
  }

  function hideMentionMenu() {
    const menu = $("mentionMenu");
    if (menu) {
      menu.classList.add("hidden");
      menu.innerHTML = "";
    }
  }

  function showMentionMenu(items, query) {
    const menu = $("mentionMenu");
    const FM = globalThis.GrokFileMentions;
    if (!menu || !FM) return;
    const filtered = FM.filterPaths(items, query, 12);
    if (!filtered.length) {
      hideMentionMenu();
      return;
    }
    mentionActiveIndex = 0;
    menu.classList.remove("hidden");
    menu.innerHTML = "";
    filtered.forEach((p, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mention-item" + (idx === 0 ? " active" : "");
      b.role = "option";
      b.textContent = p;
      b.onmousedown = (e) => {
        e.preventDefault();
        applyMention(p);
      };
      menu.appendChild(b);
    });
  }

  function applyMention(relPath) {
    const FM = globalThis.GrokFileMentions;
    if (!FM || !prompt) return;
    const caret = prompt.selectionStart ?? prompt.value.length;
    const m = FM.findMentionAt(prompt.value, caret);
    if (!m) return;
    const { value, caret: next } = FM.insertMention(prompt.value, m.start, m.end, relPath);
    prompt.value = value;
    prompt.setSelectionRange(next, next);
    hideMentionMenu();
    prompt.focus();
    autoSize();
  }

  async function onPromptInputForMentions() {
    const FM = globalThis.GrokFileMentions;
    if (!FM || !prompt) return;
    const caret = prompt.selectionStart ?? 0;
    const m = FM.findMentionAt(prompt.value, caret);
    if (!m) {
      hideMentionMenu();
      return;
    }
    hideSlashMenu();
    if (!mentionPathsCache.length) await ensureMentionPaths();
    showMentionMenu(mentionPathsCache, m.query);
  }

  // ── Slash command menu (/imagine, /settings, …) ──
  let slashActiveIndex = 0;
  let slashCatalogRequest = 0;

  async function refreshSlashCommands() {
    const SC = globalThis.GrokSlashCommands;
    if (!SC?.setRuntimeCommands || !api.slashCommands) return;
    const request = ++slashCatalogRequest;
    try {
      const items = await api.slashCommands(workspaceRoot);
      if (request !== slashCatalogRequest) return;
      SC.setRuntimeCommands(items);
      if (prompt?.value?.startsWith("/")) onPromptInputForSlash();
    } catch {
      if (request === slashCatalogRequest) SC.setRuntimeCommands([]);
    }
  }

  function hideSlashMenu() {
    const menu = $("slashMenu");
    if (menu) {
      menu.classList.add("hidden");
      menu.innerHTML = "";
    }
  }

  function showSlashMenu(spec) {
    const menu = $("slashMenu");
    if (!menu || !spec?.items?.length) {
      hideSlashMenu();
      return;
    }
    hideMentionMenu();
    slashActiveIndex = 0;
    menu.classList.remove("hidden");
    menu.innerHTML = "";
    menu.scrollTop = 0;
    spec.items.forEach((cmd, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "slash-item" + (idx === 0 ? " active" : "");
      b.role = "option";
      b.title = cmd.description || cmd.hint || cmd.label;
      b.innerHTML = `<span class="slash-cmd">${escapeHtml(cmd.label)}</span><span class="slash-hint">${escapeHtml(cmd.hint || "")}</span>`;
      b.onmousedown = (e) => {
        e.preventDefault();
        applySlashCommand(cmd);
      };
      menu.appendChild(b);
    });
  }

  function applySlashCommand(cmd) {
    if (!prompt || !cmd) return;
    // UI-only commands: run immediately
    if (!cmd.expand) {
      prompt.value = "";
      hideSlashMenu();
      runSlashUiAction(cmd.id);
      return;
    }
    prompt.value = cmd.insert || `/${cmd.id} `;
    const pos = prompt.value.length;
    prompt.setSelectionRange(pos, pos);
    hideSlashMenu();
    prompt.focus();
    autoSize();
  }

  function onPromptInputForSlash() {
    const SC = globalThis.GrokSlashCommands;
    if (!SC?.menuForInput || !prompt) return;
    const caret = prompt.selectionStart ?? 0;
    const menu = SC.menuForInput(prompt.value, caret);
    if (!menu) {
      hideSlashMenu();
      return;
    }
    showSlashMenu(menu);
  }

  function onComposerInput() {
    void onPromptInputForMentions();
    onPromptInputForSlash();
  }

  function relativeWorkspacePath(filePath) {
    const file = String(filePath || "");
    const root = String(workspaceRoot || "").replace(/[\\/]+$/, "");
    if (!root || !file) return file;
    const fileKey = file.toLowerCase();
    const rootKey = root.toLowerCase();
    if (fileKey === rootKey) return basen(root);
    if (fileKey.startsWith(`${rootKey}\\`) || fileKey.startsWith(`${rootKey}/`)) {
      return file.slice(root.length + 1);
    }
    return file;
  }

  function setLanguageBadge(filePath) {
    const language = globalThis.GrokSyntax?.languageForPath?.(filePath) || {
      id: "plain",
      label: tt("plainText", "Plain text"),
    };
    if (editorLanguage) {
      editorLanguage.textContent = language.label;
      editorLanguage.dataset.language = language.id;
      editorLanguage.title = tt("detectedLanguage", "Detected language: {language}").replace(
        "{language}",
        language.label,
      );
      editorLanguage.classList.remove("hidden");
    }
    return language;
  }

  function resetFilePreview(message) {
    selectedFilePath = "";
    if (editorPath) {
      editorPath.textContent = tt("selectFile", "Select a file");
      editorPath.title = "";
      editorPath.dataset.filePath = "";
      delete editorPath.dataset.line;
    }
    if (editorRelativePath) editorRelativePath.textContent = "";
    if (editorLanguage) editorLanguage.classList.add("hidden");
    if (filePreviewEmpty) {
      filePreviewEmpty.classList.remove("hidden");
      const hint = filePreviewEmpty.querySelector("span:last-child");
      if (hint && message) hint.textContent = message;
      else if (hint) hint.textContent = tt("selectFileHint", "Choose a file in the project tree to preview it.");
    }
    editorBody?.classList.add("hidden");
    editorBody?.classList.remove("preview-error", "highlight-limited");
    if (editorBody) editorBody.title = "";
    editorBody?.querySelector("code")?.replaceChildren();
    document.querySelectorAll(".explorer-row.selected").forEach((row) => row.classList.remove("selected"));
  }

  function selectExplorerRow(filePath) {
    const wanted = String(filePath || "").toLowerCase();
    document.querySelectorAll(".explorer-row.file").forEach((row) => {
      row.classList.toggle("selected", String(row.dataset.path || "").toLowerCase() === wanted);
    });
  }

  async function openInEditor(filePath, line) {
    switchPanel("files");
    selectedFilePath = String(filePath || "");
    selectExplorerRow(selectedFilePath);
    const relativePath = relativeWorkspacePath(filePath);
    if (editorPath) {
      editorPath.textContent = basen(filePath) || tt("selectFile", "Select a file");
      editorPath.title = filePath || "";
    }
    if (editorRelativePath) {
      editorRelativePath.textContent = relativePath;
      editorRelativePath.title = filePath || "";
    }
    setLanguageBadge(filePath);
    if (filePreviewEmpty) filePreviewEmpty.classList.add("hidden");
    editorBody?.classList.remove("hidden");
    editorBody?.classList.remove("preview-error", "highlight-limited");
    const code = editorBody?.querySelector("code");
    if (code) code.textContent = tt("loadingFile", "Loading file…");
    try {
      const res = await api.readText(filePath);
      // Ignore a slower read after the user selected another file.
      if (String(filePath || "") !== selectedFilePath) return;
      const result = globalThis.GrokSyntax?.render?.(code, res.content, res.path || filePath);
      if (!result) code.textContent = res.content;
      editorPath.dataset.filePath = res.path || filePath || "";
      if (line) editorPath.dataset.line = String(line);
      else delete editorPath.dataset.line;
      editorBody.classList.toggle("highlight-limited", Boolean(result?.limited));
      editorBody.title = result?.limited
        ? tt("highlightLimited", "Syntax colors are disabled for very large files to keep the preview responsive.")
        : "";
      if (line) {
        requestAnimationFrame(() => {
          code?.querySelector(`.code-line:nth-child(${Math.max(1, Number(line) || 1)})`)?.scrollIntoView?.({ block: "center" });
        });
      }
    } catch (e) {
      if (String(filePath || "") !== selectedFilePath) return;
      if (code) code.textContent = e?.message || String(e);
      editorBody?.classList.add("preview-error");
    }
  }

  async function openCurrentInIde() {
    const file = editorPath?.dataset?.filePath || activeDiff?.path;
    const line = Number(editorPath?.dataset?.line) || 0;
    const res = await api.openIde?.({
      workspace: workspaceRoot || undefined,
      file: file || undefined,
      line: line || undefined,
    });
    if (res && !res.ok) showIdeNotInstalledModal?.(res);
    return res;
  }

  function explorerIcon(name, className) {
    const span = document.createElement("span");
    span.className = className || "";
    globalThis.GrokIcons?.mount?.(span, name, { size: 13, className: "icon" });
    return span;
  }

  function explorerState(container, kind, message, retry) {
    const state = document.createElement("div");
    state.className = `explorer-state ${kind || ""}`.trim();
    state.setAttribute("role", kind === "error" ? "alert" : "status");
    const text = document.createElement("div");
    text.textContent = message;
    state.appendChild(text);
    if (retry) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "explorer-retry";
      button.textContent = tt("retry", "Retry");
      button.onclick = retry;
      state.appendChild(button);
    }
    container.replaceChildren(state);
  }

  function createExplorerNode(entry, depth, epoch) {
    const node = document.createElement("div");
    node.className = "explorer-node";
    const row = document.createElement("button");
    row.type = "button";
    row.className = `explorer-row ${entry.isDirectory ? "directory" : "file"}`;
    row.style.setProperty("--depth", String(depth));
    row.dataset.path = entry.path;
    row.setAttribute("role", "treeitem");
    row.title = entry.path;

    if (entry.isDirectory) {
      row.setAttribute("aria-expanded", "false");
      row.appendChild(explorerIcon("chevronRight", "explorer-chevron"));
      row.appendChild(explorerIcon("folder", "explorer-file-icon"));
    } else {
      const spacer = document.createElement("span");
      spacer.className = "explorer-spacer";
      row.appendChild(spacer);
      row.appendChild(explorerIcon("file", "explorer-file-icon"));
    }
    const name = document.createElement("span");
    name.className = "explorer-name";
    name.textContent = entry.name;
    row.appendChild(name);

    const children = document.createElement("div");
    children.className = "explorer-children hidden";
    children.setAttribute("role", "group");
    node.append(row, children);

    if (entry.isDirectory) {
      row.onclick = async () => {
        const open = row.getAttribute("aria-expanded") === "true";
        row.setAttribute("aria-expanded", open ? "false" : "true");
        children.classList.toggle("hidden", open);
        if (open || children.dataset.loaded === "true") return;
        explorerState(children, "loading", tt("loadingFolder", "Loading folder…"));
        try {
          const entries = await api.listDir(entry.path);
          if (epoch !== fileTreeRequest || !node.isConnected) return;
          children.dataset.loaded = "true";
          children.replaceChildren();
          if (!entries.length) {
            explorerState(children, "empty", tt("emptyFolder", "Empty folder"));
            return;
          }
          for (const child of entries) children.appendChild(createExplorerNode(child, depth + 1, epoch));
          selectExplorerRow(selectedFilePath);
        } catch (error) {
          if (epoch !== fileTreeRequest || !node.isConnected) return;
          children.dataset.loaded = "";
          explorerState(
            children,
            "error",
            error?.message || tt("cannotListFolder", "Cannot list this folder."),
            () => {
              row.setAttribute("aria-expanded", "false");
              row.click();
            },
          );
          row.setAttribute("aria-expanded", "true");
          children.classList.remove("hidden");
        }
      };
    } else {
      const language = globalThis.GrokSyntax?.languageForPath?.(entry.path);
      const badge = document.createElement("span");
      badge.className = "file-language";
      badge.textContent = language?.label || tt("file", "File");
      badge.title = language?.label || "";
      row.appendChild(badge);
      row.onclick = () => void openInEditor(entry.path);
    }
    return node;
  }

  function collapseExplorerFolders() {
    fileTree?.querySelectorAll('.explorer-row.directory[aria-expanded="true"]').forEach((row) => {
      row.setAttribute("aria-expanded", "false");
      row.parentElement?.querySelector(":scope > .explorer-children")?.classList.add("hidden");
    });
    fileTree?.scrollTo?.({ top: 0, behavior: "smooth" });
  }

  async function refreshFileTree(root) {
    const epoch = ++fileTreeRequest;
    const targetRoot = root || workspaceRoot;
    if (!fileTree) return;
    if (!targetRoot) {
      explorerState(fileTree, "empty", tt("openProjectForFiles", "Open a project to browse its files."));
      return;
    }
    if (filesRoot) {
      filesRoot.textContent = basen(targetRoot);
      filesRoot.title = targetRoot;
    }
    explorerState(fileTree, "loading", tt("loadingProjectFiles", "Loading project files…"));
    try {
      const entries = await api.listDir(targetRoot);
      if (epoch !== fileTreeRequest || !samePath(targetRoot, workspaceRoot)) return;
      fileTree.replaceChildren();
      if (!entries.length) {
        explorerState(fileTree, "empty", tt("emptyProject", "This project folder is empty."));
        return;
      }
      for (const entry of entries) fileTree.appendChild(createExplorerNode(entry, 0, epoch));
      selectExplorerRow(selectedFilePath);
    } catch (error) {
      if (epoch !== fileTreeRequest) return;
      explorerState(
        fileTree,
        "error",
        error?.message || tt("cannotListProject", "Cannot list project files."),
        () => void refreshFileTree(targetRoot),
      );
    }
  }

  function switchPanel(name) {
    if (name === "term") {
      setTermVisible(true);
      return;
    }
    setPanelVisible(true);
    $("panelFiles")?.classList.toggle("hidden", name !== "files");
    $("panelReview")?.classList.toggle("hidden", name !== "review");
    $("panelTools")?.classList.toggle("hidden", name !== "tools");
    $("panelManager")?.classList.toggle("hidden", name !== "manager");
    $("panelArtifacts")?.classList.toggle("hidden", name !== "artifacts");
    // Primary tabs (Files / Review)
    for (const t of document.querySelectorAll(".rtab[data-panel]")) {
      t.classList.toggle("active", t.dataset.panel === name);
    }
    // Secondary panels live under More
    const moreBtn = $("btnPanelMore");
    const secondary = name === "manager" || name === "artifacts" || name === "tools";
    moreBtn?.classList.toggle("active", secondary);
    moreBtn?.setAttribute("aria-expanded", "false");
    $("panelMoreMenu")?.classList.add("hidden");
    // Sidebar: Tools selected only when CLI tools panel is open
    if (name === "tools") setSideNav("tools");
    else if (sideNav === "tools") setSideNav(null);
    if (name === "manager") {
      switchManagerTab(
        document.querySelector("#mgrSubnav .tools-subtab.active")?.dataset?.mgrTab || "new",
      );
      void refreshJobBoard();
      void refreshWorktreeBoard();
      void refreshInbox();
    }
    if (name === "artifacts") void refreshArtifacts();
    if (name === "tools") {
      // Default to health checks — most useful first visit
      switchToolsTab(document.querySelector("#toolsSubnav .tools-subtab.active")?.dataset?.toolsTab || "health");
      paintMcpPresets();
    }
    if (name === "files") {
      requestAnimationFrame(() => setFileExplorerWidth(loadLayout().fileExplorerWidth || defaultFileExplorerWidth(), false));
    }
  }

  function switchManagerTab(tabId) {
    const id = tabId || "new";
    document.querySelectorAll("#mgrSubnav .tools-subtab").forEach((b) => {
      b.classList.toggle("active", b.dataset.mgrTab === id);
    });
    document.querySelectorAll("#panelManager .tools-section").forEach((s) => {
      s.classList.toggle("active", s.dataset.mgrSection === id);
    });
  }

  function artEmptyHtml() {
    return `<div class="panel-empty-card" id="artEmpty">
      <p class="panel-empty-title">${escapeHtml(tt("artEmptyTitle", "No saved items yet"))}</p>
      <ul>
        <li>${escapeHtml(tt("artEmpty1", "When a background task finishes, open it from Tasks → Inbox"))}</li>
        <li>${escapeHtml(tt("artEmpty2", "Or click “Save plan from chat” if a plan is visible"))}</li>
      </ul>
    </div>`;
  }

  // ── Phase C — Manager / Artifacts / Worktrees ──
  /** @type {object|null} */
  let selectedArtifact = null;
  /** @type {object[]} */
  let jobCache = [];

  function ensureInboxToast() {
    let el = $("inboxToast");
    if (el) return el;
    el = document.createElement("div");
    el.id = "inboxToast";
    el.className = "inbox-toast hidden";
    el.onclick = () => {
      el.classList.add("hidden");
      switchPanel("manager");
      switchManagerTab("inbox");
    };
    document.body.appendChild(el);
    return el;
  }

  function showInboxToast(job) {
    const el = ensureInboxToast();
    const st = job.status === "done" ? "completed" : job.status;
    el.innerHTML = `<strong>Inbox · ${escapeHtml(st)}</strong>${escapeHtml(job.title || "Task")}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 8000);
  }

  function statusBadge(status) {
    return `<span class="mgr-status" data-s="${escapeHtml(status || "")}">${escapeHtml(status || "")}</span>`;
  }

  async function refreshJobBoard() {
    const board = $("jobBoard");
    if (!board || !api.jobsList) return;
    try {
      jobCache = (await api.jobsList()) || [];
      if (!jobCache.length) {
        board.innerHTML = `<p class="muted-pad">${escapeHtml(tt("mgrNoTasks", "No tasks yet. Create one under New task."))}</p>`;
        return;
      }
      board.innerHTML = "";
      for (const j of jobCache) {
        const card = document.createElement("div");
        card.className = "mgr-card";
        card.innerHTML = `
          <div class="mgr-card-top">
            <span class="mgr-card-title">${escapeHtml(j.title || j.id)}</span>
            ${statusBadge(j.status)}
          </div>
          <div class="mgr-card-meta">${escapeHtml(j.worktree ? `wt:${j.worktree} · ` : "")}${escapeHtml((j.createdAt || "").slice(0, 19))}</div>
          <div class="mgr-card-actions"></div>`;
        const actions = card.querySelector(".mgr-card-actions");
        if (j.status === "queued" || j.status === "running") {
          const c = document.createElement("button");
          c.type = "button";
          c.className = "mini";
          c.textContent = tt("cancel", "Cancel");
          c.onclick = async () => {
            await api.jobsCancel(j.id);
            void refreshJobBoard();
          };
          actions.appendChild(c);
        }
        if (j.status === "done" || j.status === "failed") {
          const v = document.createElement("button");
          v.type = "button";
          v.className = "mini";
          v.textContent = tt("viewOutput", "View output");
          v.onclick = () => {
            void api.artifactsAdd?.({
              type: "job_output",
              title: j.title,
              content: j.stdout || j.stderr || j.error || "(empty)",
              meta: { jobId: j.id },
            }).then(() => {
              switchPanel("artifacts");
              void refreshArtifacts();
            });
          };
          actions.appendChild(v);
        }
        board.appendChild(card);
      }
    } catch (e) {
      board.innerHTML = `<p class="muted-pad">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  async function refreshInbox() {
    const list = $("inboxList");
    const badge = $("inboxBadge");
    if (!list || !api.jobsInbox) return;
    try {
      const items = (await api.jobsInbox(false)) || [];
      const unread = items.filter((x) => !x.read).length;
      if (badge) {
        badge.textContent = unread
          ? tt("mgrNNew", "{n} new").replace("{n}", String(unread))
          : "";
      }
      if (!items.length) {
        list.innerHTML = `<p class="muted-pad">${escapeHtml(tt("mgrInboxEmpty", "Completed jobs appear here."))}</p>`;
        return;
      }
      list.innerHTML = "";
      for (const j of items.slice(0, 20)) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "mgr-card" + (j.read ? "" : " active");
        card.innerHTML = `
          <div class="mgr-card-top">
            <span class="mgr-card-title">${escapeHtml(j.title || tt("mgrTask", "Task"))}</span>
            ${statusBadge(j.status)}
          </div>
          <div class="mgr-card-meta">${escapeHtml((j.finishedAt || "").slice(0, 19))}${j.error ? " · " + escapeHtml(j.error) : ""}</div>`;
        card.onclick = async () => {
          await api.jobsMarkRead?.(j.id);
          const full = await api.jobsGet?.(j.id);
          if (full) {
            await api.artifactsAdd?.({
              type: "job_output",
              title: full.title,
              content: full.stdout || full.stderr || full.error || "(empty)",
              meta: { jobId: full.id, worktree: full.worktree },
            });
            switchPanel("artifacts");
            void refreshArtifacts();
          }
          void refreshInbox();
        };
        list.appendChild(card);
      }
    } catch (e) {
      list.innerHTML = `<p class="muted-pad">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  async function queueBackgroundJob() {
    const prompt = $("jobPrompt")?.value?.trim();
    if (!prompt) {
      addMsg("error", tt("mgrNeedPrompt", "Enter a task description first."));
      return;
    }
    if (!workspaceRoot) {
      addMsg("error", tt("mgrNeedProject", "Open a project before queuing a task."));
      return;
    }
    try {
      const job = await api.jobsEnqueue({
        prompt,
        title: $("jobTitle")?.value?.trim() || undefined,
        worktree: $("jobWorktree")?.value?.trim() || undefined,
        worktreeRef: $("jobWorktreeRef")?.value?.trim() || undefined,
        permissionMode: $("jobPerm")?.value || "auto",
        cwd: workspaceRoot,
        model: selModel?.value || undefined,
        effort: selEffort?.value || undefined,
      });
      if ($("jobPrompt")) $("jobPrompt").value = "";
      if ($("jobTitle")) $("jobTitle").value = "";
      addStep(
        tt("jobQueued", "Task queued") +
          (job.title ? ` · ${job.title}` : ""),
      );
      switchManagerTab("board");
      void refreshJobBoard();
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  async function refreshWorktreeBoard() {
    const board = $("wtBoard");
    if (!board || !api.worktreeList) return;
    if (!workspaceRoot) {
      board.innerHTML = `<p class="muted-pad">${escapeHtml(tt("mgrWtNeedProject", "Open a project to list worktrees."))}</p>`;
      return;
    }
    try {
      const res = await api.worktreeList(workspaceRoot);
      if (!res?.ok && !(res?.rows || []).length) {
        board.innerHTML = `<p class="muted-pad">${escapeHtml(res?.message || res?.raw || tt("mgrWtEmpty", "No tracked worktrees yet."))}</p>`;
        return;
      }
      const rows = res.rows || [];
      if (!rows.length) {
        const raw = res.raw;
        board.innerHTML = raw
          ? `<pre class="muted-pad" style="white-space:pre-wrap;font-size:11px">${escapeHtml(raw)}</pre>`
          : `<p class="muted-pad">${escapeHtml(tt("mgrWtEmpty", "No tracked worktrees yet."))}</p>`;
        return;
      }
      board.innerHTML = "";
      for (const r of rows) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "mgr-card";
        card.innerHTML = `
          <div class="mgr-card-top"><span class="mgr-card-title">${escapeHtml(r.id)}</span></div>
          <div class="mgr-card-meta">${escapeHtml(r.branch || r.path || r.raw || "")}</div>`;
        card.onclick = () => {
          if ($("jobWorktree")) $("jobWorktree").value = r.id;
          if ($("mgrWtName")) $("mgrWtName").value = r.id;
          if ($("inpWorktree")) $("inpWorktree").value = r.id;
        };
        board.appendChild(card);
      }
    } catch (e) {
      board.innerHTML = `<p class="muted-pad">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  async function refreshArtifacts() {
    const list = $("artifactList");
    if (!list || !api.artifactsList) return;
    try {
      const items = (await api.artifactsList()) || [];
      if (!items.length) {
        list.innerHTML = artEmptyHtml();
        return;
      }
      list.innerHTML = "";
      for (const a of items) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "mgr-card" + (selectedArtifact?.id === a.id ? " active" : "");
        const typeLabel =
          a.type === "plan"
            ? tt("artTypePlan", "Plan")
            : a.type === "job_output"
              ? tt("artTypeJob", "Task output")
              : a.type || "";
        card.innerHTML = `
          <div class="mgr-card-top">
            <span class="mgr-card-title">${escapeHtml(a.title)}</span>
            <span class="mgr-status">${escapeHtml(typeLabel)}</span>
          </div>
          <div class="mgr-card-meta">${escapeHtml((a.createdAt || "").slice(0, 19))}</div>`;
        card.onclick = () => showArtifact(a);
        list.appendChild(card);
      }
    } catch (e) {
      list.innerHTML = `<p class="muted-pad">${escapeHtml(e.message || String(e))}</p>`;
    }
  }

  function showArtifact(a) {
    selectedArtifact = a;
    const detail = $("artifactDetail");
    const title = $("artDetailTitle");
    const body = $("artDetailBody")?.querySelector("code");
    if (detail) detail.classList.remove("hidden");
    if (title) title.textContent = a.title || a.type;
    if (body) body.textContent = a.content || a.path || "(empty)";
    void refreshArtifacts();
  }

  async function savePlanArtifact() {
    const html = planDock?.innerText || planDock?.textContent || "";
    if (!html || planDock?.classList.contains("hidden")) {
      addMsg("error", tt("artNoPlan", "No plan visible in chat to save."));
      return;
    }
    try {
      const item = await api.artifactsAdd({
        type: "plan",
        title: `${tt("artTypePlan", "Plan")} · ${convTitle?.textContent || "session"}`,
        content: html,
        meta: { sessionId: activeSessionId },
      });
      addStep(tt("artPlanSaved", "Plan saved to Results"));
      switchPanel("artifacts");
      showArtifact(item);
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
  }

  function wireManagerUi() {
    $("mgrSubnav")?.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-mgr-tab]");
      if (!btn) return;
      switchManagerTab(btn.dataset.mgrTab);
      if (btn.dataset.mgrTab === "board") void refreshJobBoard();
      if (btn.dataset.mgrTab === "inbox") void refreshInbox();
      if (btn.dataset.mgrTab === "worktrees") void refreshWorktreeBoard();
    });
    $("btnJobRun") && ($("btnJobRun").onclick = () => void queueBackgroundJob());
    $("btnJobsRefresh") &&
      ($("btnJobsRefresh").onclick = () => {
        void refreshJobBoard();
        void refreshInbox();
      });
    $("btnJobsClear") &&
      ($("btnJobsClear").onclick = async () => {
        await api.jobsClearFinished?.();
        void refreshJobBoard();
        void refreshInbox();
      });
    $("btnWtRefresh") && ($("btnWtRefresh").onclick = () => void refreshWorktreeBoard());
    $("btnMgrOpenToolsWt") &&
      ($("btnMgrOpenToolsWt").onclick = () => {
        switchPanel("tools");
        switchToolsTab("worktree");
      });
    $("btnMgrWtShow") &&
      ($("btnMgrWtShow").onclick = async () => {
        const name = $("mgrWtName")?.value?.trim();
        if (!name) {
          addMsg("error", tt("worktreeNeedName", "Enter a worktree name to remove."));
          return;
        }
        const res = await api.worktreeShow?.(name, workspaceRoot);
        addStep(res?.raw || res?.message || "show done");
        switchPanel("tools");
        switchToolsTab("worktree");
        setCliOut(res?.raw || res?.message || "");
      });
    $("btnMgrWtRm") &&
      ($("btnMgrWtRm").onclick = async () => {
        const name = $("mgrWtName")?.value?.trim();
        if (!name) {
          addMsg("error", tt("worktreeNeedName", "Enter a worktree name to remove."));
          return;
        }
        if (!confirm(tt("mgrWtRmConfirm", "Remove worktree {name}?").replace("{name}", name))) return;
        await api.worktreeRm?.(name, workspaceRoot);
        void refreshWorktreeBoard();
      });
    $("btnMgrWtGc") &&
      ($("btnMgrWtGc").onclick = async () => {
        await api.worktreeGc?.(workspaceRoot);
        void refreshWorktreeBoard();
      });
    $("btnArtSavePlan") && ($("btnArtSavePlan").onclick = () => void savePlanArtifact());
    $("btnArtRefresh") && ($("btnArtRefresh").onclick = () => void refreshArtifacts());
    $("btnArtClear") &&
      ($("btnArtClear").onclick = async () => {
        if (!confirm(tt("artClearConfirm", "Clear all saved results?"))) return;
        await api.artifactsClear?.();
        selectedArtifact = null;
        $("artifactDetail")?.classList.add("hidden");
        void refreshArtifacts();
      });
    $("btnArtOpenIde") &&
      ($("btnArtOpenIde").onclick = async () => {
        const p = selectedArtifact?.path || selectedArtifact?.meta?.path;
        const res = await api.openIde?.(
          p ? { file: p, workspace: workspaceRoot } : { workspace: workspaceRoot },
        );
        if (!res?.ok) showIdeNotInstalledModal?.(res);
      });

    api.onManagerJob?.((job) => {
      void refreshJobBoard();
      if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
        void refreshInbox();
      }
    });
    api.onManagerInbox?.((job) => {
      showInboxToast(job);
      void refreshInbox();
    });
    api.onManagerArtifact?.(() => {
      if (!$("panelArtifacts")?.classList.contains("hidden")) void refreshArtifacts();
    });
  }

  function setSidebarVisible(show) {
    const side = $("colSidebar");
    const split = $("split1");
    const btn = $("btnToggleSidebar");
    const on = show !== false;
    // Keep inline width when open so collapse animates from real size
    if (on && side && (!side.style.width || side.style.width === "0px")) {
      const L = loadLayout();
      side.style.width = `${L.sidebarWidth || 248}px`;
    }
    side?.classList.toggle("collapsed", !on);
    split?.classList.toggle("sidebar-collapsed", !on);
    if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
    saveLayout({ sidebarVisible: on });
  }

  function setPanelVisible(show) {
    const pane = $("colEditor");
    const split = $("split2");
    const btn = $("btnTogglePanel");
    if (!pane) return;
    const on = show !== false;
    if (on && (!pane.style.width || pane.style.width === "0px")) {
      const L = loadLayout();
      const responsiveDefault = window.innerWidth >= 1700 ? 720 : window.innerWidth >= 1450 ? 500 : window.innerWidth >= 1250 ? 450 : 400;
      pane.style.width = `${Math.max(320, Number(L.editorWidth) || responsiveDefault)}px`;
    }
    pane.classList.toggle("collapsed", !on);
    split?.classList.toggle("panel-collapsed", !on);
    if (btn) {
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    saveLayout({ panelVisible: on });
    if (on) {
      requestAnimationFrame(() => setFileExplorerWidth(loadLayout().fileExplorerWidth || defaultFileExplorerWidth(), false));
    }
    // Hiding panel leaves Tools unselected
    if (!on && sideNav === "tools") setSideNav(null);
  }

  const FILE_EXPLORER_MIN = 132;
  const FILE_PREVIEW_MIN = 180;
  const FILE_SPLITTER_WIDTH = 5;

  function fileExplorerMaxWidth() {
    const hostWidth = $("panelFiles")?.querySelector(".file-workbench")?.getBoundingClientRect().width || 0;
    return Math.max(FILE_EXPLORER_MIN, Math.floor(hostWidth - FILE_PREVIEW_MIN - FILE_SPLITTER_WIDTH));
  }

  function defaultFileExplorerWidth() {
    const hostWidth = $("panelFiles")?.querySelector(".file-workbench")?.getBoundingClientRect().width || 0;
    return Math.min(258, Math.max(154, Math.round(hostWidth * 0.39) || 154));
  }

  function setFileExplorerWidth(value, persist = false) {
    const workbench = $("panelFiles")?.querySelector(".file-workbench");
    if (!workbench) return FILE_EXPLORER_MIN;
    const requested = Number(value) || defaultFileExplorerWidth();
    const width = Math.max(FILE_EXPLORER_MIN, Math.min(fileExplorerMaxWidth(), Math.round(requested)));
    workbench.style.setProperty("--file-explorer-width", `${width}px`);
    const split = $("splitFiles");
    split?.setAttribute("aria-valuemin", String(FILE_EXPLORER_MIN));
    split?.setAttribute("aria-valuemax", String(fileExplorerMaxWidth()));
    split?.setAttribute("aria-valuenow", String(width));
    if (persist) saveLayout({ fileExplorerWidth: width });
    return width;
  }

  function updateFilePaneControls() {
    const workbench = $("panelFiles")?.querySelector(".file-workbench");
    if (!workbench) return;
    const explorerVisible = !workbench.classList.contains("explorer-collapsed");
    const previewVisible = !workbench.classList.contains("preview-collapsed");
    const explorerButton = $("btnToggleExplorer");
    const previewButton = $("btnTogglePreview");
    const split = $("splitFiles");
    const setControl = (button, visible, hideKey, showKey) => {
      if (!button) return;
      const key = visible ? hideKey : showKey;
      const label = tt(key, visible ? "Hide pane" : "Show pane");
      button.setAttribute("aria-pressed", visible ? "true" : "false");
      button.setAttribute("data-i18n-title", key);
      button.setAttribute("data-i18n-aria", key);
      button.title = label;
      button.setAttribute("aria-label", label);
    };
    setControl(explorerButton, explorerVisible, "hideProjectTree", "showProjectTree");
    setControl(previewButton, previewVisible, "hideFilePreview", "showFilePreview");
    const canResize = explorerVisible && previewVisible;
    split?.classList.toggle("file-pane-collapsed", !canResize);
    split?.setAttribute("aria-disabled", canResize ? "false" : "true");
  }

  function setFilePaneCollapsed(pane, collapsed, persist = true) {
    const workbench = $("panelFiles")?.querySelector(".file-workbench");
    if (!workbench) return;
    const isExplorer = pane === "explorer";
    const ownClass = isExplorer ? "explorer-collapsed" : "preview-collapsed";
    const peerClass = isExplorer ? "preview-collapsed" : "explorer-collapsed";
    if (collapsed && workbench.classList.contains(peerClass)) workbench.classList.remove(peerClass);
    workbench.classList.toggle(ownClass, Boolean(collapsed));
    updateFilePaneControls();
    if (!collapsed) {
      requestAnimationFrame(() => setFileExplorerWidth(loadLayout().fileExplorerWidth || defaultFileExplorerWidth(), false));
    }
    if (persist) {
      saveLayout({
        fileExplorerCollapsed: workbench.classList.contains("explorer-collapsed"),
        filePreviewCollapsed: workbench.classList.contains("preview-collapsed"),
      });
    }
  }

  function isTermOpen() {
    const dock = $("termDock");
    if (!dock) return false;
    return !dock.classList.contains("collapsed") && !dock.classList.contains("hidden");
  }

  let termReady = false;
  let termCwdActive = null;
  /** Drop TUI flood (alt-screen apps) after one notice. */
  let termTuiBlocked = false;

  /** Strip ANSI / OSC so plain CLI output is readable in the dock. */
  function stripAnsi(input) {
    if (globalThis.GrokDom?.stripAnsi) {
      return globalThis.GrokDom.stripAnsi(input)
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
    }
    return String(input || "")
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\u001b[PX^_][^\u001b]*\u001b\\/g, "")
      .replace(/\u001b[()][0-9A-Za-z]/g, "")
      .replace(/\u001b./g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  /** Full-screen TUI apps (Ink/alt buffer) — not supported in the simple dock. */
  function looksLikeTuiStream(raw) {
    const s = String(raw || "");
    return (
      /\u001b\[\?1049h/.test(s) ||
      /\u001b\[\?47h/.test(s) ||
      (/\u001b\[\d+;\d+H/.test(s) && /\u001b\[\?\d+h/.test(s)) ||
      (/\u001b\[\d+;\d+H/.test(s) && (s.match(/\u001b\[/g) || []).length > 12)
    );
  }

  /**
   * Commands that need a real TTY (not our line-mode dock).
   * `grok` alone is the interactive TUI; subcommands like `grok doctor` stay OK.
   */
  function isDockTuiCommand(line) {
    const t = String(line || "").trim();
    if (!t) return false;
    if (/^(grok)(\.exe)?$/i.test(t)) return true;
    if (/^(vim|nvim|nano|less|htop|btop|lazygit|mc)(\.exe)?(\s|$)/i.test(t)) return true;
    return false;
  }

  function termTuiHelpText(cmd) {
    const name = (cmd || "this app").split(/\s+/)[0];
    return (
      tt(
        "termTuiBlocked",
        "“{cmd}” is a full-screen terminal UI. This dock only runs plain commands (git, npm, dir…).\n" +
          "• Agent chat: send a message (auto-connects) or menu Agent → Connect\n" +
          "• Real TUI: click External (system terminal)\n",
      ).replace(/\{cmd\}/g, name) + "\n"
    );
  }

  async function openExternalTerminal() {
    if (!workspaceRoot) {
      appendTerm(`${tt("termNeedProject", "Open a project folder to use the terminal.")}\n`);
      return;
    }
    try {
      await api.openExternalTerminal?.(workspaceRoot);
      appendTerm(
        `${tt("termExternalOpened", "Opened system terminal in the project folder.")}\n`,
      );
    } catch (e) {
      appendTerm(`${e.message || e}\n`);
    }
  }

  function updateTermCwdLabel(cwd) {
    const el = $("termCwd");
    if (!el) return;
    if (!cwd) {
      el.textContent = "—";
      el.title = "";
      return;
    }
    el.textContent = cwd;
    el.title = cwd;
  }

  function setTermEmpty(needProject) {
    $("termEmpty")?.classList.toggle("hidden", !needProject);
    $("termInputRow")?.classList.toggle("hidden", needProject);
    $("termOut")?.classList.toggle("hidden", needProject);
  }

  function appendTerm(text, opts = {}) {
    const raw = text || "";
    if (!opts.raw && looksLikeTuiStream(raw)) {
      if (!termTuiBlocked) {
        termTuiBlocked = true;
        termBuffer += termTuiHelpText("TUI");
        const code = $("termOut")?.querySelector("code");
        if (code) code.textContent = termBuffer;
        const out = $("termOut");
        if (out) out.scrollTop = out.scrollHeight;
        // Kill stuck TUI child so the shell becomes usable again
        void (async () => {
          try {
            await api.termInterrupt?.();
            await api.stopShell?.();
            termReady = false;
            await ensureProjectShell({ force: true, silent: true });
          } catch {
            // ignore
          }
        })();
      }
      return;
    }
    const clean = opts.raw ? raw : stripAnsi(raw);
    if (!clean) return;
    termBuffer += clean;
    if (termBuffer.length > 200_000) termBuffer = termBuffer.slice(-150_000);
    const code = $("termOut")?.querySelector("code");
    if (code) code.textContent = termBuffer;
    const out = $("termOut");
    if (out) out.scrollTop = out.scrollHeight;
  }

  function clearTermBuffer() {
    termBuffer = "";
    termTuiBlocked = false;
    const code = $("termOut")?.querySelector("code");
    if (code) code.textContent = "";
  }

  /** Ensure interactive shell is running in the open project folder. */
  async function ensureProjectShell(opts = {}) {
    const force = Boolean(opts.force);
    const root = workspaceRoot;
    if (!root) {
      setTermEmpty(true);
      updateTermCwdLabel("");
      termReady = false;
      termCwdActive = null;
      return { ok: false, reason: "no_project" };
    }
    setTermEmpty(false);
    updateTermCwdLabel(root);
    if (!force && termReady && termCwdActive === root) {
      try {
        const st = await api.termStatus?.();
        if (st?.running && st.cwd && st.cwd.replace(/\\/g, "/").toLowerCase() === root.replace(/\\/g, "/").toLowerCase()) {
          return { ok: true, cwd: root, reused: true };
        }
      } catch {
        // fall through restart
      }
    }
    try {
      const res = await api.startShell(root);
      termReady = true;
      termCwdActive = res?.cwd || root;
      updateTermCwdLabel(termCwdActive);
      if (opts.clear !== false && !opts.silent) {
        // keep existing buffer; only soft note on restart
      }
      return { ok: true, cwd: termCwdActive, reused: false };
    } catch (e) {
      termReady = false;
      appendTerm(`${e.message || e}\n`);
      return { ok: false, error: e };
    }
  }

  async function runTermLine() {
    const input = $("termInput");
    // Keep trailing spaces only trimmed at ends; empty after trim = no-op
    const line = input?.value?.replace(/\r?\n/g, "")?.trim() || "";
    if (!line) return;
    if (!workspaceRoot) {
      setTermEmpty(true);
      appendTerm(`${tt("termNeedProject", "Open a project folder to use the terminal.")}\n`);
      return;
    }
    if (input) input.value = "";
    termTuiBlocked = false;
    // Local echo (pure terminal): show typed line; shell may echo too — acceptable for cmd
    appendTerm(`› ${line}\n`, { raw: true });

    // Full-screen TUI apps break this dock — guide the user instead of dumping escape codes
    if (isDockTuiCommand(line)) {
      appendTerm(termTuiHelpText(line), { raw: true });
      input?.focus();
      return;
    }

    try {
      const ready = await ensureProjectShell({ silent: true });
      if (!ready?.ok) {
        // One-shot fallback when interactive shell failed to start
        await api.runTerminal(line, workspaceRoot);
        return;
      }
      await api.writeShell(line, workspaceRoot);
    } catch (e) {
      try {
        await api.runTerminal(line, workspaceRoot);
      } catch (err) {
        appendTerm(`${err.message || err}\n`);
      }
    }
    input?.focus();
  }

  function setTermVisible(show) {
    const dock = $("termDock");
    const btn = $("btnToggleTerm");
    if (!dock) return;
    const on = Boolean(show);
    dock.classList.toggle("collapsed", !on);
    dock.classList.remove("hidden");
    if (btn) btn.setAttribute("aria-pressed", on ? "true" : "false");
    saveLayout({ termVisible: on });
    if (on) {
      if (!workspaceRoot) {
        setTermEmpty(true);
        updateTermCwdLabel("");
      } else {
        setTermEmpty(false);
        updateTermCwdLabel(workspaceRoot);
        // Auto-start shell in project (like VS Code / Cursor / Codex)
        void ensureProjectShell({ silent: true }).then(() => {
          setTimeout(() => $("termInput")?.focus(), 40);
        });
      }
    }
  }

  async function paintTranscript(sessionId) {
    if (!sessionId) return 0;
    try {
      const turns = await api.readTranscript(sessionId);
      streamBatcher?.clear?.();
      const n = eventStore.loadTurns(turns || []);
      if (!n) {
        showEmpty();
        // Quiet — empty history is visible via empty hero, no technical step
      }
      // Don't flood timeline with "Loaded N messages" / session ids
      scrollEnd(true);
      return n;
    } catch (e) {
      addMsg("error", `Could not load transcript: ${e.message || e}`);
      return 0;
    }
  }

  function updateQueueBar() {
    const bar = $("queueBar");
    const text = $("queueText");
    if (!bar || !text) return;
    const queue = sessionTabs?.getActive?.()?.promptQueue || promptQueue;
    if (!queue.length) {
      bar.classList.add("hidden");
      return;
    }
    bar.classList.remove("hidden");
    text.textContent = `${queue.length} message${queue.length > 1 ? "s" : ""} queued`;
  }

  async function drainQueue() {
    const owner = sessionTabs?.getActive?.();
    const queue = owner?.promptQueue || promptQueue;
    if ((owner?.drainingQueue ?? drainingQueue) || busy || !queue.length) return;
    if (owner) owner.drainingQueue = true;
    else drainingQueue = true;
    while (queue.length && !busy && (!owner || sessionTabs?.getActive?.() === owner)) {
      const next = queue.shift();
      updateQueueBar();
      if (!next) break;
      const shown = next.displayText || next.text || "(attachment)";
      clearEmpty();
      eventStore.append("user", shown, {
        attachments: (next.attachments || []).map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          data: a.data,
        })),
      });
      scrollEnd(true);
      resetAssistant();
      turnStartedAt = Date.now();
      beginTurnActivity();
      try {
        busy = true;
        if (owner) {
          owner.busy = true;
          owner.turnStartedAt = turnStartedAt;
          owner.turnPhase = turnPhase;
          sessionTabs?.render?.();
        }
        await api.prompt(next.text || "", next.attachments || []);
        if (owner && sessionTabs?.getActive?.() !== owner) break;
      } catch (e) {
        if (!owner || sessionTabs?.getActive?.() === owner) {
          busy = false;
          endTurnActivity({ error: true });
          addMsg("error", e.message || String(e));
        } else {
          owner.busy = false;
          owner.turnPhase = "error";
        }
        break;
      }
    }
    if (owner) owner.drainingQueue = false;
    else drainingQueue = false;
    if (!owner || sessionTabs?.getActive?.() === owner) updateQueueBar();
  }

  /** CLI: default | acceptEdits | auto | dontAsk | bypassPermissions | plan */
  const PERM_META = {
    default: { label: "Default", icon: "circleDot" },
    acceptEdits: { label: "Auto · edits", icon: "edit" },
    auto: { label: "Auto", icon: "zap" },
    plan: { label: "Plan", icon: "plan" },
    dontAsk: { label: "Don't ask", icon: "circle" },
    bypassPermissions: { label: "Full access", icon: "shield" },
  };
  const PERM_ALIASES = {
    ask: "default",
    full: "bypassPermissions",
    bypass: "bypassPermissions",
  };

  function normalizePermissionMode(mode) {
    const raw = String(mode || "default").trim();
    const mapped = PERM_ALIASES[raw] || raw;
    return PERM_META[mapped] ? mapped : "default";
  }

  function closeAllChipMenus(except) {
    for (const m of document.querySelectorAll(".chip-menu")) {
      if (except && m === except) continue;
      m.classList.add("hidden");
    }
    for (const b of document.querySelectorAll(".chip-btn[aria-expanded='true']")) {
      if (except && b.nextElementSibling === except) continue;
      b.setAttribute("aria-expanded", "false");
    }
  }

  function optionText(sel, value) {
    if (!sel) return "";
    const o = [...sel.options].find((x) => x.value === String(value ?? ""));
    return o?.textContent || "";
  }

  function syncPermissionChip() {
    if (!selPermission) return;
    const v = normalizePermissionMode(selPermission.value);
    if (selPermission.value !== v) selPermission.value = v;
    const meta = PERM_META[v] || PERM_META.default;
    const label = $("permLabel");
    const ico = $("permIco");
    const btn = $("btnPermission");
    if (label) label.textContent = meta.label;
    if (ico && window.GrokIcons) {
      ico.setAttribute("data-icon", meta.icon);
      window.GrokIcons.mount(ico, meta.icon, { size: 14, className: "icon" });
    }
    if (btn) btn.dataset.perm = v;
    const menu = $("menuPermission");
    if (menu) {
      for (const b of menu.querySelectorAll("[data-value]")) {
        b.setAttribute("aria-selected", b.dataset.value === v ? "true" : "false");
        const name = b.dataset.iconName || PERM_META[b.dataset.value]?.icon;
        if (name && window.GrokIcons && !b.querySelector(".opt-ico")) {
          const span = document.createElement("span");
          span.className = "opt-ico";
          span.innerHTML = window.GrokIcons.svg(name, { size: 14, className: "icon" });
          b.prepend(span);
        }
      }
    }
  }

  function realSelectOptions(sel) {
    if (!sel) return [];
    return [...sel.options].filter((o) => o.value != null && String(o.value) !== "");
  }

  function syncModelChip() {
    // One real model → auto-select and show its name (never "System default")
    if (selModel) {
      const models = realSelectOptions(selModel);
      if (models.length === 1 && !selModel.value) {
        selModel.value = models[0].value;
      }
    }
    if (selEffort) {
      const efforts = realSelectOptions(selEffort);
      if (efforts.length === 1 && !selEffort.value) {
        selEffort.value = efforts[0].value;
      }
    }
    const modelVal = selModel?.value || "";
    const effortVal = selEffort?.value || "";
    const models = realSelectOptions(selModel);
    const efforts = realSelectOptions(selEffort);
    const modelTxt = displayModelName(
      modelVal
        ? optionText(selModel, modelVal) || modelVal
        : models.length === 1
          ? models[0].textContent || models[0].value
          : "",
    );
    const effortTxt = effortVal
      ? optionText(selEffort, effortVal) || effortVal
      : efforts.length === 1
        ? efforts[0].textContent || efforts[0].value
        : "";
    const modelLabel = $("modelLabel");
    if (modelLabel) modelLabel.textContent = modelTxt || "Model";
    const effortLabel = $("effortLabel");
    if (effortLabel) effortLabel.textContent = effortTxt || "Effort";
    rebuildModelMenus();
  }

  function syncModeChip() {
    if (!selMode) return;
    const v = selMode.value || "";
    const label = $("modeLabel");
    if (label) label.textContent = v ? optionText(selMode, v) || v : "Mode";
    const menu = $("menuMode");
    if (!menu) return;
    menu.innerHTML = "";
    for (const o of selMode.options) {
      if (!o.value && selMode.options.length > 1) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.role = "option";
      b.dataset.value = o.value;
      b.textContent = o.textContent || o.value || "Mode";
      b.setAttribute("aria-selected", o.value === v ? "true" : "false");
      b.onclick = () => {
        setModeValue(o.value);
        closeAllChipMenus();
      };
      menu.appendChild(b);
    }
  }

  function rebuildModelMenus() {
    const modelHost = $("menuModelOpts");
    const effortHost = $("menuEffortOpts");
    if (modelHost && selModel) {
      modelHost.innerHTML = "";
      const models = realSelectOptions(selModel);
      const onlyOne = models.length === 1;
      for (const o of selModel.options) {
        // Skip blank "System default" when there are real models (always for multi; also for single)
        if (!o.value && (models.length >= 1 || selModel.options.length > 1)) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.role = "option";
        b.dataset.value = o.value;
        b.textContent = o.value ? displayModelName(o.textContent || o.value) : "System default";
        b.setAttribute(
          "aria-selected",
          (o.value === selModel.value || (onlyOne && o.value === models[0]?.value)) ? "true" : "false",
        );
        b.onclick = () => {
          setModelValue(o.value);
          closeAllChipMenus();
        };
        modelHost.appendChild(b);
      }
    }
    if (effortHost && selEffort) {
      effortHost.innerHTML = "";
      const efforts = realSelectOptions(selEffort);
      for (const o of selEffort.options) {
        // Keep a "Default" only when multiple efforts exist
        if (!o.value && efforts.length >= 1) continue;
        const b = document.createElement("button");
        b.type = "button";
        b.role = "option";
        b.dataset.value = o.value;
        b.textContent = o.value ? o.textContent || o.value : "Default";
        b.setAttribute("aria-selected", o.value === selEffort.value ? "true" : "false");
        b.onclick = () => {
          setEffortValue(o.value);
          closeAllChipMenus();
        };
        effortHost.appendChild(b);
      }
    }
  }

  /** Known product default when CLI not yet connected — live `grok models` overrides. */
  const PRODUCT_DEFAULT_MODEL = "grok-4.6";
  const PRODUCT_DEFAULT_EFFORT = "high";
  const EFFORT_LEVELS = [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
    { value: "xhigh", name: "xHigh" },
  ];

  function displayModelName(raw) {
    return String(raw || "").replace(/\s*\(default\)\s*/i, "").trim();
  }

  function modelSupportsXhigh(modelId) {
    const id = String(modelId || "").toLowerCase();
    if (!id) return true;
    if (/multi-agent|4\.20/.test(id)) return true;
    const m = id.match(/grok-(\d+)\.(\d+)/);
    if (!m) return /4\.6/.test(id);
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 4 || (major === 4 && minor >= 6);
  }

  function effortChoicesForModel(modelId) {
    const id = modelId || selModel?.value || PRODUCT_DEFAULT_MODEL;
    if (modelSupportsXhigh(id)) return EFFORT_LEVELS.slice();
    return EFFORT_LEVELS.filter((e) => e.value !== "xhigh");
  }

  function fillSelect(sel, choices, current, emptyLabel, opts = {}) {
    if (!sel) return;
    const layout = loadLayout();
    const prev = sel.value;
    const list = Array.isArray(choices) ? choices : [];
    const real = list.filter((c) => c != null && String(c.value ?? "") !== "");
    // Prefer explicit current → previous → layout → product default (models only)
    let want =
      current != null && current !== ""
        ? String(current)
        : prev ||
          (sel === selModel ? layout.model || bootstrap?.defaultModel || PRODUCT_DEFAULT_MODEL : "") ||
          (sel === selEffort ? layout.effort : "") ||
          "";

    sel.innerHTML = "";
    // Models: never offer blank "System default" when we have a real list
    const isModel = sel === selModel;
    const single = opts.omitEmptyIfSingle !== false && real.length === 1;
    const omitEmpty = isModel || single || opts.forceNoEmpty;
    if (!omitEmpty) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel || "Default";
      sel.appendChild(empty);
    }
    for (const c of real) {
      const o = document.createElement("option");
      o.value = String(c.value);
      o.textContent =
        sel === selModel
          ? displayModelName(c.name || String(c.value))
          : c.name || String(c.value);
      sel.appendChild(o);
    }
    if (single) {
      sel.value = String(real[0].value);
      return;
    }
    if (want && [...sel.options].some((o) => o.value === want)) sel.value = want;
    else if (real.length >= 1) {
      const def =
        real.find((c) => c.default) ||
        real.find((c) => c.value === (bootstrap?.defaultModel || PRODUCT_DEFAULT_MODEL)) ||
        real[0];
      sel.value = String(def.value);
    } else {
      sel.value = "";
    }
  }

  function normalizeModelChoices(list) {
    return (Array.isArray(list) ? list : [])
      .map((c) => {
        const value = String(c?.value ?? c ?? "").trim();
        if (!value) return null;
        return {
          value,
          name: displayModelName(c?.name || value),
          default: Boolean(c?.default) || value === (bootstrap?.defaultModel || ""),
        };
      })
      .filter(Boolean);
  }

  function seedEffortOptions(preferred) {
    if (!selEffort) return;
    const choices = effortChoicesForModel(selModel?.value);
    let want =
      preferred ||
      selEffort.value ||
      loadLayout().effort ||
      bootstrap?.effort ||
      PRODUCT_DEFAULT_EFFORT;
    if (want === "xhigh" && !choices.some((c) => c.value === "xhigh")) want = PRODUCT_DEFAULT_EFFORT;
    fillSelect(selEffort, choices, want, "Default", { forceNoEmpty: true });
    if (!selEffort.value) selEffort.value = PRODUCT_DEFAULT_EFFORT;
    saveLayout({ effort: selEffort.value });
    syncModelChip();
  }

  /** Seed model dropdown from bootstrap / grok models before ACP session_config. */
  function seedModelsFromBootstrap() {
    if (!selModel) return;
    const list = normalizeModelChoices(
      bootstrap?.models && bootstrap.models.length
        ? bootstrap.models
        : [{ value: PRODUCT_DEFAULT_MODEL, name: PRODUCT_DEFAULT_MODEL, default: true }],
    );
    const preferred =
      bootstrap?.model ||
      loadLayout().model ||
      bootstrap?.defaultModel ||
      PRODUCT_DEFAULT_MODEL;
    fillSelect(selModel, list, preferred, "Model", { forceNoEmpty: true });
    saveLayout({ model: selModel.value || preferred });
    seedEffortOptions(loadLayout().effort || bootstrap?.effort || PRODUCT_DEFAULT_EFFORT);
    syncModelChip();
  }

  function applyModelCatalog(event) {
    const ids = Array.isArray(event?.models) ? event.models : [];
    if (!ids.length) return;
    const list = normalizeModelChoices(
      ids.map((id) => ({
        value: String(id),
        name: displayModelName(id),
        default: String(id) === String(event.defaultModel || event.currentModel || ""),
      })),
    );
    const preferred = event.currentModel || selModel?.value || event.defaultModel;
    fillSelect(selModel, list, preferred, "Model", { forceNoEmpty: true });
    if (bootstrap) {
      bootstrap.models = list;
      if (event.defaultModel) bootstrap.defaultModel = event.defaultModel;
    }
    seedEffortOptions();
    syncModelChip();
  }

  function applySessionConfig(options) {
    if (!Array.isArray(options)) return;
    applyingConfig = true;
    const layout = loadLayout();
    let modelOpt;
    let effortOpt;
    for (const opt of options) {
      const cat = (opt.category || "").toLowerCase();
      const name = (opt.name || "").toLowerCase();
      if (cat === "model" || name.includes("model")) modelOpt = opt;
      if (cat === "thought_level" || /reason|effort|thought/.test(name + cat)) effortOpt = opt;
    }
    if (modelOpt?.options?.length) {
      const preferred =
        modelOpt.currentValue ||
        layout.model ||
        selModel.value ||
        bootstrap?.defaultModel ||
        PRODUCT_DEFAULT_MODEL;
      // Merge agent options with bootstrap list (CLI is source of truth for IDs)
      const fromAgent = normalizeModelChoices(modelOpt.options);
      const fromBoot = normalizeModelChoices(bootstrap?.models || []).filter(
        (m) => !fromAgent.some((a) => a.value === m.value),
      );
      fillSelect(selModel, [...fromAgent, ...fromBoot], preferred, "Model", {
        forceNoEmpty: true,
      });
      selModel.dataset.configId = modelOpt.id;
    } else if (!realSelectOptions(selModel).length) {
      seedModelsFromBootstrap();
    }
    if (effortOpt?.options?.length) {
      const agentEfforts = effortOpt.options.map((o) => ({
        value: String(o.value),
        name: o.name || String(o.value),
        default: Boolean(o.default),
      }));
      const extras = effortChoicesForModel(selModel?.value).filter(
        (e) => !agentEfforts.some((a) => a.value === e.value),
      );
      const preferred =
        effortOpt.currentValue ||
        layout.effort ||
        selEffort.value ||
        (agentEfforts.find((o) => o.default)?.value ?? PRODUCT_DEFAULT_EFFORT);
      fillSelect(selEffort, [...agentEfforts, ...extras], preferred, "Default", {
        forceNoEmpty: true,
      });
      selEffort.dataset.configId = effortOpt.id;
    } else {
      if (effortOpt) selEffort.dataset.configId = effortOpt.id;
      seedEffortOptions(effortOpt?.currentValue || layout.effort);
    }
    applyingConfig = false;
    // Keep local preference when agent offers a different default (multi-model only)
    if (
      layout.model &&
      selModel.dataset.configId &&
      layout.model !== selModel.value &&
      realSelectOptions(selModel).length > 1
    ) {
      if ([...selModel.options].some((o) => o.value === layout.model)) {
        selModel.value = layout.model;
        void onConfigChange(selModel);
      }
    }
    if (layout.effort && selEffort.dataset.configId && layout.effort !== selEffort.value) {
      if ([...selEffort.options].some((o) => o.value === layout.effort)) {
        selEffort.value = layout.effort;
        void onConfigChange(selEffort);
      }
    }
    syncModelChip();
  }

  function applySessionModes(event) {
    if (!selMode) return;
    applyingConfig = true;
    const modes = event.modes || [];
    fillSelect(
      selMode,
      modes.map((m) => ({ value: m.id, name: m.name || m.id })),
      event.currentModeId,
      "Mode",
    );
    selMode.disabled = modes.length === 0;
    const wrap = $("ctlMode");
    if (wrap) {
      if (modes.length === 0) wrap.classList.add("hidden");
      else wrap.classList.remove("hidden");
    }
    applyingConfig = false;
    syncModeChip();
  }

  async function onConfigChange(sel) {
    if (applyingConfig) return;
    if (sel === selMode) {
      if (!sel.value) return;
      try {
        await api.setSessionMode(sel.value);
      } catch (e) {
        addMsg("error", e.message || String(e));
      }
      syncModeChip();
      return;
    }
    const configId = sel.dataset.configId;
    if (!configId) {
      if (sel === selModel) {
        saveLayout({ model: sel.value || "" });
        seedEffortOptions(selEffort?.value);
      }
      if (sel === selEffort) saveLayout({ effort: sel.value || "" });
      syncModelChip();
      return;
    }
    if (!sel.value) {
      if (sel === selModel) saveLayout({ model: "" });
      if (sel === selEffort) saveLayout({ effort: "" });
      syncModelChip();
      return;
    }
    try {
      await api.setSessionConfig(configId, sel.value);
      if (sel === selModel) {
        saveLayout({ model: sel.value });
        seedEffortOptions(selEffort?.value);
      }
      if (sel === selEffort) saveLayout({ effort: sel.value });
    } catch (e) {
      addMsg("error", e.message || String(e));
    }
    syncModelChip();
  }

  function setPermissionValue(v) {
    if (!selPermission) return;
    const mode = normalizePermissionMode(v);
    selPermission.value = mode;
    saveLayout({ permissionMode: mode });
    syncPermissionChip();
  }

  function setModelValue(v) {
    if (!selModel) return;
    selModel.value = v;
    void onConfigChange(selModel);
    syncModelChip();
  }

  function setEffortValue(v) {
    if (!selEffort) return;
    selEffort.value = v;
    void onConfigChange(selEffort);
    syncModelChip();
  }

  function setModeValue(v) {
    if (!selMode) return;
    selMode.value = v;
    void onConfigChange(selMode);
    syncModeChip();
  }

  function wireChipDropdown(btnId, menuId) {
    const btn = $(btnId);
    const menu = $(menuId);
    if (!btn || !menu) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      const open = menu.classList.contains("hidden");
      closeAllChipMenus();
      if (open) {
        menu.classList.remove("hidden");
        btn.setAttribute("aria-expanded", "true");
      }
    };
  }

  function setupComposerChips() {
    wireChipDropdown("btnPermission", "menuPermission");
    wireChipDropdown("btnModel", "menuModel");
    wireChipDropdown("btnEffort", "menuEffort");
    wireChipDropdown("btnMode", "menuMode");
    wireChipDropdown("btnUsage", "menuUsage");
    $("btnUsage")?.addEventListener("click", () => {
      if (!$("menuUsage")?.classList.contains("hidden")) {
        void refreshSessionInfo();
        void refreshUsage();
      }
    });

    const menuPerm = $("menuPermission");
    if (menuPerm) {
      for (const b of menuPerm.querySelectorAll("[data-value]")) {
        b.onclick = () => {
          setPermissionValue(b.dataset.value);
          closeAllChipMenus();
        };
      }
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest?.(".chip-dd")) closeAllChipMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllChipMenus();
    });

    syncPermissionChip();
    syncModelChip();
    syncModeChip();
  }

  function updateUsage(event) {
    if (!usageChip || !usageText) return;
    const bar = $("statusUsageBar");
    if (event?.type === "usage" && event.size) {
      const pct = Math.min(100, Math.round((event.used / event.size) * 100));
      usageText.textContent = `${pct}% · ${event.used}/${event.size}`;
      // CLI footer style: ↓169k
      const k = event.used >= 1000 ? `↓${Math.round(event.used / 1000)}k` : `↓${event.used}`;
      lastUsageFooter = k;
      paintTurnStatus();
      usageChip.classList.remove("hidden");
      usageChip.title = event.cost
        ? `Context ${pct}% · Cost ${event.cost.amount} ${event.cost.currency || ""}`
        : `Session context ${pct}%`;
      if (bar) {
        bar.style.width = `${pct}%`;
        bar.classList.toggle("hot", pct >= 85);
      }
    } else if (event?.type === "token_usage") {
      const inT = event.inputTokens ?? 0;
      const outT = event.outputTokens ?? 0;
      const thought = event.thoughtTokens;
      usageText.textContent =
        thought != null
          ? `↑${inT} ↓${outT} · think ${thought}`
          : `↑${inT} ↓${outT}`;
      const tot = inT + outT;
      lastUsageFooter =
        tot >= 1000 ? `↓${Math.round(tot / 1000)}k` : tot ? `↓${tot}` : lastUsageFooter;
      paintTurnStatus();
      usageChip.classList.remove("hidden");
      usageChip.title = "Turn token usage (in / out)";
      if (bar) {
        // soft fill based on rough scale
        const approx = Math.min(100, Math.round((inT + outT) / 200));
        bar.style.width = `${Math.max(8, approx)}%`;
        bar.classList.remove("hot");
      }
    }
  }

  function projectKey(p) {
    return String(p || "")
      .replace(/[/\\]+$/, "")
      .toLowerCase();
  }

  const PROJECT_DRAG_TYPE = "application/x-grok-build-project";
  const SESSION_DRAG_TYPE = "application/x-grok-build-session";

  function clearSidebarDragState() {
    projectList?.querySelectorAll(".project-block.drag-over, .project-block.chat-drag-over")
      .forEach((element) => element.classList.remove("drag-over", "chat-drag-over"));
    document.querySelectorAll(".project-chat-item.dragging")
      .forEach((element) => element.classList.remove("dragging"));
  }

  function draggedSession(event) {
    try {
      const raw = event.dataTransfer?.getData(SESSION_DRAG_TYPE) || "";
      if (!raw) return null;
      const session = JSON.parse(raw);
      return session?.id ? session : null;
    } catch {
      return null;
    }
  }

  function bindSessionDrag(row, sessionInfo) {
    row.draggable = true;
    row.dataset.sessionId = sessionInfo.id || "";
    row.setAttribute("aria-label", `${sessionInfo.title || tt("conversation", "Conversation")}. ${tt("dragChatHint", "Drag to another project to move")}`);
    row.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      row.classList.add("dragging");
      row.setAttribute("aria-grabbed", "true");
      const payload = JSON.stringify({
        id: sessionInfo.id,
        title: sessionInfo.title || "",
        cwd: sessionInfo.cwd || "",
      });
      event.dataTransfer?.setData(SESSION_DRAG_TYPE, payload);
      event.dataTransfer?.setData("text/plain", sessionInfo.title || sessionInfo.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", (event) => {
      event.stopPropagation();
      row.setAttribute("aria-grabbed", "false");
      clearSidebarDragState();
    });
  }

  /** Ordered project paths: first opened on top (bootstrap.recentProjects order). */
  function projectListItems() {
    const recent = (bootstrap?.recentProjects || []).filter(
      (p) => p && !isRecentsPath(p),
    );
    const items = [...recent];
    // Current workspace not yet in list → append (bottom)
    if (workspaceRoot && !items.some((p) => samePath(p, workspaceRoot))) {
      items.push(workspaceRoot);
    }
    return items.slice(0, 24);
  }

  function sessionsForProject(projectPath) {
    if (!projectPath) return cachedRecentsSessions;
    return cachedSessionsByProject.get(projectKey(projectPath)) || [];
  }

  /**
   * Nested chat rows under a project (or No project).
   * @param {HTMLElement} parent
   * @param {Array} sessions
   * @param {string} emptyText
   */
  function appendNestedChats(parent, sessions, emptyText) {
    const nest = document.createElement("div");
    nest.className = "project-chats";
    nest.setAttribute("role", "group");
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "project-chats-empty";
      empty.textContent = emptyText;
      nest.appendChild(empty);
      parent.appendChild(nest);
      return;
    }
    for (const s of sessions) {
      const row = document.createElement("div");
      row.className =
        "project-chat-item" + (s.id === activeSessionId ? " active" : "");
      row.setAttribute("role", "treeitem");
      // Codex: chat title; 1.0.5 last-turn summary keeps the reasoning thread visible.
      const summary = String(s.lastTurnSummary || s.lastRecap || "").trim();
      row.innerHTML =
        `<span class="project-chat-title">${escapeHtml(s.title)}</span>` +
        (summary ? `<span class="project-chat-summary">${escapeHtml(summary)}</span>` : "");
      row.title = [s.title, summary].filter(Boolean).join("\n");
      row.onclick = (ev) => {
        if (ev.target.closest("button")) return;
        void openHistorySession(s);
      };
      bindSessionDrag(row, s);
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const exp = document.createElement("button");
      exp.type = "button";
      exp.className = "mini";
      exp.textContent = tt("exportChat", "Export");
      exp.onclick = async (ev) => {
        ev.stopPropagation();
        try {
          const mdText = await api.exportSession(s.id);
          await api.saveExport(mdText, `${s.id.slice(0, 8)}.md`);
          addStep("Session exported");
        } catch (e) {
          addMsg("error", e.message || String(e));
        }
      };
      const move = document.createElement("button");
      move.type = "button";
      move.className = "mini";
      move.textContent = tt("moveChat", "Move");
      move.onclick = (ev) => {
        ev.stopPropagation();
        const rect = move.getBoundingClientRect();
        showSessionMoveMenu(s, { x: rect.left, y: rect.bottom + 4 });
      };
      const del = document.createElement("button");
      del.type = "button";
      del.className = "mini";
      del.textContent = tt("deleteChat", "Delete");
      del.onclick = async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Delete session ${s.title}?`)) return;
        try {
          await api.deleteSession(s.id);
          void refreshHistory();
        } catch (e) {
          addMsg("error", e.message || String(e));
        }
      };
      actions.append(exp, move, del);
      row.appendChild(actions);
      nest.appendChild(row);
    }
    parent.appendChild(nest);
  }

  /** Codex-style Recents block (no-project chats only). */
  function renderRecents() {
    if (!recentsList) return;
    recentsList.innerHTML = "";
    if (!cachedRecentsSessions.length) {
      const empty = document.createElement("div");
      empty.className = "project-chats-empty";
      empty.textContent = tt("noChatsShort", "No chats");
      recentsList.appendChild(empty);
      return;
    }
    for (const s of cachedRecentsSessions) {
      const row = document.createElement("div");
      row.className =
        "project-chat-item recents-chat-item" +
        (s.id === activeSessionId ? " active" : "");
      const summary = String(s.lastTurnSummary || s.lastRecap || "").trim();
      row.innerHTML =
        `<span class="project-chat-title">${escapeHtml(s.title)}</span>` +
        (summary ? `<span class="project-chat-summary">${escapeHtml(summary)}</span>` : "");
      row.title = [s.title, summary].filter(Boolean).join("\n");
      row.onclick = (event) => {
        if (event.target.closest("button")) return;
        void openHistorySession(s);
      };
      bindSessionDrag(row, s);
      const actions = document.createElement("div");
      actions.className = "row-actions";
      const move = document.createElement("button");
      move.type = "button";
      move.className = "mini";
      move.textContent = tt("moveChat", "Move");
      move.onclick = (event) => {
        event.stopPropagation();
        const rect = move.getBoundingClientRect();
        showSessionMoveMenu(s, { x: rect.left, y: rect.bottom + 4 });
      };
      actions.appendChild(move);
      row.appendChild(actions);
      recentsList.appendChild(row);
    }
  }

  function mountProjectIcons(scope) {
    try {
      globalThis.GrokIcons?.applyAll?.(scope || projectList);
    } catch {
      /* ignore */
    }
  }

  async function persistProjectOrder(paths) {
    const list = (paths || []).filter((p) => p && !isRecentsPath(p));
    if (bootstrap) bootstrap.recentProjects = list;
    try {
      if (api.setRecentProjects) {
        const res = await api.setRecentProjects(list);
        if (res?.recentProjects && bootstrap) {
          bootstrap.recentProjects = res.recentProjects;
        }
      }
    } catch (e) {
      console.warn("setRecentProjects", e);
    }
  }

  function bindProjectDrag(block, handle) {
    handle.draggable = true;
    handle.addEventListener("dragstart", (e) => {
      e.stopPropagation();
      block.classList.add("dragging");
      e.dataTransfer?.setData(PROJECT_DRAG_TYPE, block.dataset.projectPath || "");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    handle.addEventListener("dragend", (e) => {
      e.stopPropagation();
      block.classList.remove("dragging");
      clearSidebarDragState();
    });
    block.addEventListener("dragover", (e) => {
      const types = Array.from(e.dataTransfer?.types || []);
      const hasSession = types.includes(SESSION_DRAG_TYPE);
      const hasProject = types.includes(PROJECT_DRAG_TYPE);
      if (!hasSession && !hasProject) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      block.classList.toggle("chat-drag-over", hasSession);
      block.classList.toggle("drag-over", hasProject);
    });
    block.addEventListener("dragleave", (e) => {
      if (e.relatedTarget && block.contains(e.relatedTarget)) return;
      block.classList.remove("drag-over", "chat-drag-over");
    });
    block.addEventListener("drop", (e) => {
      e.preventDefault();
      const toPath = block.dataset.projectPath || "";
      const sessionInfo = draggedSession(e);
      block.classList.remove("drag-over", "chat-drag-over");
      if (sessionInfo) {
        e.stopPropagation();
        if (!samePath(sessionInfo.cwd, toPath)) {
          void moveSessionToProject(sessionInfo, toPath);
        }
        return;
      }
      const fromPath = e.dataTransfer?.getData(PROJECT_DRAG_TYPE) || "";
      if (!fromPath || !toPath || samePath(fromPath, toPath)) return;
      const order = projectListItems();
      const fromIdx = order.findIndex((p) => samePath(p, fromPath));
      const toIdx = order.findIndex((p) => samePath(p, toPath));
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...order];
      const [item] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, item);
      void persistProjectOrder(next).then(() => renderProjects());
    });
  }

  function renderProjects() {
    if (!projectList) return;
    projectList.innerHTML = "";

    // Codex: Projects list = real folders only (never "No project" row)
    for (const p of projectListItems()) {
      const block = document.createElement("div");
      block.className = "project-block";
      block.dataset.projectPath = p;
      const active = samePath(p, workspaceRoot);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "project-item" + (active ? " active" : "");
      b.setAttribute("role", "treeitem");
      b.setAttribute("aria-expanded", "true");
      b.innerHTML = `<span class="project-ico" data-icon="folder" data-icon-size="14" aria-hidden="true"></span><span class="project-name">${escapeHtml(basen(p))}</span>`;
      b.title = p;
      b.onclick = () => void openProjectTab(p);
      block.appendChild(b);
      // Chats under every project (Codex always lists them)
      appendNestedChats(
        block,
        sessionsForProject(p),
        tt("noChatsShort", "No chats"),
      );
      bindProjectDrag(block, b);
      projectList.appendChild(block);
    }

    if (!projectListItems().length) {
      const hint = document.createElement("div");
      hint.className = "project-chats-empty";
      hint.textContent = tt(
        "projectsEmptyHint",
        "No projects yet. Press + to open a folder.",
      );
      projectList.appendChild(hint);
    }

    mountProjectIcons(projectList);
    renderRecents();
  }

  function renderProjectMenu() {
    const menu = $("menuProject");
    if (!menu) return;
    menu.innerHTML = "";
    const addOpt = (label, value, active) => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.dataset.value = value == null ? "" : value;
      b.textContent = label;
      if (active) b.setAttribute("aria-selected", "true");
      b.onclick = () => {
        menu.classList.add("hidden");
        $("btnProject")?.setAttribute("aria-expanded", "false");
        if (value === "__open__") openProjectModal("open");
        else if (value === "__add__") openProjectModal("add");
        else void openProjectTab(value || null);
      };
      menu.appendChild(b);
    };
    addOpt(tt("noProject", "No project"), "", isNoProject());
    for (const p of projectListItems()) {
      addOpt(basen(p), p, samePath(p, workspaceRoot));
    }
    addOpt(tt("addFolder", "Add folder"), "__add__", false);
    addOpt(tt("openProject", "Open project…"), "__open__", false);
  }

  let draftProjectFolders = [];
  let projectModalMode = "open";

  function extraRootsHint() {
    const extras = extraRoots.filter((p) => p && !samePath(p, workspaceRoot));
    if (!extras.length) return "";
    return (
      "Additional project folders you may read and edit in this session:\n" +
      extras.map((p) => `- ${p}`).join("\n")
    );
  }

  function renderProjectFolderDraft() {
    const host = $("projectFolderList");
    if (!host) return;
    host.innerHTML = "";
    draftProjectFolders.forEach((folder, index) => {
      const row = document.createElement("div");
      row.className = "project-folder-row";
      row.innerHTML = `<span class="project-folder-name" title="${escapeHtml(folder)}">${escapeHtml(basen(folder))}</span>`;
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "tab-x";
      rm.textContent = "×";
      rm.title = tt("remove", "Remove");
      rm.onclick = () => {
        draftProjectFolders.splice(index, 1);
        renderProjectFolderDraft();
      };
      row.appendChild(rm);
      host.appendChild(row);
    });
    if ($("inpProjectName") && !$("inpProjectName").value.trim() && draftProjectFolders[0]) {
      $("inpProjectName").placeholder = basen(draftProjectFolders[0]);
    }
  }

  function closeProjectModal() {
    $("projectModal")?.classList.add("hidden");
  }

  function openProjectModal(mode, seed) {
    projectModalMode = mode === "add" ? "add" : "open";
    draftProjectFolders = [];
    if (projectModalMode === "add" && workspaceRoot) {
      draftProjectFolders = [workspaceRoot, ...extraRoots.filter((p) => !samePath(p, workspaceRoot))];
    } else if (Array.isArray(seed)) {
      draftProjectFolders = seed.slice();
    }
    const title = $("projectModalTitle");
    if (title) {
      title.textContent =
        projectModalMode === "add"
          ? tt("addFolderTitle", "Add folders")
          : tt("openProjectTitle", "Open project");
    }
    if ($("inpProjectName")) $("inpProjectName").value = workspaceRoot ? basen(workspaceRoot) : "";
    renderProjectFolderDraft();
    $("projectModal")?.classList.remove("hidden");
    if (typeof GrokI18n !== "undefined") GrokI18n.applyDom();
    globalThis.GrokIcons?.applyAll?.($("projectModal"));
  }

  async function addDraftProjectFolder() {
    const picked = await pickFolder();
    if (!picked) return;
    if (!draftProjectFolders.some((p) => samePath(p, picked))) {
      draftProjectFolders.push(picked);
      renderProjectFolderDraft();
    }
  }

  async function confirmProjectModal() {
    if (!draftProjectFolders.length) {
      addMsg("error", tt("needFolder", "Add at least one folder."));
      return;
    }
    const primary = draftProjectFolders[0];
    const extras = draftProjectFolders.slice(1);
    closeProjectModal();
    await openProjectTab(primary, { extraRoots: extras });
  }

  function looksLikeSessionIdTitle(s) {
    const t = String(s?.title || "").trim();
    const id = String(s?.id || "");
    if (!t || !id) return true;
    // Fallback titles: "019fd646-5…" when no real user chat yet
    if (t.endsWith("…") && id.startsWith(t.replace(/…$/, ""))) return true;
    if (/^[0-9a-f]{8}-[0-9a-f]/i.test(t) && id.startsWith(t.slice(0, 8))) return true;
    return false;
  }

  function filterRealSessions(list) {
    return (list || []).filter((s) => {
      if ((s.messageCount || 0) <= 0) return false;
      if (looksLikeSessionIdTitle(s)) return false;
      return true;
    });
  }

  async function openHistorySession(s) {
    try {
      const cwd = s.cwd || "";
      const noProj = isRecentsPath(cwd);
      const project = noProj ? null : cwd;
      if (!(await alignProjectWorkspace(project))) return;

      // A sidebar chat row selects its existing owner when already open. This
      // keeps its slot, queue, cached stream and runtime instead of duplicating
      // or replacing the tab.
      const existing = (sessionTabs?.tabs || []).find((tab) => tab.sessionId === s.id);
      if (existing) {
        if (sessionTabs.getActive?.() !== existing) sessionTabs.activate(existing.id);
        prompt.focus();
        return;
      }

      const draft = [...(sessionTabs?.tabs || [])].reverse().find((tab) =>
        samePath(tab.cwd, effectiveWorkspace(project)) &&
        !tab.sessionId &&
        !tab.busy &&
        !(tab.pendingEvents || []).length &&
        !(tab.promptQueue || []).length &&
        (tab.items || []).every((item) => item.kind === "empty" || item.kind === "step"),
      );
      setStatus("starting", tt("loadingCachedChat", "Loading cached chat…"));
      editCount = 0;
      reviews = [];
      renderReviewList();
      planDock.classList.add("hidden");
      sessionTabs?.saveSnapshot?.(eventStore.items);
      if (draft) {
        sessionTabs.updateTab?.(draft.id, {
          title: s.title || "Chat",
          sessionId: s.id,
          cwd: (noProj ? getRecentsWorkspace() || "" : cwd) || null,
          items: [],
          deferLoad: true,
        });
        if (sessionTabs.getActive?.() !== draft) sessionTabs.activate(draft.id);
        else restoreStoreItems([]);
      } else {
        sessionTabs?.addTab?.(
          {
            title: s.title || "Chat",
            sessionId: s.id,
            cwd: cwd || null,
            items: [],
            deferLoad: true,
          },
          true,
        );
      }
      activeSessionId = s.id;
      syncConvTitle();
      await paintTranscript(s.id);
      applySessionRecap(s);
      sessionTabs?.saveSnapshot?.(eventStore.items);
      sessionTabs?.updateActive?.({
        sessionId: s.id,
        title: s.title || "Chat",
        cwd: (noProj ? getRecentsWorkspace() || "" : cwd) || null,
        deferLoad: false,
      });
      syncConvTitle();
      setStatus(
        agentConnected ? "connected" : "disconnected",
        tt("cachedChatReady", "Cached · send to resume"),
      );
      void refreshHistory();
      prompt.focus();
    } catch (e) {
      addMsg("error", e.message || String(e));
      setStatus("error");
    }
  }

  async function refreshHistory() {
    try {
      const recentsCwd = getRecentsWorkspace();
      const recentsRaw = recentsCwd ? await api.listSessions(recentsCwd) : [];
      cachedRecentsSessions = filterRealSessions(recentsRaw).filter((s) =>
        isRecentsPath(s.cwd),
      );

      cachedSessionsByProject.clear();
      const projects = projectListItems();
      await Promise.all(
        projects.map(async (p) => {
          try {
            const raw = await api.listSessions(p);
            const list = filterRealSessions(raw).filter((s) => samePath(s.cwd, p));
            cachedSessionsByProject.set(projectKey(p), list);
          } catch {
            cachedSessionsByProject.set(projectKey(p), []);
          }
        }),
      );
    } catch (e) {
      cachedRecentsSessions = [];
      cachedSessionsByProject.clear();
      console.warn("refreshHistory", e);
    }
    if (activeSessionId) {
      const listed = [
        ...cachedRecentsSessions,
        ...[...cachedSessionsByProject.values()].flat(),
      ];
      const current = listed.find((session) => session.id === activeSessionId);
      if (current) rememberSessionMeta(current);
    }
    paintSessionFlowStrip();
    // Nested chats under each project row
    renderProjects();
  }

  async function pickFolderAndSelect() {
    openProjectModal(workspaceRoot ? "add" : "open");
    return null;
  }

  /** Common tool chips for Agent settings (CLI --tools / --denied-tools). */
  const TOOL_PRESETS = [
    "bash",
    "read",
    "write",
    "edit",
    "glob",
    "grep",
    "web_search",
    "web_fetch",
    "todo",
  ];

  function parseToolList(raw) {
    return String(raw || "")
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function joinToolList(arr) {
    return [...new Set(arr)].join(", ");
  }

  function syncToolsHiddenFromUi() {
    const mode = $("selToolsMode")?.value || "all";
    const list = parseToolList($("inpToolsList")?.value);
    if ($("inpTools")) $("inpTools").value = mode === "allow" ? joinToolList(list) : "";
    if ($("inpDenied")) $("inpDenied").value = mode === "deny" ? joinToolList(list) : "";
  }

  function syncSandboxHidden() {
    if ($("inpSandbox") && $("selSandbox")) {
      $("inpSandbox").value = $("selSandbox").value || "";
    }
  }

  function syncWebSearchHidden() {
    // UI: allow web (checked) → disableWebSearch false
    if ($("chkDisableWeb") && $("chkWebSearch")) {
      $("chkDisableWeb").checked = !$("chkWebSearch").checked;
    }
  }

  function readMaxTurnsFromUi() {
    const mode = $("selMaxTurns")?.value || "0";
    if (mode === "custom") {
      return Math.max(0, Number($("inpMaxTurns")?.value) || 0);
    }
    return Math.max(0, Number(mode) || 0);
  }

  function applyMaxTurnsToUi(n) {
    const v = Number(n) || 0;
    const sel = $("selMaxTurns");
    const wrap = $("maxTurnsCustomWrap");
    if (!sel) return;
    const presets = ["0", "10", "25", "50", "100"];
    if (presets.includes(String(v))) {
      sel.value = String(v);
      wrap?.classList.add("hidden");
      if ($("inpMaxTurns")) $("inpMaxTurns").value = v || "";
    } else if (v > 0) {
      sel.value = "custom";
      wrap?.classList.remove("hidden");
      if ($("inpMaxTurns")) $("inpMaxTurns").value = String(v);
    } else {
      sel.value = "0";
      wrap?.classList.add("hidden");
    }
  }

  function applyToolsModeToUi(tools, denied) {
    const t = String(tools || "").trim();
    const d = String(denied || "").trim();
    const modeSel = $("selToolsMode");
    const fields = $("toolsListFields");
    const list = $("inpToolsList");
    if (!modeSel) return;
    if (t) {
      modeSel.value = "allow";
      if (list) list.value = t;
      fields?.classList.remove("hidden");
    } else if (d) {
      modeSel.value = "deny";
      if (list) list.value = d;
      fields?.classList.remove("hidden");
    } else {
      modeSel.value = "all";
      if (list) list.value = "";
      fields?.classList.add("hidden");
    }
    paintToolPresets();
  }

  function paintToolPresets() {
    const host = $("toolPresets");
    if (!host) return;
    const mode = $("selToolsMode")?.value || "all";
    const selected = new Set(parseToolList($("inpToolsList")?.value));
    host.innerHTML = "";
    if (mode === "all") return;
    for (const name of TOOL_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-chip" + (selected.has(name) ? " on" : "");
      b.textContent = name;
      b.onclick = () => {
        const set = new Set(parseToolList($("inpToolsList")?.value));
        if (set.has(name)) set.delete(name);
        else set.add(name);
        if ($("inpToolsList")) $("inpToolsList").value = joinToolList([...set]);
        paintToolPresets();
        syncToolsHiddenFromUi();
      };
      host.appendChild(b);
    }
  }

  function wireSettingsControls() {
    $("selMaxTurns")?.addEventListener("change", () => {
      const wrap = $("maxTurnsCustomWrap");
      if ($("selMaxTurns").value === "custom") wrap?.classList.remove("hidden");
      else wrap?.classList.add("hidden");
    });
    $("selToolsMode")?.addEventListener("change", () => {
      const mode = $("selToolsMode").value;
      const fields = $("toolsListFields");
      if (mode === "all") {
        fields?.classList.add("hidden");
        if ($("inpToolsList")) $("inpToolsList").value = "";
      } else {
        fields?.classList.remove("hidden");
      }
      paintToolPresets();
      syncToolsHiddenFromUi();
    });
    $("inpToolsList")?.addEventListener("input", () => {
      paintToolPresets();
      syncToolsHiddenFromUi();
    });
    $("selSandbox")?.addEventListener("change", syncSandboxHidden);
    $("chkWebSearch")?.addEventListener("change", syncWebSearchHidden);
    $("chkWorktree")?.addEventListener("change", () => {
      const on = $("chkWorktree").checked;
      $("worktreeFields")?.classList.toggle("hidden", !on);
      if (!on && $("inpWorktree")) $("inpWorktree").value = "";
    });
  }

  function connectOpts() {
    syncToolsHiddenFromUi();
    syncSandboxHidden();
    syncWebSearchHidden();
    const useWt = Boolean($("chkWorktree")?.checked);
    const wtName = useWt ? $("inpWorktree")?.value?.trim() || "" : "";
    const wtRef = useWt ? $("inpWorktreeRef")?.value?.trim() || "" : "";
    return {
      permissionMode: normalizePermissionMode(selPermission?.value),
      model:
        selModel.value ||
        bootstrap?.model ||
        bootstrap?.defaultModel ||
        PRODUCT_DEFAULT_MODEL ||
        undefined,
      effort: selEffort.value || undefined,
      sandbox: $("selSandbox")?.value ?? $("inpSandbox")?.value?.trim() ?? "",
      tools: $("inpTools")?.value?.trim() || "",
      deniedTools: $("inpDenied")?.value?.trim() || "",
      worktree: wtName,
      worktreeRef: wtRef,
      extraRoots: extraRoots.slice(),
      rules: $("inpRules")?.value?.trim() || "",
      maxTurns: readMaxTurnsFromUi(),
      disableWebSearch: Boolean($("chkDisableWeb")?.checked),
      experimentalMemory: Boolean($("chkExpMem")?.checked),
      allowOutside: Boolean($("chkAllowOutside")?.checked),
      autoConnect: Boolean($("chkAutoConnect")?.checked),
    };
  }

  function applyTheme(theme, shouldUseDark) {
    let mode = theme || "system";
    if (mode === "system") {
      mode = shouldUseDark === false ? "light" : "dark";
      // if unknown, prefer dark
      if (shouldUseDark === undefined) {
        mode =
          window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark";
      }
    }
    const resolved = mode === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", resolved);
    if ($("selTheme")) $("selTheme").value = theme || "system";
    saveLayout({ theme: theme || "system" });
    // Theme icon: show opposite action (sun when dark → go light)
    const themeIcon = $("themeIcon");
    if (themeIcon && window.GrokIcons) {
      const name = resolved === "dark" ? "sun" : "moon";
      themeIcon.setAttribute("data-icon", name);
      window.GrokIcons.mount(themeIcon, name, { size: 16, className: "icon" });
      const btn = $("btnTheme");
      if (btn) {
        btn.title =
          resolved === "dark"
            ? tt("switchToLight", "Switch to light")
            : tt("switchToDark", "Switch to dark");
      }
    }
  }

  async function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "light" ? "dark" : "light";
    const res = await api.setTheme(next);
    applyTheme(next, res.shouldUseDarkColors);
    if (bootstrap) bootstrap.theme = next;
  }

  function toggleLang() {
    if (!I()) return;
    I().toggle();
    I().applyDom();
    // refresh dynamic labels (header, projects, timeline phases EN↔VI)
    if (busy && turnPhase && turnPhase !== "idle" && turnPhase !== "done") {
      setStatus("running", phaseLabel(turnPhase));
    } else {
      setStatus(status?.dataset?.state || "disconnected");
    }
    if (workspaceRoot) setWorkspace(workspaceRoot);
    else {
      if ($("workspaceLabel")) $("workspaceLabel").textContent = tt("noProject", "No project");
      renderProjects();
      renderProjectMenu();
      updateProjectChip();
    }
    renderReviewList();
    relocalizeTimeline();
    showEmpty();
    updateFilePaneControls();
    void refreshFolderTrustUi();
    if (window.GrokIcons) window.GrokIcons.applyAll();
    applyTheme(
      bootstrap?.theme || loadLayout().theme || "system",
      document.documentElement.getAttribute("data-theme") === "light" ? false : true,
    );
  }

  function loadSettingsForm() {
    if (!bootstrap) return;
    if ($("inpExecutable")) $("inpExecutable").value = bootstrap.executable || "";
    if ($("inpWorkspace")) $("inpWorkspace").value = workspaceRoot || "";
    if ($("inpIdePath")) $("inpIdePath").value = bootstrap.idePath || "";
    if ($("inpUpdateUrl")) $("inpUpdateUrl").value = bootstrap.updateUrl || "";
    if ($("selTheme")) $("selTheme").value = bootstrap.theme || "system";

    // Agent — humanized controls
    if ($("selSandbox")) $("selSandbox").value = bootstrap.sandbox || "";
    if ($("inpSandbox")) $("inpSandbox").value = bootstrap.sandbox || "";
    applyToolsModeToUi(bootstrap.tools, bootstrap.deniedTools);
    const wt = bootstrap.worktree || "";
    if ($("chkWorktree")) $("chkWorktree").checked = Boolean(wt);
    $("worktreeFields")?.classList.toggle("hidden", !wt);
    if ($("inpWorktree")) $("inpWorktree").value = wt;
    if ($("inpWorktreeRef")) $("inpWorktreeRef").value = bootstrap.worktreeRef || "";
    if ($("inpRules")) $("inpRules").value = bootstrap.rules || "";
    applyMaxTurnsToUi(bootstrap.maxTurns || 0);

    const webOff = Boolean(bootstrap.disableWebSearch);
    if ($("chkDisableWeb")) $("chkDisableWeb").checked = webOff;
    if ($("chkWebSearch")) $("chkWebSearch").checked = !webOff;

    if ($("chkAutoConnect")) $("chkAutoConnect").checked = bootstrap.autoConnect !== false;
    if ($("chkAllowOutside")) $("chkAllowOutside").checked = Boolean(bootstrap.allowOutside);
    if ($("chkExpMem")) $("chkExpMem").checked = Boolean(bootstrap.experimentalMemory);
    if ($("chkShowReasoning")) $("chkShowReasoning").checked = bootstrap.showReasoning !== false;
    if ($("chkTelemetry")) $("chkTelemetry").checked = Boolean(bootstrap.telemetryOptIn);
    showReasoning = Boolean($("chkShowReasoning")?.checked);
    updateSettingsAuthHint(bootstrap.auth || authProfile);
  }

  function updateImagineVideoStatus(profile) {
    const el = $("imagineVideoStatus");
    if (!el) return;
    el.classList.remove("status-ok", "status-warn", "status-bad");
    if (!profile?.loggedIn) {
      el.classList.add("status-warn");
      el.textContent = "Not signed in — sign in to use /imagine-video.";
      return;
    }
    if (profile.codingDataRetentionOptOut === true || profile.imagineVideoBlocked) {
      el.classList.add("status-bad");
      el.textContent =
        "Blocked: coding data retention is Opt out. Open Grok TUI → /privacy → Opt in, then re-login Desktop. (API error looks like ZDR / upload_url.)";
      return;
    }
    if (profile.codingDataRetentionOptOut === false || profile.imagineVideoReady) {
      el.classList.add("status-ok");
      el.textContent =
        "Ready: retention Opt in. /imagine-video should work unless team ZDR is Active in the xAI Console.";
      return;
    }
    el.classList.add("status-warn");
    el.textContent =
      "Unknown privacy flag — try /imagine-video; if upload_url fails, set /privacy → Opt in.";
  }

  function updateSettingsAuthHint(profile) {
    const hint = $("settingsAuthHint");
    const loginBtn = $("btnSettingsLogin");
    const logoutBtn = $("btnSettingsLogout");
    if (!hint) return;
    if (profile?.loggedIn) {
      const name = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || profile.displayName || "Signed in";
      hint.textContent = `${name}${profile.email ? ` · ${profile.email}` : ""}`;
    } else {
      hint.textContent = "Not signed in. Login uses grok OAuth/device flow (browser).";
    }
    if (loginBtn) loginBtn.disabled = Boolean(profile?.loggedIn);
    if (logoutBtn) logoutBtn.disabled = !profile?.loggedIn;
    updateImagineVideoStatus(profile);
  }

  function formatInt(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    return Math.round(x).toLocaleString();
  }

  function formatCredits(n) {
    if (n == null || n === "") return "—";
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    return x.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function formatUsd(n) {
    if (n == null || !Number.isFinite(Number(n))) return "—";
    return `$${Number(n).toFixed(4)}`;
  }

  function formatApiDuration(ms) {
    const t = Math.max(0, Math.floor(Number(ms) || 0));
    if (!t) return "0s";
    const s = Math.floor(t / 1000);
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m <= 0) return `${rs}s`;
    return `${m}m${String(rs).padStart(2, "0")}s`;
  }

  function formatResetDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  let lastUsageManageUrl = "https://grok.com?_s=usage";
  let lastSessionInfo = null;

  function sessionInfoFieldRows(data) {
    if (!data) return [];
    const rows = [
      [tt("sessionTitleLabel", "Title"), data.title],
      [tt("shellVersion", "Shell version"), data.shellVersion],
      [tt("authMethod", "Auth method"), data.authMethod],
      [tt("sessionId", "Session ID"), data.sessionId],
      [tt("workingDirectory", "Working directory"), data.workingDirectory],
      [tt("sessionModelLabel", "Model"), data.model],
      [tt("modelHash", "Model Hash"), data.modelHash],
      [tt("apiBackend", "API Backend"), data.apiBackend],
      [tt("sandbox", "Sandbox"), data.sandbox],
      [tt("turns", "Turns"), data.turns],
      [tt("reasoningEffort", "Reasoning effort"), data.reasoningEffort],
      [tt("permissionMode", "Permission mode"), data.permissionMode],
      [tt("created", "Created"), data.createdAt ? new Date(data.createdAt).toLocaleString() : null],
      [tt("updated", "Updated"), data.updatedAt ? new Date(data.updatedAt).toLocaleString() : null],
      [tt("lastTurnSummary", "Last turn"), data.lastTurnSummary],
      [tt("lastRecap", "Last recap"), data.lastRecap],
    ];
    return rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  }

  function sessionInfoRow(label, value) {
    const copy = String(value);
    return (
      `<button type="button" class="session-info-row" data-session-copy="${escapeHtml(copy)}" title="${escapeHtml(tt("clickToCopy", "Click to copy value"))}">` +
      `<span class="session-info-row-key">${escapeHtml(label)}</span>` +
      `<span class="session-info-row-value">${escapeHtml(copy)}</span>` +
      `<span class="session-info-row-copy" data-icon="copy" data-icon-size="13" aria-hidden="true"></span>` +
      `</button>`
    );
  }

  function renderSessionInfo(data) {
    lastSessionInfo = data || null;
    const rows = sessionInfoFieldRows(data);
    const rowsEl = $("sessionInfoRows");
    const empty = $("sessionInfoEmpty");
    if (rowsEl) rowsEl.innerHTML = rows.map(([label, value]) => sessionInfoRow(label, value)).join("");
    if (empty) empty.classList.toggle("hidden", rows.length > 0);
    const status = $("sessionInfoStatus");
    if (status) {
      status.textContent = data?.ok
        ? `${data.state || tt("connected", "Connected")} · ${data.model || tt("defaultModel", "Default model")}`
        : tt("noActiveSession", "Connect to start a session.");
    }

    const context = data?.context || {};
    const pct = Number.isFinite(Number(context.percent)) ? Number(context.percent) : null;
    const pctText = pct == null ? "—" : `${pct}%`;
    if ($("sessionContextPercent")) $("sessionContextPercent").textContent = pctText;
    if ($("sessionContextBar")) {
      $("sessionContextBar").style.width = `${pct == null ? 0 : Math.min(100, Math.max(0, pct))}%`;
    }
    if ($("sessionContextBarWrap")) {
      $("sessionContextBarWrap").setAttribute("aria-valuenow", String(pct == null ? 0 : Math.round(pct)));
    }
    if ($("sessionContextDetail")) {
      $("sessionContextDetail").textContent =
        context.used != null && context.size
          ? `${formatInt(context.used)} / ${formatInt(context.size)} tokens (${pctText})`
          : tt("waitingContext", "Waiting for context data.");
    }
    if (data?.context?.used != null) {
      const label = $("usageComposerLabel");
      if (label) label.textContent = pct == null ? tt("sessionInfo", "Session") : `${pctText}`;
    }
    if (data?.lastRecap || data?.lastTurnSummary) {
      activeSessionMeta = {
        lastRecap: String(data.lastRecap || activeSessionMeta.lastRecap || "").trim(),
        lastTurnSummary: String(data.lastTurnSummary || activeSessionMeta.lastTurnSummary || "").trim(),
        titleIsManual: Boolean(data.titleIsManual || activeSessionMeta.titleIsManual),
      };
    }
    paintSessionFlowStrip();
    window.GrokIcons?.applyAll?.($("menuUsage"));
  }

  async function refreshSessionInfo() {
    const status = $("sessionInfoStatus");
    if (status) status.textContent = tt("loading", "Loading…");
    try {
      if (!api.getSessionInfo) {
        renderSessionInfo({ ok: false });
        return;
      }
      renderSessionInfo(await api.getSessionInfo());
    } catch (error) {
      renderSessionInfo({ ok: false });
      if (status) status.textContent = error?.message || String(error);
    }
  }

  function activateSessionInfoTab(id) {
    document.querySelectorAll("[data-session-info-tab]").forEach((tab) => {
      const active = tab.dataset.sessionInfoTab === id;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll("[data-session-info-panel]").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.sessionInfoPanel === id);
    });
  }

  async function copySessionInfoValue(value, label) {
    if (!value || !api.writeClipboardText) return;
    await api.writeClipboardText(String(value));
    const status = $("sessionInfoStatus");
    if (status) status.textContent = label || tt("copied", "Copied");
  }

  async function copyAllSessionInfo() {
    const rows = sessionInfoFieldRows(lastSessionInfo);
    const context = lastSessionInfo?.context || {};
    if (context.used != null) rows.push([tt("contextUsed", "Context used"), formatInt(context.used)]);
    if (context.size != null) rows.push([tt("contextWindow", "Context window"), formatInt(context.size)]);
    if (context.percent != null) rows.push([tt("contextPercent", "Context used %"), `${context.percent}%`]);
    const text = rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    await copySessionInfoValue(text, tt("copiedAll", "Copied all session info"));
  }

  function usageRow(label, valueHtml) {
    return (
      `<div class="usage-row"><span class="k">${escapeHtml(label)}</span>` +
      `<span class="v">${valueHtml}</span></div>`
    );
  }

  function eachUsage(sel, fn) {
    document.querySelectorAll(sel).forEach(fn);
  }

  function setUsagePlanBar(pct) {
    const value = pct == null || !Number.isFinite(Number(pct)) ? 0 : Math.min(100, Math.max(0, Number(pct)));
    eachUsage(".js-usage-plan-bar", (bar) => {
      bar.style.width = `${value}%`;
      bar.classList.remove("warn", "crit");
      if (pct != null && Number.isFinite(Number(pct))) {
        if (value >= 90) bar.classList.add("crit");
        else if (value >= 70) bar.classList.add("warn");
      }
    });
    eachUsage(".js-usage-plan-bar-wrap", (wrap) => {
      wrap.setAttribute("aria-valuenow", String(Math.round(value)));
      if (pct == null || !Number.isFinite(Number(pct))) wrap.removeAttribute("aria-valuetext");
      else wrap.setAttribute("aria-valuetext", `${Math.round(value)}%`);
    });
  }

  function sessionUsageHtml(session) {
    if (!session || !(session.used || session.totalTokens || session.modelCalls || session.inputTokens)) return "";
    const cached = session.cachedReadTokens
      ? ` <span class="muted">(${formatInt(session.cachedReadTokens)} ${escapeHtml(tt("cached", "cached"))})</span>`
      : "";
    const reasoning = session.reasoningTokens
      ? ` <span class="muted">(${formatInt(session.reasoningTokens)} ${escapeHtml(tt("reasoning", "reasoning"))})</span>`
      : "";
    const rows = [];
    if (session.inputTokens != null) rows.push(usageRow(tt("inputTokens", "Input tokens"), `${formatInt(session.inputTokens)}${cached}`));
    if (session.outputTokens != null) rows.push(usageRow(tt("outputTokens", "Output tokens"), `${formatInt(session.outputTokens)}${reasoning}`));
    if (session.totalTokens != null || session.used != null) {
      rows.push(usageRow(tt("totalTokens", "Total tokens"), formatInt(session.totalTokens ?? session.used)));
    }
    if (session.modelCalls != null || session.apiDurationMs != null) {
      const calls = session.modelCalls != null ? formatInt(session.modelCalls) : "—";
      const apiTime = session.apiDurationMs != null
        ? ` · ${escapeHtml(tt("apiTime", "API time"))} ${formatApiDuration(session.apiDurationMs)}`
        : "";
      rows.push(usageRow(tt("modelCalls", "Model calls"), `${calls}${apiTime}`));
    }
    if (session.costUsd != null) rows.push(usageRow(tt("cost", "Cost"), formatUsd(session.costUsd)));
    return rows.join("");
  }

  function renderUsage(data) {
    if (data?.manageUrl) lastUsageManageUrl = data.manageUrl;

    if (!data || (!data.ok && !data.session && !data.plan)) {
      const localSessionHtml = sessionUsageHtml(lastSessionInfo?.context);
      eachUsage(".js-usage-session-rows", (el) => {
        el.innerHTML = localSessionHtml;
      });
      eachUsage(".js-usage-session-empty", (el) => {
        el.classList.toggle("hidden", Boolean(localSessionHtml));
        el.textContent = tt("noSessionUsage", "No model calls yet.");
      });
      eachUsage(".js-usage-plan-rows", (el) => {
        el.innerHTML = "";
      });
      eachUsage(".js-usage-plan-pct", (el) => {
        el.textContent = "—";
      });
      setUsagePlanBar(null);
      eachUsage(".js-usage-meta", (el) => {
        el.classList.add("error");
        el.textContent = data?.error || "Could not load usage.";
      });
      return;
    }

    const s = data.session;
    const hasSession = s && (s.totalTokens || s.modelCalls || s.inputTokens);
    eachUsage(".js-usage-session-empty", (el) => {
      el.classList.toggle("hidden", Boolean(hasSession));
    });
    if (hasSession) {
      const html = sessionUsageHtml(s);
      eachUsage(".js-usage-session-rows", (el) => {
        el.innerHTML = html;
      });
    } else {
      eachUsage(".js-usage-session-rows", (el) => {
        el.innerHTML = "";
      });
      eachUsage(".js-usage-session-empty", (el) => {
        el.textContent =
          tt("noSessionUsage", "No model calls in this session yet.") +
          " " +
          tt("connectToTrack", "Connect and chat to accumulate session usage.");
      });
    }

    const plan = data.plan || data.billing || {};
    const pct = plan.creditUsagePercent != null ? Number(plan.creditUsagePercent) : null;
    const limitLabel = plan.limitLabel || tt("planLimit", "Plan limit");
    eachUsage(".js-usage-plan-title", (el) => {
      el.textContent = limitLabel;
    });
    eachUsage(".js-usage-plan-pct", (el) => {
      if (pct != null) {
        const pctText =
          Math.abs(pct - Math.round(pct)) < 0.05 ? String(Math.round(pct)) : String(pct);
        el.textContent = `${pctText}%`;
      } else el.textContent = "—";
    });
    setUsagePlanBar(pct);
    {
      const rows = [];
      // SuperGrok weekly: show % used (matches CLI /usage "Weekly limit: N%")
      if (pct != null) {
        rows.push(
          usageRow(
            tt("usedOf", "used"),
            `${escapeHtml(String(Math.abs(pct - Math.round(pct)) < 0.05 ? Math.round(pct) : pct))}%`,
          ),
        );
      }
      if (plan.nextReset || plan.billingPeriodEnd) {
        rows.push(
          usageRow(
            tt("nextReset", "Next reset"),
            escapeHtml(formatResetDate(plan.nextReset || plan.billingPeriodEnd)),
          ),
        );
      }
      // Per-product breakdown (e.g. Grok Build 4%) — same as account UI
      for (const p of plan.productUsage || []) {
        if (p.usagePercent == null && !p.label) continue;
        const pp =
          p.usagePercent != null
            ? Math.abs(p.usagePercent - Math.round(p.usagePercent)) < 0.05
              ? Math.round(p.usagePercent)
              : p.usagePercent
            : "—";
        rows.push(usageRow(p.label || p.product || "Product", `${escapeHtml(String(pp))}%`));
      }
      if (data.account?.subscriptionTier) {
        rows.push(usageRow(tt("plan", "Plan"), escapeHtml(data.account.subscriptionTier)));
      }
      // Absolute monthly credits only when API provides them (not SuperGrok weekly format)
      if (plan.used != null && plan.monthlyLimit != null) {
        rows.push(
          usageRow(
            tt("credits", "Credits"),
            `${formatCredits(plan.used)} / ${formatCredits(plan.monthlyLimit)}` +
              (plan.remaining != null
                ? ` <span class="muted">(${formatCredits(plan.remaining)} ${escapeHtml(tt("left", "left"))})</span>`
                : ""),
          ),
        );
      }
      if (plan.onDemandCap != null && Number(plan.onDemandCap) > 0) {
        rows.push(
          usageRow(
            "Pay-as-you-go",
            `${formatCredits(plan.onDemandUsed ?? 0)} / ${formatCredits(plan.onDemandCap)}`,
          ),
        );
      }
      if (!rows.length && data.error) {
        rows.push(usageRow(tt("planLimit", "Plan limit"), escapeHtml(data.error)));
      }
      const planHtml = rows.join("");
      eachUsage(".js-usage-plan-rows", (el) => {
        el.innerHTML = planHtml;
      });
    }

    const parts = [];
    if (data.session?.sessionId) parts.push(`Session ${String(data.session.sessionId).slice(0, 8)}…`);
    if (data.account?.email) parts.push(data.account.email);
    if (data.fetchedAt) parts.push(new Date(data.fetchedAt).toLocaleTimeString());
    const metaText = data.error && !data.plan ? data.error : parts.join(" · ");
    eachUsage(".js-usage-meta", (el) => {
      el.classList.toggle("error", Boolean(data.error && !data.plan));
      el.textContent = metaText;
    });
  }

  async function refreshUsage() {
    eachUsage(".js-usage-meta", (el) => {
      el.classList.remove("error");
      el.textContent = tt("loading", "Loading…");
    });
    document.querySelectorAll(".js-refresh-usage, #btnRefreshUsage").forEach((btn) => {
      btn.disabled = true;
    });
    try {
      if (!api.getUsage) {
        renderUsage({ ok: false, error: "Update app — getUsage IPC missing." });
        return;
      }
      const data = await api.getUsage();
      renderUsage(data);
    } catch (e) {
      renderUsage({ ok: false, error: e.message || String(e) });
    } finally {
      document.querySelectorAll(".js-refresh-usage, #btnRefreshUsage").forEach((b) => {
        b.disabled = false;
      });
    }
  }

  async function saveSettingsForm() {
    showReasoning = Boolean($("chkShowReasoning")?.checked);
    const settings = connectOpts();
    settings.showReasoning = showReasoning;
    settings.telemetryOptIn = Boolean($("chkTelemetry")?.checked);
    settings.theme = $("selTheme")?.value || "system";
    settings.updateUrl = $("inpUpdateUrl")?.value?.trim() || "";
    settings.idePath = $("inpIdePath")?.value?.trim() || "";
    const res = await api.saveSettings(settings);
    bootstrap = { ...bootstrap, ...settings };
    if (api.telemetrySetEnabled) {
      await api.telemetrySetEnabled(settings.telemetryOptIn);
    }
    applyTheme(settings.theme, res.shouldUseDarkColors);
    settingsModal.classList.add("hidden");
    addStep(tt("settingsSaved", "Settings saved. Agent options apply on next Connect."));
  }

  async function showTelemetrySummary() {
    const out = $("telemetryOut");
    if (!out || !api.telemetrySummary) return;
    try {
      const s = await api.telemetrySummary();
      const lines = [`enabled: ${s.enabled}`, `file: ${s.file || "—"}`, ""];
      for (const [k, m] of Object.entries(s.metrics || {})) {
        lines.push(
          `${k}: n=${m.count} p50=${m.p50 ?? "—"} p95=${m.p95 ?? "—"} max=${m.max ?? "—"}`,
        );
      }
      out.classList.remove("hidden");
      out.textContent = lines.join("\n");
    } catch (e) {
      out.classList.remove("hidden");
      out.textContent = e.message || String(e);
    }
  }

  let authProfile = { loggedIn: false };
  let profileMenuOpen = false;

  function closeProfileMenu() {
    profileMenuOpen = false;
    const menu = $("profileMenu");
    const btn = $("btnProfile");
    if (menu) menu.classList.add("hidden");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function openProfileMenu() {
    profileMenuOpen = true;
    const menu = $("profileMenu");
    const btn = $("btnProfile");
    if (menu) menu.classList.remove("hidden");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  function applyAuthProfile(profile) {
    authProfile = profile || {
      loggedIn: false,
      codingDataRetentionOptOut: null,
      imagineVideoBlocked: false,
      imagineVideoReady: false,
    };
    if (bootstrap) bootstrap.auth = authProfile;
    const btn = $("btnProfile");
    const nameEl = $("profileName");
    const subEl = $("profileSub");
    const av = $("profileAvatar");
    const emailEl = $("menuEmail");
    const caret = $("profileCaret");
    const loggedIn = Boolean(authProfile.loggedIn);
    if (btn) btn.dataset.loggedIn = loggedIn ? "true" : "false";
    if (loggedIn) {
      const full = [authProfile.firstName, authProfile.lastName].filter(Boolean).join(" ");
      const display = full || authProfile.displayName || "Account";
      if (nameEl) nameEl.textContent = display;
      if (subEl) subEl.textContent = authProfile.email || "Signed in";
      if (av) {
        const initials =
          [authProfile.firstName, authProfile.lastName]
            .filter(Boolean)
            .map((s) => s[0])
            .join("")
            .slice(0, 2)
            .toUpperCase() ||
          (authProfile.email || "G")[0].toUpperCase();
        av.textContent = initials || "G";
      }
      if (emailEl) emailEl.textContent = authProfile.email || "(no email in auth.json)";
      if (caret) caret.classList.remove("hidden");
    } else {
      if (nameEl) nameEl.textContent = "Login";
      if (subEl) subEl.textContent = "Sign in to Grok";
      if (av) av.textContent = "G";
      if (emailEl) emailEl.textContent = "—";
      if (caret) caret.classList.add("hidden");
      closeProfileMenu();
    }
    updateSettingsAuthHint(authProfile);
  }

  async function refreshAuthProfile() {
    try {
      const p = await api.getAuthProfile();
      applyAuthProfile(p);
      return p;
    } catch (e) {
      applyAuthProfile({ loggedIn: false, error: e.message || String(e) });
      return authProfile;
    }
  }

  async function doLogin() {
    closeProfileMenu();
    const nameEl = $("profileName");
    const subEl = $("profileSub");
    if (nameEl) nameEl.textContent = "Signing in…";
    if (subEl) subEl.textContent = "Browser / device code";
    try {
      const res = await api.login();
      applyAuthProfile(res.profile || (await api.getAuthProfile()));
      if (res.profile?.loggedIn || res.ok) {
        addStep(`Signed in${res.profile?.email ? `: ${res.profile.email}` : ""}`);
      } else {
        addMsg(
          "error",
          (res.stderr || res.stdout || "Login did not complete").slice(0, 400) +
            "\nTip: run `grok login` in a terminal if the browser flow stalls.",
        );
        await refreshAuthProfile();
      }
    } catch (e) {
      addMsg("error", e.message || String(e));
      await refreshAuthProfile();
    }
  }

  async function doLogout() {
    closeProfileMenu();
    if (!confirm("Sign out and clear Grok CLI credentials on this machine?")) return;
    try {
      const res = await api.logout();
      applyAuthProfile(res.profile || { loggedIn: false });
      addStep("Signed out");
      try {
        await api.disconnect();
        setStatus("disconnected");
      } catch {
        // ignore
      }
    } catch (e) {
      addMsg("error", e.message || String(e));
      await refreshAuthProfile();
    }
  }

  let settingsTab = "general";

  function switchSettingsTab(tabId) {
    const raw = String(tabId || "general");
    // legacy tab ids from older builds / shortcuts
    const map = { environment: "project", behavior: "general" };
    const id = map[raw] || raw;
    settingsTab = id;
    document.querySelectorAll("#settingsNav .settings-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.settingsTab === id);
    });
    document.querySelectorAll("#settingsContent .settings-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.settingsPanel === id);
    });
    if (id === "usage") void refreshUsage();
  }

  function openSettings(tabId) {
    closeProfileMenu();
    loadSettingsForm();
    settingsModal.classList.remove("hidden");
    switchSettingsTab(tabId || settingsTab || "general");
    if (typeof GrokI18n !== "undefined") GrokI18n.applyDom();
    // Refresh privacy flags for Imagine video status (Account panel)
    void refreshAuthProfile();
  }

  function setupProfileUi() {
    const btn = $("btnProfile");
    if (!btn) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      if (!authProfile.loggedIn) {
        void doLogin();
        return;
      }
      if (profileMenuOpen) closeProfileMenu();
      else openProfileMenu();
    };
    $("menuSettings") && ($("menuSettings").onclick = () => openSettings());
    $("menuLogout") && ($("menuLogout").onclick = () => void doLogout());
    document.addEventListener("click", (e) => {
      if (!e.target.closest?.("#profileWrap")) closeProfileMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeProfileMenu();
    });
  }

  function mergeLiveModels(info, { notifyNew = false } = {}) {
    if (!info?.models?.length) return [];
    const prev = new Set((bootstrap?.models || []).map((m) => m.value));
    const list = normalizeModelChoices(info.models);
    const added = list.filter((m) => !prev.has(m.value)).map((m) => m.value);
    bootstrap = {
      ...bootstrap,
      models: list,
      defaultModel: info.defaultModel || bootstrap?.defaultModel,
    };
    const keep = selModel?.value || info.defaultModel;
    fillSelect(selModel, list, keep, "Model", { forceNoEmpty: true });
    seedEffortOptions(selEffort?.value);
    syncModelChip();
    if (notifyNew && added.length && prev.size) {
      paintCliBanner({
        kind: "models",
        message: tt("newModelsAdded", "New models: {models}").replace("{models}", added.join(", ")),
      });
    }
    return added;
  }

  function paintCliBanner(opts) {
    const banner = $("cliUpdateBanner");
    if (!banner) return;
    const kind = opts?.kind || "cli";
    const message = opts?.message || "";
    if (!message) {
      banner.classList.add("hidden");
      banner.innerHTML = "";
      return;
    }
    banner.classList.remove("hidden");
    const showUpdate = kind === "cli" && opts.updateAvailable !== false;
    banner.innerHTML =
      `<span class="cli-update-msg">${escapeHtml(message)}</span>` +
      (showUpdate
        ? `<button type="button" class="pill-btn accent" id="btnBannerUpdateCli">${escapeHtml(tt("updateCli", "Update Grok CLI"))}</button>`
        : `<button type="button" class="tab-x" id="btnBannerDismissCli" aria-label="Close">×</button>`);
    $("btnBannerUpdateCli")?.addEventListener("click", (e) => {
      e.preventDefault();
      void applyCliUpdate();
    });
    $("btnBannerDismissCli")?.addEventListener("click", (e) => {
      e.preventDefault();
      banner.classList.add("hidden");
    });
  }

  function applyCliStatusToSettings(status) {
    const hint = $("cliVersionHint");
    const updateHint = $("cliUpdateHint");
    const btn = $("btnUpdateCli");
    if (hint) {
      const ver = status?.currentVersion || bootstrap?.cliVersion || "";
      hint.textContent = ver
        ? `${tt("cliVersion", "Grok CLI")} ${ver}` +
          (status?.latestVersion && status.latestVersion !== ver
            ? ` · ${tt("cliLatest", "latest")} ${status.latestVersion}`
            : "")
        : tt("grokCliHint", "Resolved from PATH, ~/.grok/bin, or GROK_EXECUTABLE.");
    }
    if (btn) btn.classList.toggle("hidden", !status?.updateAvailable);
    if (updateHint) {
      if (status?.updateAvailable) {
        updateHint.textContent = tt("cliUpdateAvailable", "Grok CLI {latest} is available (you have {current})")
          .replace("{latest}", status.latestVersion || "")
          .replace("{current}", status.currentVersion || "");
      } else if (status?.currentVersion) {
        updateHint.textContent = tt("cliUpToDate", "Grok CLI is up to date ({version})").replace(
          "{version}",
          status.currentVersion,
        );
      } else {
        updateHint.textContent = "";
      }
    }
  }

  async function checkCliUpdates(opts = {}) {
    const quiet = Boolean(opts.quiet);
    if (!api.cliStatus) return null;
    try {
      const status = await api.cliStatus();
      if (status?.currentVersion && bootstrap) bootstrap.cliVersion = status.currentVersion;
      mergeLiveModels(status, { notifyNew: !quiet });
      applyCliStatusToSettings(status);
      if (status?.updateAvailable) {
        paintCliBanner({
          kind: "cli",
          updateAvailable: true,
          message: tt("cliUpdateAvailable", "Grok CLI {latest} is available (you have {current})")
            .replace("{latest}", status.latestVersion || "")
            .replace("{current}", status.currentVersion || ""),
        });
      } else if (!quiet) {
        paintCliBanner({
          kind: "info",
          updateAvailable: false,
          message: tt("cliUpToDate", "Grok CLI is up to date ({version})").replace(
            "{version}",
            status?.currentVersion || "—",
          ),
        });
      }
      return status;
    } catch (e) {
      if (!quiet) {
        paintCliBanner({
          kind: "info",
          updateAvailable: false,
          message: e?.message || String(e),
        });
      }
      return null;
    }
  }

  async function applyCliUpdate() {
    if (!api.updateCli) return;
    paintCliBanner({
      kind: "info",
      updateAvailable: false,
      message: tt("cliUpdating", "Updating Grok CLI…"),
    });
    const btn = $("btnUpdateCli");
    if (btn) btn.disabled = true;
    try {
      const res = await api.updateCli();
      if (bootstrap) bootstrap.cliVersion = res?.version || bootstrap.cliVersion;
      mergeLiveModels(res, { notifyNew: true });
      applyCliStatusToSettings({
        currentVersion: res?.version,
        latestVersion: res?.version,
        updateAvailable: false,
      });
      paintCliBanner({
        kind: "info",
        updateAvailable: false,
        message: res?.ok
          ? tt("cliUpdated", "Grok CLI updated to {version}").replace("{version}", res.version || "")
          : [res?.stderr, res?.stdout].filter(Boolean).join("\n").slice(0, 240) ||
            tt("cliUpdateFailed", "Grok CLI update failed"),
      });
      if (agentConnected) {
        addStep(tt("cliUpdatedReconnect", "CLI updated. Reconnect the agent to use the new version."));
      }
    } catch (e) {
      paintCliBanner({
        kind: "info",
        updateAvailable: false,
        message: e?.message || String(e),
      });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function checkUpdates(opts = {}) {
    // P2: empty URL → main tries local dist/latest.json
    const url = $("inpUpdateUrl")?.value?.trim() || bootstrap?.updateUrl || "";
    const banner = $("updateBanner");
    const quiet = Boolean(opts.quiet); // bootstrap: only show when update available
    try {
      const res = await api.checkUpdate(url);
      if (!banner) {
        if (!quiet) addStep(res.message || "Update check done");
        return res;
      }
      // Don't spam account footer with JSON/parse noise or "up to date" on every launch
      if (!res.ok) {
        if (quiet) {
          banner.classList.add("hidden");
          banner.textContent = "";
        } else {
          banner.classList.remove("hidden");
          banner.textContent = res.message || "Update check failed";
        }
        return res;
      }
      if (res.update && res.url) {
        banner.classList.remove("hidden");
        banner.innerHTML = `${escapeHtml(res.message)} · <a href="#" id="updLink">Download</a>`;
        $("updLink")?.addEventListener("click", (e) => {
          e.preventDefault();
          void api.openExternal(res.url);
        });
      } else if (quiet) {
        banner.classList.add("hidden");
        banner.textContent = "";
      } else {
        banner.classList.remove("hidden");
        banner.textContent = res.message || "No updates";
      }
      return res;
    } catch (e) {
      if (banner) {
        if (quiet) {
          banner.classList.add("hidden");
          banner.textContent = "";
        } else {
          banner.classList.remove("hidden");
          banner.textContent = e.message || String(e);
        }
      }
      return null;
    }
  }

  function renderAttachments() {
    if (!attachments.length) {
      attachBar.classList.add("hidden");
      attachBar.innerHTML = "";
      return;
    }
    attachBar.classList.remove("hidden");
    attachBar.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip";
      if (a.mimeType?.startsWith("image/") && a.data) {
        const img = document.createElement("img");
        img.className = "attach-thumb";
        img.src = `data:${a.mimeType};base64,${a.data}`;
        img.alt = a.name;
        chip.appendChild(img);
      }
      chip.appendChild(document.createTextNode(a.name + " "));
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.onclick = () => {
        attachments.splice(i, 1);
        renderAttachments();
      };
      chip.appendChild(x);
      attachBar.appendChild(chip);
    });
  }

  async function addImageFromBlob(blob, name) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const data = btoa(binary);
    const mimeType = blob.type || "image/png";
    attachments.push({
      uri: `clipboard://${name || "paste.png"}`,
      name: name || `paste-${Date.now()}.png`,
      mimeType,
      data,
    });
    renderAttachments();
  }

  function handleAgentEvent(event) {
    if (!event?.type) return;
    switch (event.type) {
      case "state": {
        const stateTab = sessionTabs?.getActive?.();
        if (stateTab && event.slotId && !stateTab.slotId) stateTab.slotId = event.slotId;
        const nextBusy = event.state === "running" || event.state === "starting";
        // While a turn is live, prefer phase-aware running label over generic "Working…"
        if (
          event.state === "running" &&
          turnPhase &&
          turnPhase !== "idle" &&
          turnPhase !== "done" &&
          turnPhase !== "error"
        ) {
          setStatus("running", phaseLabel(turnPhase));
        } else {
          setStatus(event.state, event.detail);
        }
        busy = nextBusy;
        sessionTabs?.setBusy?.(sessionTabs.activeId, busy);
        if (event.state === "running" && !turnStartedAt) {
          turnStartedAt = Date.now();
          if (activityId == null && turnPhase === "idle") beginTurnActivity();
        }
        if (event.state === "connected" || event.state === "running") {
          agentConnected = true;
          void refreshAgentSlots();
        }
        if (event.state === "disconnected") {
          agentConnected = false;
          agentWorkspace = null;
          void refreshAgentSlots();
          if (activityId != null && turnPhase !== "done") {
            endTurnActivity({ error: true });
          }
        }
        break;
      }
      case "context": {
        if (typeof event.showReasoning === "boolean" && event.showReasoning !== showReasoning) {
          showReasoning = event.showReasoning;
          if ($("chkShowReasoning")) $("chkShowReasoning").checked = showReasoning;
          timelineView?.relocalize?.();
        }
        break;
      }
      case "slot_active":
        void refreshAgentSlots();
        break;
      case "assistant_delta":
        appendAssistant(event.text || "");
        break;
      case "thought_delta":
        appendThought(event.text || "");
        break;
      case "reconnect":
        setTurnPhase("reconnect");
        addStep(event.message || tt("phaseReconnect", "Reconnecting…"));
        break;
      case "session_config":
        applySessionConfig(event.options);
        break;
      case "session_modes":
        applySessionModes(event);
        break;
      case "current_mode":
        if (selMode && event.currentModeId) {
          applyingConfig = true;
          selMode.value = event.currentModeId;
          applyingConfig = false;
          syncModeChip();
        }
        break;
      case "usage":
      case "token_usage":
        updateUsage(event);
        break;
      case "plan":
        if (event.entries?.length) {
          planDock.classList.remove("hidden");
          planDock.innerHTML = `<strong>Plan</strong><ol>${event.entries
            .map((e) => `<li>${escapeHtml(e.content)} — ${escapeHtml(e.status)}</li>`)
            .join("")}</ol>`;
          // Phase C2 — keep latest plan as artifact (debounced replace by title)
          void api.artifactsAdd?.({
            type: "plan",
            title: `Plan · ${basen(workspaceRoot) || "session"}`,
            content: event.entries
              .map((e) => `- [${e.status}] ${e.content}`)
              .join("\n"),
            meta: { sessionId: activeSessionId, live: true },
          });
        }
        break;
      case "tool":
      case "tool_update": {
        // CLI-like: each tool is its own expandable row (◇ Read… / Edit…)
        const rawTitle = String(event.title || "").trim();
        const title = !rawTitle || /^(?:tool|tools)$/i.test(rawTitle)
          ? tt("labelTools", "Tools")
          : rawTitle;
        const status = event.status || (event.type === "tool" ? "running" : "done");
        const toolId = event.toolCallId || event.id || title;
        const diffs = event.diffs || [];
        const diff0 = diffs[0];
        upsertToolInGroup({
          toolId,
          title,
          status,
          kind: event.kind || event.toolKind || "",
          detail: event.detail || event.content || event.output || "",
          path: diff0?.path,
          oldText: diff0?.oldText,
          newText: diff0?.newText,
          diffs,
          locations: event.locations,
        });
        for (const d of diffs) {
          if (d.path) addReview({ path: d.path, oldText: d.oldText, newText: d.newText });
        }
        break;
      }
      case "workspace_edit":
        if (event.path) {
          sealLiveStreams();
          addReview({
            path: event.path,
            oldText: event.oldText,
            newText: event.newText,
          });
          void openInEditor(event.path);
          void refreshGitStrip();
        }
        break;
      case "permission_request": {
        // Phase B5 — inline card (main no longer uses native dialog)
        sealLiveStreams();
        clearEmpty();
        setTurnPhase("permission");
        eventStore.append("permission", event.title || tt("phasePermission", "Waiting for permission"), {
          requestId: event.requestId,
          kind: event.kind || "",
          options: event.options || [],
          resolved: false,
        });
        scrollEnd();
        break;
      }
      case "permission_resolved": {
        const item = eventStore.findLast?.(
          (it) => it.kind === "permission" && it.meta?.requestId === event.requestId,
        );
        if (item && !item.meta?.resolved) {
          eventStore.update(item.id, {
            meta: {
              resolved: true,
              resultLabel: event.cancelled
                ? tt("labelCancelled", "Cancelled")
                : tt("labelResolved", "Resolved"),
            },
          });
        }
        if (busy) setTurnPhase("waiting");
        break;
      }
      case "error":
        addMsg("error", event.message || tt("error", "Error"));
        if (busy || activityId != null) {
          busy = false;
          endTurnActivity({ error: true });
        }
        sessionTabs?.setBusy?.(sessionTabs.activeId, false);
        break;
      case "turn_complete": {
        streamBatcher?.flushNow?.();
        resetAssistant();
        closeOpenToolGroup();
        busy = false;
        endTurnActivity();
        sessionTabs?.setBusy?.(sessionTabs.activeId, false);
        // Always jump to latest answer (below tools), not mid-tool stack
        requestAnimationFrame(() => {
          scrollEnd(true);
        });
        void drainQueue();
        void refreshHistory();
        setTimeout(() => void refreshHistory(), 1600);
        void refreshSessionInfo();
        break;
      }
      case "model_catalog":
        applyModelCatalog(event);
        break;
      case "session":
        activeSessionId = event.sessionId || activeSessionId;
        if (!$("menuUsage")?.classList.contains("hidden")) void refreshSessionInfo();
        sessionTabs?.updateActive?.({
          sessionId: activeSessionId,
          slotId: event.slotId || sessionTabs.getActive()?.slotId || null,
          title: event.resumed
            ? sessionTabs.getActive()?.title || "Resumed"
            : sessionTabs.getActive()?.title || "Chat",
          cwd: workspaceRoot || effectiveWorkspace() || null,
        });
        {
          const sessionTab = sessionTabs?.getActive?.();
          if (sessionTab?.manualTitlePending && activeSessionId && api.renameSession) {
            sessionTab.manualTitlePending = false;
            void api.renameSession(activeSessionId, sessionTab.title).catch(() => {
              sessionTab.manualTitlePending = true;
            });
          }
        }
        if (event.resumed) {
          if (activeSessionId) void paintTranscript(activeSessionId).then(() => unlockChatInput());
        }
        syncConvTitle();
        void refreshHistory();
        unlockChatInput();
        break;
      case "clear_conversation":
        if (event.reason === "resume") break;
        resetTimeline();
        editCount = 0;
        reviews = [];
        renderReviewList();
        planDock.classList.add("hidden");
        showEmpty();
        unlockChatInput();
        break;
      default:
        break;
    }
  }

  function cacheInactiveAgentEvent(tab, event) {
    if (!tab || !event) return;
    let needsRender = false;
    if (event.type === "state") {
      const running = event.state === "running" || event.state === "starting";
      tab.busy = running;
      if (running && !tab.turnStartedAt) tab.turnStartedAt = Date.now();
      if (!running && (event.state === "connected" || event.state === "disconnected" || event.state === "error")) {
        tab.turnPhase = event.state === "error" ? "error" : "done";
      }
      needsRender = true;
    } else if (event.type === "turn_complete" || event.type === "error") {
      tab.busy = false;
      tab.turnPhase = event.type === "error" ? "error" : "done";
      needsRender = true;
    } else if (event.type === "session" && event.sessionId) {
      tab.sessionId = event.sessionId;
      needsRender = true;
    } else if (event.type === "thought_delta") {
      tab.turnPhase = "thinking";
    } else if (event.type === "assistant_delta") {
      tab.turnPhase = "responding";
    } else if (event.type === "tool" || event.type === "tool_update") {
      tab.turnPhase = "tools";
    } else if (event.type === "permission_request") {
      tab.turnPhase = "permission";
    }
    sessionTabs?.queueEvent?.(tab.id, { ...event });
    if (needsRender) sessionTabs?.render?.();
  }

  api.onEvent((event) => {
    if (!event?.type) return;
    const activeTab = sessionTabs?.getActive?.();
    const owner = event.slotId ? sessionTabs?.findBySlot?.(event.slotId) : null;
    if (owner && activeTab && (owner !== activeTab || activeTab.activating)) {
      cacheInactiveAgentEvent(owner, event);
      return;
    }
    handleAgentEvent(event);
    captureTabRuntime(activeTab);
  });

  async function pickFolder() {
    const root = await api.pickWorkspace();
    if (root) {
      bootstrap = await api.getBootstrap();
      if (bootstrap?.recentsWorkspace) recentsWorkspace = bootstrap.recentsWorkspace;
    }
    return root;
  }

  async function connect(root, extraOpts) {
    try {
      // P2 — auth preflight (avoid opaque ACP fail when not signed in)
      try {
        const auth = await api.getAuthProfile();
        applyAuthProfile(auth || { loggedIn: false });
        if (!auth?.loggedIn) {
          setStatus("error", tt("signInRequired", "Sign in required"));
          addMsg(
            "error",
            tt(
              "signInBeforeConnect",
              "Sign in to Grok first (sidebar Login or Settings), then send a message or use Agent → Connect.",
            ),
          );
          try {
            $("btnProfile")?.focus();
          } catch {
            // ignore
          }
          return { ok: false, reason: "auth" };
        }
      } catch {
        // If profile probe fails, still try connect (offline path)
      }

      // Prefer explicit root; else open project; else Recents (no project — still chatable)
      let ws = root != null && String(root).trim() !== ""
        ? String(root).trim()
        : effectiveWorkspace();
      if (!ws) {
        // Bootstrap not ready — create path via connect empty string (main uses recents)
        ws = "";
      }
      // Keep UI project null when connecting to recents
      if (ws && !isRecentsPath(ws) && !samePath(ws, workspaceRoot)) {
        setWorkspace(ws);
      }
      setStatus("starting", tt("connecting", "Connecting…"));
      const launch = { ...connectOpts(), ...(extraOpts || {}) };
      const extraHint = extraRootsHint();
      if (extraHint) {
        launch.rules = [launch.rules, extraHint].filter(Boolean).join("\n\n");
      }
      const res = await api.connect(ws || "", launch);
      agentConnected = true;
      agentWorkspace = res?.workspace || ws || null;
      const askedRecents = !ws || isRecentsPath(ws);
      if (res?.isRecents && askedRecents) {
        // Only clear the UI project when we intentionally connected to Recents
        if (workspaceRoot) setWorkspace(null);
      } else if (res?.workspace && !isRecentsPath(res.workspace) && !samePath(res.workspace, workspaceRoot)) {
        setWorkspace(res.workspace);
      }
      // Warm reuse: status chip only — no noisy chat step
      if (res?.reused) {
        setStatus("connected", tt("readyWarm", "Ready"));
      } else {
        setStatus("connected", tt("connected", "Ready"));
      }
      syncConvTitle();
      void refreshHistory();
      void refreshAgentSlots();
      void refreshGitStrip();
      unlockChatInput();
      return { ok: true, reused: Boolean(res?.reused), isRecents: Boolean(res?.isRecents) };
    } catch (e) {
      agentConnected = false;
      agentWorkspace = null;
      setStatus("error", e.message || String(e));
      addMsg("error", e.message || String(e));
      unlockChatInput();
      return { ok: false, reason: "error", error: e };
    }
  }

  function openSessionInfoPopover(tab) {
    closeAllChipMenus?.();
    const menu = $("menuUsage");
    const btn = $("btnUsage");
    if (menu) {
      menu.classList.remove("hidden");
      btn?.setAttribute("aria-expanded", "true");
    }
    activateSessionInfoTab(tab === "context" || tab === "account" ? tab : "session");
    void refreshSessionInfo();
    void refreshUsage();
    return true;
  }

  function applySlashSelect(sel, value) {
    if (!sel || value == null) return false;
    const raw = String(value).trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    const match = [...sel.options].find((option) => {
      const v = String(option.value || "").toLowerCase();
      const label = String(option.textContent || "").toLowerCase();
      return v === lower || label === lower || v.startsWith(lower) || label.includes(lower);
    });
    if (!match?.value) return false;
    sel.value = match.value;
    void onConfigChange(sel);
    return true;
  }

  function lastAssistantText() {
    const item = eventStore.findLast?.(
      (it) => it.kind === "assistant" && String(it.text || "").trim(),
    );
    return item ? String(item.text || "").trim() : "";
  }

  async function copyLastAssistantReply() {
    const text = lastAssistantText();
    if (!text) {
      addStep(tt("noReplyToCopy", "No assistant reply to copy yet."));
      return true;
    }
    if (api.writeClipboardText) await api.writeClipboardText(text);
    addStep(tt("copiedReply", "Copied last reply"));
    return true;
  }

  async function exportActiveChat() {
    if (!activeSessionId) return false;
    const mdText = await api.exportSession(activeSessionId);
    await api.saveExport(mdText, `${String(activeSessionId).slice(0, 8)}.md`);
    addStep("Session exported");
    return true;
  }

  async function renameActiveChat(arg, targetTab) {
    const tab = targetTab || sessionTabs?.getActive?.();
    if (!tab) return false;
    const requested = String(arg || "").trim();
    const title =
      requested ||
      window.prompt(tt("renamePrompt", "New chat title"), tab.title || "");
    if (!title) {
      addStep(tt("renameNeedTitle", "Type /rename <title> or /rename --auto"));
      return true;
    }
    const res = tab.sessionId && api.renameSession
      ? await api.renameSession(tab.sessionId, title)
      : { title };
    const next = res?.title || title;
    sessionTabs?.updateTab?.(tab.id, {
      title: next,
      manualTitlePending: !tab.sessionId,
    });
    if (sessionTabs?.getActive?.() === tab) syncConvTitle(next);
    void refreshHistory();
    addStep(`/rename ${res?.auto ? "--auto" : next}`);
    return true;
  }

  async function deleteActiveChat() {
    if (!activeSessionId) return false;
    const title = convTitle?.textContent || activeSessionId;
    if (!confirm(`Delete session ${title}?`)) return true;
    await api.deleteSession(activeSessionId);
    addStep(tt("deletedChat", "Chat deleted"));
    await newChatTab(true);
    void refreshHistory();
    return true;
  }

  function runSlashUiAction(action, arg) {
    if (action === "new") {
      $("btnNew")?.click();
      return true;
    }
    if (action === "session-info") return openSessionInfoPopover("session");
    if (action === "context") return openSessionInfoPopover("context");
    if (action === "usage") {
      openSettings("usage");
      return true;
    }
    if (action === "settings") {
      openSettings("general");
      return true;
    }
    if (action === "privacy") {
      openSettings("account");
      return true;
    }
    if (action === "marketplace") {
      setPanelVisible(true);
      switchPanel("tools");
      switchToolsTab("marketplace");
      void refreshMarketplaceCatalog?.();
      return true;
    }
    if (action === "plugins" || action === "skills") {
      setPanelVisible(true);
      switchPanel("tools");
      switchToolsTab("plugins");
      return true;
    }
    if (action === "mcps") {
      setPanelVisible(true);
      switchPanel("tools");
      switchToolsTab("mcp");
      return true;
    }
    if (action === "copy") {
      void copyLastAssistantReply();
      return true;
    }
    if (action === "export") {
      void exportActiveChat();
      return true;
    }
    if (action === "rename") {
      void renameActiveChat(arg);
      return true;
    }
    if (action === "delete") {
      void deleteActiveChat();
      return true;
    }
    if (action === "model") {
      if (!applySlashSelect(selModel, arg)) $("btnModel")?.click();
      return true;
    }
    if (action === "effort") {
      if (!applySlashSelect(selEffort, arg)) $("btnEffort")?.click();
      return true;
    }
    if (action === "plan") {
      setPermissionValue("plan");
      return true;
    }
    if (action === "always-approve") {
      setPermissionValue("bypassPermissions");
      return true;
    }
    if (action === "auto") {
      setPermissionValue("auto");
      return true;
    }
    if (action === "login") {
      void doLogin?.();
      return true;
    }
    if (action === "logout") {
      void doLogout?.();
      return true;
    }
    if (action === "docs") {
      void api.openExternal?.("https://docs.x.ai/build/overview");
      addStep(tt("docsOpened", "Opened Grok Build docs"));
      return true;
    }
    if (action === "changelog") {
      void api.openExternal?.("https://x.ai/build/changelog");
      addStep(tt("changelogOpened", "Opened Grok Build changelog"));
      return true;
    }
    if (action === "doctor") {
      void runCli(["doctor"]);
      return true;
    }
    if (action === "resume" || action === "history") {
      $("btnHistory")?.click();
      return true;
    }
    if (action === "dashboard" || action === "workflows") {
      setPanelVisible(true);
      switchPanel("manager");
      return true;
    }
    if (action === "view-plan") {
      setPanelVisible(true);
      switchPanel("artifacts");
      return true;
    }
    if (action === "fork") {
      void forkParallelAgent();
      return true;
    }
    if (action === "quit") {
      if (confirm(tt("quitConfirm", "Quit Grok Build Desktop?"))) void api.quitApp?.();
      return true;
    }
    if (action === "home") {
      void openProjectTab(null);
      return true;
    }
    if (
      action === "hooks" ||
      action === "hooks-list" ||
      action === "hooks-add" ||
      action === "hooks-remove"
    ) {
      setPanelVisible(true);
      switchPanel("tools");
      switchToolsTab("mcp");
      void refreshFolderTrustUi();
      if (action === "hooks-list") void runCli(["inspect"]);
      if (action === "hooks-add" || action === "hooks-remove") void openProjectHooksDir();
      return true;
    }
    if (action === "hooks-trust") {
      void setProjectFolderTrust(true);
      return true;
    }
    if (action === "hooks-untrust") {
      void setProjectFolderTrust(false);
      return true;
    }
    if (action === "theme") {
      const want = String(arg || "").trim().toLowerCase();
      if (want === "light" || want === "dark" || want === "system") {
        void api.setTheme(want).then((res) => {
          applyTheme(want, res?.shouldUseDarkColors);
          if (bootstrap) bootstrap.theme = want;
        });
      } else {
        void toggleTheme();
      }
      return true;
    }
    if (action === "tutorial") {
      void api.openExternal?.("https://docs.x.ai/build/overview");
      addStep(tt("docsOpened", "Opened Grok Build docs"));
      return true;
    }
    if (action === "import-claude") {
      openSettings("general");
      addStep(
        tt(
          "importClaudeHint",
          "Claude import is a Grok TUI modal (Ctrl+I). Desktop cannot run that wizard — open Grok CLI to import ~/.claude settings.",
        ),
      );
      return true;
    }
    if (action === "config-agents") {
      openSettings("agent");
      return true;
    }
    if (action === "timestamps") {
      toggleLayoutFlag(
        "showTimestamps",
        { key: "timestampsOn", fallback: "Message timestamps on" },
        { key: "timestampsOff", fallback: "Message timestamps off" },
      );
      return true;
    }
    if (action === "compact-mode") {
      toggleLayoutFlag(
        "compactMode",
        { key: "compactOn", fallback: "Compact layout on" },
        { key: "compactOff", fallback: "Compact layout off" },
      );
      return true;
    }
    if (action === "multiline") {
      toggleLayoutFlag(
        "composerMultiline",
        { key: "multilineOn", fallback: "Multiline: Enter inserts a newline, Ctrl+Enter sends" },
        { key: "multilineOff", fallback: "Enter sends the message" },
      );
      return true;
    }
    return false;
  }

  function slotIsRunning(slot) {
    return slot?.state === "running" || slot?.state === "starting";
  }

  async function ensureActiveTabAgent() {
    const tab = sessionTabs?.getActive?.();
    if (!tab) throw new Error("No active chat tab.");
    const cwd = tab.cwd || effectiveWorkspace() || "";
    const state = await api.agentSlots?.();
    const slots = Array.isArray(state?.slots) ? state.slots : [];
    let slot = tab.slotId ? slots.find((item) => item.id === tab.slotId) : null;

    if (
      slot &&
      slot.warm &&
      (!tab.sessionId || !slot.sessionId || slot.sessionId === tab.sessionId)
    ) {
      await api.setActiveAgentSlot?.(slot.id);
      if (!tab.sessionId && slot.sessionId) {
        tab.sessionId = slot.sessionId;
        activeSessionId = slot.sessionId;
      }
      agentConnected = true;
      agentWorkspace = slot.workspace || cwd || null;
      return slot;
    }

    if (slot && slotIsRunning(slot)) {
      throw new Error(tt("tabSessionMismatch", "This tab's agent is still busy with another session."));
    }

    // Reuse only a stopped slot. Running slots belong to their current tabs and
    // must not be resumed/replaced as a side effect of sending elsewhere.
    if (!slot) {
      slot = slots.find((item) => !slotIsRunning(item));
    }

    if (!slot && slots.length < Number(state?.maxSlots || 2)) {
      const launch = {
        ...connectOpts(),
        ...(tab.sessionId ? { resumeSessionId: tab.sessionId } : {}),
      };
      const spawned = await api.spawnAgentSlot?.(cwd, launch, tab.title || "Parallel chat");
      if (!spawned?.slotId) {
        throw new Error(tt("connectFailed", "Could not connect agent."));
      }
      tab.slotId = spawned?.slotId || null;
      tab.sessionId = spawned?.sessionId || tab.sessionId || null;
      activeSessionId = tab.sessionId;
      if (tab.slotId) await api.setActiveAgentSlot?.(tab.slotId);
      agentConnected = true;
      agentWorkspace = cwd || null;
      sessionTabs?.render?.();
      return { id: tab.slotId, warm: true, workspace: cwd, sessionId: tab.sessionId };
    }

    if (!slot) {
      throw new Error(
        tt("allTabAgentsBusy", "Two chats are already running. Wait for one to finish before starting another."),
      );
    }

    const previousOwner = sessionTabs?.findBySlot?.(slot.id);
    if (previousOwner && previousOwner !== tab) previousOwner.slotId = null;
    tab.slotId = slot.id;
    await api.setActiveAgentSlot?.(slot.id);

    let sessionId = tab.sessionId || null;
    if (sessionId) {
      await api.loadSession(sessionId, cwd, connectOpts());
    } else if (slot.warm) {
      const created = await api.newSession();
      sessionId = created?.sessionId || null;
    } else {
      const connected = await connect(cwd);
      if (!connected?.ok) throw connected?.error || new Error(tt("connectFailed", "Could not connect agent."));
      const refreshed = await api.agentSlots?.();
      sessionId = refreshed?.slots?.find?.((item) => item.id === slot.id)?.sessionId || null;
    }

    tab.sessionId = sessionId;
    activeSessionId = sessionId;
    agentConnected = true;
    agentWorkspace = cwd || null;
    sessionTabs?.render?.();
    return { ...slot, warm: true, workspace: cwd, sessionId };
  }

  async function send() {
    let text = prompt.value.trim();
    const sendTab = sessionTabs?.getActive?.();
    if ((!text && !attachments.length) || (sendTab?.drainingQueue ?? drainingQueue)) return;
    hideSlashMenu();
    hideMentionMenu();

    // Slash: UI commands or expand /imagine into agent prompt
    const slash = globalThis.GrokSlashCommands;
    let displayText = text;
    if (text && slash?.resolveSlash) {
      // Fresh privacy flags for Imagine video preflight
      const parsedSlash = slash.parseLeadingSlash?.(text);
      if (parsedSlash?.id === "imagine-video") {
        try {
          await refreshAuthProfile();
        } catch {
          /* ignore */
        }
      }
      const slashCtx = {
        codingDataRetentionOptOut: authProfile?.codingDataRetentionOptOut,
        imagineVideoBlocked: Boolean(authProfile?.imagineVideoBlocked),
      };
      const resolved = slash.resolveSlash(text, slashCtx);
      if (resolved.kind === "ui") {
        prompt.value = "";
        autoSize();
        runSlashUiAction(resolved.action, resolved.arg);
        return;
      }
      if (resolved.kind === "prompt") {
        displayText = text; // show what user typed
        text = resolved.text;
        // Surface privacy block early so user doesn't wait a full failed video turn
        if (
          resolved.id === "imagine-video" &&
          (authProfile?.imagineVideoBlocked ||
            authProfile?.codingDataRetentionOptOut === true)
        ) {
          addStep(
            "Imagine video: privacy is Opt out — video API will fail until Grok /privacy → Opt in (then re-login). Still sending so agent can deliver a still frame.",
          );
        }
      }
    }

    const atts = attachments.map((a) => ({
      uri: a.uri,
      name: a.name,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      ...(a.data ? { data: a.data } : {}),
    }));
    prompt.value = "";
    autoSize();
    attachments = [];
    renderAttachments();

    if (busy) {
      (sendTab?.promptQueue || promptQueue).push({ text, attachments: atts, displayText });
      updateQueueBar();
      addStep(`Queued: ${(displayText || text).slice(0, 48) || "(attachment)"}${(displayText || text).length > 48 ? "…" : ""}`);
      return;
    }

    // Bind only at send time. A pure tab click never resumes/replaces a
    // session, while a second running tab receives a separate ACP slot.
    try {
      await ensureActiveTabAgent();
    } catch (e) {
      addMsg("error", e?.message || String(e));
      return;
    }

    if (displayText || text) {
      clearEmpty();
      eventStore.append("user", displayText || text, {
        attachments: atts.map((a) => ({
          name: a.name,
          mimeType: a.mimeType,
          data: a.data,
        })),
      });
      scrollEnd(true);
    }
    // Title tab from first user line
    if ((displayText || text) && sessionTabs?.getActive?.()) {
      const t = sessionTabs.getActive();
      const titleSrc = displayText || text;
      if (!t.title || t.title === "Chat" || t.title === "New chat" || t.title === "New conversation") {
        sessionTabs.updateActive({ title: titleSrc.slice(0, 28) + (titleSrc.length > 28 ? "…" : "") });
      }
    }
    resetAssistant();
    turnStartedAt = Date.now();
    busy = true;
    beginTurnActivity();
    sessionTabs?.updateActive?.({
      busy: true,
      turnPhase,
      turnStartedAt,
      phaseStartedAt,
      lastUsageFooter,
    });
    try {
      await api.prompt(text, atts);
    } catch (e) {
      busy = false;
      endTurnActivity({ error: true });
      // If agent dropped, offer reconnect path via status
      if (/not connected/i.test(String(e?.message || e))) {
        agentConnected = false;
        setStatus("disconnected");
      }
      addMsg("error", e.message || String(e));
    }
  }

  function autoSize() {
    // No-op: inline height resize was collapsing/disabling the chat box.
    // CSS fixed min-height handles layout; overflow-y scrolls long text.
    if (prompt) prompt.style.height = "";
  }

  function setCliOut(text) {
    const code = $("cliOut")?.querySelector("code");
    if (code) code.textContent = text;
  }

  async function runCli(args) {
    switchPanel("tools");
    const label = Array.isArray(args) ? args.join(" ") : String(args);
    if (args[0] === "login") {
      setCliOut(
        `$ grok login\n${tt("loginStarting", "Starting sign-in…")}\n`,
      );
    } else {
      setCliOut(`$ grok ${label}\n…`);
    }
    try {
      const r = await api.runCli(args);
      const body = [r.stdout, r.stderr].filter(Boolean).join("\n") || tt("noOutput", "(no output)");
      setCliOut(`$ grok ${label}\n` + body);
      if (args[0] === "login" && r.code && r.code !== 0) {
        addMsg(
          "error",
          tt("loginFailed", "Login did not finish. Prefer terminal: grok login"),
        );
      }
    } catch (e) {
      setCliOut(String(e.message || e));
    }
  }

  /** Tools panel: sub-tabs + help popups + MCP presets */
  const MCP_PRESETS = [
    {
      id: "github",
      label: "GitHub",
      name: "github",
      cmd: "npx -y @modelcontextprotocol/server-github",
    },
    {
      id: "filesystem",
      label: "Filesystem",
      name: "filesystem",
      cmd: "npx -y @modelcontextprotocol/server-filesystem",
    },
    {
      id: "fetch",
      label: "Fetch",
      name: "fetch",
      cmd: "npx -y @modelcontextprotocol/server-fetch",
    },
    {
      id: "memory",
      label: "Memory",
      name: "memory",
      cmd: "npx -y @modelcontextprotocol/server-memory",
    },
  ];

  function toolsHelpDocs(topic) {
    const vi = I()?.getLang?.() === "vi";
    const docs = {
      health: vi
        ? {
            title: "Sức khỏe CLI",
            html: `
              <h3>Sức khỏe CLI</h3>
              <p>Kiểm tra nhanh Grok CLI và môi trường trước khi làm việc.</p>
              <h4>Chạy Doctor</h4>
              <p>Chẩn đoán đăng nhập, đường dẫn, cấu hình. Nên chạy nếu Connect lỗi.</p>
              <h4>Hiện phiên bản</h4>
              <p>Xem version CLI đang dùng — hữu ích khi báo cáo lỗi.</p>
              <div class="help-note">Bạn không cần cấu hình gì ở đây nếu app đã Connect bình thường.</div>`,
          }
        : {
            title: "CLI health",
            html: `
              <h3>CLI health</h3>
              <p>Quick checks that the Grok CLI and environment are healthy.</p>
              <h4>Run doctor</h4>
              <p>Diagnoses login, paths, and config. Use this if Connect fails.</p>
              <h4>Show version</h4>
              <p>Prints the CLI version — useful when reporting issues.</p>
              <div class="help-note">No configuration needed if Connect already works.</div>`,
          },
      mcp: vi
        ? {
            title: "Máy chủ MCP",
            html: `
              <h3>Máy chủ MCP</h3>
              <p><strong>MCP</strong> (Model Context Protocol) gắn công cụ ngoài vào agent: GitHub, API, browser…</p>
              <h4>Cách dùng nhanh</h4>
              <ul>
                <li>Bấm <strong>Danh sách server</strong> xem server đã cài.</li>
                <li>Chọn preset (GitHub, Fetch…) để điền form.</li>
                <li>Bấm <strong>Thêm server local</strong> hoặc remote URL.</li>
                <li><strong>Trust thư mục</strong> nếu server nằm trong <code>.grok/config.toml</code> của repo (lệnh <code>/hooks-trust</code>).</li>
                <li><strong>Kết nối lại</strong> agent để MCP có hiệu lực.</li>
              </ul>
              <h4>Local (stdio)</h4>
              <p>Chạy process trên máy, ví dụ: <code>npx -y @modelcontextprotocol/server-github</code>. Có thể cần biến môi trường (token) trong shell hệ thống.</p>
              <h4>Remote (HTTP/SSE)</h4>
              <p>Kết nối server MCP qua URL — chọn đúng transport HTTP hoặc SSE.</p>
              <h4>Bật / Tắt / Xóa</h4>
              <p>Nhập <em>đúng tên</em> từ danh sách, rồi Bật / Tắt / Xóa.</p>
              <div class="help-note">Mặc định: không cần MCP. Chỉ thêm khi agent cần tool ngoài (GitHub, API…).</div>`,
          }
        : {
            title: "MCP servers",
            html: `
              <h3>MCP servers</h3>
              <p><strong>MCP</strong> (Model Context Protocol) attaches external tools to the agent: GitHub, APIs, browsers…</p>
              <h4>Quick path</h4>
              <ul>
                <li>Click <strong>List servers</strong> to see what is installed.</li>
                <li>Pick a preset (GitHub, Fetch…) to fill the form.</li>
                <li>Click <strong>Add local</strong> or add a remote URL.</li>
                <li><strong>Trust folder</strong> if the server is in the repo <code>.grok/config.toml</code> (<code>/hooks-trust</code>).</li>
                <li><strong>Connect</strong> the agent again so MCP is loaded.</li>
              </ul>
              <h4>Local (stdio)</h4>
              <p>Runs a process on your machine, e.g. <code>npx -y @modelcontextprotocol/server-github</code>. You may need env tokens in your system shell.</p>
              <h4>Remote (HTTP/SSE)</h4>
              <p>Connects to an MCP server over a URL — pick the matching transport.</p>
              <h4>Enable / Disable / Remove</h4>
              <p>Use the <em>exact name</em> from the list, then Enable, Disable, or Remove.</p>
              <div class="help-note">Default: no MCP required. Add only when you need extra tools.</div>`,
          },
      plugins: vi
        ? {
            title: "Plugins",
            html: `
              <h3>Plugins</h3>
              <p>Gói skill / extension đã cài cho agent. Duyệt catalog ở tab <strong>Marketplace</strong>.</p>
              <h4>Cài đặt thủ công</h4>
              <ul>
                <li><code>user/repo</code> trên GitHub</li>
                <li>URL git đầy đủ</li>
                <li>Đường dẫn thư mục local</li>
              </ul>
              <p>Install dùng <code>--trust</code>. Update / Details / Enable / Disable theo tên đã cài.</p>
              <div class="help-note">Hầu hết người dùng không cần plugin. Bỏ qua nếu workflow hiện tại đủ.</div>`,
          }
        : {
            title: "Plugins",
            html: `
              <h3>Plugins</h3>
              <p>Installed skill packs. Browse catalogs under the <strong>Marketplace</strong> tab.</p>
              <h4>Manual install source</h4>
              <ul>
                <li><code>user/repo</code> on GitHub</li>
                <li>Full git URL</li>
                <li>Local folder path</li>
              </ul>
              <p>Install uses <code>--trust</code>. Update / Details / Enable by installed name.</p>
              <div class="help-note">Most users can skip plugins. Leave this empty if your workflow already works.</div>`,
          },
      marketplace: vi
        ? {
            title: "Marketplace",
            html: `
              <h3>Plugin marketplace</h3>
              <p>Catalog từ nguồn CLI (mặc định: <strong>xAI Official</strong>, <strong>claude-plugins-official</strong>).</p>
              <ol>
                <li><strong>Update cache</strong> — đồng bộ git marketplace.</li>
                <li><strong>Refresh catalog</strong> — đọc lại danh sách plugin local.</li>
                <li>Tìm plugin → <strong>Install</strong> (dùng <code>plugin install --trust</code>).</li>
              </ol>
              <p>Thêm/xóa source bằng form phía trên (git URL hoặc <code>user/repo</code>).</p>
              <div class="help-note">Cài xong, xem lại tab Plugins → List installed.</div>`,
          }
        : {
            title: "Marketplace",
            html: `
              <h3>Plugin marketplace</h3>
              <p>Catalogs from CLI sources (defaults: <strong>xAI Official</strong>, <strong>claude-plugins-official</strong>).</p>
              <ol>
                <li><strong>Update cache</strong> — sync marketplace git clones.</li>
                <li><strong>Refresh catalog</strong> — reload local plugin list.</li>
                <li>Search → <strong>Install</strong> (<code>plugin install --trust</code>).</li>
              </ol>
              <p>Add/remove sources with the form above (git URL or <code>user/repo</code>).</p>
              <div class="help-note">After install, check Plugins → List installed.</div>`,
          },
      worktree: vi
        ? {
            title: "Git worktrees",
            html: `
              <h3>Git worktrees</h3>
              <p>Thư mục làm việc song song với nhánh chính — agent sửa code mà không đụng branch hiện tại.</p>
              <h4>Tạo / dùng trong session</h4>
              <p>Vào <strong>Cài đặt → Agent → Isolation</strong>, bật worktree, đặt tên, rồi <strong>Kết nối</strong>.</p>
              <h4>Tại đây</h4>
              <p>Chỉ <strong>liệt kê</strong>, xem chi tiết, xóa. Task nền có worktree nằm ở tab <strong>Tác vụ</strong>.</p>
              <div class="help-note">Mặc định: không dùng worktree. Bật khi cần nhánh thử nghiệm an toàn.</div>`,
          }
        : {
            title: "Git worktrees",
            html: `
              <h3>Git worktrees</h3>
              <p>Parallel working folders so the agent can edit code without touching your main branch.</p>
              <h4>Create / use in a session</h4>
              <p>Go to <strong>Settings → Agent → Isolation</strong>, enable worktree, set a name, then <strong>Connect</strong>.</p>
              <h4>Here</h4>
              <p>Only <strong>list</strong>, show details, or remove. Background tasks with worktrees live under <strong>Tasks</strong>.</p>
              <div class="help-note">Default: no worktree. Enable when you need a safe experiment branch.</div>`,
          },
      files: vi
        ? {
            title: "Tệp dự án",
            html: `
              <h3>Tệp dự án</h3>
              <p>Xem cây thư mục và nội dung file trong project đang mở.</p>
              <ul>
                <li>Bấm file để xem trước.</li>
                <li>Double-click đường dẫn (nếu có) để mở trong IDE.</li>
              </ul>
              <div class="help-note">Không cần thiết lập gì. Chỉ cần <strong>Mở thư mục</strong> dự án.</div>`,
          }
        : {
            title: "Project files",
            html: `
              <h3>Project files</h3>
              <p>Browse the open project tree and preview file contents.</p>
              <ul>
                <li>Click a file to preview it.</li>
                <li>Double-click the path (when shown) to open in the IDE.</li>
              </ul>
              <div class="help-note">No setup. Just <strong>Open folder</strong> for your project.</div>`,
          },
      review: vi
        ? {
            title: "Review chỉnh sửa",
            html: `
              <h3>Review chỉnh sửa</h3>
              <p>Khi agent sửa file, diff hiện ở đây để bạn duyệt.</p>
              <ul>
                <li><strong>Accept</strong> — giữ bản mới của agent.</li>
                <li><strong>Reject</strong> — giữ bản gốc.</li>
                <li><strong>Side</strong> — xem song song cũ / mới.</li>
              </ul>
              <div class="help-note">Trống là bình thường nếu agent chưa chỉnh file trong phiên này.</div>`,
          }
        : {
            title: "Review edits",
            html: `
              <h3>Review edits</h3>
              <p>When the agent changes files, diffs appear here for you to approve.</p>
              <ul>
                <li><strong>Accept</strong> — keep the agent’s version.</li>
                <li><strong>Reject</strong> — keep the original.</li>
                <li><strong>Side</strong> — compare old and new side by side.</li>
              </ul>
              <div class="help-note">Empty is normal if the agent has not edited files yet.</div>`,
          },
      manager: vi
        ? {
            title: "Tác vụ nền",
            html: `
              <h3>Tác vụ nền</h3>
              <p>Chạy job riêng (headless) trong khi bạn vẫn chat. <strong>Không bắt buộc</strong> — hầu hết việc chỉ cần chat.</p>
              <h4>Luồng đơn giản</h4>
              <ol>
                <li><strong>Tác vụ mới</strong> — mô tả việc cần làm, bấm <em>Xếp hàng</em>.</li>
                <li><strong>Bảng</strong> — theo dõi trạng thái / hủy nếu cần.</li>
                <li><strong>Hộp thư</strong> — khi xong, bấm job để mở kết quả trong <em>Kết quả</em>.</li>
              </ol>
              <h4>Tùy chọn nâng cao</h4>
              <p>Worktree, base ref, permission mode — chỉ mở khi bạn cần isolation hoặc chế độ quyền đặc biệt. Để trống = mặc định an toàn.</p>
              <div class="help-note">Cần đã <strong>Mở thư mục</strong> dự án. Không cần Connect chat cho job nền (job chạy CLI riêng).</div>`,
          }
        : {
            title: "Background tasks",
            html: `
              <h3>Background tasks</h3>
              <p>Run a separate headless job while you keep chatting. <strong>Optional</strong> — most work only needs chat.</p>
              <h4>Simple path</h4>
              <ol>
                <li><strong>New task</strong> — describe the work, click <em>Queue task</em>.</li>
                <li><strong>Board</strong> — watch status or cancel.</li>
                <li><strong>Inbox</strong> — when done, click the job to open output in <em>Results</em>.</li>
              </ol>
              <h4>Advanced options</h4>
              <p>Worktree, base ref, permission mode — only when you need isolation or special permission. Leave empty for safe defaults.</p>
              <div class="help-note">Requires an open project folder. Chat Connect is not required for background jobs (they use the CLI).</div>`,
          },
      "manager-new": vi
        ? {
            title: "Tạo tác vụ nền",
            html: `
              <h3>Tạo tác vụ nền</h3>
              <p>Viết rõ việc agent nền phải làm (giống prompt chat nhưng chạy riêng).</p>
              <ul>
                <li><strong>Tiêu đề</strong> — nhãn ngắn trên bảng (tuỳ chọn).</li>
                <li><strong>Tùy chọn nâng cao</strong> — worktree / permission — để trống nếu không chắc.</li>
              </ul>
              <p>Sau khi xếp hàng, app chuyển sang <strong>Bảng</strong> để theo dõi.</p>
              <div class="help-note">Ví dụ: “Chạy test packages/acp-client và tóm tắt lỗi.”</div>`,
          }
        : {
            title: "Create a background task",
            html: `
              <h3>Create a background task</h3>
              <p>Describe what the headless agent should do (like a chat prompt, but separate).</p>
              <ul>
                <li><strong>Title</strong> — short label on the board (optional).</li>
                <li><strong>Advanced</strong> — worktree / permission — leave closed if unsure.</li>
              </ul>
              <p>After queueing, the app switches to <strong>Board</strong> so you can watch progress.</p>
              <div class="help-note">Example: “Run tests in packages/acp-client and summarize failures.”</div>`,
          },
      "manager-worktree": vi
        ? {
            title: "Worktree trong Tác vụ",
            html: `
              <h3>Worktree trong Tác vụ</h3>
              <p>Danh sách worktree git liên quan job nền. Bấm card để điền tên vào form.</p>
              <ul>
                <li><strong>Xem chi tiết / Xóa / Cleanup</strong> — quản lý id đã có.</li>
                <li><strong>CLI worktrees</strong> — mở tab Tiện ích → Worktree.</li>
              </ul>
              <p>Tạo worktree mới: <em>Tác vụ mới → Tùy chọn nâng cao → tên worktree</em> rồi xếp hàng, hoặc <strong>Cài đặt → Agent → Isolation</strong>.</p>
              <div class="help-note">Người dùng cơ bản có thể bỏ qua tab này.</div>`,
          }
        : {
            title: "Worktrees in Tasks",
            html: `
              <h3>Worktrees in Tasks</h3>
              <p>Git worktrees used by background jobs. Click a card to fill the name field.</p>
              <ul>
                <li><strong>Show / Remove / Cleanup</strong> — manage existing ids.</li>
                <li><strong>CLI worktrees</strong> — opens Extensions → Worktrees.</li>
              </ul>
              <p>Create one: <em>New task → Advanced → worktree name</em> then Queue, or <strong>Settings → Agent → Isolation</strong>.</p>
              <div class="help-note">Basic users can ignore this tab.</div>`,
          },
      artifacts: vi
        ? {
            title: "Kết quả đã lưu",
            html: `
              <h3>Kết quả đã lưu</h3>
              <p>Kho lưu plan và output job để xem lại. <strong>Không cần cấu hình</strong>.</p>
              <h4>Làm sao có item?</h4>
              <ul>
                <li>Tác vụ nền xong → <strong>Tác vụ → Hộp thư</strong> → bấm job (tự mở ở đây).</li>
                <li>Hoặc <strong>Lưu plan từ chat</strong> khi plan đang hiện trên chat.</li>
              </ul>
              <h4>Thao tác</h4>
              <ul>
                <li>Bấm item trong danh sách để xem nội dung.</li>
                <li><strong>Mở IDE</strong> — nếu item gắn path file.</li>
                <li><strong>Xóa hết</strong> — dọn danh sách local.</li>
              </ul>
              <div class="help-note">Trống là bình thường. Chat thường ngày không bắt buộc dùng tab này.</div>`,
          }
        : {
            title: "Saved results",
            html: `
              <h3>Saved results</h3>
              <p>A shelf for plans and job outputs. <strong>Nothing to configure</strong>.</p>
              <h4>How items appear</h4>
              <ul>
                <li>Background task finishes → <strong>Tasks → Inbox</strong> → click the job (opens here).</li>
                <li>Or <strong>Save plan from chat</strong> when a plan is visible.</li>
              </ul>
              <h4>Actions</h4>
              <ul>
                <li>Click a list item to read it.</li>
                <li><strong>Open in IDE</strong> — if the item has a file path.</li>
                <li><strong>Clear all</strong> — wipe local saved results.</li>
              </ul>
              <div class="help-note">Empty is normal. Everyday chat does not require this tab.</div>`,
          },
    };
    return docs[topic] || docs.health;
  }

  function openHelp(topic) {
    const doc = toolsHelpDocs(topic);
    const modal = $("helpModal");
    if ($("helpModalTitle")) $("helpModalTitle").textContent = doc.title;
    if ($("helpModalBody")) $("helpModalBody").innerHTML = doc.html;
    modal?.classList.remove("hidden");
  }

  function closeHelp() {
    $("helpModal")?.classList.add("hidden");
  }

  function switchToolsTab(tabId) {
    const id = tabId || "health";
    document.querySelectorAll("#toolsSubnav .tools-subtab").forEach((b) => {
      b.classList.toggle("active", b.dataset.toolsTab === id);
    });
    document.querySelectorAll("#panelTools .tools-section").forEach((s) => {
      s.classList.toggle("active", s.dataset.toolsSection === id);
    });
    if (id === "mcp") void refreshFolderTrustUi();
  }

  function paintMcpPresets() {
    const host = $("mcpPresets");
    if (!host) return;
    host.innerHTML = "";
    for (const p of MCP_PRESETS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool-chip";
      b.textContent = p.label;
      b.title = p.cmd;
      b.onclick = () => {
        if ($("mcpName")) $("mcpName").value = p.name;
        if ($("mcpCmd")) $("mcpCmd").value = p.cmd;
        switchToolsTab("mcp");
      };
      host.appendChild(b);
    }
  }

  // ── Marketplace catalog state ──
  /** @type {{ plugins: any[], marketplaces: any[] } | null} */
  let mktCatalog = null;

  function paintMktSources(list) {
    const host = $("mktSourceList");
    if (!host) return;
    const rows = list || [];
    if (!rows.length) {
      host.textContent = tt(
        "mktNoSources",
        "No marketplace cache. Click Update cache, then Refresh catalog.",
      );
      return;
    }
    host.textContent = rows
      .map((m) => `${m.name} · ${m.pluginCount || 0} plugins`)
      .join("\n");
    const sel = $("mktMarketFilter");
    if (sel) {
      const cur = sel.value;
      sel.innerHTML = "";
      const all = document.createElement("option");
      all.value = "";
      all.textContent = tt("mktAll", "All marketplaces");
      sel.appendChild(all);
      for (const m of rows) {
        const o = document.createElement("option");
        o.value = m.name;
        o.textContent = `${m.name} (${m.pluginCount || 0})`;
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
    }
  }

  function paintMktPlugins() {
    const host = $("mktPluginList");
    const stats = $("mktStats");
    if (!host) return;
    const q = ($("mktFilter")?.value || "").trim().toLowerCase();
    const mkt = $("mktMarketFilter")?.value || "";
    let list = mktCatalog?.plugins || [];
    if (mkt) list = list.filter((p) => p.marketplace === mkt);
    if (q) {
      list = list.filter(
        (p) =>
          String(p.name).toLowerCase().includes(q) ||
          String(p.description || "").toLowerCase().includes(q) ||
          String(p.category || "").toLowerCase().includes(q),
      );
    }
    const total = mktCatalog?.totalPlugins ?? mktCatalog?.plugins?.length ?? 0;
    if (stats) {
      stats.textContent = tt("mktStats", "Showing {n} of {total}")
        .replace("{n}", String(list.length))
        .replace("{total}", String(total));
    }
    host.innerHTML = "";
    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "muted-pad";
      empty.textContent = tt(
        "mktEmpty",
        "No plugins match. Update cache or clear the search.",
      );
      host.appendChild(empty);
      return;
    }
    // Cap DOM rows
    const slice = list.slice(0, 80);
    for (const p of slice) {
      const card = document.createElement("div");
      card.className = "mkt-card";
      const head = document.createElement("div");
      head.className = "mkt-card-head";
      const left = document.createElement("div");
      const nameEl = document.createElement("div");
      nameEl.className = "mkt-card-name";
      nameEl.textContent = p.name;
      const meta = document.createElement("div");
      meta.className = "mkt-card-meta";
      meta.textContent = [p.marketplace, p.category, p.author].filter(Boolean).join(" · ");
      left.append(nameEl, meta);
      head.appendChild(left);
      const desc = document.createElement("div");
      desc.className = "mkt-card-desc";
      desc.textContent = p.description || "";
      const actions = document.createElement("div");
      actions.className = "mkt-card-actions";
      const inst = document.createElement("button");
      inst.type = "button";
      inst.className = "pill-btn accent";
      inst.textContent = tt("install", "Install");
      inst.onclick = () => {
        if ($("pluginName")) $("pluginName").value = p.installSource || p.name;
        void runCli(["plugin", "install", p.installSource || p.name, "--trust"]);
      };
      const use = document.createElement("button");
      use.type = "button";
      use.className = "pill-btn";
      use.textContent = tt("mktUseName", "Use name");
      use.onclick = () => {
        if ($("pluginName")) $("pluginName").value = p.name;
        switchToolsTab("plugins");
      };
      actions.append(inst, use);
      card.append(head, desc, actions);
      host.appendChild(card);
    }
    if (list.length > slice.length) {
      const more = document.createElement("p");
      more.className = "field-hint";
      more.textContent = tt("mktTruncated", "Showing first 80 — refine search for more.");
      host.appendChild(more);
    }
  }

  async function refreshMarketplaceCatalog(opts = {}) {
    const host = $("mktSourceList");
    if (host && !opts.silent) host.textContent = tt("mktLoading", "Loading…");
    try {
      if (!api.pluginCatalog) {
        if (host) host.textContent = "pluginCatalog IPC missing — rebuild desktop.";
        return;
      }
      const cat = await api.pluginCatalog();
      mktCatalog = cat;
      paintMktSources(cat.marketplaces || []);
      paintMktPlugins();
      if (cat.message && !(cat.plugins || []).length) {
        setCliOut(cat.message);
      }
    } catch (e) {
      if (host) host.textContent = e.message || String(e);
    }
  }

  function wireToolsPanel() {
    paintMcpPresets();
    $("toolsSubnav")?.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-tools-tab]");
      if (!btn) return;
      switchToolsTab(btn.dataset.toolsTab);
      if (btn.dataset.toolsTab === "marketplace") {
        void refreshMarketplaceCatalog({ silent: true });
      }
    });
    // Help popups: Tools + Manager + Artifacts + Files + Review
    document.querySelectorAll(".help-btn[data-help]").forEach((btn) => {
      btn.onclick = () => openHelp(btn.dataset.help);
    });
    $("btnCloseHelp") && ($("btnCloseHelp").onclick = closeHelp);
    $("btnHelpDone") && ($("btnHelpDone").onclick = closeHelp);
    $("helpModal")?.addEventListener("click", (e) => {
      if (e.target === $("helpModal")) closeHelp();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("helpModal")?.classList.contains("hidden")) {
        closeHelp();
      }
    });
    $("btnCliOutClear") &&
      ($("btnCliOutClear").onclick = () =>
        setCliOut(tt("toolsOutputEmpty", "Run a check or action above. Results appear here.")));
    $("btnWtList") &&
      ($("btnWtList").onclick = () => {
        switchToolsTab("worktree");
        void runCli(["worktree", "list"]);
      });
    $("btnToolsOpenManager") &&
      ($("btnToolsOpenManager").onclick = () => {
        setSideNav(null);
        switchPanel("manager");
      });
  }

  function endResizeDrag() {
    document.body.classList.remove("resizing");
    for (const el of document.querySelectorAll(".splitter.dragging")) {
      el.classList.remove("dragging");
    }
  }

  // splitters
  function setupSplitters() {
    const specs = [
      {
        el: $("split1"), target: $("colSidebar"), key: "sidebarWidth", min: 180, reverse: false, defaultWidth: 248,
        max: () => Math.min(400, Math.round(window.innerWidth * 0.6)),
      },
      {
        el: $("split2"), target: $("colEditor"), key: "editorWidth", min: 320, reverse: true,
        defaultWidth: () => (window.innerWidth >= 1700 ? 720 : window.innerWidth >= 1450 ? 500 : window.innerWidth >= 1250 ? 450 : 400),
        max: () => Math.max(320, Math.min(Math.round(window.innerWidth * 0.6), ($("workRow")?.clientWidth || window.innerWidth) - 285)),
      },
      {
        el: $("splitFiles"), target: $("projectExplorer"), key: "fileExplorerWidth", min: FILE_EXPLORER_MIN,
        reverse: false, defaultWidth: defaultFileExplorerWidth, max: fileExplorerMaxWidth,
        disabled: () => $("splitFiles")?.getAttribute("aria-disabled") === "true",
        write: (width) => setFileExplorerWidth(width, false),
      },
    ];
    const readWidth = (spec) => spec.target.getBoundingClientRect().width;
    const getMax = (spec) => Math.max(spec.min, Number(typeof spec.max === "function" ? spec.max() : spec.max) || window.innerWidth * 0.6);
    const writeWidth = (spec, value) => {
      const width = Math.max(spec.min, Math.min(getMax(spec), Math.round(value)));
      if (spec.write) spec.write(width);
      else spec.target.style.width = `${width}px`;
      spec.el.setAttribute("aria-valuemin", String(spec.min));
      spec.el.setAttribute("aria-valuemax", String(Math.round(getMax(spec))));
      spec.el.setAttribute("aria-valuenow", String(width));
      return width;
    };
    const saveSpec = (spec, width = Math.round(readWidth(spec))) => saveLayout({ [spec.key]: Math.round(width) });
    for (const s of specs) {
      if (!s.el || !s.target) continue;
      s.el.setAttribute("aria-valuemin", String(s.min));
      s.el.setAttribute("aria-valuemax", String(Math.round(getMax(s))));
      s.el.setAttribute("aria-valuenow", String(Math.round(readWidth(s))));
      s.el.addEventListener("pointerdown", (ev) => {
        // Only start drag from the splitter strip itself
        if (ev.button !== 0 || s.disabled?.()) return;
        ev.preventDefault();
        s.el.setPointerCapture(ev.pointerId);
        s.el.classList.add("dragging");
        document.body.classList.add("resizing");
        const startX = ev.clientX;
        const startW = readWidth(s);
        const onMove = (e) => {
          const dx = e.clientX - startX;
          let w = s.reverse ? startW - dx : startW + dx;
          writeWidth(s, w);
        };
        let ended = false;
        const onUp = (e) => {
          if (ended) return;
          ended = true;
          try {
            s.el.releasePointerCapture(e.pointerId);
          } catch {
            // ignore
          }
          s.el.classList.remove("dragging");
          endResizeDrag();
          s.el.removeEventListener("pointermove", onMove);
          s.el.removeEventListener("pointerup", onUp);
          s.el.removeEventListener("pointercancel", onUp);
          s.el.removeEventListener("lostpointercapture", onUp);
          saveSpec(s);
        };
        s.el.addEventListener("pointermove", onMove);
        s.el.addEventListener("pointerup", onUp);
        s.el.addEventListener("pointercancel", onUp);
        s.el.addEventListener("lostpointercapture", onUp);
      });
      s.el.addEventListener("keydown", (event) => {
        if (s.disabled?.()) return;
        const isArrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
        if (!isArrow && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        const step = event.shiftKey ? 40 : 16;
        let next = readWidth(s);
        if (event.key === "Home") next = s.reverse ? getMax(s) : s.min;
        else if (event.key === "End") next = s.reverse ? s.min : getMax(s);
        else {
          const direction = event.key === "ArrowRight" ? 1 : -1;
          next += direction * step * (s.reverse ? -1 : 1);
        }
        const applied = writeWidth(s, next);
        saveSpec(s, applied);
      });
      s.el.addEventListener("dblclick", () => {
        if (s.disabled?.()) return;
        const value = typeof s.defaultWidth === "function" ? s.defaultWidth() : s.defaultWidth;
        const applied = writeWidth(s, value || s.min);
        saveSpec(s, applied);
      });
    }
    // Global safety: never leave body.resizing stuck (blocks typing in Electron)
    window.addEventListener("blur", endResizeDrag);
    window.addEventListener("mouseup", endResizeDrag);
    window.addEventListener("pointerup", endResizeDrag);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") endResizeDrag();
    });

    const L = loadLayout();
    if (L.sidebarWidth) $("colSidebar").style.width = `${L.sidebarWidth}px`;
    if (L.editorWidth) $("colEditor").style.width = `${Math.max(320, L.editorWidth)}px`;
    const workbench = $("panelFiles")?.querySelector(".file-workbench");
    workbench?.classList.toggle("explorer-collapsed", Boolean(L.fileExplorerCollapsed));
    workbench?.classList.toggle("preview-collapsed", Boolean(L.filePreviewCollapsed) && !L.fileExplorerCollapsed);
    setFileExplorerWidth(L.fileExplorerWidth || defaultFileExplorerWidth(), false);
    updateFilePaneControls();
    setSidebarVisible(L.sidebarVisible !== false);
    setPanelVisible(L.panelVisible !== false);
    setTermVisible(Boolean(L.termVisible));
    window.addEventListener("resize", () => {
      if (!workbench?.classList.contains("explorer-collapsed") && !workbench?.classList.contains("preview-collapsed")) {
        setFileExplorerWidth(loadLayout().fileExplorerWidth || defaultFileExplorerWidth(), false);
      }
      for (const spec of specs) {
        if (!spec.el || !spec.target) continue;
        spec.el.setAttribute("aria-valuemax", String(Math.round(getMax(spec))));
        spec.el.setAttribute("aria-valuenow", String(Math.round(readWidth(spec))));
      }
    });
    if (workbench && typeof ResizeObserver !== "undefined") {
      let resizeFrame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => {
          if (!workbench.classList.contains("explorer-collapsed") && !workbench.classList.contains("preview-collapsed")) {
            setFileExplorerWidth(loadLayout().fileExplorerWidth || defaultFileExplorerWidth(), false);
          }
        });
      });
      observer.observe(workbench);
    }
  }

  /** Titlebar File/Edit/… → native popup menus */
  function wireTitlebarMenus() {
    document.querySelectorAll(".titlebar-menu-btn[data-menu]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const label = btn.getAttribute("data-menu");
        const rect = btn.getBoundingClientRect();
        void api.popupMenu?.(label, Math.round(rect.left), Math.round(rect.bottom));
      });
    });
    $("btnToggleSidebar") &&
      ($("btnToggleSidebar").onclick = () => {
        const on = $("btnToggleSidebar").getAttribute("aria-pressed") !== "true";
        setSidebarVisible(on);
      });
  }

  function ensureInputsInteractive() {
    endResizeDrag();
    unlockChatInput();
  }

  // wire
  $("btnWorkspace").onclick = () => openProjectModal("open");
  $("btnCloseProjectModal") && ($("btnCloseProjectModal").onclick = () => closeProjectModal());
  $("btnCancelProjectModal") && ($("btnCancelProjectModal").onclick = () => closeProjectModal());
  $("btnAddProjectFolder") && ($("btnAddProjectFolder").onclick = () => void addDraftProjectFolder());
  $("btnConfirmProjectModal") &&
    ($("btnConfirmProjectModal").onclick = () => void confirmProjectModal());
  $("projectModal")?.addEventListener("click", (e) => {
    if (e.target === $("projectModal")) closeProjectModal();
  });

  // Composer project picker (Codex-style)
  $("btnProject")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("menuProject");
    const btn = $("btnProject");
    if (!menu || !btn) return;
    const open = menu.classList.contains("hidden");
    document.querySelectorAll(".chip-menu").forEach((m) => m.classList.add("hidden"));
    document.querySelectorAll(".chip-btn[aria-expanded='true']").forEach((b) => {
      b.setAttribute("aria-expanded", "false");
    });
    if (open) {
      renderProjectMenu();
      menu.classList.remove("hidden");
      btn.setAttribute("aria-expanded", "true");
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.("#ddProject")) {
      $("menuProject")?.classList.add("hidden");
      $("btnProject")?.setAttribute("aria-expanded", "false");
    }
  });
  $("btnNew").onclick = async () => {
    try {
      setSideNav(null);
      await newChatTab(true);
      void refreshHistory();
    } catch (e) {
      addMsg("error", e.message || String(e));
      unlockChatInput();
    }
  };

  $("btnDiffSide") && ($("btnDiffSide").onclick = () => setDiffMode(!diffSideBySide));
  $("btnDiffAccept") && ($("btnDiffAccept").onclick = () => void acceptDiff());
  $("btnDiffReject") && ($("btnDiffReject").onclick = () => void rejectDiff());
  $("btnCmdK") && ($("btnCmdK").onclick = () => cmdPalette?.toggle?.());
  wireManagerUi();
  wireTitlebarMenus();
  try {
    globalThis.GrokIcons?.applyAll?.($("titlebar"));
  } catch {
    /* ignore */
  }

  // Phase C4 — header Open IDE with workspace; double-click path opens file in IDE
  editorPath?.addEventListener("dblclick", () => void openCurrentInIde());
  $("btnRefreshFiles")?.addEventListener("click", () => void refreshFileTree(workspaceRoot));
  $("btnCollapseFiles")?.addEventListener("click", collapseExplorerFolders);
  $("btnToggleExplorer")?.addEventListener("click", () => {
    const collapsed = $("panelFiles")?.querySelector(".file-workbench")?.classList.contains("explorer-collapsed");
    setFilePaneCollapsed("explorer", !collapsed);
  });
  $("btnTogglePreview")?.addEventListener("click", () => {
    const collapsed = $("panelFiles")?.querySelector(".file-workbench")?.classList.contains("preview-collapsed");
    setFilePaneCollapsed("preview", !collapsed);
  });
  $("btnHistory").onclick = () => {
    setSideNav("history");
    setSidebarVisible(true);
    // Bring recent list into view and refresh
    $("projectList")?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    $("projectList")?.classList.add("history-focus");
    setTimeout(() => $("projectList")?.classList.remove("history-focus"), 800);
    void refreshHistory();
  };
  $("btnTools").onclick = () => {
    setSideNav("tools");
    setPanelVisible(true);
    switchPanel("tools");
  };
  $("btnTogglePanel") &&
    ($("btnTogglePanel").onclick = () => {
      const hidden = $("colEditor")?.classList.contains("collapsed");
      setPanelVisible(Boolean(hidden));
    });
  $("btnClosePanel") && ($("btnClosePanel").onclick = () => setPanelVisible(false));
  $("btnToggleTerm") &&
    ($("btnToggleTerm").onclick = () => {
      setTermVisible(!isTermOpen());
    });
  $("btnTermClose") && ($("btnTermClose").onclick = () => setTermVisible(false));
  function closeIdeModal() {
    $("ideModal")?.classList.add("hidden");
  }

  function showIdeNotInstalledModal(res) {
    const modal = $("ideModal");
    if (!modal) {
      addMsg(
        "error",
        res?.message ||
          tt("ideNotInstalledBody", "Grok Build IDE is not installed."),
      );
      return;
    }
    const title = $("ideModalTitle");
    const body = $("ideModalBody");
    const pathEl = $("ideModalPath");
    const hint = $("ideModalHint");
    if (title) {
      title.textContent = tt("ideNotInstalledTitle", "Grok Build IDE not installed");
    }
    if (body) {
      body.textContent =
        res?.message ||
        tt("ideNotInstalledBody", "Grok Build IDE is not installed.");
    }
    if (pathEl) {
      const dir =
        res?.expectedDir ||
        bootstrap?.ideInstall?.installDir ||
        "%LOCALAPPDATA%\\Programs\\Grok Build IDE";
      pathEl.textContent = `${dir}\\Grok Build IDE.exe`;
    }
    if (hint) {
      hint.textContent = tt(
        "ideNotInstalledHint",
        "Install the IDE or set Settings → IDE path.",
      );
    }
    const dl = $("btnIdeDownload");
    if (dl) {
      dl.dataset.url =
        res?.downloadUrl ||
        bootstrap?.ideInstall?.downloadUrl ||
        "https://github.com/nct88/Grok-Build-IDE/releases/latest";
    }
    modal.classList.remove("hidden");
  }

  $("btnOpenIde") &&
    ($("btnOpenIde").onclick = async () => {
      try {
        // Phase C4: workspace + current preview file if any
        const file = editorPath?.dataset?.filePath || "";
        const line = Number(editorPath?.dataset?.line) || 0;
        const res = await api.openIde?.({
          workspace: workspaceRoot || undefined,
          file: file || undefined,
          line: line || undefined,
        });
        if (res?.ok) {
          addStep(
            `${res.productName || "IDE"} · ${basen(res.path || "")}` +
              (res.workspace ? ` · ${basen(res.workspace)}` : "") +
              (res.file ? ` · ${basen(res.file)}${res.line ? `:${res.line}` : ""}` : ""),
          );
          return;
        }
        if (res?.reason === "not_installed") {
          showIdeNotInstalledModal(res);
          return;
        }
        addMsg(
          "error",
          res?.message || tt("ideLaunchFailed", "Could not start Grok Build IDE."),
        );
      } catch (e) {
        addMsg("error", e.message || String(e));
      }
    });
  $("btnCloseIdeModal") && ($("btnCloseIdeModal").onclick = () => closeIdeModal());
  $("btnIdeDismiss") && ($("btnIdeDismiss").onclick = () => closeIdeModal());
  $("btnIdeDownload") &&
    ($("btnIdeDownload").onclick = () => {
      const url =
        $("btnIdeDownload")?.dataset?.url ||
        bootstrap?.ideInstall?.downloadUrl ||
        "https://github.com/nct88/Grok-Build-IDE/releases/latest";
      void api.openExternal?.(url);
      closeIdeModal();
    });
  $("ideModal")?.addEventListener("click", (e) => {
    if (e.target === $("ideModal")) closeIdeModal();
  });
  setupProfileUi();
  $("btnCloseSettings").onclick = () => settingsModal.classList.add("hidden");
  $("btnSaveSettings").onclick = () => void saveSettingsForm();
  wireSettingsControls();
  $("btnTelemetrySummary") &&
    ($("btnTelemetrySummary").onclick = () => void showTelemetrySummary());
  $("chkTelemetry") &&
    ($("chkTelemetry").onchange = () => {
      void api.telemetrySetEnabled?.(Boolean($("chkTelemetry").checked));
    });
  $("btnDisconnect") &&
    ($("btnDisconnect").onclick = async () => {
      await api.disconnect();
      setStatus("disconnected");
      settingsModal.classList.add("hidden");
    });
  $("btnSettingsLogin") && ($("btnSettingsLogin").onclick = () => void doLogin());
  $("btnSettingsLogout") && ($("btnSettingsLogout").onclick = () => void doLogout());
  $("btnRefreshImaginePrivacy") &&
    ($("btnRefreshImaginePrivacy").onclick = async () => {
      const p = await refreshAuthProfile();
      updateImagineVideoStatus(p);
      addStep(
        p?.imagineVideoBlocked
          ? "Imagine video: still blocked (privacy Opt out)"
          : p?.loggedIn
            ? "Imagine video: privacy OK for hosted video"
            : "Imagine video: not signed in",
      );
    });
  document.querySelectorAll(".js-refresh-usage, #btnRefreshUsage").forEach((btn) => {
    btn.addEventListener("click", () => void refreshUsage());
  });
  document.querySelectorAll(".js-refresh-session-info").forEach((btn) => {
    btn.addEventListener("click", () => void refreshSessionInfo());
  });
  $("menuUsage")?.addEventListener("click", (event) => {
    const tab = event.target.closest?.("[data-session-info-tab]");
    if (tab) {
      activateSessionInfoTab(tab.dataset.sessionInfoTab);
      if (tab.dataset.sessionInfoTab === "account") void refreshUsage();
      return;
    }
    const row = event.target.closest?.("[data-session-copy]");
    if (row) void copySessionInfoValue(row.dataset.sessionCopy, tt("copied", "Copied"));
  });
  $("btnCopySessionInfo")?.addEventListener("click", () => void copyAllSessionInfo());
  document.querySelectorAll(".js-manage-billing, #btnManageBilling").forEach((btn) => {
    btn.addEventListener("click", () => {
      void api.openExternal?.(lastUsageManageUrl || "https://grok.com?_s=usage");
    });
  });
  $("btnCheckCliUpdate") && ($("btnCheckCliUpdate").onclick = () => void checkCliUpdates());
  $("btnCheckCliUpdateAccount") &&
    ($("btnCheckCliUpdateAccount").onclick = () => void checkCliUpdates());
  $("btnUpdateCli") && ($("btnUpdateCli").onclick = () => void applyCliUpdate());
  $("settingsNav")?.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-settings-tab]");
    if (!btn) return;
    switchSettingsTab(btn.dataset.settingsTab);
  });
  $("btnSend").onclick = () => void send();
  $("btnTurnStop") &&
    ($("btnTurnStop").onclick = () => {
      void api.cancel?.();
    });
  $("btnQueueClear") &&
    ($("btnQueueClear").onclick = () => {
      const queue = sessionTabs?.getActive?.()?.promptQueue || promptQueue;
      queue.length = 0;
      updateQueueBar();
    });
  $("btnAttach").onclick = async () => {
    const files = await api.pickFiles();
    for (const f of files || []) {
      const lower = (f.name || "").toLowerCase();
      if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(lower) && f.path) {
        try {
          const img = await api.readFileBase64(f.path);
          attachments.push(img);
        } catch {
          attachments.push(f);
        }
      } else {
        attachments.push(f);
      }
    }
    renderAttachments();
  };
  for (const btn of document.querySelectorAll("[data-cli]")) {
    btn.onclick = () => {
      const raw = btn.getAttribute("data-cli") || "";
      const args = raw.split(/\s+/).filter(Boolean);
      void runCli(args);
    };
  }
  $("btnTermClear") &&
    ($("btnTermClear").onclick = () => {
      clearTermBuffer();
      $("termInput")?.focus();
    });
  $("btnTermExternal") &&
    ($("btnTermExternal").onclick = () => void openExternalTerminal());
  $("btnTermRestart") &&
    ($("btnTermRestart").onclick = async () => {
      if (!workspaceRoot) {
        setTermEmpty(true);
        return;
      }
      clearTermBuffer();
      await api.stopShell?.();
      termReady = false;
      await ensureProjectShell({ force: true });
      $("termInput")?.focus();
    });
  $("btnTermPickProject") &&
    ($("btnTermPickProject").onclick = async () => {
      const root = await pickFolderAndSelect();
      if (root) {
        setTermVisible(true);
        void ensureProjectShell({ force: true });
      }
    });
  $("termInput")?.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    $("termInput").focus();
  });
  $("termInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runTermLine();
    } else if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
      // optional interrupt when input empty
      if (!$("termInput").value) {
        e.preventDefault();
        void api.termInterrupt?.();
      }
    } else if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      clearTermBuffer();
    }
  });
  $("termDock")?.addEventListener("mousedown", (e) => {
    if (e.target.closest?.("button, input")) return;
    if (e.target.closest?.(".term-empty")) return;
    if (e.target.closest?.(".term-input-row") || e.target.id === "termOut" || e.target.closest?.("#termOut")) {
      setTimeout(() => $("termInput")?.focus(), 0);
    }
  });
  api.onTermChunk?.((chunk) => {
    if (chunk.type === "start") {
      // one-shot run: ensure dock open
      if (!isTermOpen()) setTermVisible(true);
      if (chunk.cwd) updateTermCwdLabel(chunk.cwd);
    } else if (chunk.type === "data") {
      if (!isTermOpen()) setTermVisible(true);
      appendTerm(chunk.text || "");
    } else if (chunk.type === "end") {
      // pure stream — no noisy exit footer for interactive shell
    }
  });

  wireToolsPanel();
  $("btnHooksTrust") && ($("btnHooksTrust").onclick = () => void setProjectFolderTrust(true));
  $("btnHooksUntrust") && ($("btnHooksUntrust").onclick = () => void setProjectFolderTrust(false));
  $("btnMcpAdd") &&
    ($("btnMcpAdd").onclick = async () => {
      const name = $("mcpName")?.value.trim();
      const cmd = $("mcpCmd")?.value.trim();
      if (!name || !cmd) {
        setCliOut(tt("mcpNeedFields", "Enter a name and command, or pick a preset."));
        return;
      }
      const parts = cmd.split(/\s+/).filter(Boolean);
      void runCli(["mcp", "add", name, "--", ...parts]);
    });
  $("btnMcpHttpAdd") &&
    ($("btnMcpHttpAdd").onclick = async () => {
      const name = $("mcpHttpName")?.value.trim();
      const url = $("mcpHttpUrl")?.value.trim();
      const kind = $("mcpHttpKind")?.value || "http";
      if (!name || !url) {
        setCliOut(tt("mcpNeedRemote", "Enter a name and URL for the remote server."));
        return;
      }
      void runCli(["mcp", "add", "--transport", kind === "sse" ? "sse" : "http", name, url]);
    });
  $("btnMcpRm") &&
    ($("btnMcpRm").onclick = async () => {
      const name = $("mcpRmName")?.value.trim();
      if (!name) {
        setCliOut(tt("mcpNeedName", "Enter the server name from List servers."));
        return;
      }
      void runCli(["mcp", "remove", name]);
    });
  $("btnMcpEn") &&
    ($("btnMcpEn").onclick = async () => {
      const name = $("mcpRmName")?.value.trim();
      if (!name) return;
      void runCli(["mcp", "enable", name]);
    });
  $("btnMcpDis") &&
    ($("btnMcpDis").onclick = async () => {
      const name = $("mcpRmName")?.value.trim();
      if (!name) return;
      void runCli(["mcp", "disable", name]);
    });
  $("btnWtStart") &&
    ($("btnWtStart").onclick = async () => {
      const name = $("wtName")?.value.trim();
      if (!name) {
        setCliOut(
          tt(
            "worktreeShowHint",
            "Enter a worktree name to show details, or use List worktrees.\nTo start a session in a worktree: Settings → Agent → Isolation.",
          ),
        );
        void runCli(["worktree", "list"]);
        return;
      }
      void runCli(["worktree", "show", name]);
    });
  $("btnWtRm") &&
    ($("btnWtRm").onclick = async () => {
      const name = $("wtName")?.value.trim();
      if (!name) {
        setCliOut(tt("worktreeNeedName", "Enter a worktree name to remove."));
        return;
      }
      void runCli(["worktree", "rm", name]);
    });
  $("btnPluginInstall") &&
    ($("btnPluginInstall").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) {
        setCliOut(tt("pluginNeedSource", "Enter a git URL, user/repo, or local path."));
        return;
      }
      void runCli(["plugin", "install", n, "--trust"]);
    });
  $("btnPluginUninstall") &&
    ($("btnPluginUninstall").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) return;
      void runCli(["plugin", "uninstall", n]);
    });
  $("btnPluginEnable") &&
    ($("btnPluginEnable").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) return;
      void runCli(["plugin", "enable", n]);
    });
  $("btnPluginDisable") &&
    ($("btnPluginDisable").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) return;
      void runCli(["plugin", "disable", n]);
    });
  $("btnPluginUpdate") &&
    ($("btnPluginUpdate").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) {
        setCliOut(tt("pluginNeedName", "Enter an installed plugin name to update."));
        return;
      }
      void runCli(["plugin", "update", n]);
    });
  $("btnPluginUpdateAll") &&
    ($("btnPluginUpdateAll").onclick = () => void runCli(["plugin", "update"]));
  $("btnPluginDetails") &&
    ($("btnPluginDetails").onclick = () => {
      const n = $("pluginName")?.value.trim();
      if (!n) {
        setCliOut(tt("pluginNeedName", "Enter an installed plugin name."));
        return;
      }
      void runCli(["plugin", "details", n]);
    });
  $("btnOpenMarketplaceTab") &&
    ($("btnOpenMarketplaceTab").onclick = () => {
      switchPanel("tools");
      switchToolsTab("marketplace");
      void refreshMarketplaceCatalog();
    });

  // Marketplace tab
  $("btnMktRefresh") &&
    ($("btnMktRefresh").onclick = () => void refreshMarketplaceCatalog());
  $("btnMktSources") &&
    ($("btnMktSources").onclick = () => void runCli(["plugin", "marketplace", "list", "--json"]));
  $("btnMktUpdate") &&
    ($("btnMktUpdate").onclick = async () => {
      await runCli(["plugin", "marketplace", "update"]);
      void refreshMarketplaceCatalog();
    });
  $("btnMktAddSource") &&
    ($("btnMktAddSource").onclick = async () => {
      const url = $("mktSourceUrl")?.value.trim();
      if (!url) {
        setCliOut(tt("mktNeedUrl", "Enter a git URL or user/repo to add."));
        return;
      }
      await runCli(["plugin", "marketplace", "add", url]);
      void refreshMarketplaceCatalog();
    });
  $("btnMktRmSource") &&
    ($("btnMktRmSource").onclick = async () => {
      const name = $("mktSourceName")?.value.trim();
      if (!name) {
        setCliOut(tt("mktNeedSourceName", "Enter the source name to remove."));
        return;
      }
      await runCli(["plugin", "marketplace", "remove", name]);
      void refreshMarketplaceCatalog();
    });
  $("mktFilter")?.addEventListener("input", () => paintMktPlugins());
  $("mktMarketFilter")?.addEventListener("change", () => paintMktPlugins());

  for (const t of document.querySelectorAll(".rtab[data-panel]")) {
    t.onclick = () => switchPanel(t.dataset.panel);
  }
  // More menu: Tasks / Results / Extensions (kept out of the main tab strip)
  $("btnPanelMore") &&
    ($("btnPanelMore").onclick = (e) => {
      e.stopPropagation();
      const menu = $("panelMoreMenu");
      const btn = $("btnPanelMore");
      if (!menu || !btn) return;
      const open = menu.classList.toggle("hidden") === false;
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  for (const b of document.querySelectorAll("#panelMoreMenu [data-panel]")) {
    b.onclick = (e) => {
      e.stopPropagation();
      switchPanel(b.dataset.panel);
    };
  }
  document.addEventListener("click", (e) => {
    if (!e.target?.closest?.(".rtab-more-wrap")) {
      $("panelMoreMenu")?.classList.add("hidden");
      $("btnPanelMore")?.setAttribute("aria-expanded", "false");
    }
  });

  // ── Voice input (Web Speech API — STT into composer; MCP voice is TTS-only) ──
  function wireVoiceInput() {
    const btn = $("btnVoice");
    if (!btn || !prompt) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      btn.disabled = true;
      btn.title = tt(
        "voiceUnsupported",
        "Voice input not available in this runtime (needs Chromium speech recognition).",
      );
      return;
    }
    let rec = null;
    let listening = false;
    let micStream = null;

    const stopMicStream = () => {
      if (micStream) {
        try {
          for (const t of micStream.getTracks()) t.stop();
        } catch {
          // ignore
        }
        micStream = null;
      }
    };

    const setListening = (on) => {
      listening = on;
      btn.classList.toggle("listening", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.title = on
        ? tt("voiceListening", "Listening… click to stop")
        : tt("voiceInput", "Voice input");
      if (!on) stopMicStream();
    };

    async function showMicDeniedHelp() {
      addMsg(
        "error",
        tt(
          "voiceDeniedHelp",
          "Microphone blocked. 1) Restart Grok Build after allowing mic. 2) Windows: Settings → Privacy → Microphone → allow desktop apps / Grok Build.",
        ),
      );
      try {
        if (api.openMicSettings) await api.openMicSettings();
      } catch {
        // ignore
      }
    }

    /**
     * Ask for mic via getUserMedia first — triggers Electron permission handlers
     * and Windows privacy prompt. Keep stream open while listening so OS keeps grant.
     */
    async function ensureMicrophone() {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          tt("voiceUnsupported", "Microphone API not available in this runtime."),
        );
      }
      stopMicStream();
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      return micStream;
    }

    btn.onclick = async () => {
      if (listening && rec) {
        try {
          rec.stop();
        } catch {
          // ignore
        }
        setListening(false);
        return;
      }
      btn.disabled = true;
      try {
        await ensureMicrophone();
      } catch (e) {
        btn.disabled = false;
        const name = e?.name || "";
        if (name === "NotAllowedError" || name === "PermissionDeniedError" || /denied|not allowed/i.test(String(e?.message || e))) {
          void showMicDeniedHelp();
        } else if (name === "NotFoundError") {
          addMsg("error", tt("voiceNoDevice", "No microphone found. Plug in a mic and try again."));
        } else {
          addMsg("error", e?.message || String(e));
        }
        stopMicStream();
        return;
      }
      btn.disabled = false;

      rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      const isVi =
        (typeof GrokI18n !== "undefined" && GrokI18n.getLang?.() === "vi") ||
        document.documentElement.lang === "vi";
      rec.lang = isVi ? "vi-VN" : "en-US";
      let base = prompt.value;
      let committed = "";
      rec.onresult = (ev) => {
        let interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          const t = r[0]?.transcript || "";
          if (r.isFinal) committed += t;
          else interim += t;
        }
        const piece = (committed + interim).trim();
        const sep = base && !/\s$/.test(base) && piece ? " " : "";
        prompt.value = base + sep + piece;
        autoSize();
        unlockChatInput();
      };
      rec.onerror = (ev) => {
        setListening(false);
        if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
          void showMicDeniedHelp();
        } else if (ev.error === "network") {
          addMsg(
            "error",
            tt(
              "voiceNetwork",
              "Speech service needs network (Chromium cloud STT). Check internet and try again.",
            ),
          );
        } else if (ev.error !== "aborted" && ev.error !== "no-speech") {
          addMsg("error", `${tt("voiceError", "Voice error")}: ${ev.error}`);
        }
      };
      rec.onend = () => setListening(false);
      try {
        base = prompt.value;
        committed = "";
        rec.start();
        setListening(true);
      } catch (e) {
        setListening(false);
        addMsg("error", e.message || String(e));
      }
    };
  }
  wireVoiceInput();
  // Simple: click the box focuses; no stopPropagation games
  prompt.addEventListener("click", () => unlockChatInput());
  prompt.addEventListener("input", () => onComposerInput());
  prompt.addEventListener("keydown", (e) => {
    const mentionOpen = $("mentionMenu") && !$("mentionMenu").classList.contains("hidden");
    const slashOpen = $("slashMenu") && !$("slashMenu").classList.contains("hidden");
    if (mentionOpen) {
      const items = [...$("mentionMenu").querySelectorAll(".mention-item")];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mentionActiveIndex = Math.min(items.length - 1, mentionActiveIndex + 1);
        items.forEach((el, i) => el.classList.toggle("active", i === mentionActiveIndex));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mentionActiveIndex = Math.max(0, mentionActiveIndex - 1);
        items.forEach((el, i) => el.classList.toggle("active", i === mentionActiveIndex));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const el = items[mentionActiveIndex];
        if (el) applyMention(el.textContent || "");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideMentionMenu();
        return;
      }
    }
    if (slashOpen) {
      const items = [...$("slashMenu").querySelectorAll(".slash-item")];
      const SC = globalThis.GrokSlashCommands;
      const caret = prompt.selectionStart ?? 0;
      const spec = SC?.menuForInput?.(prompt.value, caret);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashActiveIndex = Math.min(items.length - 1, slashActiveIndex + 1);
        items.forEach((el, i) => el.classList.toggle("active", i === slashActiveIndex));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashActiveIndex = Math.max(0, slashActiveIndex - 1);
        items.forEach((el, i) => el.classList.toggle("active", i === slashActiveIndex));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const cmd = spec?.items?.[slashActiveIndex];
        if (cmd) applySlashCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlashMenu();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (composerMultiline && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      void send();
    }
  });
  prompt.addEventListener("blur", () => {
    // delay so mousedown on mention/slash still fires
    setTimeout(() => {
      hideMentionMenu();
      hideSlashMenu();
    }, 150);
  });
  // Paste images (screenshot) → ACP image attachment
  prompt.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) void addImageFromBlob(blob, `paste-${Date.now()}.png`);
      }
    }
  });
  setupComposerChips();
  selModel.onchange = () => void onConfigChange(selModel);
  selEffort.onchange = () => void onConfigChange(selEffort);
  if (selMode) selMode.onchange = () => void onConfigChange(selMode);
  selPermission.onchange = () => {
    const mode = normalizePermissionMode(selPermission.value);
    if (selPermission.value !== mode) selPermission.value = mode;
    saveLayout({ permissionMode: mode });
    syncPermissionChip();
  };
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.classList.add("hidden");
  });

  // Phase B4 command palette
  const cmdPalette = globalThis.GrokCommandPalette?.create?.({
    commands: [
      { id: "connect", label: "Connect agent", hint: "Ctrl+Shift+C", keywords: "start", run: () => void connect() },
      { id: "disconnect", label: "Disconnect", keywords: "stop", run: () => void api.disconnect().then(() => setStatus("disconnected")) },
      {
        id: "parallel",
        label: "Spawn parallel agent",
        keywords: "slot multi process",
        run: () => void forkParallelAgent(),
      },
      {
        id: "marketplace",
        label: "Plugin marketplace",
        keywords: "plugins extensions catalog install",
        run: () => {
          setPanelVisible(true);
          switchPanel("tools");
          switchToolsTab("marketplace");
          void refreshMarketplaceCatalog();
        },
      },
      { id: "git", label: "Refresh git status", keywords: "branch pr", run: () => void refreshGitStrip() },
      { id: "new", label: "New chat tab", hint: "Ctrl+N", run: () => $("btnNew").click() },
      { id: "focus", label: "Focus message box", hint: "Ctrl+L", run: () => prompt.focus() },
      { id: "settings", label: "Settings", hint: "Ctrl+,", run: () => openSettings() },
      { id: "sidebar", label: "Toggle left sidebar", keywords: "projects", run: () => setSidebarVisible($("colSidebar")?.classList.contains("collapsed")) },
      { id: "panel", label: "Toggle right panel", hint: "Ctrl+P", run: () => setPanelVisible($("colEditor")?.classList.contains("collapsed")) },
      { id: "term", label: "Toggle terminal", hint: "Ctrl+T", run: () => setTermVisible(!isTermOpen()) },
      { id: "theme", label: "Toggle theme", hint: "Ctrl+Shift+T", run: () => void toggleTheme() },
      { id: "history", label: "Refresh chat history", run: () => void refreshHistory() },
      { id: "ide", label: "Open IDE", run: () => $("btnOpenIde")?.click() },
      { id: "ide-file", label: "Open current file in IDE", keywords: "goto deep link", run: () => void openCurrentInIde() },
      { id: "manager", label: "Open Tasks (background)", keywords: "jobs board inbox manager", run: () => switchPanel("manager") },
      { id: "artifacts", label: "Open Results (artifacts)", keywords: "artifacts plans outputs", run: () => switchPanel("artifacts") },
      { id: "queue-job", label: "Focus background task prompt", run: () => { switchPanel("manager"); $("jobPrompt")?.focus(); } },
      { id: "save-plan", label: "Save plan as artifact", run: () => void savePlanArtifact() },
      { id: "health", label: "Control plane health", keywords: "status d2", run: async () => {
        const h = await api.health?.();
        addStep(h ? `Health · ${h.connectionState} · ${h.executable}` : "Health unavailable");
      } },
      { id: "telemetry", label: "Latency summary", keywords: "perf metrics", run: () => {
        openSettings("general");
        void showTelemetrySummary();
      } },
      { id: "cancel", label: "Cancel current turn", hint: "Esc", run: () => void api.cancel() },
      { id: "usage", label: "Refresh usage", run: () => void refreshUsage?.() },
    ],
  });

  // Keyboard shortcuts — skip global binds while typing in the project terminal
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inTerm =
      e.target === $("termInput") ||
      e.target?.closest?.("#termDock") ||
      e.target?.id === "termInput";
    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      cmdPalette?.toggle?.();
      return;
    }
    if (cmdPalette?.isOpen?.()) return;
    // Terminal owns Enter / Ctrl+L / Ctrl+C when focused
    if (inTerm) {
      if (mod && e.key.toLowerCase() === "t" && !e.shiftKey) {
        e.preventDefault();
        setTermVisible(false);
      }
      return;
    }
    // (layout toggles below)
    if (mod && e.key === "Enter") {
      e.preventDefault();
      void send();
    } else if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      $("btnNew").click();
    } else if (mod && e.key.toLowerCase() === "l" && !e.shiftKey) {
      e.preventDefault();
      prompt.focus();
    } else if (mod && e.key === ",") {
      e.preventDefault();
      openSettings();
    } else if (mod && e.key.toLowerCase() === "b" && !e.shiftKey) {
      e.preventDefault();
      setSidebarVisible($("colSidebar")?.classList.contains("collapsed"));
    } else if (mod && e.key.toLowerCase() === "t" && !e.shiftKey) {
      e.preventDefault();
      setTermVisible(!isTermOpen());
    } else if (mod && e.key.toLowerCase() === "p" && !e.shiftKey) {
      e.preventDefault();
      const hidden = $("colEditor")?.classList.contains("collapsed");
      setPanelVisible(Boolean(hidden));
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      void toggleTheme();
    } else if (e.key === "Escape" && busy) {
      void api.cancel();
    }
  });

  $("btnAbout") &&
    ($("btnAbout").onclick = () => {
      settingsModal.classList.add("hidden");
      $("aboutVersion").textContent = `${bootstrap?.product || "Grok Build"} ${bootstrap?.version || ""}`;
      const authLine = authProfile?.loggedIn
        ? `Signed in: ${authProfile.email || authProfile.displayName || "yes"}`
        : "Not signed in";
      $("aboutPaths").textContent = `CLI: ${bootstrap?.executable || "grok"}\nPackaged: ${bootstrap?.isPackaged ? "yes" : "dev"}\n${authLine}`;
      $("aboutModal").classList.remove("hidden");
    });
  $("btnCloseAbout") && ($("btnCloseAbout").onclick = () => $("aboutModal").classList.add("hidden"));
  $("btnAboutDone") && ($("btnAboutDone").onclick = () => $("aboutModal").classList.add("hidden"));
  $("btnCheckUpdate") && ($("btnCheckUpdate").onclick = () => void checkUpdates());
  $("aboutModal")?.addEventListener("click", (e) => {
    if (e.target === $("aboutModal")) $("aboutModal").classList.add("hidden");
  });

  api.onMenuCommand?.((msg) => {
    const cmd = msg?.cmd;
    if (cmd === "openProject") void pickFolderAndSelect();
    else if (cmd === "newSession") $("btnNew").click();
    else if (cmd === "settings") openSettings();
    else if (cmd === "toggleTheme") void toggleTheme();
    else if (cmd === "focusPrompt") prompt.focus();
    else if (cmd === "sidebar") {
      setSidebarVisible($("colSidebar")?.classList.contains("collapsed"));
    } else if (cmd === "panel") {
      setPanelVisible($("colEditor")?.classList.contains("collapsed"));
    } else if (cmd === "terminal") {
      setTermVisible(!isTermOpen());
    } else if (cmd === "connect") void connect();
    else if (cmd === "disconnect") void api.disconnect().then(() => setStatus("disconnected"));
    else if (cmd === "cancel") void api.cancel();
    else if (cmd === "about") $("btnAbout")?.click();
  });

  // Drag-drop files/images onto composer
  if (composerEl) {
    composerEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      composerEl.classList.add("drag-over");
    });
    composerEl.addEventListener("dragleave", () => composerEl.classList.remove("drag-over"));
    composerEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      composerEl.classList.remove("drag-over");
      const files = [...(e.dataTransfer?.files || [])];
      for (const f of files) {
        if (f.type.startsWith("image/")) {
          await addImageFromBlob(f, f.name);
        } else {
          // path not available in browser File without path - use pick only for non-image
          // Electron File may have path
          const p = f.path;
          if (p) {
            if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) {
              try {
                attachments.push(await api.readFileBase64(p));
              } catch {
                attachments.push({ uri: `file://${p}`, name: f.name, path: p });
              }
            } else {
              attachments.push({ uri: `file://${p}`, name: f.name, path: p });
            }
          }
        }
      }
      renderAttachments();
    });
  }

  // Icons + i18n (single sources)
  if (typeof GrokI18n !== "undefined") {
    GrokI18n.load();
    GrokI18n.applyDom();
  }
  if (typeof GrokIcons !== "undefined") GrokIcons.applyAll();
  $("btnTheme") && ($("btnTheme").onclick = () => void toggleTheme());
  $("btnLang") && ($("btnLang").onclick = () => toggleLang());

  setupSplitters();
  ensureInputsInteractive();
  showEmpty();
  // Focus chat on load so user can type immediately
  setTimeout(() => {
    ensureInputsInteractive();
    prompt?.focus();
  }, 100);

  (async () => {
    bootstrap = await api.getBootstrap();
    recentsWorkspace = bootstrap.recentsWorkspace || null;
    extraRoots = Array.isArray(bootstrap.extraRoots) ? bootstrap.extraRoots : [];
    setWorkspace(bootstrap.workspaceRoot || null);
    sessionTabs?.updateActive?.({ cwd: effectiveWorkspace() || null });
    syncConvTitle();
    updateProjectChip();
    applyAuthProfile(bootstrap.auth || { loggedIn: false });
    void refreshAuthProfile();
    ensureInputsInteractive();
    if (bootstrap.permissionMode) {
      selPermission.value = normalizePermissionMode(bootstrap.permissionMode);
    }
    showReasoning = bootstrap.showReasoning !== false;
    applyTheme(bootstrap.theme || loadLayout().theme || "system", bootstrap.shouldUseDarkColors);
    applyComposerChrome();
    if (typeof GrokIcons !== "undefined") GrokIcons.applyAll();
    const L = loadLayout();
    if (L.permissionMode) {
      const mode = normalizePermissionMode(L.permissionMode);
      selPermission.value = mode;
      if (L.permissionMode !== mode) saveLayout({ permissionMode: mode });
    }
    // Seed models from `grok models` (bootstrap) — never leave "System default"
    seedModelsFromBootstrap();
    syncPermissionChip();
    syncModelChip();
    renderProjects();
    void refreshHistory();
    // Refresh model list + detect CLI/model updates in background
    void api.listModels?.().then((info) => {
      mergeLiveModels(info, { notifyNew: true });
    });
    // Quiet probe on launch (banner only if a newer version is available)
    void checkUpdates({ quiet: true });
    void checkCliUpdates({ quiet: true });
    if (bootstrap.autoConnect !== false && bootstrap.workspaceRoot) {
      void connect(bootstrap.workspaceRoot);
    }
  })();
})();
