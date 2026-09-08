/**
 * Safe Markdown → HTML renderer for the Grok transcript.
 * Agent-provided HTML is always escaped. Only explicitly supported Markdown is emitted as markup.
 */
(() => {
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
    // Images before links; local paths ok — timeline may rewrite src via resolveMediaSrc
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, alt, src) =>
      token(
        `<img class="md-img" src="${escapeText(src)}" alt="${escapeText(alt)}" loading="lazy" data-raw-src="${escapeText(src)}" />`,
      ),
    );
    text = text.replace(/`([^`\n]+)`/g, (_match, code) => token(`<code>${escapeText(code)}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, href) =>
      token(`<a href="${escapeText(href)}" title="${escapeText(href)}">${escapeText(label)}</a>`),
    );
    text = text.replace(
      /\[([^\]\n]*)\]\((<[^>\n]+>|file:\/\/[^)\n]+|(?:[A-Za-z]:[\\/]|\\\\|\/|\.\.?[\\/])[^)\n]+|[A-Za-z0-9_@()+.-]+[\\/][^)\n]+)\)/gi,
      (_match, label, rawHref) => {
        const href = String(rawHref).trim().replace(/^<|>$/g, "");
        return token(
          `<a href="${escapeText(href)}" class="md-path-link" title="${escapeText(href)}">${escapeText(label || href)}</a>`,
        );
      },
    );
    text = text.replace(/<(https?:\/\/[^>\s]+)>/gi, (_match, href) =>
      token(`<a href="${escapeText(href)}" title="${escapeText(href)}">${escapeText(href)}</a>`),
    );
    text = escapeText(text);
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
    text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
    text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>");
    return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)] ?? "");
  }

  function splitTableRow(line) {
    return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  }

  function isTableDivider(line) {
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isMarkdownPath(filePath) {
    const base = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
    return /\.(md|mdx|markdown)$/i.test(base);
  }

  function isMermaidFence(language) {
    return /^(mermaid|mmd)$/i.test(String(language || "").trim());
  }

  function parseMermaidNode(raw) {
    const s = String(raw || "").trim();
    let match;
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*\[\s*"([^"]*)"\s*\]$/))) {
      return { id: match[1], label: match[2], shape: "rect" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*\[\s*([^\]]*)\s*\]$/))) {
      return { id: match[1], label: match[2], shape: "rect" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*\(\(\s*([^)]*)\s*\)\)$/))) {
      return { id: match[1], label: match[2], shape: "circle" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*\(\s*([^)]*)\s*\)$/))) {
      return { id: match[1], label: match[2], shape: "round" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*\{\s*([^}]*)\s*\}$/))) {
      return { id: match[1], label: match[2], shape: "diamond" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)\s*>\s*([^\]]*)\s*\]$/))) {
      return { id: match[1], label: match[2], shape: "rect" };
    }
    if ((match = s.match(/^([A-Za-z_][\w-]*)$/))) {
      return { id: match[1], label: match[1], shape: "rect" };
    }
    return null;
  }

  function mermaidNodeBox(node) {
    const label = String(node.label || node.id || "").replace(/\s+/g, " ").trim() || node.id;
    const width = Math.min(220, Math.max(96, label.length * 8 + 28));
    const height = node.shape === "diamond" ? 52 : node.shape === "circle" ? 48 : 36;
    return { ...node, label, width, height };
  }

  function renderFlowchartSvg(source) {
    const lines = String(source || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("%%") && !/^subgraph\b|^end$/i.test(line));
    let dir = "TD";
    const nodes = new Map();
    const edges = [];
    const ensure = (parsed) => {
      if (!parsed) return null;
      const current = nodes.get(parsed.id);
      if (!current) nodes.set(parsed.id, mermaidNodeBox(parsed));
      else {
        if (parsed.label && parsed.label !== parsed.id) current.label = parsed.label;
        if (parsed.shape) current.shape = parsed.shape;
        Object.assign(current, mermaidNodeBox(current));
      }
      return parsed.id;
    };
    for (const line of lines) {
      const header = line.match(/^(?:graph|flowchart)\s+(TD|TB|BT|RL|LR)\b/i);
      if (header) {
        dir = header[1].toUpperCase();
        continue;
      }
      if (/^(graph|flowchart)\b/i.test(line)) continue;
      const labeled = line.match(/^(.+?)\s+--\s+(.+?)\s+-->\s+(.+)$/);
      const arrow = line.match(/^(.+?)\s*(-->|---|-.->|==>)\s*(?:\|([^|]+)\|)?\s*(.+)$/);
      if (labeled || arrow) {
        const from = parseMermaidNode((labeled ? labeled[1] : arrow[1]).trim());
        const to = parseMermaidNode((labeled ? labeled[3] : arrow[4]).trim());
        const fromId = ensure(from);
        const toId = ensure(to);
        if (fromId && toId) {
          edges.push({ from: fromId, to: toId, label: (labeled ? labeled[2] : arrow[3] || "").trim() });
        }
        continue;
      }
      ensure(parseMermaidNode(line));
    }
    if (!nodes.size) return "";
    const incoming = new Map();
    const outgoing = new Map();
    for (const id of nodes.keys()) {
      incoming.set(id, 0);
      outgoing.set(id, []);
    }
    for (const edge of edges) {
      incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1);
      outgoing.get(edge.from)?.push(edge.to);
    }
    const layers = [];
    const placed = new Set();
    let frontier = [...nodes.keys()].filter((id) => !incoming.get(id));
    if (!frontier.length) frontier = [nodes.keys().next().value];
    while (frontier.length && placed.size < nodes.size) {
      const layer = [];
      const next = [];
      for (const id of frontier) {
        if (placed.has(id)) continue;
        placed.add(id);
        layer.push(id);
        for (const dest of outgoing.get(id) || []) {
          if (!placed.has(dest)) next.push(dest);
        }
      }
      if (layer.length) layers.push(layer);
      frontier = next.filter((id, index, list) => list.indexOf(id) === index);
      if (!frontier.length) {
        const rest = [...nodes.keys()].filter((id) => !placed.has(id));
        if (rest.length) frontier = [rest[0]];
      }
    }
    const horizontal = dir === "LR" || dir === "RL";
    const gap = 28;
    const layerGap = 56;
    const positions = new Map();
    let canvasWidth = 0;
    let canvasHeight = 0;
    if (horizontal) {
      let x = 16;
      for (const layer of layers) {
        const layerHeight = layer.reduce((sum, id) => sum + nodes.get(id).height + gap, -gap);
        let y = 16 + Math.max(0, (Math.max(...layers.map((row) => row.reduce((sum, id) => sum + nodes.get(id).height + gap, -gap))) - layerHeight) / 2);
        let maxWidth = 0;
        for (const id of layer) {
          const node = nodes.get(id);
          positions.set(id, { x, y, node });
          y += node.height + gap;
          maxWidth = Math.max(maxWidth, node.width);
        }
        x += maxWidth + layerGap;
        canvasHeight = Math.max(canvasHeight, y);
      }
      canvasWidth = x;
    } else {
      let y = 16;
      for (const layer of layers) {
        const layerWidth = layer.reduce((sum, id) => sum + nodes.get(id).width + gap, -gap);
        let x = 16;
        canvasWidth = Math.max(canvasWidth, layerWidth + 32);
        x = Math.max(16, (canvasWidth - layerWidth) / 2);
        let maxHeight = 0;
        for (const id of layer) {
          const node = nodes.get(id);
          positions.set(id, { x, y, node });
          x += node.width + gap;
          maxHeight = Math.max(maxHeight, node.height);
        }
        y += maxHeight + layerGap;
      }
      canvasHeight = y;
    }
    canvasWidth = Math.max(160, Math.ceil(canvasWidth));
    canvasHeight = Math.max(80, Math.ceil(canvasHeight));
    const shapes = [];
    for (const [id, pos] of positions) {
      const { node, x, y } = pos;
      const cx = x + node.width / 2;
      const cy = y + node.height / 2;
      const label = escapeText(node.label);
      if (node.shape === "diamond") {
        const points = `${cx},${y} ${x + node.width},${cy} ${cx},${y + node.height} ${x},${cy}`;
        shapes.push(`<polygon points="${points}" class="md-diagram-shape md-diagram-diamond"/>`);
      } else if (node.shape === "circle") {
        shapes.push(`<ellipse cx="${cx}" cy="${cy}" rx="${node.width / 2}" ry="${node.height / 2}" class="md-diagram-shape md-diagram-circle"/>`);
      } else if (node.shape === "round") {
        shapes.push(`<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="16" ry="16" class="md-diagram-shape md-diagram-round"/>`);
      } else {
        shapes.push(`<rect x="${x}" y="${y}" width="${node.width}" height="${node.height}" rx="6" ry="6" class="md-diagram-shape md-diagram-rect"/>`);
      }
      shapes.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" class="md-diagram-label">${label}</text>`);
      node._box = { x, y, cx, cy, width: node.width, height: node.height };
    }
    const linesSvg = [];
    for (const edge of edges) {
      const from = nodes.get(edge.from)?._box;
      const to = nodes.get(edge.to)?._box;
      if (!from || !to) continue;
      let x1 = from.cx;
      let y1 = from.cy;
      let x2 = to.cx;
      let y2 = to.cy;
      if (horizontal) {
        x1 = from.x + from.width;
        x2 = to.x;
      } else {
        y1 = from.y + from.height;
        y2 = to.y;
      }
      linesSvg.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="md-diagram-edge"/>`);
      if (edge.label) {
        linesSvg.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 6}" text-anchor="middle" class="md-diagram-edge-label">${escapeText(edge.label)}</text>`);
      }
    }
    return `<div class="md-diagram" data-kind="flowchart" data-dir="${escapeText(dir)}" role="img" aria-label="flowchart"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="${canvasWidth}" height="${canvasHeight}">${linesSvg.join("")}${shapes.join("")}</svg></div>`;
  }

  function renderSequenceSvg(source) {
    const lines = String(source || "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("%%") && !/^sequenceDiagram\b/i.test(line));
    const actors = [];
    const actorIndex = new Map();
    const messages = [];
    const ensureActor = (id, label) => {
      const key = String(id || "").trim();
      if (!key) return;
      if (!actorIndex.has(key)) {
        actorIndex.set(key, actors.length);
        actors.push({ id: key, label: label || key });
      } else if (label) {
        actors[actorIndex.get(key)].label = label;
      }
    };
    for (const line of lines) {
      const participant = line.match(/^participant\s+(\S+)(?:\s+as\s+(.+))?$/i);
      if (participant) {
        ensureActor(participant[1], participant[2]);
        continue;
      }
      const message = line.match(/^(\S+)\s*(->>|-->>|->|-->)\s*(\S+)\s*:\s*(.*)$/);
      if (message) {
        ensureActor(message[1]);
        ensureActor(message[3]);
        messages.push({
          from: message[1],
          to: message[3],
          label: message[4] || "",
          dashed: message[2].includes("--"),
        });
      }
    }
    if (!actors.length) return "";
    const col = 140;
    const top = 28;
    const row = 36;
    const width = Math.max(200, actors.length * col);
    const height = Math.max(80, top + 24 + messages.length * row + 36);
    const actorSvg = actors.map((actor, index) => {
      const x = 40 + index * col;
      return `<text x="${x}" y="18" text-anchor="middle" class="md-diagram-label">${escapeText(actor.label)}</text><line x1="${x}" y1="${top}" x2="${x}" y2="${height - 12}" class="md-diagram-life"/>`;
    });
    const msgSvg = messages.map((message, index) => {
      const y = top + 18 + index * row;
      const x1 = 40 + (actorIndex.get(message.from) || 0) * col;
      const x2 = 40 + (actorIndex.get(message.to) || 0) * col;
      const dash = message.dashed ? ` stroke-dasharray="5 4"` : "";
      const marker = x2 >= x1 ? "url(#md-arrow)" : "url(#md-arrow-rev)";
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" class="md-diagram-edge"${dash} marker-end="${marker}"/><text x="${(x1 + x2) / 2}" y="${y - 6}" text-anchor="middle" class="md-diagram-edge-label">${escapeText(message.label)}</text>`;
    });
    return `<div class="md-diagram" data-kind="sequence" role="img" aria-label="sequence diagram"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><defs><marker id="md-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" class="md-diagram-arrowhead"/></marker><marker id="md-arrow-rev" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M 10 0 L 0 5 L 10 10 z" class="md-diagram-arrowhead"/></marker></defs>${actorSvg.join("")}${msgSvg.join("")}</svg></div>`;
  }

  function renderMermaid(source) {
    const text = String(source || "").replaceAll("\r\n", "\n").trim();
    if (!text) return `<pre class="md-code" data-lang="mermaid"><code></code></pre>`;
    const html = /^sequenceDiagram\b/i.test(text) ? renderSequenceSvg(text) : renderFlowchartSvg(text);
    return html || `<pre class="md-code" data-lang="mermaid"><code>${escapeText(text)}</code></pre>`;
  }

  function renderMarkdown(source) {
    const lines = String(source ?? "").replaceAll("\r\n", "\n").split("\n");
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
        if (isMermaidFence(language)) {
          parts.push(renderMermaid(body.join("\n")));
        } else {
          parts.push(
            `<pre class="md-code"${language ? ` data-lang="${escapeText(language)}"` : ""}><code>${escapeText(body.join("\n"))}</code></pre>`,
          );
        }
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        parts.push(`<h${level} class="md-h md-h${level}">${renderInline(heading[2].replace(/\s+#+\s*$/, ""))}</h${level}>`);
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
        const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
        const body = rows.map((row) =>
          `<tr>${headers.map((_header, cellIndex) => `<td>${renderInline(row[cellIndex] ?? "")}</td>`).join("")}</tr>`,
        ).join("");
        parts.push(`<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      if (unordered) {
        const items = [];
        while (index < lines.length) {
          const item = lines[index].match(/^\s*[-+*]\s+(.+)$/);
          if (!item) break;
          const task = item[1].match(/^\[([ xX])\]\s+(.*)$/);
          items.push(task
            ? `<li class="md-task"><input type="checkbox" disabled${task[1].toLowerCase() === "x" ? " checked" : ""}> ${renderInline(task[2])}</li>`
            : `<li>${renderInline(item[1])}</li>`);
          index += 1;
        }
        parts.push(`<ul class="md-list">${items.join("")}</ul>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        const items = [];
        const start = Number(line.match(/^\s*(\d+)/)?.[1] ?? 1);
        while (index < lines.length) {
          const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!item) break;
          items.push(`<li>${renderInline(item[1])}</li>`);
          index += 1;
        }
        parts.push(`<ol class="md-list"${start !== 1 ? ` start="${start}"` : ""}>${items.join("")}</ol>`);
        continue;
      }

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const paragraph = [];
      while (
        index < lines.length &&
        lines[index].trim() &&
        !/^\s*```/.test(lines[index]) &&
        !/^(#{1,6})\s+/.test(lines[index]) &&
        !/^\s*>\s?/.test(lines[index]) &&
        !/^\s*[-+*]\s+/.test(lines[index]) &&
        !/^\s*\d+[.)]\s+/.test(lines[index])
      ) {
        paragraph.push(lines[index]);
        index += 1;
      }
      parts.push(`<p class="md-p">${renderInline(paragraph.join(" "))}</p>`);
    }
    return parts.join("") || '<p class="md-p"></p>';
  }

  function bindMarkdownLinks(element, openLink) {
    for (const link of element.querySelectorAll("a[href]")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const href = link.getAttribute("href");
        if (href && /^https?:\/\//i.test(href)) openLink?.(href);
      });
    }
  }

  function enhanceMarkdownElement(element, openLink) {
    if (!element) return;
    for (const pre of [...element.querySelectorAll("pre.md-code")]) {
      const lang = (pre.getAttribute("data-lang") || "").trim();
      if (isMermaidFence(lang) && !pre.closest(".md-diagram")) {
        const source = pre.querySelector("code")?.textContent || pre.textContent || "";
        const wrap = element.ownerDocument.createElement("div");
        wrap.innerHTML = renderMermaid(source);
        const node = wrap.firstElementChild;
        if (node) pre.replaceWith(node);
        continue;
      }
      if (pre.parentElement?.classList.contains("code-card")) {
        const code = pre.querySelector("code");
        if (code && globalThis.GrokSyntax?.highlightFence) globalThis.GrokSyntax.highlightFence(code, lang);
        continue;
      }
      const card = element.ownerDocument.createElement("div");
      card.className = "code-card";
      const header = element.ownerDocument.createElement("div");
      header.className = "code-card-header";
      header.textContent = lang || "code";
      pre.parentNode?.insertBefore(card, pre);
      card.append(header, pre);
      const code = pre.querySelector("code");
      if (code && globalThis.GrokSyntax?.highlightFence) globalThis.GrokSyntax.highlightFence(code, lang);
    }
    bindMarkdownLinks(element, openLink);
  }

  function setMarkdownContent(element, source, openLink) {
    element.classList.add("md-body");
    element.classList.remove("md-structured");
    element.innerHTML = renderMarkdown(source);
    enhanceMarkdownElement(element, openLink);
  }

  /**
   * Structured timeline body: same safe Markdown, plus code fences wrapped as
   * language-tagged cards (Cursor/Windsurf-style blocks).
   */
  function setStructuredContent(element, source, openLink) {
    element.classList.add("md-body", "md-structured");
    element.innerHTML = renderMarkdown(source);
    enhanceMarkdownElement(element, openLink);
  }

  globalThis.GrokMarkdown = {
    renderMarkdown,
    renderMermaid,
    setMarkdownContent,
    setStructuredContent,
    enhanceElement: enhanceMarkdownElement,
    isMarkdownPath,
    escapeText,
  };
})();
