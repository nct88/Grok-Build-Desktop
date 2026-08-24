import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const version = (await readFile(path.join(root, "product", "VERSION"), "utf8")).trim();
const evidenceDir = path.join(root, "docs", "reports", "evidence", version);
const profileDir = path.join(root, ".build", `explorer-profile-${process.pid}`);
const fixtureRoot = path.join(root, ".build", `project-explorer-fixture-${process.pid}`);
const fixtureName = path.basename(fixtureRoot);

await mkdir(evidenceDir, { recursive: true });
await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
await mkdir(path.join(fixtureRoot, "styles"), { recursive: true });
await mkdir(path.join(fixtureRoot, "empty"), { recursive: true });
await mkdir(path.join(fixtureRoot, ".project-memory"), { recursive: true });
await mkdir(profileDir, { recursive: true });
await writeFile(
  path.join(fixtureRoot, "src", "netinfo.rs"),
  [
    "use std::net::Ipv4Addr;",
    "",
    "// Resolve the local network kind without blocking the UI.",
    "pub fn local_network_kind(ip: &str) -> Option<u32> {",
    "    let fallback: u32 = 42;",
    "    if ip.is_empty() { return Some(fallback); }",
    "    None",
    "}",
  ].join("\n"),
);
await writeFile(
  path.join(fixtureRoot, "src", "sessionTabs.ts"),
  'export function activateTab(id: string): boolean {\n  return id.length > 0;\n}\n',
);
await writeFile(path.join(fixtureRoot, "styles", "app.css"), ".panel { color: #f5f5f5; display: grid; }\n");
await writeFile(path.join(fixtureRoot, "README.md"), "# Project explorer fixture\n\nChoose a source file.\n");
await writeFile(path.join(fixtureRoot, "package.json"), '{"name":"explorer-fixture","private":true}\n');
await writeFile(path.join(fixtureRoot, ".project-memory", "STATE.md"), "# State\n\nExplorer fixture.\n");
await writeFile(
  path.join(fixtureRoot, "a-very-long-file-name-that-must-truncate-without-breaking-the-tree.json"),
  '{"enabled":true,"retries":3}\n',
);
await writeFile(
  path.join(profileDir, "desktop-state.json"),
  JSON.stringify({ workspaceRoot: fixtureRoot, recentProjects: [fixtureRoot], autoConnect: false }),
);

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: { ...process.env, GROK_EXECUTABLE: path.join(profileDir, "missing-grok.exe") },
});

async function setWindow(width, height, zoom = 1) {
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setZoomFactor(size.zoom);
    win.setContentSize(size.width, size.height);
    win.show();
  }, { width, height, zoom });
}

