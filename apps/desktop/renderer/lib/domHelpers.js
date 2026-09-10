/**
 * Shared pure DOM/string helpers (P1 — reduce app.js duplication).
 * Loaded before app.js; attaches to globalThis.GrokDom.
 */
(() => {
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function basen(p) {
    if (!p) return "";
    const s = String(p).replace(/[/\\]+$/, "");
    const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function stripAnsi(input) {
    return String(input ?? "").replace(
      // eslint-disable-next-line no-control-regex
      /\u001b\[[0-9;]*[a-zA-Z]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b./g,
      "",
    );
  }

  /**
   * Compact relative age for sidebar rows. Units follow the app language.
   * @param {string|number|Date|null|undefined} value
   * @param {number} [nowMs]
   * @param {(key: string, fallback?: string) => string} [translate]
   */
  function formatRelativeAge(value, nowMs = Date.now(), translate) {
    if (value == null || value === "") return "";
    const ts = value instanceof Date ? value.getTime() : Date.parse(String(value));
    if (!Number.isFinite(ts)) return "";
    const tr = (key, fallback, n) => {
      const lookup =
        typeof translate === "function"
          ? translate
          : typeof globalThis.GrokI18n?.t === "function"
            ? (k, fb) => globalThis.GrokI18n.t(k) || fb
            : null;
      const raw = lookup ? lookup(key, fallback) : fallback;
      const text = raw == null || raw === key ? fallback : raw;
      return n != null ? String(text).replaceAll("{n}", String(n)) : String(text);
    };
    const sec = Math.max(0, Math.round((nowMs - ts) / 1000));
    if (sec < 45) return tr("ageNow", "now");
    const min = Math.round(sec / 60);
    if (min < 60) return tr("ageMinutes", "{n}m", min);
    const hr = Math.round(min / 60);
    if (hr < 24) return tr("ageHours", "{n}h", hr);
    const day = Math.round(hr / 24);
    if (day < 14) return tr("ageDays", "{n}d", day);
    const week = Math.round(day / 7);
    if (week < 9) return tr("ageWeeks", "{n}w", week);
    const month = Math.round(day / 30);
    if (month < 18) return tr("ageMonths", "{n}mo", month);
    return tr("ageYears", "{n}y", Math.max(1, Math.round(day / 365)));
  }

  const api = { escapeHtml, basen, stripAnsi, formatRelativeAge };
  globalThis.GrokDom = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
