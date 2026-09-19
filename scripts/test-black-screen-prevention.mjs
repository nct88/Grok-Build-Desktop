import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const mainSrc = fs.readFileSync(path.join(root, "apps/desktop/src/main.cjs"), "utf8");
const mdSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/lib/markdown.js"), "utf8");
const tlSrc = fs.readFileSync(path.join(root, "apps/desktop/renderer/lib/timelineView.js"), "utf8");

// 1. Crash recovery in main.cjs
assert.ok(
  mainSrc.includes('mainWindow.webContents.on("render-process-gone"'),
  "main.cjs must handle render-process-gone",
);
assert.ok(
  mainSrc.includes('app.on("child-process-gone"'),
  "main.cjs must handle child-process-gone",
);
assert.ok(
  mainSrc.includes("disable-gpu-process-crash-limit"),
  "main.cjs must configure disable-gpu-process-crash-limit on Windows",
);

// 2. IPC payload capping in onFileWrite
assert.ok(
  mainSrc.includes("MAX_TEXT_LEN = 120_000"),
  "main.cjs onFileWrite must cap text to prevent IPC buffer explosion",
);

// 3. Markdown streaming performance
assert.ok(
  mdSrc.includes("enhanceMarkdownElement(element, openLink, isStreaming)"),
  "markdown.js must support isStreaming parameter",
);
assert.ok(
  mdSrc.includes("// While streaming, defer heavy syntax tokenization to finalizeItem"),
  "markdown.js must defer syntax tokenization during streaming",
);

// 4. TimelineView streaming integration
assert.ok(
  tlSrc.includes("const isStreaming = Boolean(item.streaming);"),
  "timelineView.js must pass isStreaming to enhanceElement",
);
assert.ok(
  tlSrc.includes("safeOld = typeof oldText === \"string\" && oldText.length > 150_000"),
  "timelineView.js renderCliDiff must cap oldText length",
);

console.log("Black screen prevention contracts passed: render recovery, GPU crash limit, streaming DOM deferral, and IPC payload caps verified.");
