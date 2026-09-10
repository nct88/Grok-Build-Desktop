import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { formatRelativeAge } = require(path.join(root, "apps/desktop/renderer/lib/domHelpers.js"));
await import(pathToFileURL(path.join(root, "apps/desktop/renderer/lib/timelineView.js")));

const now = Date.parse("2026-09-09T12:00:00.000Z");
assert.equal(formatRelativeAge("2026-09-09T11:59:30.000Z", now), "now");
assert.equal(formatRelativeAge("2026-09-09T11:15:00.000Z", now), "45m");
assert.equal(formatRelativeAge("2026-09-09T09:00:00.000Z", now), "3h");
assert.equal(formatRelativeAge("2026-09-02T12:00:00.000Z", now), "7d");
assert.equal(formatRelativeAge("", now), "");
assert.equal(formatRelativeAge(null, now), "");

await import(pathToFileURL(path.join(root, "apps/desktop/renderer/lib/i18n.js")));
const i18n = globalThis.GrokI18n;
assert.ok(i18n?.STR?.vi?.ageNow, "Vietnamese relative-age strings exist");
assert.equal(i18n.STR.en.ageMinutes, "{n}m");
assert.equal(i18n.STR.vi.ageMinutes, "{n}p");
const vi = (key, fallback) => i18n.STR.vi[key] || fallback;
assert.equal(formatRelativeAge("2026-09-09T11:59:30.000Z", now, vi), "vừa xong");
assert.equal(formatRelativeAge("2026-09-09T11:15:00.000Z", now, vi), "45p");
assert.equal(formatRelativeAge("2026-09-09T09:00:00.000Z", now, vi), "3g");
assert.equal(formatRelativeAge("2026-09-02T12:00:00.000Z", now, vi), "7ng");
const en = (key, fallback) => i18n.STR.en[key] || fallback;
assert.equal(formatRelativeAge("2026-09-09T11:15:00.000Z", now, en), "45m");

const pinRangeToTail = globalThis.GrokTimelineView.pinRangeToTail;
assert.ok(pinRangeToTail, "timeline exports pinRangeToTail");
const heights = Array.from({ length: 80 }, () => 200);
const unpinned = pinRangeToTail(80, 10, 20, false, 600, (i) => heights[i]);
assert.deepEqual(unpinned, { start: 10, end: 20 });
const pinned = pinRangeToTail(80, 10, 20, true, 600, (i) => heights[i]);
assert.equal(pinned.end, 80);
assert.ok(pinned.start <= 77, "tail pin includes the last messages");
assert.ok(pinned.start >= 67, "tail pin does not remount the whole transcript");

console.log("Relative age + timeline tail pin: passed");
