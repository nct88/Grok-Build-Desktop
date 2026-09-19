/**
 * Phase A5 — append-only event store for the chat timeline.
 * Streaming deltas update in-place buffers; UI subscribes and renders derived views.
 */
(() => {
  let seq = 1;

  /**
   * @typedef {"user"|"assistant"|"thought"|"step"|"error"|"review"|"foot"|"empty"|"activity"|"tool"|"tool_group"|"permission"|"recap"} ItemKind
   * @typedef {{ id: number, kind: ItemKind, text: string, meta: Record<string, unknown>, ts: number, streaming?: boolean }} StoreItem
   */

  function createEventStore() {
    /** @type {StoreItem[]} */
    const items = [];
    /** @type {Set<(change: object) => void>} */
    const listeners = new Set();

    /** @type {number|null} */
    let streamAssistantId = null;
    /** @type {number|null} */
    let streamThoughtId = null;

    function emit(change) {
      for (const fn of listeners) {
        try {
          fn(change);
        } catch {
          /* isolate subscriber errors */
        }
      }
    }

    function getById(id) {
      return items.find((it) => it.id === id) || null;
    }

    return {
      get items() {
        return items;
      },
      get length() {
        return items.length;
      },
      get streamAssistantId() {
        return streamAssistantId;
      },
      get streamThoughtId() {
        return streamThoughtId;
      },

      /** @param {(change: object) => void} fn */
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },

      clear() {
        items.length = 0;
        streamAssistantId = null;
        streamThoughtId = null;
        emit({ type: "reset" });
      },

      /**
       * @param {ItemKind} kind
       * @param {string} [text]
       * @param {Record<string, unknown>} [meta]
       */
      append(kind, text, meta) {
        /** @type {StoreItem} */
        const item = {
          id: seq++,
          kind,
          text: text == null ? "" : String(text),
          meta: meta || {},
          ts: Date.now(),
          streaming: false,
        };
        items.push(item);
        emit({ type: "append", item });
        return item;
      },

      /**
       * Insert at the start (session recap / last-turn summary on resume).
       * @param {ItemKind} kind
       * @param {string} [text]
       * @param {Record<string, unknown>} [meta]
       */
      prepend(kind, text, meta) {
        /** @type {StoreItem} */
        const item = {
          id: seq++,
          kind,
          text: text == null ? "" : String(text),
          meta: meta || {},
          ts: Date.now(),
          streaming: false,
        };
        items.unshift(item);
        emit({ type: "reset" });
        return item;
      },

      removeKind(kind) {
        let changed = false;
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].kind === kind) {
            items.splice(i, 1);
            changed = true;
          }
        }
        if (changed) emit({ type: "reset" });
      },

      /**
       * If tools/steps were appended after the live stream bubble, the next
       * deltas must start a NEW bubble (otherwise final answer sticks above tools).
       * @param {number|null} streamId
       */
      _streamInterrupted(streamId) {
        if (streamId == null) return false;
        const idx = items.findIndex((it) => it.id === streamId);
        if (idx < 0) return true;
        return idx < items.length - 1;
      },

      /**
       * Begin or continue a live stream buffer (assistant / thought).
       * @param {"assistant"|"thought"} kind
       * @param {string} chunk
       */
      pushDelta(kind, chunk) {
        const piece = chunk == null ? "" : String(chunk);
        if (!piece) return null;

        if (kind === "assistant") {
          if (streamAssistantId != null && this._streamInterrupted(streamAssistantId)) {
            this.endStream("assistant");
          }
          if (streamAssistantId == null) {
            const item = this.append("assistant", piece, { streaming: true });
            item.streaming = true;
            streamAssistantId = item.id;
            emit({ type: "stream", item, full: true });
            return item;
          }
          const item = getById(streamAssistantId);
          if (!item) {
            streamAssistantId = null;
            return this.pushDelta(kind, piece);
          }
          item.text += piece;
          item.streaming = true;
          emit({ type: "stream", item, full: false });
          return item;
        }

        if (kind === "thought") {
          if (streamThoughtId != null && this._streamInterrupted(streamThoughtId)) {
            this.endStream("thought");
          }
          if (streamThoughtId == null) {
            const item = this.append("thought", piece, { streaming: true });
            item.streaming = true;
            streamThoughtId = item.id;
            emit({ type: "stream", item, full: true });
            return item;
          }
          const item = getById(streamThoughtId);
          if (!item) {
            streamThoughtId = null;
            return this.pushDelta(kind, piece);
          }
          item.text += piece;
          item.streaming = true;
          emit({ type: "stream", item, full: false });
          return item;
        }
        return null;
      },

      /** @param {"assistant"|"thought"|"all"} [kind] */
      endStream(kind) {
        const endOne = (id) => {
          if (id == null) return;
          const item = getById(id);
          if (item) {
            item.streaming = false;
            emit({ type: "finalize", item });
          }
        };
        if (kind === "assistant" || kind === "all" || kind == null) {
          endOne(streamAssistantId);
          streamAssistantId = null;
        }
        if (kind === "thought" || kind === "all" || kind == null) {
          endOne(streamThoughtId);
          streamThoughtId = null;
        }
      },

      /**
       * Update existing item (permission resolve, tool status).
       * @param {number} id
       * @param {{ text?: string, meta?: Record<string, unknown>, streaming?: boolean }} patch
       */
      update(id, patch) {
        const item = getById(id);
        if (!item) return null;
        if (patch.text != null) item.text = String(patch.text);
        if (patch.streaming != null) item.streaming = Boolean(patch.streaming);
        if (patch.meta) item.meta = { ...(item.meta || {}), ...patch.meta };
        emit({ type: "update", item });
        return item;
      },

      /**
       * Move an item to the end (live activity status follows the turn tail).
       * @param {number} id
       */
      bringToEnd(id) {
        const idx = items.findIndex((it) => it.id === id);
        if (idx < 0 || idx === items.length - 1) return getById(id);
        const [item] = items.splice(idx, 1);
        items.push(item);
        emit({ type: "reorder", item });
        return item;
      },

      /** Find first item matching predicate (reverse search). */
      findLast(pred) {
        for (let i = items.length - 1; i >= 0; i--) {
          if (pred(items[i])) return items[i];
        }
        return null;
      },

      /**
       * Replace store from transcript turns (history load).
       * @param {Array<{ role: string, text: string, messageId?: string, status?: string }>} turns
       */
      loadTurns(turns) {
        const turnList = Array.isArray(turns) ? turns : [];
        // Preserve any pending live user prompt or active streaming tail that hasn't been written to disk yet
        const pendingTail = [];
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (
            it.streaming ||
            (it.kind === "user" &&
              !turnList.some((t) => t.role === "user" && String(t.text || "").trim() === String(it.text || "").trim()))
          ) {
            pendingTail.unshift(it);
          } else {
            break;
          }
        }
        items.length = 0;
        streamAssistantId = null;
        streamThoughtId = null;
        for (const t of turnList) {
          if (t.role === "user") {
            items.push({
              id: seq++,
              kind: "user",
              text: String(t.text || ""),
              meta: {},
              ts: Date.now(),
              streaming: false,
            });
          } else if (t.role === "assistant") {
            items.push({
              id: seq++,
              kind: "assistant",
              text: String(t.text || ""),
              meta: {},
              ts: Date.now(),
              streaming: false,
            });
          } else if (t.role === "thought") {
            items.push({
              id: seq++,
              kind: "thought",
              text: String(t.text || ""),
              meta: {
                persisted: true,
                open: false,
                ...(t.messageId ? { messageId: String(t.messageId) } : {}),
                ...(t.status ? { status: String(t.status) } : {}),
              },
              ts: Date.now(),
              streaming: false,
            });
          }
        }
        for (const p of pendingTail) {
          items.push(p);
          if (p.streaming && p.kind === "assistant") streamAssistantId = p.id;
          if (p.streaming && p.kind === "thought") streamThoughtId = p.id;
        }
        emit({ type: "reset" });
        return items.length;
      },
    };
  }

  globalThis.GrokEventStore = { create: createEventStore };
})();
