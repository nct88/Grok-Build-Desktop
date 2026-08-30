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
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "grok-build-sidebar-ctx-"));
const profileDir = path.join(fixtureRoot, "profile");
const grokHome = path.join(fixtureRoot, "grok-home");
const projectDir = path.join(fixtureRoot, "project-alpha");
const sessionId = "sidebar-ctx-session";
const sessionTitle = "Đánh giá và hoàn thiện dự án";

await mkdir(profileDir, { recursive: true });
await mkdir(projectDir, { recursive: true });
await writeFile(path.join(projectDir, "README.md"), "sidebar context menu fixture\n");
await writeFile(
  path.join(profileDir, "desktop-state.json"),
  JSON.stringify({
    workspaceRoot: projectDir,
    recentProjects: [projectDir],
    autoConnect: false,
    theme: "dark",
  }),
);
const storedSession = path.join(grokHome, "sessions", encodeURIComponent(projectDir), sessionId);
await mkdir(storedSession, { recursive: true });
await writeFile(
  path.join(storedSession, "summary.json"),
  JSON.stringify({
    info: { id: sessionId, cwd: projectDir },
    session_summary: sessionTitle,
    num_chat_messages: 1,
    updated_at: "2026-08-30T00:00:00.000Z",
  }),
);
await writeFile(
  path.join(storedSession, "chat_history.jsonl"),
  `${JSON.stringify({ type: "user", content: sessionTitle })}\n`,
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

function menuActions(page, selector) {
  return page.evaluate((sel) =>
    Array.from(document.querySelectorAll(`${sel} [data-sidebar-act]`))
      .map((node) => node.getAttribute("data-sidebar-act")), selector);
}

function spinState(page) {
  return page.evaluate(() => {
    const header = document.querySelector("#convBusySpin");
    const row = document.querySelector(`.project-chat-item[data-session-id="${CSS.escape("sidebar-ctx-session")}"] > .busy-spin`);
    const headerStyle = header ? getComputedStyle(header) : null;
    return {
      headerHidden: header?.classList.contains("hidden") ?? null,
      rowHidden: row?.classList.contains("hidden") ?? null,
      headerTop: headerStyle?.borderTopColor || "",
      headerTrack: headerStyle?.borderRightColor || "",
      headerDisplay: headerStyle?.display || "",
    };
  });
}

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector(".project-item");
  await page.waitForFunction((title) =>
    Array.from(document.querySelectorAll(".project-chat-title"))
      .some((node) => node.textContent?.includes(title)), sessionTitle);

  const projectRow = page.locator(".project-item").filter({ hasText: path.basename(projectDir) }).first();
  await projectRow.click({ button: "right" });
  await page.waitForSelector("#sidebarCtx:not(.hidden)");
  const projectActions = await menuActions(page, "#sidebarCtx");
  assert.deepEqual(
    projectActions,
    ["new-chat", "open-folder", "copy-path", "open-ide", "remove-project"],
    `project folder menu: ${JSON.stringify(projectActions)}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#sidebarCtx")?.classList.contains("hidden"));

  const chatRow = page.locator(".project-chat-item").filter({ hasText: sessionTitle }).first();
  await chatRow.click({ button: "right" });
  await page.waitForSelector("#sidebarCtx:not(.hidden)");
  const chatActions = await menuActions(page, "#sidebarCtx");
  assert.deepEqual(
    chatActions,
    ["rename", "move", "copy-menu", "export", "delete"],
    `project chat menu: ${JSON.stringify(chatActions)}`,
  );

  await page.locator('#sidebarCtx [data-sidebar-act="copy-menu"]').hover();
  await page.waitForSelector("#sidebarSubmenu:not(.hidden)");
  const copyActions = await menuActions(page, "#sidebarSubmenu");
  assert.deepEqual(copyActions, ["copy-id", "copy-md"], `copy submenu: ${JSON.stringify(copyActions)}`);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.querySelector("#sidebarCtx")?.classList.contains("hidden") &&
    document.querySelector("#sidebarSubmenu")?.classList.contains("hidden"));

  await page.evaluate((id) => {
    document.querySelector(`.project-chat-item[data-session-id="${id}"]`)?.click();
  }, sessionId);
  await page.waitForFunction((id) =>
    Boolean(document.querySelector(`.project-chat-item.active[data-session-id="${id}"]`)), sessionId, { timeout: 8000 });

  const idle = await spinState(page);
  assert.equal(idle.headerHidden, true, `header spinner starts hidden: ${JSON.stringify(idle)}`);
  assert.equal(idle.rowHidden, true, `row spinner starts hidden: ${JSON.stringify(idle)}`);

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("agent:event", {
      type: "state",
      state: "running",
      detail: "Working",
    });
  });
  await page.waitForFunction(() => !document.querySelector("#convBusySpin")?.classList.contains("hidden"));
  const runningDark = await spinState(page);
  assert.equal(runningDark.headerHidden, false, "header spinner shows while the discussion is running");
  assert.equal(runningDark.rowHidden, false, "chat row spinner shows while the discussion is running");
  assert.notEqual(runningDark.headerDisplay, "none");
  assert.match(runningDark.headerTop, /rgb\(243,\s*243,\s*243\)/, `dark spinner must use light ink: ${runningDark.headerTop}`);

  await page.locator("#btnTheme").click();
  await page.waitForTimeout(120);
  const runningLight = await spinState(page);
  assert.equal(runningLight.headerHidden, false, "header spinner remains in light theme");
  assert.match(runningLight.headerTop, /rgb\(17,\s*17,\s*17\)/, `light spinner must use dark ink: ${runningLight.headerTop}`);

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("agent:event", {
      type: "state",
      state: "connected",
      detail: "Ready",
    });
  });
  await page.waitForFunction(() => document.querySelector("#convBusySpin")?.classList.contains("hidden"));
  const stopped = await spinState(page);
  assert.equal(stopped.headerHidden, true, "header spinner hides when the turn stops");
  assert.equal(stopped.rowHidden, true, "row spinner hides when the turn stops");

  console.log("Sidebar context menu and conversation busy spinner passed.");
} finally {
  await electronApp.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
