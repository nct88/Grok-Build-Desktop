import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// 1. Contract tests for app.js and eventStore.js
const appSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/app.js"), "utf8");
const esSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/lib/eventStore.js"), "utf8");
const tlSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/lib/timelineView.js"), "utf8");

assert.ok(
  appSrc.includes("if (activeSessionId && eventStore.length === 0 && !busy)"),
  "app.js must guard paintTranscript in case 'session' against overwriting live/busy eventStore",
);

assert.ok(
  appSrc.includes("convTitle.textContent = projectName ? `${projectName} · ${rawTitle}` : rawTitle;"),
  "app.js syncConvTitle must display project and conversation / prompt title in header",
);

assert.ok(
  appSrc.includes("syncConvTitle(newTitle);"),
  "app.js send() must update convTitle when generating title from the first user line",
);

assert.ok(
  tlSrc.includes("if (item.kind === \"user\") {"),
  "timelineView.js must handle user items specifically on update",
);

// 2. Functional test of eventStore.js loadTurns preserving pending user prompts
// Emulate global environment for eventStore
const globalScope = {};
const fn = new Function("globalThis", esSrc);
fn(globalScope);

const store = globalScope.GrokEventStore.create();

// User sends prompt
store.append("user", "lock-horizontal-rail cuộn Top 10");

// Concurrently, a background paintTranscript calls loadTurns with previous history
store.loadTurns([
  { role: "user", text: "Xin chào Grok" },
  { role: "assistant", text: "Chào bạn, tôi có thể giúp gì?" },
]);

assert.equal(store.items.length, 3, "Store must keep both 2 historical messages and 1 pending user prompt");
assert.equal(store.items[0].text, "Xin chào Grok");
assert.equal(store.items[1].text, "Chào bạn, tôi có thể giúp gì?");
assert.equal(store.items[2].text, "lock-horizontal-rail cuộn Top 10");
assert.equal(store.items[2].kind, "user");

// 3. Functional test of readSessionTranscript ignoring scaffolding
import { pathToFileURL } from "node:url";
const { readSessionTranscript } = await import(pathToFileURL(path.join(root, "packages/sessions/dist/index.js")).href);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-session-test-"));
try {
  const sessionDir = path.join(tmpDir, "sessions", "test-project", "session-test-123");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "summary.json"), JSON.stringify({ session_title: "Test" }), "utf8");
  const historyPath = path.join(sessionDir, "chat_history.jsonl");

  const lines = [
    JSON.stringify({ type: "user", content: "<user_info>\nPlatform: win32\nBranch: main\n</user_info>" }),
    JSON.stringify({ type: "user", content: "<user_query>Làm sao để cuộn ngang thanh Top 10?</user_query>" }),
    JSON.stringify({ type: "assistant", content: "Bạn cần kiểm tra overflow-x: auto và wheel listener." }),
    JSON.stringify({ type: "user", content: "<system-reminder>Remember to follow conventions</system-reminder>" }),
  ];
  fs.writeFileSync(historyPath, lines.join("\n"), "utf8");

  const transcript = await readSessionTranscript({ sessionId: "session-test-123", grokHome: tmpDir });
  assert.equal(transcript.length, 2, "Scaffolding rows should be skipped, keeping only real query and answer");
  assert.equal(transcript[0].role, "user");
  assert.equal(transcript[0].text, "Làm sao để cuộn ngang thanh Top 10?");
  assert.equal(transcript[1].role, "assistant");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("All user prompt persistence and convTitle tests passed successfully!");
