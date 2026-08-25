/**
 * Multi-session state (snapshot, queue, slot). The visible switcher is the
 * left sidebar project/chat list — this module no longer paints a tab rail.
 * Switching is presentation-only; the renderer decides when to bind/resume.
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

    function hideRail() {
      if (!root) return;
      root.innerHTML = "";
      root.classList.add("session-tabs");
      root.classList.add("session-tabs-empty");
      root.hidden = true;
      if (typeof root.setAttribute === "function") {
        root.setAttribute("aria-hidden", "true");
        root.setAttribute("hidden", "");
      }
    }

    function render() {
      hideRail();
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
