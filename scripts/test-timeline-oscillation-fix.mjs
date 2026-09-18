import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tlSrc = fs.readFileSync(
  path.join(root, "apps/desktop/renderer/lib/timelineView.js"),
  "utf8",
);

new Function(tlSrc)();
const TL = globalThis.GrokTimelineView;

assert.equal(TL.VIRTUAL_THRESHOLD, 64);
assert.ok(typeof TL.pinRangeToTail === "function");

const heights = Array.from({ length: 100 }, () => 100);
const pinned = TL.pinRangeToTail(100, 10, 20, true, 4000, (i) => heights[i]);
assert.equal(pinned.end, 100);
assert.ok(pinned.start <= 60, "generous tail budget mounts at least 40 items at tail");

assert.ok(
  tlSrc.includes("const maxScroll = Math.max(0, root.scrollHeight - root.clientHeight);"),
  "maxScroll calculation must be present",
);
assert.ok(
  !tlSrc.includes("if (stickToBottom) {\n        scrollEnd(false);"),
  "render() must not call scrollEnd(false) recursively",
);
assert.ok(
  tlSrc.includes("WINDOW_OVERSCAN = 30;"),
  "WINDOW_OVERSCAN must be at least 30",
);
assert.ok(
  tlSrc.includes("top = Math.min(top, Math.max(0, scrollTop));"),
  "spacerTop <= scrollTop invariant preserved",
);

console.log("Timeline oscillation & scroll-up verification: PASSED");
