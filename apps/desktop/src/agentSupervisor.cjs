/**
 * AgentSupervisor — multi-slot ACP process manager (P1).
 *
 * Intelligence stays in `grok agent stdio` per slot. This module only:
 *   - spawns / reuses GrokClient processes
 *   - tracks primary + optional parallel slots (default max 2)
 *   - auto-reconnects the active chat slot
 *   - routes permission callbacks
 *
 * Not a full Codex App Server. Renderer still talks through main IPC.
 */
"use strict";

const { randomUUID } = require("node:crypto");
const {
  normalizePermissionMode,
  buildLaunchArgs,
  launchFingerprint,
} = require("./launchArgs.cjs");

const PRIMARY_ID = "primary";
const MAX_RECONNECT = 3;

/**
 * @typedef {{
 *   id: string,
 *   client: any,
 *   unsubscribe: (() => void)|null,
 *   workspace: string|null,
 *   connectOptions: object,
 *   intentionalStop: boolean,
 *   hadLiveSession: boolean,
 *   reconnectAttempts: number,
 *   reconnectTimer: ReturnType<typeof setTimeout>|null,
 *   reconnectScheduled: boolean,
 *   label: string,
 * }} AgentSlot
 */

class AgentSupervisor {
  /**
   * @param {{
   *   send: (channel: string, payload: any) => void,
   *   loadAcp: () => Promise<any>,
   *   resolveExecutable: () => string,
   *   grokEnv: () => object,
   *   createHost: (slot: AgentSlot, mode: string) => any,
   *   ensureTelemetry?: () => any,
   *   onConnected?: (slot: AgentSlot, result: object) => void,
   *   maxSlots?: number,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.maxSlots = Math.max(1, Number(deps.maxSlots) || 2);
    /** @type {Map<string, AgentSlot>} */
    this.slots = new Map();
    this.activeId = PRIMARY_ID;
    /** @type {Map<string, (result: any) => void>} */
    this.pendingPermissions = new Map();
    // Label is "Primary agent" — never "Chat" (session tabs use Chat for conversations)
    this._ensureSlot(PRIMARY_ID, "Primary agent");
  }

  /**
   * @param {string} id
   * @param {string} [label]
   * @returns {AgentSlot}
   */
  _ensureSlot(id, label) {
    let s = this.slots.get(id);
    if (s) return s;
    s = {
      id,
      client: null,
      unsubscribe: null,
      workspace: null,
      connectOptions: {},
      intentionalStop: false,
      hadLiveSession: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
      reconnectScheduled: false,
      label: label || id,
    };
    this.slots.set(id, s);
    return s;
  }

  /** @returns {AgentSlot} */
  active() {
    return this._ensureSlot(this.activeId);
  }

  /** Back-compat: primary/active GrokClient */
  get client() {
    return this.active().client;
  }

  get connectedWorkspace() {
    return this.active().workspace;
  }

  get connectOptions() {
    return this.active().connectOptions;
  }

  set connectOptions(v) {
    this.active().connectOptions = v || {};
  }

  /**
   * Snapshot for UI / control plane.
   * @returns {object[]}
   */
  listSlots() {
    return [...this.slots.values()].map((s) => ({
      id: s.id,
      label: s.label,
      active: s.id === this.activeId,
      workspace: s.workspace,
      sessionId: s.client?.sessionId || null,
      state: s.client?.connectionState || "disconnected",
      warm: this._isWarm(s),
      hadLiveSession: s.hadLiveSession,
      reconnectAttempts: s.reconnectAttempts,
    }));
  }

  /**
   * @param {string} slotId
   * @returns {{ ok: boolean, activeId: string }}
   */
  setActive(slotId) {
    const id = String(slotId || PRIMARY_ID);
    if (!this.slots.has(id)) {
      throw new Error(`Unknown agent slot: ${id}`);
    }
    this.activeId = id;
    const s = this.active();
    this.deps.send("agent:event", {
      type: "slot_active",
      slotId: id,
      sessionId: s.client?.sessionId || null,
      workspace: s.workspace,
    });
    return { ok: true, activeId: id };
  }

  /**
   * @param {AgentSlot} slot
   */
  _isWarm(slot) {
    if (!slot.client) return false;
    const st = slot.client.connectionState;
    return st === "connected" || st === "running" || st === "starting";
  }

  _sameWorkspace(a, b) {
    if (!a || !b) return !a && !b;
    const left = String(a).replace(/[/\\]+$/, "").toLowerCase();
    const right = String(b).replace(/[/\\]+$/, "").toLowerCase();
    return left === right;
  }

  isClientWarm() {
    return this._isWarm(this.active());
  }

  /**
   * @param {AgentSlot} slot
   */
  _scheduleAutoReconnect(slot) {
    if (slot.intentionalStop || !slot.workspace || !slot.hadLiveSession) return;
    if (slot.reconnectScheduled) return;
    if (slot.reconnectAttempts >= MAX_RECONNECT) {
      slot.hadLiveSession = false;
      this.deps.send("agent:event", {
        type: "error",
        message: `Agent exited; auto-reconnect gave up after ${MAX_RECONNECT} tries.`,
        slotId: slot.id,
      });
      return;
    }
    slot.reconnectScheduled = true;
    slot.reconnectAttempts += 1;
    const delay = Math.min(8000, 1000 * slot.reconnectAttempts);
    if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
    this.deps.send("agent:event", {
      type: "reconnect",
      message: `Agent process lost — reconnecting in ${Math.round(delay / 1000)}s (${slot.reconnectAttempts}/${MAX_RECONNECT})…`,
      attempt: slot.reconnectAttempts,
      slotId: slot.id,
    });
    this.deps.send("agent:event", {
      type: "state",
      state: "starting",
      detail: `Reconnect ${slot.reconnectAttempts}/${MAX_RECONNECT}`,
      slotId: slot.id,
    });
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = null;
      slot.reconnectScheduled = false;
      const root = slot.workspace;
      const opts = { ...slot.connectOptions, forceRestart: true };
      this.connect(root, opts, { slotId: slot.id }).catch((err) => {
        this.deps.send("agent:event", {
          type: "error",
          message: `Reconnect failed: ${err?.message || err}`,
          slotId: slot.id,
        });
        this._scheduleAutoReconnect(slot);
      });
    }, delay);
  }

  /**
   * Connect or reuse a slot.
   * @param {string} workspaceRoot
   * @param {object} [options]
   * @param {{ slotId?: string, label?: string }} [meta]
   */
  async connect(workspaceRoot, options = {}, meta = {}) {
    const slotId = meta.slotId || this.activeId || PRIMARY_ID;
    const slot = this._ensureSlot(slotId, meta.label);
    if (meta.label) slot.label = meta.label;

    const opts = options || {};
    const force = Boolean(opts.forceRestart);
    const resumeId = opts.resumeSessionId ? String(opts.resumeSessionId) : "";

    if (
      !force &&
      this._isWarm(slot) &&
      this._sameWorkspace(slot.workspace, workspaceRoot) &&
      launchFingerprint(opts) === launchFingerprint(slot.connectOptions)
    ) {
      if (resumeId) {
        try {
          slot.client.setReasoningEffort?.(opts.effort);
          await slot.client.loadSession(resumeId);
          slot.connectOptions = { ...slot.connectOptions, ...opts };
          return { ok: true, reused: true, sessionId: slot.client.sessionId, slotId: slot.id };
        } catch {
          // cold start with --resume
        }
      } else {
        slot.connectOptions = { ...slot.connectOptions, ...opts };
        this.deps.send("agent:event", {
          type: "state",
          state: slot.client.connectionState,
          detail: "Ready",
          slotId: slot.id,
        });
        return { ok: true, reused: true, sessionId: slot.client.sessionId, slotId: slot.id };
      }
    }

    slot.intentionalStop = true;
    await this.disconnect(slot.id, { soft: true });
    slot.intentionalStop = false;
    slot.connectOptions = opts;
    slot.workspace = workspaceRoot;
    slot.reconnectAttempts = 0;
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }

    const tel = this.deps.ensureTelemetry?.();
    tel?.mark?.("connect", { workspace: workspaceRoot, slotId: slot.id });

    const acp = await this.deps.loadAcp();
    const executable = this.deps.resolveExecutable();
    const mode = normalizePermissionMode(slot.connectOptions.permissionMode);
    const host = this.deps.createHost(slot, mode);

    slot.client = new acp.GrokClient(
      {
        executable,
        cwd: workspaceRoot,
        arguments: buildLaunchArgs(slot.connectOptions),
        environment: this.deps.grokEnv(),
        enableTerminal: true,
        ...(slot.connectOptions.effort
          ? { reasoningEffort: String(slot.connectOptions.effort) }
          : {}),
        ...(slot.connectOptions.resumeSessionId
          ? { resumeSessionId: slot.connectOptions.resumeSessionId }
          : {}),
      },
      host,
    );

    let firstTokenSeen = false;
    let promptMarkActive = false;
    const client = slot.client;
    slot.unsubscribe = client.onEvent((event) => {
      // Tag events with slot for multi-agent UI
      const payload =
        event && typeof event === "object" ? { ...event, slotId: slot.id } : event;
      this.deps.send("agent:event", payload);
      try {
        if (
          !firstTokenSeen &&
          (event?.type === "assistant_delta" || event?.type === "thought_delta") &&
          event.text
        ) {
          firstTokenSeen = true;
          tel?.measure?.("first_token", "first_token_ms");
        }
        if (event?.type === "tool" || event?.type === "tool_update") {
          if (event.status === "pending" || event.status === "running" || event.type === "tool") {
            tel?.mark?.(`tool:${event.toolCallId || event.title || "x"}`);
          }
          if (event.status === "completed" || event.status === "failed") {
            tel?.measure?.(
              `tool:${event.toolCallId || event.title || "x"}`,
              "tool_roundtrip_ms",
              { title: event.title || "", status: event.status },
            );
          }
        }
        if (event?.type === "turn_complete" && promptMarkActive) {
          tel?.measure?.("prompt_turn", "prompt_to_complete_ms", {
            stopReason: event.stopReason,
          });
          promptMarkActive = false;
          firstTokenSeen = false;
          tel?.clearMark?.("first_token");
        }
      } catch {
        // ignore telemetry errors
      }
      if (
        event?.type === "state" &&
        event.state === "error" &&
        !slot.intentionalStop &&
        slot.hadLiveSession &&
        slot.workspace
      ) {
        this._scheduleAutoReconnect(slot);
      }
    });

    client.__desktopTelemetry = {
      setPromptMarkActive: (v) => {
        promptMarkActive = v;
      },
      resetFirstToken: () => {
        firstTokenSeen = false;
      },
    };

    try {
      await client.start();
    } catch (err) {
      slot.client = null;
      slot.unsubscribe = null;
      slot.hadLiveSession = false;
      tel?.clearMark?.("connect");
      throw err;
    }

    tel?.measure?.("connect", "connect_ms", { reused: false, slotId: slot.id });
    slot.hadLiveSession = true;
    slot.reconnectAttempts = 0;
    slot.reconnectScheduled = false;
    this.activeId = slot.id;

    const result = {
      ok: true,
      reused: false,
      sessionId: client.sessionId,
      slotId: slot.id,
    };
    this.deps.onConnected?.(slot, result);
    return result;
  }

  /**
   * Spawn a parallel slot (does not stop primary).
   * @param {string} workspaceRoot
   * @param {object} [options]
   * @param {string} [label]
   */
  async spawnSlot(workspaceRoot, options = {}, label) {
    const nonPrimary = [...this.slots.keys()].filter((id) => id !== PRIMARY_ID);
    if (this.slots.size >= this.maxSlots && nonPrimary.length >= this.maxSlots - 1) {
      // free a finished secondary if any
      for (const id of nonPrimary) {
        const s = this.slots.get(id);
        if (s && !this._isWarm(s)) {
          await this.disconnect(id, { remove: true });
          break;
        }
      }
    }
    if (this.slots.size >= this.maxSlots) {
      throw new Error(
        `Max ${this.maxSlots} agent slots (primary + parallel). Stop a slot first.`,
      );
    }
    const slotId = `slot-${randomUUID().slice(0, 8)}`;
    return this.connect(workspaceRoot, { ...options, forceRestart: true }, {
      slotId,
      label: label || "Parallel",
    });
  }

  /**
   * @param {string} [slotId]
   * @param {{ soft?: boolean, remove?: boolean }} [opts]
   */
  async disconnect(slotId, opts = {}) {
    const id = slotId || this.activeId;
    const slot = this.slots.get(id);
    if (!slot) return { ok: true };

    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }
    slot.intentionalStop = true;
    if (slot.unsubscribe) {
      try {
        slot.unsubscribe();
      } catch {
        // ignore
      }
      slot.unsubscribe = null;
    }
    if (slot.client) {
      try {
        await slot.client.stop();
      } catch {
        // ignore
      }
      slot.client = null;
    }
    slot.workspace = null;
    slot.hadLiveSession = false;
    slot.reconnectScheduled = false;

    if (opts.remove && id !== PRIMARY_ID) {
      this.slots.delete(id);
      if (this.activeId === id) this.activeId = PRIMARY_ID;
    } else {
      setTimeout(() => {
        slot.intentionalStop = false;
      }, 0);
    }
    return { ok: true, slotId: id };
  }

  /** Disconnect all slots (app quit / hard reset). */
  async disconnectAll() {
    const ids = [...this.slots.keys()];
    for (const id of ids) {
      await this.disconnect(id, { remove: id !== PRIMARY_ID });
    }
    this.activeId = PRIMARY_ID;
    return { ok: true };
  }

  /**
   * @param {string} requestId
   * @param {string|null} optionId
   */
  resolvePermission(requestId, optionId) {
    const id = String(requestId || "");
    const fn = this.pendingPermissions.get(id);
    if (!fn) return { ok: false, message: "No pending permission" };
    this.pendingPermissions.delete(id);
    if (optionId == null || optionId === "" || optionId === "__cancel__") {
      fn({ outcome: { outcome: "cancelled" } });
      this.deps.send("agent:event", {
        type: "permission_resolved",
        requestId: id,
        cancelled: true,
      });
    } else {
      fn({ outcome: { outcome: "selected", optionId: String(optionId) } });
      this.deps.send("agent:event", {
        type: "permission_resolved",
        requestId: id,
        optionId: String(optionId),
      });
    }
    return { ok: true };
  }

  setPermissionMode(mode, slotId) {
    const normalized = normalizePermissionMode(mode);
    const s = slotId ? this.slots.get(slotId) : this.active();
    if (s) {
      s.connectOptions = { ...s.connectOptions, permissionMode: normalized };
    }
    return { ok: true, permissionMode: normalized };
  }

  /**
   * Build permission request handler for a slot's FS host.
   * @param {AgentSlot} slot
   * @param {string} mode
   */
  createPermissionHandler(slot, mode) {
    return async (request) => {
      const currentMode = normalizePermissionMode(slot.connectOptions?.permissionMode || mode);
      const optionsList = request.options || [];
      if (currentMode === "bypassPermissions" || currentMode === "dontAsk" || currentMode === "auto") {
        const allow =
          optionsList.find((o) => /allow|accept|yes|always/i.test(`${o.optionId} ${o.name}`)) ||
          optionsList[0];
        if (!allow) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: allow.optionId } };
      }
      if (currentMode === "acceptEdits") {
        const kind = request.toolCall?.kind || "";
        if (!kind || /edit|write|read|search/i.test(kind)) {
          const allow =
            optionsList.find((o) => /allow|accept|yes/i.test(`${o.optionId} ${o.name}`)) ||
            optionsList[0];
          if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
        }
      }
      const requestId = randomUUID();
      this.deps.send("agent:event", {
        type: "permission_request",
        requestId,
        title: request.toolCall?.title || "Permission required",
        kind: request.toolCall?.kind,
        path: request.toolCall?.locations?.[0]?.path,
        options: optionsList.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind,
        })),
        slotId: slot.id,
      });
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (!this.pendingPermissions.has(requestId)) return;
          this.pendingPermissions.delete(requestId);
          resolve({ outcome: { outcome: "cancelled" } });
          this.deps.send("agent:event", {
            type: "permission_resolved",
            requestId,
            cancelled: true,
            reason: "timeout",
          });
        }, 120_000);
        this.pendingPermissions.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    };
  }

  status() {
    const s = this.active();
    return {
      connected: this._isWarm(s),
      state: s.client?.connectionState || "disconnected",
      sessionId: s.client?.sessionId || null,
      workspace: s.workspace,
      reconnectAttempts: s.reconnectAttempts,
      activeSlotId: this.activeId,
      slots: this.listSlots(),
      maxSlots: this.maxSlots,
    };
  }
}

module.exports = {
  AgentSupervisor,
  PRIMARY_ID,
  MAX_RECONNECT,
};
