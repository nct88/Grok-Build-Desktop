import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(
  path.join(root, "apps", "desktop", "renderer", "lib", "effortChoice.js"),
  "utf8",
);
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const effort = context.globalThis.GrokEffortChoice;

const grok47 = [
  { value: "xhigh", name: "Extra High", default: false },
  { value: "high", name: "High", default: true },
  { value: "medium", name: "Medium", default: false },
  { value: "low", name: "Low", default: false },
];

assert.equal(effort.normalizeEffortId("Extra High"), "xhigh");
assert.equal(effort.normalizeEffortId("x-high"), "xhigh");

assert.equal(
  effort.resolveEffortValue({ choices: grok47, currentValue: "", selectedValue: "" }),
  "high",
  "empty current value uses the option marked default, not the first row",
);

assert.equal(
  effort.resolveEffortValue({
    choices: grok47,
    currentValue: "xhigh",
    savedEffort: "xhigh",
    selectedValue: "high",
    userOwned: true,
  }),
  "high",
  "a click on High stays High when ACP still echoes Extra High",
);

assert.equal(
  effort.shouldRestoreSavedEffort({
    userOwned: true,
    savedEffort: "xhigh",
    selectedValue: "medium",
    choices: grok47,
  }),
  false,
);

assert.equal(
  effort.shouldRestoreSavedEffort({
    userOwned: false,
    savedEffort: "medium",
    selectedValue: "xhigh",
    choices: grok47,
  }),
  true,
);

const app = await readFile(path.join(root, "apps", "desktop", "renderer", "app.js"), "utf8");
assert.match(app, /restoredSavedEffort/);
assert.match(app, /GrokEffortChoice/);
assert.match(app, /saveLayout\(\{ effort: id \}\)/);

console.log("effort choice: passed");
