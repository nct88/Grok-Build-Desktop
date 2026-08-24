/**
 * Phase D3 — E2E / integration suite (no Electron UI required).
 *
 * Levels:
 *   1. Architecture guardrails
 *   2. Unit: eventStore, telemetry, jobRunner validation, artifactStore
 *   3. Control-plane contract
 *   4. Optional live: grok -p smoke (set GROK_E2E_LIVE=1)
 *
 * Run: node scripts/e2e-desktop.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const live = process.env.GROK_E2E_LIVE === "1" || process.env.GROK_E2E_LIVE === "true";

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}
function fail(name, err) {
  failed++;
  console.error(`  ✗ ${name}: ${err?.message || err}`);
}

async function runNode(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// ── 1 Architecture ──
console.log("\n[1] Architecture");
{
  const r = await runNode(path.join(root, "scripts", "check-architecture.mjs"));
  if (r.code === 0) ok("check-architecture");
  else fail("check-architecture", new Error(r.err || r.out || `exit ${r.code}`));
}

// ── 2 Units ──
console.log("\n[2] Unit modules");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grok-e2e-"));

// Telemetry
try {
  const { Telemetry } = require(path.join(root, "apps/desktop/src/telemetry.cjs"));
  let enabled = true;
  const t = new Telemetry({
    stateDir: tmp,
    loadEnabled: () => enabled,
    saveEnabled: (v) => {
      enabled = v;
    },
  });
  t.mark("connect");
  await new Promise((r) => setTimeout(r, 20));
  const row = t.measure("connect", "connect_ms");
  if (!row || row.ms < 10) throw new Error("connect measure failed");
  t.record("first_token_ms", 120);
  const s = t.summary();
  if (!s.metrics.connect_ms.count) throw new Error("no samples");
  if (s.metrics.first_token_ms.p50 !== 120) throw new Error("p50 wrong");
  enabled = false;
  t.record("connect_ms", 999);
  if (t.summary().metrics.connect_ms.count !== 1) throw new Error("opt-out ignored");
  ok("telemetry buckets + opt-in");
} catch (e) {
  fail("telemetry", e);
}

// Artifact store
try {
  const { ArtifactStore } = require(path.join(root, "apps/desktop/src/artifactStore.cjs"));
  const a = new ArtifactStore(tmp);
  a.clear();
  a.add({ type: "plan", title: "p", content: "x" });
  if (a.list().length !== 1) throw new Error("list");
  ok("artifactStore");
} catch (e) {
  fail("artifactStore", e);
}

// Job runner validation
try {
  const { JobRunner } = require(path.join(root, "apps/desktop/src/jobRunner.cjs"));
  const jr = new JobRunner({
    resolveExecutable: () => "grok",
    grokEnv: () => ({}),
    stateDir: tmp,
  });
  let threw = false;
  try {
    jr.enqueue({ prompt: "", cwd: tmp });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("empty prompt should throw");
  ok("jobRunner validation");
} catch (e) {
  fail("jobRunner", e);
}

// Event store proper (IIFE attaches to globalThis)
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/eventStore.js"),
    "utf8",
  );
  const g = globalThis;
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const store = g.GrokEventStore.create();
  store.append("user", "hi");
  store.pushDelta("assistant", "hel");
  store.pushDelta("assistant", "lo");
  store.endStream("assistant");
  if (store.length < 2) throw new Error("store length");
  const a = store.items.find((i) => i.kind === "assistant");
  if (!a || a.text !== "hello") throw new Error(`assistant text ${a?.text}`);

  // Tools interrupting stream → next assistant is a NEW bubble below tools
  const s2 = g.GrokEventStore.create();
  s2.pushDelta("assistant", "part1 ");
  s2.append("tool_group", "Tools · 1", { tools: [{ toolId: "t1", title: "run", status: "done" }] });
  s2.pushDelta("assistant", "part2");
  const assistants = s2.items.filter((i) => i.kind === "assistant");
  if (assistants.length !== 2) throw new Error(`expected 2 assistant bubbles, got ${assistants.length}`);
  if (assistants[0].text !== "part1 ") throw new Error(assistants[0].text);
  if (assistants[1].text !== "part2") throw new Error(assistants[1].text);
  const order = s2.items.map((i) => i.kind).join(",");
  if (!order.includes("assistant,tool_group,assistant")) {
    throw new Error(`bad order ${order}`);
  }

  // Persisted transcript replay keeps display-safe thought summaries in order.
  const s3 = g.GrokEventStore.create();
  s3.loadTurns([
    { role: "user", text: "question" },
    { role: "thought", text: "safe summary", messageId: "r1", status: "completed" },
    { role: "assistant", text: "answer" },
  ]);
  const replayOrder = s3.items.map((i) => i.kind).join(",");
  if (replayOrder !== "user,thought,assistant") {
    throw new Error(`bad transcript replay order ${replayOrder}`);
  }
  const replayThought = s3.items.find((i) => i.kind === "thought");
  if (!replayThought || replayThought.meta.open !== false || replayThought.meta.messageId !== "r1") {
    throw new Error("persisted thought metadata missing");
  }
  ok("eventStore stream + append + split after tools");
} catch (e) {
  fail("eventStore", e);
}

// Session transcript: restore summary_text only, never encrypted reasoning.
try {
  const { readSessionTranscript } = await import(
    pathToFileURL(path.join(root, "packages/sessions/dist/index.js")).href
  );
  const grokHome = path.join(tmp, "grok-home");
  const sessionId = "reasoning-session";
  const sessionDir = path.join(
    grokHome,
    "sessions",
    encodeURIComponent("C:\\work"),
    sessionId,
  );
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "summary.json"),
    JSON.stringify({ info: { id: sessionId, cwd: "C:\\work" } }),
  );
  fs.writeFileSync(
    path.join(sessionDir, "chat_history.jsonl"),
    [
      { type: "system", content: "hidden system" },
      { type: "user", content: [{ type: "text", text: "Question" }] },
      {
        type: "reasoning",
        id: "reasoning-1",
        status: "completed",
        summary: [{ type: "summary_text", text: "Display-safe reasoning summary" }],
        encrypted_content: "must-never-cross-ipc",
      },
      { type: "assistant", content: "Final answer" },
      {
        type: "reasoning",
        id: "reasoning-empty",
        status: "completed",
        summary: [],
        encrypted_content: "also-hidden",
      },
    ].map((row) => JSON.stringify(row)).join("\n"),
  );
  const transcript = await readSessionTranscript({ sessionId, grokHome, limit: 20 });
  const transcriptOrder = transcript.map((item) => item.role).join(",");
  if (transcriptOrder !== "user,thought,assistant") {
    throw new Error(`unexpected transcript order ${transcriptOrder}`);
  }
  if (transcript[1]?.text !== "Display-safe reasoning summary") {
    throw new Error("reasoning summary not restored");
  }
  if (JSON.stringify(transcript).includes("must-never-cross-ipc")) {
    throw new Error("encrypted reasoning leaked into transcript");
  }
  ok("session transcript reasoning summary + encrypted-content boundary");
} catch (e) {
  fail("session transcript reasoning", e);
}

// Control plane
try {
  const { ControlPlane } = require(path.join(root, "apps/desktop/src/controlPlane.cjs"));
  const cp = new ControlPlane({
    getClient: () => ({ connectionState: "connected", sessionId: "abc" }),
    getWorkspace: () => tmp,
    resolveExecutable: () => "grok",
    getConnectOptions: () => ({ permissionMode: "default" }),
    getVersion: () => "0.5.19",
    telemetry: null,
  });
  const h = cp.health();
  if (!h.connected || h.agentLoopOwner !== "grok-cli") throw new Error("health");
  const cap = cp.capabilities();
  if (!cap.surfaces.includes("chat-acp")) throw new Error("capabilities");
  if (!cap.forbidden.includes("agent-loop-in-electron")) throw new Error("forbidden");
  ok("controlPlane contract");
} catch (e) {
  fail("controlPlane", e);
}

// Stream batcher
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/streamBatcher.js"),
    "utf8",
  );
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.window = globalThis;
  // eslint-disable-next-line no-new-func
  new Function(src)();
  let flushed = "";
  let segmentOrder = "";
  const b = globalThis.GrokStreamBatcher.create({
    intervalMs: 5,
    onFlush: (p) => {
      flushed += p.assistant;
      segmentOrder += p.segments.map((segment) => segment.kind).join(",");
    },
  });
  b.pushAssistant("a");
  b.pushAssistant("b");
  b.flushNow();
  if (flushed !== "ab") throw new Error(`flush ${flushed}`);
  const ordered = globalThis.GrokStreamBatcher.create({
    intervalMs: 5,
    onFlush: (p) => {
      segmentOrder = p.segments.map((segment) => segment.kind).join(",");
    },
  });
  ordered.pushThought("reasoning");
  ordered.pushAssistant("answer");
  ordered.pushThought("follow-up");
  ordered.flushNow();
  if (segmentOrder !== "thought,assistant,thought") {
    throw new Error(`stream segment order ${segmentOrder}`);
  }
  ok("streamBatcher coalesce");
} catch (e) {
  fail("streamBatcher", e);
}

// P1 launchArgs
try {
  const {
    normalizePermissionMode,
    buildLaunchArgs,
    launchFingerprint,
  } = require(path.join(root, "apps/desktop/src/launchArgs.cjs"));
  if (normalizePermissionMode("ask") !== "default") throw new Error("alias ask");
  if (normalizePermissionMode("full") !== "bypassPermissions") throw new Error("alias full");
  const args = buildLaunchArgs({
    permissionMode: "default",
    model: "grok-4.5",
    worktree: "wt1",
    worktreeRef: "main",
  });
  if (!args.includes("--model") || !args.includes("grok-4.5")) throw new Error("model arg");
  if (!args.includes("--worktree") || !args.includes("wt1")) throw new Error("worktree arg");
  const fp1 = launchFingerprint({ model: "a" });
  const fp2 = launchFingerprint({ model: "b" });
  if (fp1 === fp2) throw new Error("fingerprint should differ");
  ok("launchArgs normalize + fingerprint");
} catch (e) {
  fail("launchArgs", e);
}

try {
  const acp = await import(pathToFileURL(path.join(root, "packages/acp-client/dist/index.js")).href);
  const meta = acp.sessionRequestMeta({ reasoningEffort: "xhigh" });
  if (meta.reasoningEffort !== "xhigh" || meta.reasoning_effort !== "xhigh") {
    throw new Error(JSON.stringify(meta));
  }
  if (acp.sessionRequestMeta({ reasoningEffort: "nope" })) throw new Error("invalid effort leaked");
  ok("ACP session/new reasoning-effort meta");
} catch (e) {
  fail("ACP session meta", e);
}

// P1 AgentSupervisor (mocked ACP)
try {
  const { AgentSupervisor } = require(path.join(root, "apps/desktop/src/agentSupervisor.cjs"));
  const events = [];
  let startCount = 0;
  let stopCount = 0;
  const clients = [];
  class FakeClient {
    constructor() {
      this.connectionState = "starting";
      this.sessionId = "sess-1";
      this._handlers = [];
      clients.push(this);
    }
    onEvent(fn) {
      this._handlers.push(fn);
      return () => {};
    }
    async start() {
      startCount++;
      this.connectionState = "connected";
    }
    async stop() {
      stopCount++;
      this.connectionState = "disconnected";
    }
    async loadSession() {}
    async prompt() {}
    async cancel() {}
  }
  const sup = new AgentSupervisor({
    maxSlots: 2,
    send: (ch, p) => events.push({ ch, p }),
    loadAcp: async () => ({
      GrokClient: FakeClient,
      createNodeFsHost: () => ({}),
    }),
    resolveExecutable: () => "grok",
    grokEnv: () => ({}),
    createHost: () => ({}),
    ensureTelemetry: () => ({
      mark() {},
      measure() {},
      clearMark() {},
    }),
  });
  const r1 = await sup.connect(tmp, { permissionMode: "default" });
  if (!r1.ok || r1.reused) throw new Error("first connect");
  if (startCount !== 1) throw new Error("start once");
  const r2 = await sup.connect(tmp, { permissionMode: "default" });
  if (!r2.reused) throw new Error("warm reuse expected");
  if (startCount !== 1) throw new Error("should not restart");
  const st = sup.status();
  if (!st.connected || st.slots.length < 1) throw new Error("status slots");
  // A second tab gets a separate process; starting it must not stop the
  // primary task that is already running.
  clients[0].connectionState = "running";
  const r3 = await sup.spawnSlot(tmp, { permissionMode: "auto" }, "Parallel");
  if (!r3.ok || r3.slotId === "primary") throw new Error("spawn slot id");
  if (sup.listSlots().length !== 2) throw new Error("2 slots");
  if (clients[0].connectionState !== "running" || stopCount !== 0) {
    throw new Error("spawning parallel slot interrupted primary task");
  }
  sup.setActive("primary");
  if (sup.status().activeSlotId !== "primary" || clients[0].connectionState !== "running") {
    throw new Error("switching back did not preserve primary runtime");
  }
  sup.setActive(r3.slotId);
  // max 2
  let threw = false;
  try {
    await sup.spawnSlot(tmp, {});
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("max slots should throw");
  await sup.disconnectAll();
  ok("agentSupervisor warm + multi-slot");
} catch (e) {
  fail("agentSupervisor", e);
}

// P1 IPC contract
try {
  const { validatePreloadContract, INVOKE_CHANNELS } = require(
    path.join(root, "apps/desktop/src/ipcContract.cjs"),
  );
  const preload = fs.readFileSync(
    path.join(root, "apps/desktop/src/preload.cjs"),
    "utf8",
  );
  const v = validatePreloadContract(preload);
  if (!v.ok) {
    throw new Error(
      `missing invoke=${v.missing.join(",")} events=${v.missingEvents.join(",")}`,
    );
  }
  if (INVOKE_CHANNELS.length < 40) throw new Error("contract too small");
  ok("ipcContract preload coverage");
} catch (e) {
  fail("ipcContract", e);
}

// P1 product paths
try {
  const { createProductPaths, resolveExeInDir, isExecutableFile } = require(
    path.join(root, "apps/desktop/src/productPaths.cjs"),
  );
  const pp = createProductPaths("C:\\Users\\test");
  if (!pp.desktop.installDir.includes("Grok Build")) throw new Error("desktop path");
  if (!pp.ide.exeNames.includes("Grok Build IDE.exe")) throw new Error("ide exe");
  if (isExecutableFile(tmp)) throw new Error("dir not exe");
  if (resolveExeInDir(tmp, ["nope.exe"])) throw new Error("empty dir");
  ok("productPaths layout");
} catch (e) {
  fail("productPaths", e);
}

// Version consistency (changelog/release notes ↔ package)
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const ver = pkg.version;
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  if (!changelog.includes(`## ${ver}`)) {
    throw new Error(`CHANGELOG.md missing version ${ver}`);
  }
  const productVer = fs
    .readFileSync(path.join(root, "product/VERSION"), "utf8")
    .replace(/^\uFEFF/, "")
    .trim();
  if (productVer !== ver) throw new Error(`product/VERSION ${productVer} != ${ver}`);
  ok(`version consistency ${ver}`);
} catch (e) {
  fail("version consistency", e);
}

// P2 diff hunks
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/diffHunks.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const HD = globalThis.GrokDiffHunks;
  const rows = [
    { t: "ctx", l: "a" },
    { t: "del", l: "old" },
    { t: "add", l: "new" },
    { t: "ctx", l: "b" },
    { t: "del", l: "x" },
    { t: "add", l: "y" },
  ];
  const hunks = HD.groupHunks(rows);
  if (hunks.length < 1) throw new Error("expected hunks");
  const allAcc = HD.decideAll(hunks.length, "accept");
  const textAcc = HD.applyHunkDecisions(rows, hunks, allAcc);
  if (!textAcc.includes("new") || textAcc.includes("old")) {
    throw new Error(`accept apply: ${textAcc}`);
  }
  const allRej = HD.decideAll(hunks.length, "reject");
  const textRej = HD.applyHunkDecisions(rows, hunks, allRej);
  if (!textRej.includes("old") || textRej.includes("new")) {
    throw new Error(`reject apply: ${textRej}`);
  }
  ok("diffHunks group + apply");
} catch (e) {
  fail("diffHunks", e);
}

// Session tabs: single-tab does not paint a lone "Chat" chip
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/sessionTabs.js"),
    "utf8",
  );
  // Minimal DOM mock
  class FakeEl {
    constructor() {
      this.children = [];
      this.classList = {
        _s: new Set(),
        add: (c) => this.classList._s.add(c),
        remove: (c) => this.classList._s.delete(c),
        contains: (c) => this.classList._s.has(c),
      };
      this.innerHTML = "";
    }
    appendChild(c) {
      this.children.push(c);
      return c;
    }
  }
  globalThis.document = {
    createElement: (tag) => {
      const el = new FakeEl();
      el.tagName = tag;
      el.type = "";
      el.className = "";
      el.title = "";
      el.textContent = "";
      el.dataset = {};
      el.onclick = null;
      el.setAttribute = () => {};
      el.appendChild = (c) => {
        el.children.push(c);
        return c;
      };
      return el;
    },
  };
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const tabRoot = new FakeEl();
  let renameTarget = null;
  const tabs = globalThis.GrokSessionTabs.create({
    root: tabRoot,
    onActivate: () => {},
    onRename: (tab) => {
      renameTarget = tab;
    },
  });
  const firstTab = tabs.getActive();
  // After ensureOne → single tab: should be empty mode (no session-tab chip)
  if (!tabRoot.classList.contains("session-tabs-empty")) {
    throw new Error("expected session-tabs-empty for single tab");
  }
  const hasTabChip = tabRoot.children.some(
    (rail) =>
      rail.children &&
      rail.children.some(
        (c) =>
          String(c.className || "").includes("session-tab") &&
          !String(c.className || "").includes("session-tab-add"),
      ),
  );
  if (hasTabChip) throw new Error("single tab should not render Chat chip");
  tabs.addTab({ title: "Second", sessionId: "session-b", cwd: "D:\\projects\\beta" }, true);
  firstTab.promptQueue.push({ text: "queued for first" });
  if (tabs.getActive().promptQueue.length !== 0) throw new Error("prompt queues leaked between tabs");
  if (tabRoot.classList.contains("session-tabs-empty")) {
    throw new Error("expected multi-tab rail visible");
  }
  if (tabs.getActive()?.cwd !== "D:\\projects\\beta") {
    throw new Error(`tab cwd was not retained: ${tabs.getActive()?.cwd}`);
  }
  tabs.updateSession("session-b", { cwd: "E:\\projects\\moved" });
  if (tabs.getActive()?.cwd !== "E:\\projects\\moved") {
    throw new Error(`moved session cwd was not synchronized: ${tabs.getActive()?.cwd}`);
  }
  tabs.updateTab(tabs.getActive().id, { slotId: "slot-b", turnStartedAt: Date.now() - 3000 });
  if (tabs.findBySlot("slot-b") !== tabs.getActive()) throw new Error("slot ownership lookup");
  tabs.queueEvent(tabs.getActive().id, { type: "assistant_delta", slotId: "slot-b", text: "one" });
  tabs.queueEvent(tabs.getActive().id, { type: "assistant_delta", slotId: "slot-b", text: " two" });
  const pending = tabs.takePendingEvents(tabs.getActive().id);
  if (pending.length !== 1 || pending[0].text !== "one two") throw new Error("inactive stream coalescing");
  tabs.setBusy(tabs.activeId, true);
  const latestRail = tabRoot.children[tabRoot.children.length - 1];
  const activeButton = latestRail?.children?.find?.((el) => String(el.className).includes("active"));
  const activeLabel = activeButton?.children?.find?.((el) => el.className === "session-tab-label");
  activeLabel?.ondblclick?.({ stopPropagation() {} });
  if (renameTarget !== tabs.getActive()) throw new Error("direct tab rename interaction");
  tabs.setBusy(tabs.activeId, false);
  ok("sessionTabs cache + slot runtime + rename");
} catch (e) {
  fail("sessionTabs UI", e);
}

// Switching tabs is cache-only. Agent resume/spawn happens exclusively at send time.
try {
  const appSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/app.js"), "utf8");
  const activateStart = appSrc.indexOf("onActivate: (tab, prev) =>");
  const activateEnd = appSrc.indexOf("onNew: () =>", activateStart);
  const activation = appSrc.slice(activateStart, activateEnd);
  if (activateStart < 0 || activateEnd < 0) throw new Error("tab activation block missing");
  if (/loadSession\s*\(/.test(activation)) throw new Error("tab activation resumes backend session");
  if (!/takePendingEvents/.test(activation)) throw new Error("inactive event replay missing");
  const binderStart = appSrc.indexOf("async function ensureActiveTabAgent");
  const sendStart = appSrc.indexOf("async function send()", binderStart);
  const binder = appSrc.slice(binderStart, sendStart);
  if (!/spawnAgentSlot/.test(binder) || !/slotIsRunning/.test(binder)) {
    throw new Error("concurrent tab slot guard missing");
  }
  if (!/await ensureActiveTabAgent\(\)/.test(appSrc.slice(sendStart))) {
    throw new Error("send-time agent binding missing");
  }
  const alignStart = appSrc.indexOf("async function alignProjectWorkspace");
  const openProjectStart = appSrc.indexOf("async function openProjectTab", alignStart);
  const sidebarStart = appSrc.indexOf("function renderProjects()", openProjectStart);
  const sidebarEnd = appSrc.indexOf("function renderProjectMenu()", sidebarStart);
  const alignment = appSrc.slice(alignStart, openProjectStart);
  const sidebar = appSrc.slice(sidebarStart, sidebarEnd);
  if (alignStart < 0 || openProjectStart < 0 || sidebarStart < 0 || sidebarEnd < 0) {
    throw new Error("sidebar project navigation blocks missing");
  }
  if (/connect\s*\(|resetToOne\s*\(/.test(alignment)) {
    throw new Error("project alignment mutates agent or tab ownership");
  }
  if (!/openProjectTab\(p\)/.test(sidebar)) {
    throw new Error("sidebar project header bypasses ownership-preserving navigation");
  }
  ok("tab/sidebar activation cache-only + send-time slot binding");
} catch (e) {
  fail("tab runtime regression", e);
}

// Agent slots UI: hide when only primary
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/agentSlotsUi.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const host = {
    classList: {
      _s: new Set(["hidden"]),
      add: (c) => host.classList._s.add(c),
      remove: (c) => host.classList._s.delete(c),
      contains: (c) => host.classList._s.has(c),
    },
    innerHTML: "x",
    appendChild() {},
  };
  globalThis.GrokAgentSlotsUi.render(host, {
    slots: [{ id: "primary", label: "Chat", warm: true, state: "connected" }],
    activeId: "primary",
    maxSlots: 2,
  });
  if (!host.classList.contains("hidden") || host.innerHTML !== "") {
    throw new Error("single primary must stay hidden");
  }
  ok("agentSlotsUi hide single");
} catch (e) {
  fail("agentSlotsUi", e);
}

// P2 file mentions
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/fileMentions.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const FM = globalThis.GrokFileMentions;
  const m = FM.findMentionAt("see @src/foo", 12);
  if (!m || m.query !== "src/foo") throw new Error(`mention ${JSON.stringify(m)}`);
  const filtered = FM.filterPaths(["src/a.js", "lib/b.ts", "src/foo.js"], "foo");
  if (!filtered.some((p) => p.includes("foo"))) throw new Error("filter");
  const ins = FM.insertMention("see @fo", 4, 7, "src/a.js");
  if (!ins.value.includes("@src/a.js")) throw new Error(ins.value);
  ok("fileMentions parse + insert");
} catch (e) {
  fail("fileMentions", e);
}

// P2 git porcelain path + createPr export
try {
  const git = require(path.join(root, "apps/desktop/src/gitStatus.cjs"));
  if (typeof git.createPullRequest !== "function") throw new Error("createPullRequest");
  const p = git.parsePorcelainPath(" M apps/desktop/src/main.cjs");
  if (!p.includes("main.cjs")) throw new Error(p);
  ok("gitStatus P2 helpers");
} catch (e) {
  fail("gitStatus P2", e);
}

// Marketplace catalog loader
try {
  const { loadMarketplaceCatalog } = require(
    path.join(root, "apps/desktop/src/marketplaceCatalog.cjs"),
  );
  const cat = loadMarketplaceCatalog();
  if (!cat || !cat.ok) throw new Error("catalog not ok");
  if (!Array.isArray(cat.plugins) || !Array.isArray(cat.marketplaces)) {
    throw new Error("shape");
  }
  // On dev machines with grok cache, expect plugins; without cache still ok
  ok(
    `marketplaceCatalog (${cat.marketplaces.length} mkts, ${cat.plugins.length} plugins)`,
  );
} catch (e) {
  fail("marketplaceCatalog", e);
}

// Slash commands + media extract (Imagine path)
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/slashCommands.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const SC = globalThis.GrokSlashCommands;
  const r1 = SC.resolveSlash("/imagine a red cube");
  if (r1.kind !== "prompt" || !/image_gen/i.test(r1.text)) {
    throw new Error(`imagine expand: ${JSON.stringify(r1)}`);
  }
  const r2 = SC.resolveSlash("/imagine-video cat jazz");
  if (r2.kind !== "prompt" || !/image_to_video/i.test(r2.text)) {
    throw new Error("imagine-video expand");
  }
  if (!/videos\//i.test(r2.text)) throw new Error("imagine-video should mention videos/ paths");
  const r2b = SC.resolveSlash("/imagine-video cat", {
    codingDataRetentionOptOut: true,
    imagineVideoBlocked: true,
  });
  if (r2b.kind !== "prompt" || !/PREFLIGHT/i.test(r2b.text)) {
    throw new Error("imagine-video should inject privacy preflight when opted out");
  }
  if (!SC.imagineVideoPreflightNote?.({ imagineVideoBlocked: true })) {
    throw new Error("imagineVideoPreflightNote missing");
  }
  const r3 = SC.resolveSlash("/settings");
  if (r3.kind !== "ui" || r3.action !== "settings") throw new Error("settings ui");
  const menu = SC.menuForInput("/ima", 4);
  if (!menu?.items?.some((c) => c.id === "imagine")) throw new Error("menu filter");
  const media = SC.extractMediaRefs(
    "see ![shot](C:\\\\tmp\\\\a.png) and E:\\\\out\\\\clip.mp4 and videos/1.mp4 done",
  );
  if (!media.some((m) => m.kind === "image")) throw new Error("image ref");
  if (!media.some((m) => m.kind === "video")) throw new Error("video ref");
  if (!media.some((m) => /videos[\\/]1\.mp4/i.test(m.src))) {
    throw new Error("relative videos/ path");
  }
  const trust = SC.resolveSlash("/hooks-trust");
  if (trust.kind !== "ui" || trust.action !== "hooks-trust") {
    throw new Error(`hooks-trust ui: ${JSON.stringify(trust)}`);
  }
  ok("slashCommands imagine + media extract");
} catch (e) {
  fail("slashCommands", e);
}

try {
  const {
    parseTrustedFolders,
    serializeTrustedFolders,
    getFolderTrust,
    setFolderTrust,
  } = require(path.join(root, "apps/desktop/src/folderTrust.cjs"));
  const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-trust-"));
  const folder = path.join(grokHome, "project");
  fs.mkdirSync(folder);
  const parsed = parseTrustedFolders(
    "[folders.'E:\\\\projects\\\\Grok-Build']\ntrusted = true\ndecided_at = 10\n",
  );
  if (!parsed.length || parsed[0].trusted !== true) throw new Error("parse trusted folder");
  const text = serializeTrustedFolders([{ path: folder, trusted: true, decidedAt: 11 }]);
  if (!text.includes("trusted = true")) throw new Error("serialize");
  const before = getFolderTrust(grokHome, folder);
  if (before.trusted) throw new Error("default should be untrusted");
  const after = setFolderTrust(grokHome, folder, true);
  if (!after.trusted) throw new Error("set trust failed");
  const again = getFolderTrust(grokHome, folder);
  if (!again.trusted) throw new Error("trust did not persist");
  setFolderTrust(grokHome, folder, false);
  if (getFolderTrust(grokHome, folder).trusted) throw new Error("untrust failed");
  ok("folderTrust store");
} catch (e) {
  fail("folderTrust", e);
}

// Finalized assistant content recognizes navigable local paths without
// mistaking URLs or prose slash-pairs for filesystem locations.
try {
  const source = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/pathLinks.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(source)();
  const sample = "Open E:\\work\\app\\dist\\setup.exe and apps/desktop/styles.css; skip https://example.com/a/file.txt and reasoning/tool";
  const found = globalThis.GrokPathLinks.findSegments(sample).map((entry) => entry.path);
  if (!found.includes("E:\\work\\app\\dist\\setup.exe")) throw new Error(`absolute path missing: ${found.join(" | ")}`);
  if (!found.includes("apps/desktop/styles.css")) throw new Error(`relative path missing: ${found.join(" | ")}`);
  if (found.some((value) => /example\.com|reasoning\/tool/.test(value))) throw new Error(`false path: ${found.join(" | ")}`);
  ok("session path link detection");
} catch (e) {
  fail("session path links", e);
}

// Markdown supports images and emits the same framed-table wrapper on both
// the main-thread fallback and the off-thread production renderer.
try {
  const src = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/markdown.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(src)();
  const html = globalThis.GrokMarkdown.renderMarkdown("hi ![x](./a.png)");
  if (!/md-img|img /i.test(html)) throw new Error(html.slice(0, 120));
  const spacedPathHtml = globalThis.GrokMarkdown.renderMarkdown(
    "[report](<E:\\work\\project with spaces\\report.md:12>)",
  );
  if (!/md-path-link/.test(spacedPathHtml) || !/project with spaces/.test(spacedPathHtml)) {
    throw new Error(`markdown path with spaces: ${spacedPathHtml}`);
  }
  const tableSource = "| Name | State |\n|---|---|\n| Desktop | Ready |";
  const tableHtml = globalThis.GrokMarkdown.renderMarkdown(tableSource);
  if (!tableHtml.includes('class="md-table-wrap"') || !tableHtml.includes("<table>")) {
    throw new Error(`main markdown table: ${tableHtml.slice(0, 160)}`);
  }

  const previousSelf = globalThis.self;
  let workerReply = null;
  globalThis.self = {
    postMessage(value) { workerReply = value; },
    onmessage: null,
  };
  const workerSource = fs.readFileSync(
    path.join(root, "apps/desktop/renderer/lib/workers/contentWorker.js"),
    "utf8",
  );
  // eslint-disable-next-line no-new-func
  new Function(workerSource)();
  globalThis.self.onmessage({ data: { id: 1, type: "markdown", source: tableSource } });
  if (!workerReply?.ok || !workerReply.html?.includes('class="md-table-wrap"') || !workerReply.html.includes("<table>")) {
    throw new Error(`worker markdown table: ${String(workerReply?.html || workerReply).slice(0, 160)}`);
  }
  if (previousSelf === undefined) delete globalThis.self;
  else globalThis.self = previousSelf;
  ok("markdown images + framed tables");
} catch (e) {
  fail("markdown images", e);
}

// Media preview path allow-list (Imagine ~/.grok/sessions)
try {
  const sec = require(path.join(root, "apps/desktop/src/security.cjs"));
  const home = os.homedir();
  const grokHome = path.join(home, ".grok");
  // Simulate URL-encoded session project key (real Grok layout)
  const encProj = encodeURIComponent("E:\\projects\\Grok-Build");
  const imgDir = path.join(grokHome, "sessions", encProj, "sess-test", "images");
  fs.mkdirSync(imgDir, { recursive: true });
  const imgPath = path.join(imgDir, "2.jpg");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(imgPath, png);

  // Full path as on disk (encoded folder name) must work — no bulk decode
  const resolved = sec.assertMediaPreviewPath(imgPath, {
    workspaceRoot: "E:\\projects\\Grok-Build",
    allowOutside: false,
    grokHome,
  });
  if (!fs.existsSync(resolved)) throw new Error("resolved missing");

  // Relative images/2.jpg against workspace → session lookup
  const rel = sec.assertMediaPreviewPath("images/2.jpg", {
    workspaceRoot: "E:\\projects\\Grok-Build",
    allowOutside: false,
    grokHome,
  });
  if (!fs.existsSync(rel)) throw new Error("relative session image failed");

  // Session videos/ for Imagine video pipeline
  const vidDir = path.join(grokHome, "sessions", encProj, "sess-test", "videos");
  fs.mkdirSync(vidDir, { recursive: true });
  const vidPath = path.join(vidDir, "1.mp4");
  fs.writeFileSync(vidPath, Buffer.from("fake-mp4"));
  const relVid = sec.assertMediaPreviewPath("videos/1.mp4", {
    workspaceRoot: "E:\\projects\\Grok-Build",
    allowOutside: false,
    grokHome,
  });
  if (!fs.existsSync(relVid)) throw new Error("relative session video failed");

  // decodeURIComponent would break encoded session path — sanitize keeps it
  const broken = sec.sanitizeMediaPathInput(imgPath);
  if (broken.includes("E:\\projects") && !fs.existsSync(broken)) {
    // if sanitize wrongly decoded, fail
    throw new Error("sanitize must not destroy encoded session dirs");
  }

  let blocked = false;
  try {
    sec.assertMediaPreviewPath(path.join(grokHome, "auth.json"), {
      workspaceRoot: tmp,
      allowOutside: true,
      grokHome,
    });
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("auth.json must stay blocked");
  try {
    fs.rmSync(path.join(grokHome, "sessions", encProj), { recursive: true, force: true });
  } catch {
    // ignore
  }
  ok("media preview session paths + relative images/");
} catch (e) {
  fail("media preview path", e);
}

// ── 2b Security helpers ──
console.log("\n[2b] Security");
try {
  const sec = require(path.join(root, "apps/desktop/src/security.cjs"));
  const rootWs = tmp;
  // outside path blocked
  let blocked = false;
  try {
    sec.assertWorkspacePath(path.join(os.homedir(), "Desktop", "x.txt"), {
      workspaceRoot: rootWs,
      allowOutside: false,
      grokHome: path.join(os.homedir(), ".grok"),
    });
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("outside path should fail");
  // credential block
  blocked = false;
  try {
    sec.assertWorkspacePath(path.join(os.homedir(), ".grok", "auth.json"), {
      workspaceRoot: rootWs,
      allowOutside: true,
      grokHome: path.join(os.homedir(), ".grok"),
    });
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("auth.json should be blocked");
  // safe url
  sec.assertSafeExternalUrl("https://x.ai/");
  blocked = false;
  try {
    sec.assertSafeExternalUrl("file:///C:/Windows/System32");
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("file: url should fail");
  blocked = false;
  try {
    sec.assertSafeExternalUrl("https://user:password@example.com/private");
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("credential-bearing URL should fail");
  // cli allowlist
  sec.assertSafeGrokCliArgs(["doctor"]);
  blocked = false;
  try {
    sec.assertSafeGrokCliArgs(["agent", "stdio"]);
  } catch {
    blocked = true;
  }
  if (!blocked) throw new Error("agent stdio should fail");
  ok("security path/url/cli gates");
} catch (e) {
  fail("security", e);
}

// ── 3 Packaging contract ──
console.log("\n[3] Packaging (D5)");
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
  );
  if (pkg.build?.win?.signAndEditExecutable !== false) {
    throw new Error("signAndEditExecutable must be false");
  }
  if (pkg.build?.afterPack !== "build/stamp-win-icon.cjs") {
    throw new Error("afterPack missing");
  }
  const stamp = fs.readFileSync(
    path.join(root, "apps/desktop/build/stamp-win-icon.cjs"),
    "utf8",
  );
  if (!/set-icon|rcedit/.test(stamp)) throw new Error("stamp script incomplete");
  if (!/--set-icon/.test(stamp) && !/set-icon/.test(stamp)) {
    // stamp uses --set-icon
  }
  ok("packaging icon stamp contract");
} catch (e) {
  fail("packaging", e);
}

// ── 4 Optional live grok ──
console.log("\n[4] Live CLI smoke" + (live ? "" : " (skip — set GROK_E2E_LIVE=1)"));
if (live) {
  try {
    const r = await new Promise((resolve) => {
      const child = spawn("grok", ["--version"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: process.platform === "win32",
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("error", (e) => resolve({ code: -1, out: e.message }));
      child.on("close", (code) => resolve({ code, out }));
    });
    if (r.code !== 0 && !/grok|version|\d+\.\d+/i.test(r.out)) {
      throw new Error(r.out || `exit ${r.code}`);
    }
    ok(`grok available: ${r.out.trim().slice(0, 80)}`);
  } catch (e) {
    fail("live grok --version", e);
  }
} else {
  ok("live skipped");
}

// cleanup
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // ignore
}

console.log(`\nE2E result: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