try {
  const page = await electronApp.firstWindow();
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await setWindow(1904, 1000);
  await page.waitForSelector("#fileTree .explorer-row");
  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("dark");
    document.documentElement.dataset.theme = "dark";
  });

  assert.equal((await page.locator("#convTitle").textContent())?.trim(), fixtureName);
  assert.equal((await page.locator(".conv-title-wrap").textContent())?.trim(), fixtureName, "session header must contain only the project name");
  assert.equal(await page.locator("#workspaceLabel").isVisible(), false, "full path must not occupy the session header");
  assert.equal((await page.locator("#filesRoot").textContent())?.trim(), fixtureName);
  assert.equal(await page.locator(".explorer-row").filter({ hasText: ".project-memory" }).count(), 1);
  assert.equal(await page.locator(".explorer-row.file").filter({ hasText: "README.md" }).locator(".file-language").textContent(), "Markdown");
  assert.equal(await page.locator(".explorer-row.file").filter({ hasText: "package.json" }).locator(".file-language").textContent(), "JSON");

  await page.locator(".explorer-row.directory").filter({ hasText: "src" }).click();
  await page.waitForSelector('.explorer-row.file[data-path$="netinfo.rs"]');
  const rustRow = page.locator('.explorer-row.file[data-path$="netinfo.rs"]');
  assert.equal(await rustRow.locator(".file-language").textContent(), "Rust");
  await rustRow.click();
  await page.waitForFunction(() => document.querySelector("#editorLanguage")?.textContent === "Rust");
  await page.waitForSelector("#editorBody .tok-keyword");

  const typical = await page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null;
    };
    const color = (selector) => getComputedStyle(document.querySelector(selector)).color;
    return {
      explorer: rect(".project-explorer"),
      preview: rect(".file-preview-pane"),
      conversation: rect(".conversation"),
      panel: rect("#colEditor"),
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      keyword: color("#editorBody .tok-keyword"),
      comment: color("#editorBody .tok-comment"),
      number: color("#editorBody .tok-number"),
      plain: color("#editorBody"),
      lineCount: document.querySelectorAll("#editorBody .code-line").length,
      language: document.querySelector("#editorBody code")?.dataset.language,
    };
  });
  assert.ok(typical.explorer.width >= 200, `wide explorer width ${typical.explorer.width}`);
  assert.ok(typical.preview.width >= 360, `wide preview width ${typical.preview.width}`);
  assert.ok(typical.conversation.width >= 575, `conversation width ${typical.conversation.width}`);
  assert.ok(typical.explorer.right <= typical.preview.left + 1, "explorer and preview must be separate columns");
  assert.equal(typical.pageOverflow, false);
  assert.equal(typical.language, "rust");
  assert.ok(typical.lineCount >= 8);
  assert.notEqual(typical.keyword, typical.plain);
  assert.notEqual(typical.comment, typical.keyword);
  assert.notEqual(typical.number, typical.keyword);
  await page.screenshot({ path: path.join(evidenceDir, "project-explorer-dark-1904x1000.png") });
  await page.locator("#panelFiles").screenshot({ path: path.join(evidenceDir, "project-explorer-dark-detail.png") });

  await page.locator(".explorer-row.directory").filter({ hasText: "empty" }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".explorer-state")).some((node) => node.textContent?.includes("Empty folder")));
  assert.equal(await page.getByText("Empty folder", { exact: true }).count(), 1);

  await setWindow(1440, 900);
  await page.waitForTimeout(180);
  const standard = await page.evaluate(() => ({
    pageOverflow: document.documentElement.scrollWidth > innerWidth,
    treeWidth: document.querySelector(".project-explorer")?.getBoundingClientRect().width,
    previewWidth: document.querySelector(".file-preview-pane")?.getBoundingClientRect().width,
    conversationWidth: document.querySelector(".conversation")?.getBoundingClientRect().width,
  }));
  assert.equal(standard.pageOverflow, false);
  assert.ok(standard.treeWidth >= 154 && standard.previewWidth >= 225, JSON.stringify(standard));
  assert.ok(standard.conversationWidth >= 575, JSON.stringify(standard));
  await page.screenshot({ path: path.join(evidenceDir, "project-explorer-dark-1440x900.png") });

  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("light");
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(120);
  const lightColors = await page.evaluate(() => ({
    keyword: getComputedStyle(document.querySelector("#editorBody .tok-keyword")).color,
    comment: getComputedStyle(document.querySelector("#editorBody .tok-comment")).color,
    panel: getComputedStyle(document.querySelector(".file-preview-pane")).backgroundColor,
  }));
  assert.notEqual(lightColors.keyword, lightColors.comment);
  await page.screenshot({ path: path.join(evidenceDir, "project-explorer-light-1440x900.png") });

  await setWindow(1181, 700);
  await page.waitForTimeout(180);
  const narrow = await page.evaluate(() => ({
    panelVisible: getComputedStyle(document.querySelector("#colEditor")).display !== "none",
    treeWidth: document.querySelector(".project-explorer")?.getBoundingClientRect().width,
    previewWidth: document.querySelector(".file-preview-pane")?.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.equal(narrow.panelVisible, true);
  assert.equal(narrow.overflow, false);
  assert.ok(narrow.treeWidth >= 150 && narrow.previewWidth >= 180, JSON.stringify(narrow));
  await page.screenshot({ path: path.join(evidenceDir, "project-explorer-light-1181x700.png") });

  for (const zoom of [1.25, 1.5]) {
    await setWindow(1920, 1000, zoom);
    await page.waitForTimeout(160);
    const scaled = await page.evaluate(() => ({
      panelVisible: getComputedStyle(document.querySelector("#colEditor")).display !== "none",
      overflow: document.documentElement.scrollWidth > innerWidth,
      previewWidth: document.querySelector(".file-preview-pane")?.getBoundingClientRect().width,
      clippedRows: [...document.querySelectorAll(".explorer-row")].some((row) => row.scrollHeight > row.clientHeight + 1),
    }));
    assert.equal(scaled.panelVisible, true, `panel hidden at ${zoom * 100}%`);
    assert.equal(scaled.overflow, false, `overflow at ${zoom * 100}%`);
    assert.equal(scaled.clippedRows, false, `clipped explorer row at ${zoom * 100}%`);
    assert.ok(scaled.previewWidth >= 240, JSON.stringify(scaled));
    if (zoom === 1.5) await page.screenshot({ path: path.join(evidenceDir, "project-explorer-light-1920x1000-scale150.png") });
  }

  await setWindow(1440, 900, 1);
  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("dark");
    document.documentElement.dataset.theme = "dark";
  });
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("fs:listDir");
    ipcMain.handle("fs:listDir", async () => { throw new Error("Fixture directory unavailable"); });
  });
  await page.locator("#btnRefreshFiles").click();
  await page.waitForSelector("#fileTree .explorer-state.error");
  assert.match(await page.locator("#fileTree .explorer-state.error").textContent(), /Fixture directory unavailable/);
  assert.equal(await page.locator("#fileTree .explorer-retry").count(), 1);
  await page.screenshot({ path: path.join(evidenceDir, "project-explorer-error-dark-1440x900.png") });

  assert.deepEqual(runtimeErrors, [], `renderer errors: ${runtimeErrors.join(" | ")}`);
  console.log(
    `Project explorer visual OK (${version}): project-only header, lazy tree, language labels, syntax colors, empty/error states, dark/light, 1181/1440/1904, 125/150%.`,
  );
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
}
