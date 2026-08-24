/**
 * Phase B1 — multi-session tabs (UI + snapshot).
 * Each tab owns an independent timeline snapshot, runtime state and optional
 * AgentSupervisor slot. Switching tabs is presentation-only; the renderer
 * decides when a tab needs to bind/resume an agent.
 */
(() => {
  let seq = 1;

  /**
   * @param {{
   *   root: HTMLElement,
   *   onActivate: (tab: object, prev: object|null) => void,
   *   onClose?: (tab: object) => void,
   *   onNew?: () => void,
   *   onRename?: (tab: object) => void,
   * }} opts
   */
  function createSessionTabs(opts) {
    const root = opts.root;
    /** @type {Array<object>} */
    let tabs = [];
    let activeId = null;
    let runtimeTicker = 0;

    function makeTab(partial) {
      return {
        id: `tab-${seq++}`,
        title: partial?.title || "Chat",
        sessionId: partial?.sessionId || null,
        cwd: partial?.cwd || null,
        items: partial?.items || [],
        busy: Boolean(partial?.busy),
        slotId: partial?.slotId || null,
        pendingEvents: Array.isArray(partial?.pendingEvents) ? partial.pendingEvents : [],
        promptQueue: Array.isArray(partial?.promptQueue) ? partial.promptQueue : [],
        drainingQueue: Boolean(partial?.drainingQueue),
        turnPhase: partial?.turnPhase || "idle",
        turnStartedAt: Number(partial?.turnStartedAt) || 0,
        phaseStartedAt: Number(partial?.phaseStartedAt) || 0,
        lastUsageFooter: partial?.lastUsageFooter || "",
        manualTitlePending: Boolean(partial?.manualTitlePending),
        deferLoad: Boolean(partial?.deferLoad),
        skipPrevSnapshot: Boolean(partial?.skipPrevSnapshot),
      };
    }

    function formatElapsed(ms) {
      const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
    }

    function refreshRuntimeLabels() {
      if (!root.querySelectorAll) return;
      const now = Date.now();
      for (const el of root.querySelectorAll(".session-tab-runtime")) {
        const tab = tabs.find((t) => t.id === el.dataset.tabId);
        if (!tab) continue;
        el.textContent = tab.busy && tab.turnStartedAt
          ? formatElapsed(now - tab.turnStartedAt)
          : "";
      }
    }

    function syncRuntimeTicker() {
      const needsTicker = tabs.length > 1 && tabs.some((t) => t.busy && t.turnStartedAt);
      if (needsTicker && !runtimeTicker) {
        runtimeTicker = setInterval(refreshRuntimeLabels, 1000);
      } else if (!needsTicker && runtimeTicker) {
        clearInterval(runtimeTicker);
        runtimeTicker = 0;
      }
      refreshRuntimeLabels();
    }

    function render() {
      root.innerHTML = "";
      root.classList.add("session-tabs");
      // One conversation lives under the sidebar project. Hide the rail until
      // the user explicitly keeps two chats open at once.
      if (tabs.length <= 1) {
        root.classList.add("session-tabs-empty");
        syncRuntimeTicker();
        return;
      }
      root.classList.remove("session-tabs-empty");
      const rail = document.createElement("div");
      rail.className = "session-tabs-rail";
      for (const t of tabs) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "session-tab" + (t.id === activeId ? " active" : "");
        btn.dataset.tabId = t.id;
        btn.dataset.busy = t.busy ? "true" : "false";
        btn.title = `${t.title || "Chat"}${t.busy ? " · Running" : ""} · Double-click to rename`;
        if (t.busy) {
          const dot = document.createElement("span");
          dot.className = "session-tab-running";
          dot.setAttribute("aria-label", "Running");
          btn.appendChild(dot);
        }
        const label = document.createElement("span");
        label.className = "session-tab-label";
        label.textContent = t.title;
        label.ondblclick = (ev) => {
          ev.stopPropagation();
          opts.onRename?.(t);
        };
        btn.appendChild(label);
        const runtime = document.createElement("span");
        runtime.className = "session-tab-runtime";
        runtime.dataset.tabId = t.id;
        btn.appendChild(runtime);
        const x = document.createElement("span");
        x.className = "session-tab-x";
        x.textContent = "×";
        x.title = "Close tab";
        x.onclick = (ev) => {
          ev.stopPropagation();
          closeTab(t.id);
        };
        btn.appendChild(x);
        btn.onclick = () => activate(t.id);
        btn.oncontextmenu = (ev) => {
          ev.preventDefault();
          opts.onRename?.(t);
        };
        rail.appendChild(btn);
      }
      const add = document.createElement("button");
      add.type = "button";
      add.className = "session-tab-add";
      add.title = "New chat tab";
      add.setAttribute("aria-label", "New chat tab");
      add.textContent = "+";
      add.onclick = () => {
        if (opts.onNew) opts.onNew();
        else addTab({});
      };
      rail.appendChild(add);
      root.appendChild(rail);
      syncRuntimeTicker();
    }

    function getActive() {
      return tabs.find((t) => t.id === activeId) || null;
    }

    function snapshotItems(items) {
      return (items || []).map((it) => ({
        kind: it.kind,
        text: it.text,
        meta: it.meta ? { ...it.meta } : {},
        streaming: false,
      }));
    }

    function activate(id) {
      if (id === activeId) return;
      const prev = getActive();
      const next = tabs.find((t) => t.id === id);
      if (!next) return;
      activeId = id;
      render();
      opts.onActivate(next, prev);
    }

    function addTab(partial, activateNow = true) {
      const t = makeTab(partial);
      tabs.push(t);
      if (activateNow) {
        const prev = getActive();
        activeId = t.id;
        render();
        opts.onActivate(t, prev);
      } else {
        render();
      }
      return t;
    }

    function closeTab(id) {
      if (tabs.length <= 1) return;
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const [removed] = tabs.splice(idx, 1);
      opts.onClose?.(removed);
      if (activeId === id) {
        const next = tabs[Math.max(0, idx - 1)];
        activeId = next.id;
        render();
        opts.onActivate(next, removed);
      } else {
        render();
      }
    }

    function updateActive(patch) {
      const t = getActive();
      if (!t) return;
      Object.assign(t, patch);
      render();
    }

    function updateSession(sessionId, patch) {
      let changed = false;
      for (const tab of tabs) {
        if (tab.sessionId !== sessionId) continue;
        Object.assign(tab, patch);
        changed = true;
      }
      if (changed) render();
      return changed;
    }

    function updateTab(id, patch) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return null;
      Object.assign(tab, patch || {});
      render();
      return tab;
    }

    function findBySlot(slotId) {
      if (!slotId) return null;
      return tabs.find((t) => t.slotId === slotId) || null;
    }

    function queueEvent(id, event) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return false;
      const last = tab.pendingEvents[tab.pendingEvents.length - 1];
      if (
        last &&
        event &&
        (event.type === "assistant_delta" || event.type === "thought_delta") &&
        last.type === event.type &&
        last.slotId === event.slotId
      ) {
        last.text = String(last.text || "") + String(event.text || "");
        return true;
      }
      tab.pendingEvents.push(event);
      return true;
    }

    function takePendingEvents(id) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !tab.pendingEvents.length) return [];
      const pending = tab.pendingEvents.slice();
      tab.pendingEvents.length = 0;
      return pending;
    }

    function setBusy(id, busy) {
      const t = tabs.find((x) => x.id === id);
      if (t) {
        t.busy = Boolean(busy);
        if (t.busy && !t.turnStartedAt) t.turnStartedAt = Date.now();
        render();
      }
    }

    function saveSnapshot(items) {
      const t = getActive();
      if (t) t.items = snapshotItems(items);
    }

    function ensureOne() {
      if (!tabs.length) {
        const t = makeTab({ title: "Chat" });
        tabs = [t];
        activeId = t.id;
        render();
      }
    }

    function resetToOne(partial) {
      const t = makeTab(partial);
      tabs = [t];
      activeId = t.id;
      render();
      return t;
    }

    function pruneToActive() {
      const cur = getActive();
      if (!cur) {
        ensureOne();
        return getActive();
      }
      tabs = [cur];
      activeId = cur.id;
      render();
      return cur;
    }

    ensureOne();

    return {
      get tabs() {
        return tabs;
      },
      get activeId() {
        return activeId;
      },
      getActive,
      activate,
      addTab,
      resetToOne,
      pruneToActive,
      closeTab,
      updateActive,
      updateTab,
      updateSession,
      findBySlot,
      queueEvent,
      takePendingEvents,
      setBusy,
      saveSnapshot,
      snapshotItems,
      render,
    };
  }

  globalThis.GrokSessionTabs = { create: createSessionTabs };
})();
