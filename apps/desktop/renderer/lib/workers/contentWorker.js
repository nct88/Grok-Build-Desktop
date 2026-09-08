/**
 * Phase A4 — off-main-thread markdown + line-diff.
 * Mirrors safe rules from renderer/lib/markdown.js (kept in-worker for CSP isolation).
 */
/* eslint-disable no-restricted-globals */

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value) {
  const tokens = [];
  const token = (html) => {
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  };
  let text = String(value ?? "");
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) =>
    token(
      `<img class="md-img" src="${escapeText(src)}" alt="${escapeText(alt)}" loading="lazy" data-raw-src="${escapeText(src)}" />`,
    ),
  );
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => token(`<code>${escapeText(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_m, label, href) =>
    token(`<a href="${escapeText(href)}" title="${escapeText(href)}">${escapeText(label)}</a>`),
  );
  text = text.replace(
    /\[([^\]\n]*)\]\((<[^>\n]+>|file:\/\/[^)\n]+|(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])[^)\n]+|[A-Za-z0-9_@()+.-]+[\\/][^)\n]+)\)/gi,
    (_m, label, rawHref) => {
      const href = String(rawHref).trim().replace(/^<|>$/g, "");
      return token(
        `<a href="${escapeText(href)}" class="md-path-link" title="${escapeText(href)}">${escapeText(label || href)}</a>`,
      );
    },
  );
  text = text.replace(/<(https?:\/\/[^>\s]+)>/gi, (_m, href) =>
    token(`<a href="${escapeText(href)}" title="${escapeText(href)}">${escapeText(href)}</a>`),
  );
  text = escapeText(text);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, index) => tokens[Number(index)] ?? "");
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdown(source) {
  const lines = String(source ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const parts = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      const language = fence[1].trim();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const lang = language.trim();
      parts.push(
        `<pre class="md-code"${lang ? ` data-lang="${escapeText(lang)}"` : ""}><code>${escapeText(body.join("\n"))}</code></pre>`,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      parts.push(
        `<h${level} class="md-h md-h${level}">${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`,
      );
      index += 1;
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      parts.push('<hr class="md-rule">');
      index += 1;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(renderInline(lines[index].replace(/^\s*>\s?/, "")));
        index += 1;
      }
      parts.push(`<blockquote class="md-quote">${quote.join("<br>")}</blockquote>`);
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const th = headers.map((h) => `<th>${renderInline(h)}</th>`).join("");
      const tr = rows
        .map((r) => `<tr>${headers.map((_header, cellIndex) => `<td>${renderInline(r[cellIndex] ?? "")}</td>`).join("")}</tr>`)
        .join("");
      // Keep worker output identical to the main-thread fallback so the same
      // framed, horizontally scrollable table styles always apply.
      parts.push(`<div class="md-table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (index < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`);
        index += 1;
      }
      parts.push(
        ordered
          ? `<ol class="md-list">${items.join("")}</ol>`
          : `<ul class="md-list">${items.join("")}</ul>`,
      );
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const para = [];
    while (index < lines.length && lines[index].trim() && !/^\s*```/.test(lines[index])) {
      if (/^(#{1,6})\s+/.test(lines[index])) break;
      if (/^\s*([-*+]|\d+\.)\s+/.test(lines[index])) break;
      if (/^\s*>\s?/.test(lines[index])) break;
      para.push(renderInline(lines[index]));
      index += 1;
    }
    parts.push(`<p class="md-p">${para.join("<br>")}</p>`);
  }
  return parts.join("");
}

function lineDiff(oldText, newText) {
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

self.onmessage = (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    if (msg.type === "markdown") {
      self.postMessage({ id, ok: true, html: renderMarkdown(msg.source) });
      return;
    }
    if (msg.type === "diff") {
      self.postMessage({
        id,
        ok: true,
        rows: lineDiff(msg.oldText, msg.newText),
      });
      return;
    }
    self.postMessage({ id, ok: false, error: "unknown type" });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e && e.message ? e.message : e) });
  }
};
