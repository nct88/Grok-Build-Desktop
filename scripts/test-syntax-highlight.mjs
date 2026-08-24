import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await import(pathToFileURL(path.join(root, "apps", "desktop", "renderer", "lib", "syntaxHighlight.js")));

const syntax = globalThis.GrokSyntax;
assert.ok(syntax, "syntax highlighter should register on globalThis");

const languages = new Map([
  ["src/app.tsx", "TypeScript"],
  ["src/netinfo.rs", "Rust"],
  ["tools/check.py", "Python"],
  ["web/index.html", "HTML"],
  ["web/styles.css", "CSS"],
  ["README.md", "Markdown"],
  ["package.json", "JSON"],
  ["Dockerfile", "Dockerfile"],
]);
for (const [file, expected] of languages) {
  assert.equal(syntax.languageForPath(file).label, expected, `${file} language`);
}

const rust = syntax.tokenize(
  'pub fn local_network_kind() -> Option<u32> {\n  let port = 42; // cached value\n  Some(port)\n}',
  "rust",
);
assert.ok(rust.some((token) => token.type === "keyword" && token.text.includes("pub")));
assert.ok(rust.some((token) => token.type === "function" && token.text.includes("local_network_kind")));
assert.ok(rust.some((token) => token.type === "type" && token.text.includes("u32")));
assert.ok(rust.some((token) => token.type === "number" && token.text === "42"));
assert.ok(rust.some((token) => token.type === "comment" && token.text.includes("cached value")));

const json = syntax.tokenize('{"name":"grok-build","private":true,"count":3}', "json");
assert.ok(json.some((token) => token.type === "property" && token.text === '"name"'));
assert.ok(json.some((token) => token.type === "literal" && token.text === "true"));

const hostile = '<img src=x onerror="globalThis.pwned=true">';
const markup = syntax.tokenize(hostile, "markup");
assert.equal(markup.map((token) => token.text).join(""), hostile, "tokenization must preserve source exactly");

console.log(`Syntax highlighting: ${languages.size} language mappings and token classes passed.`);
