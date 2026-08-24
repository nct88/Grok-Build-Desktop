/**
 * Phase A2 — virtualized timeline over GrokEventStore.
 * Windowed DOM when item count is large; always mounts live streaming nodes.
 */
(() => {
  const VIRTUAL_THRESHOLD = 64;
  const OVERSCAN = 10;
  const EST = {
    user: 72,
    assistant: 140,
    thought: 48,
    step: 28,
    error: 64,
    review: 52,
    foot: 24,
    empty: 100,
    tool: 56,
    tool_group: 52,
    permission: 88,
    activity: 32,
    recap: 72,
  };

  function formatClock(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  /**
   * @param {HTMLElement} root
   * @param {{
   *   store: ReturnType<typeof globalThis.GrokEventStore.create>,
   *   showReasoning?: () => boolean,
   *   openExternal?: (href: string) => void,
   *   onReview?: (meta: object) => void,
   *   onPermission?: (requestId: string, optionId: string) => void,
   *   resolveMediaSrc?: (src: string) => Promise<string|null>,
   *   resolveMedia?: (src: string) => Promise<{url:string,path?:string,mimeType?:string,kind?:string}|null>,
   *   onMediaActivate?: (info: object) => void,
   *   onMediaContext?: (info: object, pos: {x:number,y:number}) => void,
   *   onPathActivate?: (info: {path:string,label?:string}) => void,
   *   onPathContext?: (info: {path:string,label?:string}, pos: {x:number,y:number}) => void,
   *   emptyTitle?: () => string,
   *   emptyBody?: () => string,
   *   t?: (key: string, fallback?: string) => string,
   * }} opts
   */
  function createTimelineView(root, opts) {
    const store = opts.store;
    const off = globalThis.GrokOffthread;
    const md = globalThis.GrokMarkdown;
    const pathLinks = globalThis.GrokPathLinks;
    const slash = globalThis.GrokSlashCommands;
    const t = (key, fallback) => {
      if (typeof opts.t === "function") {
        const v = opts.t(key, fallback);
        return v != null && v !== "" ? v : fallback || key;
      }
      return fallback || key;
    };

    function toolStatusLabel(status) {
      const s = String(status || "done").toLowerCase();
      if (s === "running") return t("toolStatusRunning", "running");
      if (s === "pending") return t("toolStatusPending", "pending");
      if (s === "failed" || s === "error") return t("toolStatusFailed", "failed");
      if (s === "completed" || s === "done") return t("toolStatusCompleted", "done");
      return status || "";
    }

    function localizedToolTitle(value, status) {
      const title = String(value || "").trim();
      const running = status === "running" || status === "pending";
      if (running) {
        const prepared = preparingToolLabel(title);
        if (prepared) return prepared;
      }
      return !title || /^(?:tool|tools)$/i.test(title) ? t("labelTools", "Tools") : title;
    }

    /** Grok CLI 1.0.5 preparing spinner: readable labels while arguments arrive. */
    function preparingToolLabel(title) {
      const raw = String(title || "").trim();
      if (!raw) return t("preparingWriteFile", "Writing file…");
      if (/^(?:mcp__|user-)/i.test(raw) && !/\s/.test(raw)) {
        const short = raw.replace(/^(?:mcp__|user-)/i, "").replace(/[_-]+/g, " ");
        return t("preparingNamedTool", "Preparing {name}…").replace("{name}", short || raw);
      }
      if (/^edit\b|search_replace|str_replace/i.test(raw)) return t("preparingWriteEdit", "Writing edit…");
      if (/^write\b|^create\b/i.test(raw)) return t("preparingWriteFile", "Writing file…");
      if (/^read\b|^read_file\b/i.test(raw)) return t("preparingReadFile", "Reading file…");
      if (/grep|search|glob|web_search|web_fetch/i.test(raw)) return t("preparingSearch", "Searching…");
      if (/list_dir|listdir|list directory/i.test(raw)) return t("preparingListDir", "Listing directory…");
      if (/bash|shell|terminal|run_terminal/i.test(raw)) return t("preparingCommand", "Running command…");
      return "";
    }

    function toolGroupPreview(tools) {
      const list = tools || [];
      const running = list.some((x) => x.status === "running" || x.status === "pending");
      const done = list.filter((x) => x.status === "completed" || x.status === "done").length;
      const failed = list.filter((x) => x.status === "failed" || x.status === "error").length;
      if (list.length <= 1) return localizedToolTitle(list[0]?.title);
      let s = t("toolsSteps", "{n} steps").replace("{n}", String(list.length));
      if (running) s += " · " + t("toolsRunningN", "{n} running").replace("{n}", String(list.filter((x) => x.status === "running" || x.status === "pending").length));
      else if (failed) s += " · " + t("toolsFailedN", "{n} failed").replace("{n}", String(failed));
      else if (done) s += " · " + t("toolsDoneN", "{n} done").replace("{n}", String(done));
      return s;
    }

    function thoughtTitle(item) {
      if (item.streaming) return t("phaseThinking", "Thinking");
      const duration = item.meta?.durationLabel;
      if (duration) {
        return t("thoughtFor", "Thought for {t}").replace("{t}", duration);
      }
      if (item.meta?.persisted) {
        const preview = String(item.text || "")
          .replace(/```[\s\S]*?```/g, " ")
          .replace(/[*_`#>\[\]]/g, "")
          .replace(/\s+/g, " ")
          .trim();
        if (preview) return preview.length > 96 ? `${preview.slice(0, 95).trimEnd()}…` : preview;
      }
      return t("labelThinking", "Thinking");
    }

    root.classList.add("timeline", "tl-virtual");
    root.innerHTML = `
      <div class="tl-spacer tl-spacer-top" aria-hidden="true"></div>
      <div class="tl-window"></div>
      <div class="tl-spacer tl-spacer-bottom" aria-hidden="true"></div>
    `;
    const spacerTop = root.querySelector(".tl-spacer-top");
    const spacerBottom = root.querySelector(".tl-spacer-bottom");
    const windowEl = root.querySelector(".tl-window");

    /** @type {Map<number, HTMLElement>} */
    const nodeMap = new Map();
    /** @type {Map<number, number>} */
    const heightCache = new Map();
    /** @type {Map<number, number>} async md generation tokens */
    const mdGenMap = new Map();
    let stickToBottom = true;
    let renderScheduled = false;
    let disposed = false;
    /** Prevent scroll-handler from treating programmatic bottom snaps as user leave */
    let ignoreScrollUntil = 0;
    let lastUserScrollTop = 0;

    function estimateHeight(item) {
      if (heightCache.has(item.id)) return heightCache.get(item.id);
      const base = EST[item.kind] || 48;
      const textLen = (item.text || "").length;
      const lines = Math.ceil(textLen / 80);
      // Open thought/tool groups are taller than collapsed chips
      let openBoost = 0;
      if (item.kind === "thought" && (item.streaming || item.meta?.open !== false)) {
        openBoost = Math.min(240, 40 + Math.ceil(textLen / 60) * 14);
      }
      if (item.kind === "tool_group") {
        const n = (item.meta?.tools || []).length || 1;
        openBoost = n * 36;
      }
      return base + openBoost + Math.min(600, Math.max(0, lines - 2) * 15);
    }

    function measure(el, id) {
      if (!el || el.hidden) return 0;
      const h = el.getBoundingClientRect().height;
      if (h > 0) {
        const prev = heightCache.get(id);
        heightCache.set(id, h);
        return prev != null && Math.abs(prev - h) > 2 ? h : h;
      }
      return 0;
    }

    /** Strict: only re-stick when truly pinned to the end */
    function isAtBottom() {
      const gap = root.scrollHeight - root.scrollTop - root.clientHeight;
      return gap <= 8;
    }

    /**
     * Scroll to latest content. force=true re-enables stick-to-bottom
     * (user send / turn complete). force=false only follows if already stuck.
     */
    function scrollEnd(force) {
      if (force) stickToBottom = true;
      if (!force && !stickToBottom) return;
      ignoreScrollUntil = performance.now() + 120;
      requestAnimationFrame(() => {
        if (disposed) return;
        root.scrollTop = root.scrollHeight;
        lastUserScrollTop = root.scrollTop;
      });
    }

    /** Capture first visible item so remeasure doesn't jump mid-read */
    function captureScrollAnchor() {
      if (stickToBottom) return null;
      const items = store.items;
      const top = root.scrollTop;
      let acc = 0;
      for (let i = 0; i < items.length; i++) {
        const h = estimateHeight(items[i]);
        if (acc + h > top + 1) {
          return { id: items[i].id, offset: top - acc, index: i };
        }
        acc += h;
      }
      return null;
    }

    function restoreScrollAnchor(anchor) {
      if (!anchor || stickToBottom) return;
      const items = store.items;
      let acc = 0;
      for (let i = 0; i < items.length; i++) {
        if (items[i].id === anchor.id) {
          ignoreScrollUntil = performance.now() + 80;
          root.scrollTop = Math.max(0, acc + anchor.offset);
          return;
        }
        acc += estimateHeight(items[i]);
      }
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function placeholderSvg(label, sub) {
      const a = label || "Loading…";
      const b = sub || "";
      return (
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect fill="#1a1a1a" width="100%" height="100%"/><text x="50%" y="${b ? "45%" : "50%"}" fill="#888" font-size="12" text-anchor="middle" dy=".3em">${a}</text>${b ? `<text x="50%" y="62%" fill="#666" font-size="10" text-anchor="middle">${b}</text>` : ""}</svg>`,
        )
      );
    }

    /**
     * @param {HTMLElement} mediaEl
     * @param {{ kind: string, rawSrc: string, displayUrl?: string|null, filePath?: string|null, mimeType?: string|null, alt?: string }} info
     */
    function bindMediaChrome(mediaEl, info) {
      mediaEl.classList.add("media-interactive");
      mediaEl.title = "Click to enlarge · Right-click for more";
      const getInfo = () => ({
        kind: info.kind,
        rawSrc: info.rawSrc,
        displayUrl: info.displayUrl || mediaEl.getAttribute("src") || "",
        filePath: info.filePath || "",
        mimeType: info.mimeType || "",
        alt: info.alt || "",
      });
      mediaEl.addEventListener("click", (e) => {
        // Let native video controls work for play/scrub; only enlarge on poster/body click outside controls is hard —
        // double-click / click when not interacting with controls: use click on card chrome for video enlarge via button
        if (info.kind === "video" && e.target?.closest?.("video")) {
          // single click on video = play; use double-click to enlarge
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        opts.onMediaActivate?.(getInfo());
      });
      if (info.kind === "video") {
        mediaEl.addEventListener("dblclick", (e) => {
          e.preventDefault();
          e.stopPropagation();
          opts.onMediaActivate?.(getInfo());
        });
      }
      mediaEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        opts.onMediaContext?.(getInfo(), { x: e.clientX, y: e.clientY });
      });
    }

    async function resolveRef(ref) {
      if (ref.src.startsWith("data:") || /^https?:\/\//i.test(ref.src)) {
        return {
          url: ref.src,
          path: "",
          mimeType: ref.kind === "video" ? "video/mp4" : "image/png",
          kind: ref.kind,
        };
      }
      if (opts.resolveMedia) {
        const meta = await opts.resolveMedia(ref.src);
        if (meta?.url) {
          return {
            url: meta.url,
            path: meta.path || "",
            mimeType: meta.mimeType || "",
            kind: meta.kind || ref.kind,
          };
        }
        return null;
      }
      if (opts.resolveMediaSrc) {
        const url = await opts.resolveMediaSrc(ref.src);
        return url ? { url, path: "", mimeType: "", kind: ref.kind } : null;
      }
      return null;
    }

    function mountMediaStrip(el, item) {
      if (item.streaming) return;
      const refs =
        item.meta?.media ||
        (slash?.extractMediaRefs ? slash.extractMediaRefs(item.text || "") : []);
      if (!refs?.length) return;
      let strip = el.querySelector(".media-strip");
      if (!strip) {
        strip = document.createElement("div");
        strip.className = "media-strip";
        el.appendChild(strip);
      }
      strip.innerHTML = "";
      for (const ref of refs.slice(0, 8)) {
        const card = document.createElement("div");
        card.className = "media-card";
        card.dataset.rawSrc = ref.src;
        card.dataset.kind = ref.kind || "image";

        if (ref.kind === "video") {
          const v = document.createElement("video");
          v.className = "media-video media-broken";
          v.controls = true;
          v.preload = "metadata";
          v.playsInline = true;
          // Placeholder — local paths must be resolved (CSP blocks file://)
          card.appendChild(v);
          const applyVideo = (meta) => {
            if (!v.isConnected) return;
            if (meta?.url) {
              v.src = meta.url;
              v.classList.remove("media-broken");
              v.dataset.filePath = meta.path || "";
              bindMediaChrome(v, {
                kind: "video",
                rawSrc: ref.src,
                displayUrl: meta.url,
                filePath: meta.path || "",
                mimeType: meta.mimeType || "video/mp4",
                alt: ref.alt || "",
              });
              // Context menu also on card (controls eat some events)
              card.oncontextmenu = (e) => {
                e.preventDefault();
                opts.onMediaContext?.(
                  {
                    kind: "video",
                    rawSrc: ref.src,
                    displayUrl: meta.url,
                    filePath: meta.path || "",
                    mimeType: meta.mimeType || "video/mp4",
                    alt: ref.alt || "",
                  },
                  { x: e.clientX, y: e.clientY },
                );
              };
            } else {
              v.classList.add("media-broken");
              v.removeAttribute("src");
            }
          };
          if (ref.src.startsWith("data:") || /^https?:\/\//i.test(ref.src)) {
            applyVideo({ url: ref.src, path: "", mimeType: "video/mp4" });
          } else {
            resolveRef(ref).then(applyVideo);
          }
        } else {
          const img = document.createElement("img");
          img.className = "media-img";
          img.alt = ref.alt || "image";
          img.loading = "lazy";
          img.dataset.rawSrc = ref.src;
          img.src = placeholderSvg("Loading…");
          card.appendChild(img);
          const applySrc = (meta) => {
            if (!img.isConnected) return;
            const url = typeof meta === "string" ? meta : meta?.url;
            const filePath = typeof meta === "object" && meta ? meta.path || "" : "";
            const mimeType =
              typeof meta === "object" && meta ? meta.mimeType || "image/png" : "image/png";
            if (url) {
              img.src = url;
              img.classList.remove("media-broken");
              img.dataset.filePath = filePath;
              bindMediaChrome(img, {
                kind: "image",
                rawSrc: ref.src,
                displayUrl: url,
                filePath,
                mimeType,
                alt: ref.alt || "",
              });
              card.oncontextmenu = (e) => {
                e.preventDefault();
                opts.onMediaContext?.(
                  {
                    kind: "image",
                    rawSrc: ref.src,
                    displayUrl: url,
                    filePath,
                    mimeType,
                    alt: ref.alt || "",
                  },
                  { x: e.clientX, y: e.clientY },
                );
              };
            } else {
              img.classList.add("media-broken");
              img.src = placeholderSvg("Preview failed", "Right-click for options");
              bindMediaChrome(img, {
                kind: "image",
                rawSrc: ref.src,
                displayUrl: "",
                filePath: "",
                mimeType: "",
                alt: ref.alt || "",
              });
            }
          };
          if (ref.src.startsWith("data:")) {
            applySrc({ url: ref.src, path: "", mimeType: "image/png" });
          } else if (/^https?:\/\//i.test(ref.src)) {
            img.onerror = () => {
              resolveRef(ref).then(applySrc);
            };
            img.src = ref.src;
            bindMediaChrome(img, {
              kind: "image",
              rawSrc: ref.src,
              displayUrl: ref.src,
              filePath: "",
              mimeType: "image/png",
              alt: ref.alt || "",
            });
          } else {
            resolveRef(ref).then(applySrc);
          }
        }
        const cap = document.createElement("div");
        cap.className = "media-cap";
        const name =
          (ref.alt || ref.src || "").replace(/\\/g, "/").split("/").pop() || "";
        cap.textContent = name;
        cap.title = ref.src;
        // Enlarge button for videos (single-click plays)
        if (ref.kind === "video") {
          const zoomBtn = document.createElement("button");
          zoomBtn.type = "button";
          zoomBtn.className = "media-zoom-btn";
          zoomBtn.textContent = "Enlarge";
          zoomBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const v = card.querySelector("video");
            opts.onMediaActivate?.({
              kind: "video",
              rawSrc: ref.src,
              displayUrl: v?.src || "",
              filePath: v?.dataset?.filePath || "",
              mimeType: "video/mp4",
              alt: ref.alt || "",
            });
          };
          card.appendChild(zoomBtn);
        }
        card.appendChild(cap);
        strip.appendChild(card);
      }
    }

    function hydrateImages(el) {
      for (const img of el.querySelectorAll("img.md-img[data-raw-src], img.md-img")) {
        const raw =
          img.getAttribute("data-raw-src") ||
          img.dataset?.rawSrc ||
          img.getAttribute("src") ||
          "";
        if (!raw) continue;
        if (img.dataset.mediaBound === "1") continue;
        img.dataset.mediaBound = "1";
        const apply = (meta) => {
          if (!img.isConnected) return;
          const url = typeof meta === "string" ? meta : meta?.url;
          const filePath = typeof meta === "object" && meta ? meta.path || "" : "";
          if (url) {
            img.src = url;
            img.dataset.filePath = filePath;
          }
          bindMediaChrome(img, {
            kind: "image",
            rawSrc: raw,
            displayUrl: url || img.src,
            filePath,
            mimeType: (typeof meta === "object" && meta?.mimeType) || "image/png",
            alt: img.alt || "",
          });
        };
        if (raw.startsWith("data:") || /^https?:\/\//i.test(raw)) {
          apply({ url: raw, path: "", mimeType: "image/png" });
          continue;
        }
        if (opts.resolveMedia) {
          opts.resolveMedia(raw).then(apply);
        } else if (opts.resolveMediaSrc) {
          opts.resolveMediaSrc(raw).then((url) => apply(url ? { url, path: "" } : null));
        }
      }
    }

    function bindAssistantContent(el, item, structured) {
      const text = item.text || "";
      if (!text) {
        el.textContent = "";
        el.classList.remove("md-streaming", "md-structured");
        return;
      }

      // Live stream: plain text + pre-wrap (CLI-like). Avoid MD thrash every frame.
      if (item.streaming || !structured) {
        // Cancel any in-flight structured render for this node
        mdGenMap.set(item.id, (mdGenMap.get(item.id) || 0) + 1);
        el.classList.add("md-body", "md-streaming");
        el.classList.remove("md-structured");
        delete el.dataset.mdPending;
        // Only rewrite when text actually changed (reduces layout thrash / flicker)
        if (el.dataset.streamText !== text) {
          el.dataset.streamText = text;
          el.textContent = text;
        }
        heightCache.delete(item.id);
        return;
      }

      // Final answer: keep plain/pre-wrap visible until MD HTML is ready
      // (prevents empty flash, newline collapse, and race rewrites).
      delete el.dataset.streamText;
      const gen = (mdGenMap.get(item.id) || 0) + 1;
      mdGenMap.set(item.id, gen);

      const applyFinal = (applyFn) => {
        if (disposed || el.dataset.itemId !== String(item.id)) return;
        if (mdGenMap.get(item.id) !== gen) return;
        delete el.dataset.mdPending;
        el.classList.remove("md-streaming");
        applyFn();
        pathLinks?.hydrate?.(el, {
          onActivate: opts.onPathActivate,
          onContext: opts.onPathContext,
        });
        hydrateImages(el);
        mountMediaStrip(el, item);
        measure(el, item.id);
        if (stickToBottom) scrollEnd(false);
      };

      if (off?.renderMarkdownHtml) {
        // Seed plain so node is never empty while worker runs
        if (!el.classList.contains("md-structured")) {
          el.classList.add("md-body", "md-streaming");
          if (el.textContent !== text) el.textContent = text;
        }
        el.dataset.mdPending = "1";
        off.renderMarkdownHtml(text).then((html) => {
          applyFinal(() => {
            off.applyStructuredHtml(el, html, opts.openExternal);
          });
        });
      } else if (md?.setStructuredContent) {
        applyFinal(() => {
          md.setStructuredContent(el, text, opts.openExternal);
        });
      } else {
        el.classList.remove("md-streaming");
        el.textContent = text;
        pathLinks?.hydrate?.(el, {
          onActivate: opts.onPathActivate,
          onContext: opts.onPathContext,
        });
        mountMediaStrip(el, item);
      }
    }

    /**
     * Simple red/green line view for edit diffs (CLI-style).
     * @param {HTMLElement} host
     * @param {string} [oldText]
     * @param {string} [newText]
     * @param {string} [path]
     */
    function renderCliDiff(host, oldText, newText, path) {
      const wrap = document.createElement("div");
      wrap.className = "cli-diff";
      if (path) {
        const head = document.createElement("div");
        head.className = "cli-diff-path";
        head.textContent = path.replace(/\\/g, "/").split("/").pop() || path;
        head.title = path;
        head.onclick = (ev) => {
          ev.preventDefault();
          opts.onReview?.({ path, oldText, newText });
        };
        wrap.appendChild(head);
      }
      const pre = document.createElement("pre");
      pre.className = "cli-diff-pre";
      const a = String(oldText ?? "").split(/\r?\n/);
      const b = String(newText ?? "").split(/\r?\n/);
      // Prefer off-thread LCS when available later; fast path for UI: show del then add
      // If both empty, skip
      if (!a.length && !b.length) return;
      const HD = globalThis.GrokDiffHunks;
      let rows = null;
      if (HD?.groupHunks && (oldText != null || newText != null)) {
        // Use lineDiff if rows not precomputed — lightweight local LCS for small files
        try {
          // sync coarse: mark all old as del, all new as add when huge
          if (a.length * b.length > 80_000) {
            rows = [
              ...a.slice(0, 80).map((l) => ({ t: "del", l })),
              ...b.slice(0, 80).map((l) => ({ t: "add", l })),
            ];
          }
        } catch {
          rows = null;
        }
      }
      if (!rows) {
        // Minimal: show unified context by index alignment when lengths small
        rows = [];
        const n = Math.max(a.length, b.length);
        if (n <= 200 && a.length && b.length) {
          // greedy: output dels for lines only in old prefix then adds
          const maxShow = 120;
          for (let i = 0; i < a.length && rows.length < maxShow; i++) {
            if (b[i] !== a[i]) {
              if (a[i] !== undefined) rows.push({ t: "del", l: a[i] });
              if (b[i] !== undefined) rows.push({ t: "add", l: b[i] });
            } else {
              rows.push({ t: "ctx", l: a[i] });
            }
          }
          for (let i = a.length; i < b.length && rows.length < maxShow; i++) {
            rows.push({ t: "add", l: b[i] });
          }
        } else {
          for (const l of a.slice(0, 60)) rows.push({ t: "del", l });
          for (const l of b.slice(0, 60)) rows.push({ t: "add", l });
        }
      }
      for (const r of rows.slice(0, 160)) {
        const line = document.createElement("div");
        line.className =
          r.t === "add" ? "cli-diff-add" : r.t === "del" ? "cli-diff-del" : "cli-diff-ctx";
        const mark = r.t === "add" ? "+" : r.t === "del" ? "−" : " ";
        line.textContent = `${mark} ${r.l}`;
        pre.appendChild(line);
      }
      wrap.appendChild(pre);
      host.appendChild(wrap);
    }

    function fillToolBody(body, item) {
      if (!body) return;
      body.replaceChildren();
      const detail = item.meta?.detail || "";
      if (detail) {
        const det = document.createElement("div");
        det.className = "cli-tool-detail";
        det.textContent = String(detail).slice(0, 2000);
        body.appendChild(det);
      }
      const diffs = item.meta?.diffs?.length
        ? item.meta.diffs
        : item.meta?.path
          ? [{ path: item.meta.path, oldText: item.meta.oldText, newText: item.meta.newText }]
          : [];
      for (const d of diffs.slice(0, 4)) {
        if (d.newText != null || d.oldText != null) {
          renderCliDiff(body, d.oldText, d.newText, d.path);
        } else if (d.path) {
          const p = document.createElement("button");
          p.type = "button";
          p.className = "cli-tool-path-btn";
          p.textContent = d.path.replace(/\\/g, "/").split("/").pop() || d.path;
          p.onclick = () => opts.onReview?.({ path: d.path, oldText: d.oldText, newText: d.newText });
          body.appendChild(p);
        }
      }
      if (!body.childNodes.length && item.meta?.path) {
        const p = document.createElement("button");
        p.type = "button";
        p.className = "cli-tool-path-btn";
        p.textContent = item.meta.path;
        p.onclick = () =>
          opts.onReview?.({
            path: item.meta.path,
            oldText: item.meta.oldText,
            newText: item.meta.newText,
          });
        body.appendChild(p);
      }
    }

    function buildToolInner(tool) {
      const row = document.createElement("details");
      row.className = "cli-tool nested";
      const running = tool.status === "running" || tool.status === "pending";
      row.open = running;
      row.innerHTML = `<summary class="cli-line">
        <span class="cli-mark" aria-hidden="true">${running ? "◆" : "◇"}</span>
        <span class="cli-line-title"></span>
      </summary><div class="cli-tool-body"></div>`;
      row.querySelector(".cli-line-title").textContent = localizedToolTitle(tool.title);
      fillToolBody(row.querySelector(".cli-tool-body"), { meta: tool, text: tool.title });
      return row;
    }

    function createNode(item) {
      if (item.kind === "thought" && opts.showReasoning && !opts.showReasoning()) {
        const hidden = document.createElement("div");
        hidden.className = "tl-item tl-hidden";
        hidden.dataset.itemId = String(item.id);
        hidden.hidden = true;
        return hidden;
      }

      if (item.kind === "user") {
        const d = document.createElement("div");
        d.className = "msg user tl-item";
        d.dataset.itemId = String(item.id);
        if (item.ts) d.dataset.ts = formatClock(item.ts);
        d.textContent = item.text || "";
        const atts = item.meta?.attachments || [];
        if (atts.length) {
          const strip = document.createElement("div");
          strip.className = "media-strip user-atts";
          for (const a of atts.slice(0, 6)) {
            if (a.mimeType?.startsWith("image/") && a.data) {
              const img = document.createElement("img");
              img.className = "media-img";
              img.alt = a.name || "attachment";
              img.src = `data:${a.mimeType};base64,${a.data}`;
              strip.appendChild(img);
            } else {
              const chip = document.createElement("span");
              chip.className = "attach-chip";
              chip.textContent = a.name || "file";
              strip.appendChild(chip);
            }
          }
          d.appendChild(strip);
        }
        return d;
      }
      if (item.kind === "assistant") {
        const d = document.createElement("div");
        d.className = "msg assistant tl-item";
        d.dataset.itemId = String(item.id);
        if (item.ts) d.dataset.ts = formatClock(item.ts);
        bindAssistantContent(d, item, !item.streaming);
        return d;
      }
      if (item.kind === "activity") {
        // Live phase lives in #turnStatus footer (CLI-like); hide mid-timeline chips
        const d = document.createElement("div");
        d.className = "tl-item tl-hidden";
        d.dataset.itemId = String(item.id);
        d.hidden = true;
        return d;
      }
      if (item.kind === "recap") {
        const d = document.createElement("details");
        d.className = "cli-recap tl-item";
        d.open = Boolean(item.meta?.open);
        d.dataset.itemId = String(item.id);
        const lastTurn = String(item.meta?.lastTurnSummary || "").trim();
        d.innerHTML = `<summary class="cli-line">
          <span class="cli-mark" aria-hidden="true">▣</span>
          <span class="cli-line-title"></span>
        </summary><div class="cli-recap-body body"></div>`;
        d.querySelector(".cli-line-title").textContent =
          lastTurn || t("sessionRecap", "Session recap");
        d.querySelector(".body").textContent = item.text || lastTurn || "";
        return d;
      }
      if (item.kind === "thought") {
        // CLI: "◆ Thought for 1.8s" — expand to read stream
        const d = document.createElement("details");
        d.className = "cli-thought tl-item";
        d.open = Boolean(item.streaming) || Boolean(item.meta?.open);
        d.dataset.itemId = String(item.id);
        const title = thoughtTitle(item);
        d.innerHTML = `<summary class="cli-line">
          <span class="cli-mark" aria-hidden="true">◆</span>
          <span class="cli-line-title"></span>
        </summary><div class="cli-thought-body body"></div>`;
        d.querySelector(".cli-line-title").textContent = title;
        d.querySelector(".body").textContent = item.text || "";
        return d;
      }
      if (item.kind === "tool_group") {
        // Legacy grouped tools (older sessions) — still render compact
        const d = document.createElement("details");
        d.className = "cli-tool-group tl-item";
        const tools = item.meta?.tools || [];
        const running = tools.some(
          (x) => x.status === "running" || x.status === "pending",
        );
        d.open = Boolean(item.meta?.open) || running;
        d.dataset.itemId = String(item.id);
        d.innerHTML = `<summary class="cli-line">
          <span class="cli-mark" aria-hidden="true">◇</span>
          <span class="cli-line-title"></span>
        </summary><div class="cli-tool-group-body"></div>`;
        d.querySelector(".cli-line-title").textContent = toolGroupPreview(tools);
        const body = d.querySelector(".cli-tool-group-body");
        for (const tool of tools) {
          body.appendChild(buildToolInner(tool));
        }
        return d;
      }
      if (item.kind === "tool") {
        // CLI: "◇ Read 3 files" / "Edit path" — expand for detail + red/green diff
        const d = document.createElement("details");
        const status = item.meta?.status || "done";
        const running = status === "running" || status === "pending";
        d.className = "cli-tool tl-item";
        d.open = Boolean(item.meta?.open) || running;
        d.dataset.itemId = String(item.id);
        d.dataset.status = status;
        const title = localizedToolTitle(item.text || item.meta?.title, status);
        d.innerHTML = `<summary class="cli-line">
          <span class="cli-mark${running ? " spin-dot" : ""}" aria-hidden="true">${running ? "◆" : "◇"}</span>
          <span class="cli-line-title"></span>
          <span class="cli-line-meta"></span>
        </summary><div class="cli-tool-body"></div>`;
        d.querySelector(".cli-line-title").textContent = title;
        const metaEl = d.querySelector(".cli-line-meta");
        if (metaEl && !running && status !== "completed" && status !== "done") {
          metaEl.textContent = toolStatusLabel(status);
        }
        fillToolBody(d.querySelector(".cli-tool-body"), item);
        return d;
      }
      if (item.kind === "permission") {
        const d = document.createElement("div");
        d.className = "perm-card tl-item";
        d.dataset.itemId = String(item.id);
        const resolved = Boolean(item.meta?.resolved);
        const title = item.text || t("phasePermission", "Waiting for permission");
        d.innerHTML = `
          <div class="perm-card-head">
            <span class="perm-badge">${escapeHtml(t("labelPermission", "Permission"))}</span>
            <strong class="perm-title">${escapeHtml(title)}</strong>
            ${item.meta?.kind ? `<span class="perm-kind">${escapeHtml(item.meta.kind)}</span>` : ""}
          </div>
          <div class="perm-card-actions"></div>`;
        const actions = d.querySelector(".perm-card-actions");
        if (resolved) {
          actions.innerHTML = `<span class="perm-resolved">${escapeHtml(item.meta?.resultLabel || t("labelResolved", "Resolved"))}</span>`;
        } else {
          for (const opt of item.meta?.options || []) {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "perm-btn" + (/allow|accept|yes/i.test(opt.name) ? " primary" : "");
            b.textContent = opt.name;
            b.onclick = () => opts.onPermission?.(item.meta.requestId, opt.optionId);
            actions.appendChild(b);
          }
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "perm-btn ghost";
          cancel.textContent = t("cancel", "Cancel");
          cancel.onclick = () => opts.onPermission?.(item.meta.requestId, "__cancel__");
          actions.appendChild(cancel);
        }
        return d;
      }
      if (item.kind === "step") {
        const d = document.createElement("div");
        d.className = "step tl-item";
        d.dataset.itemId = String(item.id);
        d.textContent = item.text || "";
        return d;
      }
      if (item.kind === "error") {
        const d = document.createElement("div");
        d.className = "msg error tl-item";
        d.dataset.itemId = String(item.id);
        d.textContent = item.text || "";
        return d;
      }
      if (item.kind === "review") {
        const d = document.createElement("div");
        d.className = "review-chip tl-item";
        d.dataset.itemId = String(item.id);
        const path = String(item.meta?.path || item.text || "");
        const basen = path.replace(/\\/g, "/").split("/").pop() || path;
        const count = item.meta?.editCount || 1;
        const fileLabel =
          count === 1
            ? t("reviewFiles", "{n} file").replace("{n}", String(count))
            : t("reviewFilesPlural", "{n} files").replace("{n}", String(count));
        d.innerHTML = `<span><strong>${escapeHtml(fileLabel)}</strong> · ${escapeHtml(basen)}</span>`;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "review-btn";
        btn.textContent = t("review", "Review");
        btn.onclick = () => opts.onReview?.(item.meta || {});
        d.appendChild(btn);
        return d;
      }
      if (item.kind === "foot") {
        const d = document.createElement("div");
        d.className = "time-foot tl-item";
        d.dataset.itemId = String(item.id);
        d.textContent = item.text || "";
        return d;
      }
      if (item.kind === "empty") {
        const d = document.createElement("div");
        d.className = "empty-hero tl-item";
        d.dataset.itemId = String(item.id);
        d.innerHTML = `<h2>${escapeHtml(opts.emptyTitle?.() || "project")}</h2><p>${escapeHtml(opts.emptyBody?.() || "")}</p>`;
        return d;
      }
      const d = document.createElement("div");
      d.className = "step tl-item";
      d.dataset.itemId = String(item.id);
      d.textContent = item.text || "";
      return d;
    }

    function patchToolGroup(el, item) {
      const tools = item.meta?.tools || [];
      const running = tools.some(
        (x) => x.status === "running" || x.status === "pending",
      );
      const failed = tools.some((x) => x.status === "failed" || x.status === "error");
      const preview = toolGroupPreview(tools);
      const labelEl = el.querySelector(".tool-group-sum .thought-label");
      if (labelEl) labelEl.textContent = t("labelTools", "Tools");
      const prevEl = el.querySelector(".thought-preview");
      if (prevEl) prevEl.textContent = preview;
      const sumStatus = el.querySelector(".tool-group-sum .tool-status");
      if (sumStatus) {
        sumStatus.dataset.status = running ? "running" : failed ? "failed" : "completed";
      }
      // Respect user collapse when tools finished; keep open while running
      if (running) el.open = true;
      else if (item.meta?.closed) el.open = false;
      else if (item.meta?.open === false) el.open = false;

      const body = el.querySelector(".tool-group-body");
      if (!body) {
        const fresh = createNode(item);
        el.replaceWith(fresh);
        nodeMap.set(item.id, fresh);
        return;
      }
      // In-place row update — avoid full replaceWith (causes layout jump / overlap)
      body.replaceChildren();
      for (const tool of tools) {
        const row = document.createElement("div");
        row.className = "tool-group-row";
        row.innerHTML = `
            <span class="tool-status" data-status="${escapeHtml(tool.status || "done")}"></span>
            <span class="tool-group-row-title">${escapeHtml(localizedToolTitle(tool.title))}</span>
            <span class="tool-status-text">${escapeHtml(toolStatusLabel(tool.status))}</span>`;
        if (tool.path) {
          const rev = document.createElement("button");
          rev.type = "button";
          rev.className = "review-btn tool-review-btn";
          rev.textContent = t("review", "Review");
          rev.onclick = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            opts.onReview?.({
              path: tool.path,
              oldText: tool.oldText,
              newText: tool.newText,
            });
          };
          row.appendChild(rev);
        }
        if (tool.detail) {
          const det = document.createElement("div");
          det.className = "tool-group-row-detail";
          det.textContent = String(tool.detail).slice(0, 400);
          row.appendChild(det);
        }
        body.appendChild(row);
      }
      heightCache.delete(item.id);
    }

    function patchActivity(el, item) {
      const phase = item.meta?.phase || "waiting";
      const active = item.meta?.active !== false && phase !== "done" && phase !== "error";
      el.dataset.phase = phase;
      el.classList.toggle("is-active", active);
      el.classList.toggle("is-done", !active);
      const icon = el.querySelector(".activity-icon");
      if (icon) {
        icon.classList.toggle("spin", active);
        icon.classList.toggle("ok", !active && phase !== "error");
        icon.classList.toggle("err", phase === "error");
      }
      const label = el.querySelector(".activity-label");
      if (label) label.textContent = item.text || t("phaseWaiting", "Waiting for response");
      const elapsed = el.querySelector(".activity-elapsed");
      if (elapsed) elapsed.textContent = item.meta?.elapsedLabel || "";
    }

    function updateNode(el, item) {
      if (item.kind === "activity") {
        patchActivity(el, item);
        return;
      }
      if (item.kind === "assistant") {
        bindAssistantContent(el, item, !item.streaming);
        return;
      }
      if (item.kind === "thought") {
        const body = el.querySelector(".body");
        if (body) {
          const txt = item.text || "";
          if (body.dataset.streamText !== txt) {
            body.dataset.streamText = txt;
            body.textContent = txt;
          }
          if (item.streaming && stickToBottom) {
            body.scrollTop = body.scrollHeight;
          }
        }
        const titleEl = el.querySelector(".cli-line-title");
        if (titleEl) {
          titleEl.textContent = thoughtTitle(item);
        }
        if (item.streaming) el.open = true;
        else if (item.meta?.open === false) el.open = false;
        heightCache.delete(item.id);
        return;
      }
      if (item.kind === "tool_group") {
        // Rebuild legacy group
        const fresh = createNode(item);
        el.replaceWith(fresh);
        nodeMap.set(item.id, fresh);
        return;
      }
      if (item.kind === "tool") {
        const status = item.meta?.status || "done";
        const running = status === "running" || status === "pending";
        el.dataset.status = status;
        const mark = el.querySelector(".cli-mark");
        if (mark) {
          mark.textContent = running ? "◆" : "◇";
          mark.classList.toggle("spin-dot", running);
        }
        const title = el.querySelector(".cli-line-title");
        if (title) title.textContent = localizedToolTitle(item.text || item.meta?.title);
        const metaEl = el.querySelector(".cli-line-meta");
        if (metaEl) {
          metaEl.textContent =
            !running && status !== "completed" && status !== "done"
              ? toolStatusLabel(status)
              : "";
        }
        if (running) el.open = true;
        else if (item.meta?.open === false) el.open = false;
        fillToolBody(el.querySelector(".cli-tool-body"), item);
        heightCache.delete(item.id);
        return;
      }
      if (item.kind === "permission") {
        const fresh = createNode(item);
        el.replaceWith(fresh);
        nodeMap.set(item.id, fresh);
        return;
      }
      if (item.kind === "user" || item.kind === "step" || item.kind === "error" || item.kind === "foot") {
        el.textContent = item.text || "";
      }
    }

    function visibleRange() {
      const items = store.items;
      const n = items.length;
      if (n === 0) return { start: 0, end: 0, top: 0, bottom: 0, full: true };

      if (n < VIRTUAL_THRESHOLD) {
        return { start: 0, end: n, top: 0, bottom: 0, full: true };
      }

      const scrollTop = root.scrollTop;
      const viewH = root.clientHeight || 600;
      let acc = 0;
      let start = 0;
      for (let i = 0; i < n; i++) {
        const h = estimateHeight(items[i]);
        if (acc + h >= scrollTop) {
          start = i;
          break;
        }
        acc += h;
        start = i;
      }
      start = Math.max(0, start - OVERSCAN);
      let top = 0;
      for (let i = 0; i < start; i++) top += estimateHeight(items[i]);

      let end = start;
      let used = 0;
      while (end < n && used < viewH + OVERSCAN * 40) {
        used += estimateHeight(items[end]);
        end++;
      }
      end = Math.min(n, end + OVERSCAN);

      // Always include streaming tail
      const streamIds = new Set(
        [store.streamAssistantId, store.streamThoughtId].filter((x) => x != null),
      );
      if (streamIds.size) {
        for (let i = 0; i < n; i++) {
          if (streamIds.has(items[i].id)) {
            start = Math.min(start, i);
            end = Math.max(end, i + 1);
          }
        }
      }

      let bottom = 0;
      for (let i = end; i < n; i++) bottom += estimateHeight(items[i]);
      return { start, end, top, bottom, full: false };
    }

    let remeasurePasses = 0;

    function render() {
      if (disposed) return;
      renderScheduled = false;
      const items = store.items;
      const range = visibleRange();
      // Only anchor when virtualized — full mount uses real DOM scroll positions
      const anchor = range.full ? null : captureScrollAnchor();
      const prevScrollTop = root.scrollTop;

      spacerTop.style.height = range.full ? "0px" : `${range.top}px`;
      spacerBottom.style.height = range.full ? "0px" : `${range.bottom}px`;

      const want = new Set();
      for (let i = range.start; i < range.end; i++) {
        want.add(items[i].id);
      }
      // Always keep live streams mounted even if estimate put them off-window
      for (const sid of [store.streamAssistantId, store.streamThoughtId]) {
        if (sid != null) want.add(sid);
      }

      // Remove off-window nodes
      for (const [id, el] of nodeMap) {
        if (!want.has(id)) {
          el.remove();
          nodeMap.delete(id);
        }
      }

      // Ensure order: rebuild window children in range order
      const frag = document.createDocumentFragment();
      const ordered = [];
      for (let i = range.start; i < range.end; i++) {
        const item = items[i];
        let el = nodeMap.get(item.id);
        if (!el) {
          el = createNode(item);
          nodeMap.set(item.id, el);
        }
        ordered.push(el);
      }
      // Only replace if structure changed
      let needsRebuild = ordered.length !== windowEl.childNodes.length;
      if (!needsRebuild) {
        for (let i = 0; i < ordered.length; i++) {
          if (windowEl.childNodes[i] !== ordered[i]) {
            needsRebuild = true;
            break;
          }
        }
      }
      if (needsRebuild) {
        for (const el of ordered) frag.appendChild(el);
        windowEl.replaceChildren(frag);
      }

      let heightsChanged = false;
      for (const el of ordered) {
        const id = Number(el.dataset.itemId);
        const prev = heightCache.get(id);
        const h = measure(el, id);
        if (prev != null && h > 0 && Math.abs(prev - h) > 4) heightsChanged = true;
      }

      if (stickToBottom) {
        scrollEnd(false);
      } else if (anchor) {
        restoreScrollAnchor(anchor);
      } else {
        // Full mount: preserve exact scroll position (content may grow below)
        if (root.scrollTop !== prevScrollTop) {
          ignoreScrollUntil = performance.now() + 40;
          root.scrollTop = prevScrollTop;
        }
      }

      // One corrective pass when measured heights diverge from spacer math
      if (heightsChanged && !range.full && !stickToBottom && remeasurePasses < 2) {
        remeasurePasses += 1;
        requestAnimationFrame(() => {
          if (!disposed) scheduleRender();
        });
      } else {
        remeasurePasses = 0;
      }
    }

    function scheduleRender() {
      if (renderScheduled || disposed) return;
      renderScheduled = true;
      requestAnimationFrame(render);
    }

    function patchStream(item) {
      let el = nodeMap.get(item.id);
      if (!el) {
        scheduleRender();
        return;
      }
      updateNode(el, item);
      measure(el, item.id);
      // Follow live output ONLY if still stuck — never auto re-stick mid-scroll
      if (stickToBottom) scrollEnd(false);
    }

    function finalizeItem(item) {
      const el = nodeMap.get(item.id);
      if (el && item.kind === "assistant") {
        bindAssistantContent(el, item, true);
        measure(el, item.id);
      } else if (el && item.kind === "thought") {
        // Collapse thought body like CLI after stream ends (title keeps "Thought for Xs")
        if (item.meta?.open !== true) el.open = false;
        updateNode(el, item);
        measure(el, item.id);
      } else if (el) {
        updateNode(el, item);
        measure(el, item.id);
      } else {
        scheduleRender();
      }
      if (stickToBottom) scrollEnd(false);
    }

    const unsub = store.subscribe((change) => {
      if (change.type === "reset") {
        nodeMap.clear();
        heightCache.clear();
        mdGenMap.clear();
        windowEl.replaceChildren();
        stickToBottom = true;
        scheduleRender();
        return;
      }
      if (change.type === "append" || change.type === "reorder") {
        scheduleRender();
        // Soft follow: new rows while stuck at bottom
        if (stickToBottom) scrollEnd(false);
        return;
      }
      if (change.type === "stream" && change.item) {
        if (change.full) scheduleRender();
        else patchStream(change.item);
        return;
      }
      if (change.type === "finalize" && change.item) {
        finalizeItem(change.item);
        return;
      }
      if (change.type === "update" && change.item) {
        const el = nodeMap.get(change.item.id);
        if (el) {
          updateNode(el, change.item);
          // Activity timer ticks must NOT force scroll; only growing content does
          if (change.item.kind !== "activity") {
            measure(el, change.item.id);
            if (stickToBottom) scrollEnd(false);
          }
        } else {
          scheduleRender();
        }
      }
    });

    // Intent to read history: wheel up immediately unsticks (don't wait for scroll gap)
    root.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0) {
          stickToBottom = false;
          ignoreScrollUntil = 0;
        } else if (e.deltaY > 0 && isAtBottom()) {
          stickToBottom = true;
        }
      },
      { passive: true },
    );

    root.addEventListener(
      "scroll",
      () => {
        // Ignore scroll events caused by our own scrollTop assignment
        if (performance.now() < ignoreScrollUntil) {
          lastUserScrollTop = root.scrollTop;
          return;
        }
        const top = root.scrollTop;
        // Any meaningful upward scroll = leave live tail
        if (top + 2 < lastUserScrollTop) {
          stickToBottom = false;
        } else if (isAtBottom()) {
          stickToBottom = true;
        }
        lastUserScrollTop = top;
        if (store.length >= VIRTUAL_THRESHOLD) scheduleRender();
      },
      { passive: true },
    );

    return {
      render: scheduleRender,
      /**
       * @param {boolean} [force=true] When true, re-enable stick-to-bottom (send / turn end).
       *   When false, only scroll if the user is already following the live tail.
       */
      scrollEnd: (force = true) => {
        scrollEnd(force !== false);
      },
      isStickToBottom: () => stickToBottom,
      /** Rebuild mounted nodes (e.g. after language switch). */
      relocalize() {
        for (const [, el] of nodeMap) el.remove();
        nodeMap.clear();
        scheduleRender();
      },
      dispose() {
        disposed = true;
        unsub();
        nodeMap.clear();
        mdGenMap.clear();
      },
    };
  }

  globalThis.GrokTimelineView = { create: createTimelineView, VIRTUAL_THRESHOLD };
})();
