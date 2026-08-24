import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { MAX_HINT_LENGTH, normalizeInspectSkills } = require(
  path.join(root, "apps", "desktop", "src", "slashCatalog.cjs"),
);

const workspaceRoot = path.join(root, "temp", "slash-fixture-project");
const grokHome = path.join(root, "temp", "slash-fixture-home", ".grok");
const localSkill = (name, description, sourcePath, extra = {}) => ({
  name,
  description,
  userInvocable: true,
  source: { type: "project", path: sourcePath },
  ...extra,
});

const inspect = {
  skills: [
    localSkill(
      "work-analysis",
      "Produce a claims-vs-code analysis report. This second sentence stays out of the compact hint.",
      path.join(workspaceRoot, ".grok", "skills", "work-analysis", "SKILL.md"),
    ),
    localSkill(
      "context-watch",
      "Detect when reasoning quality is dropping because the context window is filling and provide a deliberately long explanation that must be truncated before it can make the slash menu too dense.",
      path.join(grokHome, "skills", "context-watch", "SKILL.md"),
      { source: { type: "user", path: path.join(grokHome, "skills", "context-watch", "SKILL.md") } },
    ),
    localSkill(
      "external-skill",
      "Must not appear.",
      path.join(root, "outside", "SKILL.md"),
      { source: { type: "user", path: path.join(root, "outside", "SKILL.md") } },
    ),
    localSkill(
      "bundled-review",
      "Must not appear.",
      path.join(grokHome, "bundled", "skills", "review", "SKILL.md"),
      { source: { type: "bundled", path: path.join(grokHome, "bundled", "skills", "review", "SKILL.md") } },
    ),
    localSkill(
      "disabled-skill",
      "Must not appear.",
      path.join(workspaceRoot, ".grok", "skills", "disabled-skill", "SKILL.md"),
      { userInvocable: false },
    ),
  ],
};

const catalog = normalizeInspectSkills(inspect, { workspaceRoot, grokHome });
assert.deepEqual(catalog.map((command) => command.id), ["context-watch", "work-analysis"]);
assert.ok(catalog.every((command) => command.hint.length <= MAX_HINT_LENGTH));
assert.equal(catalog.find((command) => command.id === "work-analysis")?.hint, "Produce a claims-vs-code analysis report.");
assert.deepEqual(normalizeInspectSkills(null, { workspaceRoot, grokHome }), []);

const source = await readFile(
  path.join(root, "apps", "desktop", "renderer", "lib", "slashCommands.js"),
  "utf8",
);
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const slash = context.globalThis.GrokSlashCommands;

const builtinIds = Array.from(slash.COMMANDS, (command) => command.id);
for (const id of [
  "new",
  "resume",
  "dashboard",
  "fork",
  "session-info",
  "context",
  "compact",
  "recap",
  "rewind",
  "copy",
  "export",
  "rename",
  "delete",
  "quit",
  "home",
  "model",
  "effort",
  "plan",
  "view-plan",
  "history",
  "compact-mode",
  "multiline",
  "timestamps",
  "always-approve",
  "auto",
  "btw",
  "remember",
  "memory",
  "flush",
  "dream",
  "imagine",
  "imagine-video",
  "usage",
  "settings",
  "marketplace",
  "plugins",
  "skills",
  "mcps",
  "hooks",
  "hooks-trust",
  "hooks-untrust",
  "hooks-list",
  "hooks-add",
  "hooks-remove",
  "loop",
  "goal",
  "deep-research",
  "workflow",
  "workflows",
  "theme",
  "tutorial",
  "import-claude",
  "config-agents",
  "personas",
  "docs",
  "changelog",
  "doctor",
  "feedback",
  "privacy",
  "login",
  "logout",
]) {
  assert.ok(builtinIds.includes(id), `missing built-in /${id}`);
}
assert.equal(slash.resolveSlash("/clear").action, "new");
assert.equal(slash.resolveSlash("/status").action, "session-info");
assert.equal(slash.resolveSlash("/undo").kind, "prompt");
assert.equal(slash.resolveSlash("/hooks-trust").action, "hooks-trust");
assert.equal(slash.resolveSlash("/hooks-untrust").action, "hooks-untrust");
assert.equal(slash.resolveSlash("/exit").action, "quit");
assert.equal(slash.resolveSlash("/t").action, "theme");
assert.equal(slash.resolveSlash("/agents-dashboard").action, "dashboard");
assert.equal(slash.resolveSlash("/show-plan").action, "view-plan");
assert.equal(slash.resolveSlash("/ml").action, "multiline");
assert.match(slash.resolveSlash("/loop 30m ping").text, /scheduler_create/);
assert.match(slash.resolveSlash("/goal status").text, /status\/pause\/resume\/clear/);
assert.match(slash.resolveSlash("/deep-research postgres vs mysql").text, /Query: postgres vs mysql/);
assert.equal(slash.resolveSlash("/terminal-info").action, "doctor");
assert.match(slash.resolveSlash("/compact keep auth").text, /Preserve especially: keep auth/);
assert.match(slash.resolveSlash("/recap").text, /recap of this session/i);
assert.equal(slash.resolveSlash("/effort high").action, "effort");
assert.equal(slash.resolveSlash("/effort high").arg, "high");
slash.setRuntimeCommands(catalog);
assert.deepEqual(
  Array.from(slash.COMMANDS, (command) => command.id).slice(-2),
  ["context-watch", "work-analysis"],
);
assert.ok(slash.COMMANDS.every((command) => command.id !== "imagine" || command.kind !== "skill"));
assert.deepEqual(
  Array.from(slash.menuForInput("/work", 5).items, (command) => command.id),
  ["workflow", "workflows", "work-analysis"],
);
assert.deepEqual(
  Array.from(slash.menuForInput("/work-a", 7).items, (command) => command.id),
  ["work-analysis"],
);
assert.equal(
  slash.resolveSlash("/work-analysis check release claims").text,
  "Use the work-analysis skill and follow it.\nUser request: check release claims",
);
assert.equal(slash.resolveSlash("/settings").kind, "ui");
assert.equal(slash.resolveSlash("/not-installed").kind, "passthrough");
slash.setRuntimeCommands([]);
assert.equal(slash.menuForInput("/work-a", 7), null);

console.log("Slash command catalog OK: built-ins, aliases, local skill discovery, filtering, invocation, fallback.");
