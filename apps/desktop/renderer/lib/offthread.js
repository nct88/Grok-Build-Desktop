/**
 * Phase A4 — promise API over contentWorker (markdown + LCS diff).
 * Falls back to main-thread GrokMarkdown / local diff if Worker unavailable.
 */
(() => {
  let worker = null;
  let reqId = 1;
  /** @type {Map<number, { resolve: Function, reject: Function }>} */
  const pending = new Map();

  function ensureWorker() {
    if (worker) return worker;
    try {
      worker = new Worker("lib/workers/contentWorker.js");
      worker.onmessage = (ev) => {
        const msg = ev.data || {};
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.ok) slot.resolve(msg);
        else slot.reject(new Error(msg.error || "worker error"));
      };
      worker.onerror = (err) => {
        for (const [, slot] of pending) {
          slot.reject(err?.message ? new Error(err.message) : new Error("worker failed"));
        }
        pending.clear();
        worker = null;
      };
    } catch {
      worker = null;
    }
    return worker;
  }

  function callWorker(type, payload, timeoutMs = 8000) {
    const w = ensureWorker();
    if (!w) return Promise.reject(new Error("no worker"));
    const id = reqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("worker timeout"));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      w.postMessage({ id, type, ...payload });
    });
  }

  async function renderMarkdownHtml(source) {
    try {
      const res = await callWorker("markdown", { source: String(source ?? "") });
      return res.html;
    } catch {
      if (globalThis.GrokMarkdown?.renderMarkdown) {
        return globalThis.GrokMarkdown.renderMarkdown(source);
      }
      return String(source ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }
  }

  async function computeLineDiff(oldText, newText) {
    try {
      const res = await callWorker("diff", {
        oldText: oldText ?? "",
        newText: newText ?? "",
      });
      return res.rows;
    } catch {
      // Main-thread fallback (same cap as before)
      const a = String(oldText ?? "").split(/\r?\n/);
      const b = String(newText ?? "").split(/\r?\n/);
      const n = a.length;
      const m = b.length;
      if (n * m > 250_000) {
        return [
          ...a.slice(0, 300).map((l) => ({ t: "del", l })),
          ...b.slice(0, 300).map((l) => ({ t: "add", l })),
        ];
      }
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
      const out = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          out.push({ t: "ctx", l: a[i] });
          i++;
          j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          out.push({ t: "del", l: a[i++] });
        } else {
          out.push({ t: "add", l: b[j++] });
        }
      }
      while (i < n) out.push({ t: "del", l: a[i++] });
      while (j < m) out.push({ t: "add", l: b[j++] });
      return out;
    }
  }

  /**
   * Apply structured markdown HTML into an element (code cards + link bind).
   * @param {HTMLElement} el
   * @param {string} html
   * @param {(href: string) => void} [openLink]
   */
  function applyStructuredHtml(el, html, openLink) {
    el.classList.add("md-body", "md-structured");
    el.innerHTML = html || "";
    if (globalThis.GrokMarkdown?.enhanceElement) {
      globalThis.GrokMarkdown.enhanceElement(el, openLink);
      return;
    }
    for (const pre of [...el.querySelectorAll("pre.md-code")]) {
      if (pre.parentElement?.classList.contains("code-card")) continue;
      const card = document.createElement("div");
      card.className = "code-card";
      const header = document.createElement("div");
      header.className = "code-card-header";
      const lang = (pre.getAttribute("data-lang") || "code").trim() || "code";
      header.textContent = lang;
      pre.parentNode?.insertBefore(card, pre);
      card.append(header, pre);
    }
    for (const link of el.querySelectorAll("a[href]")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const href = link.getAttribute("href");
        if (href && /^https?:\/\//i.test(href)) openLink?.(href);
      });
    }
  }

  globalThis.GrokOffthread = {
    renderMarkdownHtml,
    computeLineDiff,
    applyStructuredHtml,
  };
})();
