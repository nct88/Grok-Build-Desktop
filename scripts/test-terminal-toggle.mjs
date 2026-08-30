import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "grok-build-term-toggle-"));
const profileDir = path.join(fixtureRoot, "profile");
const grokHome = path.join(fixtureRoot, "grok-home");
const projectDir = path.join(fixtureRoot, "project");

await mkdir(profileDir, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(projectDir, "README.md"), "terminal toggle fixture\n");
await writeFile(
  path.join(profileDir, "desktop-state.json"),
  JSON.stringify({
    workspaceRoot: projectDir,
    recentProjects: [projectDir],
    autoConnect: false,
    theme: "dark",
  }),
);

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: {
    ...process.env,
    GROK_HOME: grokHome,
    GROK_EXECUTABLE: path.join(fixtureRoot, "missing-grok.exe"),
  },
});

function snapshotTerm(page) {
  return page.evaluate(() => {
    const dock = document.querySelector("#termDock");
    const btn = document.querySelector("#btnToggleTerm");
    const style = dock ? getComputedStyle(dock) : null;
    return {
      collapsed: dock?.classList.contains("collapsed") ?? null,
      hidden: dock?.classList.contains("hidden") ?? null,
      height: dock ? Math.round(dock.getBoundingClientRect().height) : null,
      computedHeight: style?.height || null,
      pointerEvents: style?.pointerEvents || null,
      ariaPressed: btn?.getAttribute("aria-pressed") || null,
      clickCount: globalThis.__termToggleDebug?.click || 0,
      pointerdownCount: globalThis.__termToggleDebug?.pointerdown || 0,
    };
  });
}

async function mouseClickToggle(page) {
  const box = await page.locator("#btnToggleTerm").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "titlebar terminal toggle must be hittable");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function mouseClickClose(page) {
  const box = await page.locator("#btnTermClose").boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, "terminal close button must be hittable");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector("#btnToggleTerm");
  await page.waitForSelector("#termDock");
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    globalThis.__termToggleDebug = { click: 0, pointerdown: 0 };
    const btn = document.querySelector("#btnToggleTerm");
    btn?.addEventListener("pointerdown", () => {
      globalThis.__termToggleDebug.pointerdown += 1;
    }, true);
    btn?.addEventListener("click", () => {
      globalThis.__termToggleDebug.click += 1;
    }, true);
  });

  const initial = await snapshotTerm(page);
  assert.equal(initial.collapsed, true, `terminal must start collapsed: ${JSON.stringify(initial)}`);
  assert.ok(initial.height <= 1, `collapsed dock height must be ~0, got ${initial.height}`);

  await mouseClickToggle(page);
  await page.waitForTimeout(500);
  const opened = await snapshotTerm(page);
  assert.equal(opened.collapsed, false, `first titlebar click must open terminal: ${JSON.stringify(opened)}`);
  assert.ok(opened.height > 80, `open dock must have height, got ${opened.height}`);
  assert.equal(opened.ariaPressed, "true", "titlebar button must show pressed after open");

  await mouseClickToggle(page);
  await page.waitForTimeout(500);
  const closed = await snapshotTerm(page);
  assert.equal(
    closed.collapsed,
    true,
    `second titlebar click must close terminal: ${JSON.stringify({ initial, opened, closed })}`,
  );
  assert.ok(closed.height <= 1, `closed dock height must be ~0, got ${closed.height}`);
  assert.equal(closed.ariaPressed, "false", "titlebar button must show unpressed after close");

  await page.waitForTimeout(800);
  const stayedClosed = await snapshotTerm(page);
  assert.equal(
    stayedClosed.collapsed,
    true,
    `PTY output must not reopen a user-closed terminal: ${JSON.stringify(stayedClosed)}`,
  );

  await mouseClickToggle(page);
  await page.waitForTimeout(400);
  const reopened = await snapshotTerm(page);
  assert.equal(reopened.collapsed, false, `third titlebar click must open again: ${JSON.stringify(reopened)}`);

  // Electron drag regions on the custom titlebar often swallow the second
  // `click` after a layout shift. The control must still toggle from the
  // pointerdown that Chromium does deliver.
  await page.evaluate(() => {
    document.querySelector("#btnToggleTerm")?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
  });
  await page.waitForTimeout(400);
  const closedByPointerDown = await snapshotTerm(page);
  assert.equal(
    closedByPointerDown.collapsed,
    true,
    `titlebar toggle must close on pointerdown when click is swallowed: ${JSON.stringify(closedByPointerDown)}`,
  );

  await mouseClickClose(page);
  await page.waitForTimeout(400);
  const closedByX = await snapshotTerm(page);
  assert.equal(closedByX.collapsed, true, `× button must close terminal: ${JSON.stringify(closedByX)}`);

  for (let i = 0; i < 4; i += 1) {
    await mouseClickToggle(page);
    await page.waitForTimeout(180);
  }
  const afterBurst = await snapshotTerm(page);
  assert.equal(
    afterBurst.collapsed,
    true,
    `four extra clicks from closed must end closed: ${JSON.stringify(afterBurst)}`,
  );

  console.log("Terminal titlebar toggle: open, close, stay closed, × close, burst clicks passed.");
} finally {
  await electronApp.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
