import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { insertAtSelection } = require(
  path.join(root, "apps/desktop/renderer/lib/voiceTranscript.js"),
);

assert.deepEqual(insertAtSelection("before after", 7, 7, "spoken"), {
  value: "before spokenafter",
  selectionStart: 13,
  selectionEnd: 13,
});
assert.deepEqual(insertAtSelection("before selected after", 7, 15, "spoken"), {
  value: "before spoken after",
  selectionStart: 13,
  selectionEnd: 13,
});
assert.deepEqual(insertAtSelection("tail", 999, 999, "!"), {
  value: "tail!",
  selectionStart: 5,
  selectionEnd: 5,
});

console.log("Voice transcript selection insertion: passed");
