/* Detect and hydrate local paths in finalized assistant content. */
(() => {
  const PATH_CANDIDATE = /(?:[A-Za-z]:[\\/]|\\\\)[^\s<>"'`|?*\u0000]+|(?:\/[A-Za-z0-9_@()+.-]+){2,}|(?:\.{1,2}[\\/])?[A-Za-z0-9_@()+.-]+(?:[\\/][A-Za-z0-9_@()+.-]+)+/g;

  function trimTrailingPunctuation(value) {
    return String(value || "").replace(/[),.;:!?]+$/g, "");
  }

  function looksLikePath(value) {
    const path = String(value || "");
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return true;
    if (path.startsWith("/")) return true;
    if (/^\.{1,2}[\\/]/.test(path)) return true;
    if (path.includes("\\")) return true;
    const name = path.split("/").pop() || "";
    return /\.[A-Za-z0-9_-]{1,16}$/.test(name);
  }

  /** @returns {Array<{start:number,end:number,path:string}>} */
  function findSegments(value) {
    const text = String(value || "");
    const out = [];
    PATH_CANDIDATE.lastIndex = 0;
    let match;
    while ((match = PATH_CANDIDATE.exec(text))) {
      const path = trimTrailingPunctuation(match[0]);
      if (!path || !looksLikePath(path)) continue;
      if (path.includes("://")) continue;
      // Avoid turning the path portion of an unformatted URL into a local link.
      const prefix = text.slice(Math.max(0, match.index - 10), match.index);
      if (prefix.includes("://") || /https?:\/?$/i.test(prefix)) continue;
      out.push({ start: match.index, end: match.index + path.length, path });
    }
    return out;
  }

  function bindLink(node, path, handlers) {
    node.classList.add("md-path-link");
    node.dataset.path = path;
    const isMd = /\.(md|mdx|markdown)$/i.test(String(path).replace(/[?#].*$/, ""));
    node.title = isMd
      ? `${path}\nClick to preview rendered document · Right-click for options`
      : `${path}\nClick to open containing folder · Right-click for options`;
    node.setAttribute("aria-label", `Local path: ${path}`);
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handlers?.onActivate?.({ path, label: node.textContent || path });
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handlers?.onContext?.(
        { path, label: node.textContent || path },
        { x: event.clientX, y: event.clientY },
      );
    });
  }

  function hydrate(root, handlers = {}) {
    if (!root || typeof document === "undefined") return 0;
    let count = 0;

    for (const link of root.querySelectorAll("a.md-path-link")) {
      if (link.dataset.pathBound === "1") continue;
      const raw = link.getAttribute("href") || link.dataset.path || link.textContent || "";
      const path = String(raw).replace(/^file:\/\//i, "").replace(/^\/([A-Za-z]:)/, "$1");
      link.dataset.pathBound = "1";
      bindLink(link, path, handlers);
      count += 1;
    }

    // Inline-code paths are common in agent answers. Keep fenced code blocks
    // intact, but make a standalone inline path use the same open/copy menu.
    for (const code of root.querySelectorAll("code:not(pre code)")) {
      if (code.dataset.pathBound === "1") continue;
      const path = trimTrailingPunctuation(code.textContent || "");
      if (!looksLikePath(path)) continue;
      code.dataset.pathBound = "1";
      bindLink(code, path, handlers);
      count += 1;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const node of textNodes) {
      const parent = node.parentElement;
      if (!parent || parent.closest("a, button, pre, .md-path-link, .cli-diff")) continue;
      const text = node.nodeValue || "";
      const segments = findSegments(text);
      if (!segments.length) continue;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const segment of segments) {
        if (segment.start > cursor) fragment.append(text.slice(cursor, segment.start));
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = segment.path;
        bindLink(button, segment.path, handlers);
        fragment.append(button);
        cursor = segment.end;
        count += 1;
      }
      if (cursor < text.length) fragment.append(text.slice(cursor));
      node.replaceWith(fragment);
    }
    return count;
  }

  globalThis.GrokPathLinks = { findSegments, hydrate };
})();
