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
const profileDir = path.join(root, ".build", `resizable-panes-profile-${process.pid}`);
const fixtureRoot = path.join(root, ".build", `resizable-panes-fixture-${process.pid}`);

await mkdir(evidenceDir, { recursive: true });
await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
await mkdir(profileDir, { recursive: true });
await writeFile(path.join(fixtureRoot, "src", "index.ts"), "export const ready: boolean = true;\n");
await writeFile(path.join(fixtureRoot, "README.md"), "# Resizable panes fixture\n");
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

async function captureWindow(fileName) {
  const base64 = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage();
    return image.toPNG().toString("base64");
  });
  await writeFile(path.join(evidenceDir, fileName), Buffer.from(base64, "base64"));
}

async function dragX(page, selector, delta) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} must have a bounding box`);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(120, box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(60);
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { left: box.left, right: box.right, width: box.width, height: box.height } : null;
    };
    return {
      sidebar: rect("#colSidebar"),
      conversation: rect("#colConv"),
      panel: rect("#colEditor"),
      explorer: rect("#projectExplorer"),
      fileSplitter: rect("#splitFiles"),
      preview: rect("#filePreviewPane"),
      workbench: rect(".file-workbench"),
      overflow: document.documentElement.scrollWidth > innerWidth,
      fileClasses: document.querySelector(".file-workbench")?.className,
    };
  });
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
  await page.waitForFunction(() => document.querySelector("#splitFiles")?.getAttribute("aria-valuenow"));
  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("dark");
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(320);

  for (const selector of ["#split1", "#split2", "#splitFiles"]) {
    const separator = page.locator(selector);
    assert.equal(await separator.getAttribute("role"), "separator", `${selector} role`);
    assert.equal(await separator.getAttribute("tabindex"), "0", `${selector} keyboard focus`);
    assert.equal(await separator.getAttribute("aria-orientation"), "vertical", `${selector} orientation`);
  }

  const initial = await geometry(page);
  assert.ok(initial.explorer.width >= 250, JSON.stringify(initial));
  assert.ok(initial.preview.width >= 400, JSON.stringify(initial));
  assert.equal(initial.overflow, false);

  await dragX(page, "#splitFiles", 96);
  const dragged = await geometry(page);
  assert.ok(dragged.explorer.width >= initial.explorer.width + 88, JSON.stringify({ initial, dragged }));
  assert.ok(dragged.preview.width <= initial.preview.width - 88, JSON.stringify({ initial, dragged }));
  assert.ok(dragged.explorer.right <= dragged.fileSplitter.left + 1, "explorer must end at its splitter");
  assert.ok(dragged.fileSplitter.right <= dragged.preview.left + 1, "splitter must end at preview");
  const savedAfterDrag = await page.evaluate(() => JSON.parse(localStorage.getItem("grokBuild.layout.v2") || "{}"));
  assert.ok(Math.abs(savedAfterDrag.fileExplorerWidth - dragged.explorer.width) <= 1, JSON.stringify(savedAfterDrag));

  await page.locator("#splitFiles").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(240);
  const keyboardResized = await geometry(page);
  assert.ok(Math.abs(keyboardResized.explorer.width - (dragged.explorer.width - 16)) <= 2, JSON.stringify({ dragged, keyboardResized }));

  await page.locator("#btnToggleExplorer").click();
  await page.waitForTimeout(240);
  const explorerCollapsed = await geometry(page);
  assert.ok(Math.abs(explorerCollapsed.explorer.width - 36) <= 1, JSON.stringify(explorerCollapsed));
  assert.ok(explorerCollapsed.fileSplitter.width <= 0.5, JSON.stringify(explorerCollapsed));
  assert.equal(await page.locator("#fileTree").isVisible(), false);
  assert.equal(await page.locator("#btnToggleExplorer").isVisible(), true);
  assert.equal(await page.locator("#btnToggleExplorer").getAttribute("aria-pressed"), "false");
  assert.equal(await page.locator("#btnToggleExplorer").getAttribute("title"), "Show project tree");
  await page.locator("#panelFiles").screenshot({ path: path.join(evidenceDir, "resizable-explorer-collapsed-dark.png") });

  await page.reload();
  await page.waitForFunction(() => document.querySelector("#splitFiles")?.getAttribute("aria-valuenow"));
  await page.waitForTimeout(280);
  const explorerPersisted = await geometry(page);
  assert.ok(explorerPersisted.fileClasses.includes("explorer-collapsed"), JSON.stringify(explorerPersisted));
  assert.ok(Math.abs(explorerPersisted.explorer.width - 36) <= 1, JSON.stringify(explorerPersisted));
  await page.locator("#btnToggleExplorer").click();
  await page.waitForTimeout(240);
  const explorerRestored = await geometry(page);
  assert.ok(Math.abs(explorerRestored.explorer.width - keyboardResized.explorer.width) <= 2, JSON.stringify({ keyboardResized, explorerRestored }));

  await page.locator("#btnTogglePreview").click();
  await page.waitForTimeout(240);
  const previewCollapsed = await geometry(page);
  assert.ok(Math.abs(previewCollapsed.preview.width - 36) <= 1, JSON.stringify(previewCollapsed));
  assert.ok(previewCollapsed.fileSplitter.width <= 0.5, JSON.stringify(previewCollapsed));
  assert.equal(await page.locator("#filePreviewEmpty").isVisible(), false);
  assert.equal(await page.locator("#btnTogglePreview").isVisible(), true);
  assert.equal(await page.locator("#btnTogglePreview").getAttribute("aria-pressed"), "false");
  await page.locator("#panelFiles").screenshot({ path: path.join(evidenceDir, "resizable-preview-collapsed-dark.png") });
  await page.locator("#btnTogglePreview").click();
  await page.waitForTimeout(240);

  const sidebarBefore = (await geometry(page)).sidebar.width;
  await page.locator("#split1").focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(260);
  const sidebarAfter = (await geometry(page)).sidebar.width;
  assert.ok(Math.abs(sidebarAfter - (sidebarBefore + 16)) <= 2, JSON.stringify({ sidebarBefore, sidebarAfter }));
  await page.locator("#btnToggleSidebar").click();
  await page.waitForTimeout(280);
  const sidebarCollapsed = await geometry(page);
  assert.ok(sidebarCollapsed.sidebar.width <= 1.5, `sidebar must collapse to its border rail: ${JSON.stringify(sidebarCollapsed)}`);
  await page.locator("#btnToggleSidebar").click();
  await page.waitForTimeout(280);
  assert.ok(Math.abs((await geometry(page)).sidebar.width - sidebarAfter) <= 2, "sidebar width must restore");

  const panelBefore = (await geometry(page)).panel.width;
  await page.locator("#split2").focus();
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(260);
  const panelAfter = (await geometry(page)).panel.width;
  assert.ok(Math.abs(panelAfter - (panelBefore + 16)) <= 2, JSON.stringify({ panelBefore, panelAfter }));
  await page.locator("#btnTogglePanel").click();
  await page.waitForTimeout(280);
  assert.ok((await geometry(page)).panel.width <= 1.5, "right panel must collapse to its border rail");
  await page.locator("#btnTogglePanel").click();
  await page.waitForTimeout(280);
  assert.ok(Math.abs((await geometry(page)).panel.width - panelAfter) <= 2, "right panel width must restore");

  await page.screenshot({ path: path.join(evidenceDir, "resizable-panes-dark-1904x1000.png") });
  await page.locator("#panelFiles").screenshot({ path: path.join(evidenceDir, "resizable-files-dark-detail.png") });

  await page.locator("#btnTools").click();
  await page.locator('[data-tools-tab="mcp"]').click();
  await page.waitForSelector("#mcpPresets .tool-chip");
  const inspectChips = () => page.evaluate(() => {
    const chips = [...document.querySelectorAll("#mcpPresets .tool-chip")].map((node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        text: node.textContent,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        scrollWidth: node.scrollWidth,
        display: style.display,
        whiteSpace: style.whiteSpace,
      };
    });
    const overlaps = chips.some((a, index) => chips.slice(index + 1).some((b) =>
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5));
    const host = document.querySelector("#mcpPresets");
    return { chips, overlaps, hostOverflow: host.scrollWidth > host.clientWidth + 1 };
  });
  const wideChips = await inspectChips();
  assert.equal(wideChips.overlaps, false, JSON.stringify(wideChips));
  assert.equal(wideChips.hostOverflow, false, JSON.stringify(wideChips));
  for (const chip of wideChips.chips) {
    assert.ok(chip.width + 0.5 >= chip.scrollWidth, `${chip.text} background must contain its text`);
    assert.ok(chip.height >= 28, `${chip.text} hit target height`);
    assert.equal(chip.display, "flex");
    assert.equal(chip.whiteSpace, "nowrap");
  }

  await page.locator("#split2").focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(280);
  assert.ok((await geometry(page)).panel.width <= 322, "right panel keyboard End must reach compact width");
  const narrowChips = await inspectChips();
  assert.equal(narrowChips.overlaps, false, JSON.stringify(narrowChips));
  assert.equal(narrowChips.hostOverflow, false, JSON.stringify(narrowChips));
  for (const chip of narrowChips.chips) assert.ok(chip.width + 0.5 >= chip.scrollWidth, JSON.stringify(chip));

  await page.locator('.rtab[data-panel="files"]').click();
  await page.waitForTimeout(260);
  const minimumFiles = await geometry(page);
  assert.ok(minimumFiles.explorer.width >= 132, JSON.stringify(minimumFiles));
  assert.ok(minimumFiles.preview.width >= 180, JSON.stringify(minimumFiles));
  assert.equal(minimumFiles.overflow, false, JSON.stringify(minimumFiles));
  await page.locator("#panelFiles").screenshot({ path: path.join(evidenceDir, "resizable-files-minimum-dark.png") });
  await page.locator("#btnTools").click();
  await page.locator('[data-tools-tab="mcp"]').click();

  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("light");
    document.documentElement.dataset.theme = "light";
  });
  await setWindow(1181, 700);
  await page.waitForTimeout(300);
  const compact = await geometry(page);
  assert.equal(compact.overflow, false, JSON.stringify(compact));
  assert.ok(compact.conversation.width >= 575, JSON.stringify(compact));
  assert.equal((await inspectChips()).overlaps, false);
  await page.screenshot({ path: path.join(evidenceDir, "quick-add-light-compact-1181x700.png") });
  await page.locator("#mcpPresets").screenshot({ path: path.join(evidenceDir, "quick-add-light-detail.png") });

  await setWindow(2160, 1200, 1.5);
  await page.waitForTimeout(300);
  const scaledLayout = await geometry(page);
  assert.ok(scaledLayout.panel.width >= 320, JSON.stringify(scaledLayout));
  const scaledChips = await inspectChips();
  assert.equal(scaledChips.overlaps, false, JSON.stringify(scaledChips));
  assert.equal(scaledChips.hostOverflow, false, JSON.stringify(scaledChips));
  for (const chip of scaledChips.chips) assert.ok(chip.width >= 48 && chip.height >= 28, JSON.stringify(chip));
  await captureWindow("quick-add-light-2160x1200-scale150-native.png");

  assert.deepEqual(runtimeErrors, [], `renderer errors: ${runtimeErrors.join(" | ")}`);
  console.log(
    `Resizable panes + Quick add visual OK (${version}): mouse/keyboard resize, collapse/restore/persistence, compact wrapping, dark/light, 1181/1904 and 2160@150%.`,
  );
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
  await rm(fixtureRoot, { recursive: true, force: true });
}
