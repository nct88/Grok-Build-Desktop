/**
 * Grok Build Desktop — single icon pack.
 * Geometry: Lucide-style 24×24 outline (MIT), currentColor, 1.75 stroke.
 * Source: adapted Lucide icons — https://lucide.dev (consistent stroke grid).
 */
(function (global) {
  /** Raw inner SVG (paths/circles/lines) in 24×24 space. */
  const PATHS = {
    // — navigation / chrome —
    plus:
      '<path d="M5 12h14"/><path d="M12 5v14"/>',
    history:
      '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    plug:
      '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a6 6 0 0 1-12 0V8z"/>',
    menu:
      '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    folderOpen:
      '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
    settings:
      '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    logout:
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
    user:
      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    chevronDown:
      '<path d="m6 9 6 6 6-6"/>',
    chevronRight:
      '<path d="m9 18 6-6-6-6"/>',
    caret:
      '<path d="m6 9 6 6 6-6"/>',
    close:
      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    panel:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    panelLeft:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    panelRight:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    panelBottom:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>',
    terminal:
      '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    ide:
      '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',

    // — composer —
    attach:
      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    paperclip:
      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    send:
      '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    mic:
      '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
    // model / effort
    spark:
      '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
    effort:
      '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    gauge:
      '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    brain:
      '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.023 10.125a4 4 0 0 1 0-2.25"/><path d="M21.001 7.875a4 4 0 0 1 0 2.25"/><path d="M15 19.5a4 4 0 0 0-6 0"/>',

    // — theme / lang —
    sun:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon:
      '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    lang:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',

    // — permission modes —
    circle:
      '<circle cx="12" cy="12" r="10"/>',
    circleDot:
      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" data-fill="1"/>',
    check:
      '<path d="M20 6 9 17l-5-5"/>',
    edit:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
    zap:
      '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    plan:
      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    dontAsk:
      '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',

    // — actions —
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    external:
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    info:
      '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    warning:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    error:
      '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    usage:
      '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
    copy:
      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    search:
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    file:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    play:
      '<polygon points="6 3 20 12 6 21 6 3"/>',
    stop:
      '<rect width="14" height="14" x="5" y="5" rx="2"/>',
    image:
      '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
    message:
      '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    wrap:
      '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><path d="M3 18h7"/>',
  };

  // Aliases so existing data-icon names keep working
  PATHS.attach = PATHS.paperclip;
  PATHS.effort = PATHS.effort || PATHS.zap;

  function paint(body) {
    return body
      .replace(/<path\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/stroke=|fill=/.test(attrs)) return `<path${attrs}/>`;
        return `<path fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
      })
      .replace(/<polyline\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/stroke=|fill=/.test(attrs)) return `<polyline${attrs}/>`;
        return `<polyline fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
      })
      .replace(/<line\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/stroke=|fill=/.test(attrs)) return `<line${attrs}/>`;
        return `<line fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
      })
      .replace(/<polygon\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/fill=/.test(attrs)) return `<polygon${attrs}/>`;
        return `<polygon fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
      })
      .replace(/<rect\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/stroke=|fill=/.test(attrs)) return `<rect${attrs}/>`;
        return `<rect fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"${attrs}/>`;
      })
      .replace(/<circle\b([^/]*?)\/>/g, (_m, attrs) => {
        if (/data-fill\s*=\s*["']1["']/.test(attrs)) {
          // solid dot
          const cleaned = attrs.replace(/\s*data-fill\s*=\s*["']1["']/, "");
          return `<circle fill="currentColor" stroke="none"${cleaned}/>`;
        }
        if (/fill=|stroke=/.test(attrs) && !/fill\s*=\s*["']none["']/.test(attrs) && /fill=/.test(attrs)) {
          return `<circle${attrs}/>`;
        }
        return `<circle fill="none" stroke="currentColor" stroke-width="1.75"${attrs}/>`;
      });
  }

  function svg(name, opts) {
    const size = (opts && opts.size) || 16;
    const cls = (opts && opts.className) || "icon";
    const body = PATHS[name];
    if (!body) return "";
    return (
      `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
      paint(body) +
      `</svg>`
    );
  }

  function mount(el, name, opts) {
    if (!el) return;
    el.innerHTML = svg(name, opts);
  }

  function applyAll(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-icon]").forEach((el) => {
      const name = el.getAttribute("data-icon");
      const size = Number(el.getAttribute("data-icon-size") || 16);
      mount(el, name, { size, className: "icon" });
    });
  }

  global.GrokIcons = { PATHS, svg, mount, applyAll, names: Object.keys(PATHS) };
})(typeof window !== "undefined" ? window : globalThis);
