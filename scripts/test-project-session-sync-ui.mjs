import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const version = (await readFile(path.join(root, "product", "VERSION"), "utf8")).trim();
const evidenceDir = path.join(root, "docs", "reports", "evidence", version);
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "grok-build-project-sync-"));
const profileDir = path.join(fixtureRoot, "profile");
const grokHome = path.join(fixtureRoot, "grok-home");
const projectA = path.join(fixtureRoot, "project-alpha");
const projectB = path.join(fixtureRoot, "project-beta");
const sessionId = "project-move-fixture";
const sessionTitle = "Chat cần chuyển dự án";

await mkdir(profileDir, { recursive: true });
await mkdir(evidenceDir, { recursive: true });
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await writeFile(
  path.join(profileDir, "desktop-state.json"),
  JSON.stringify({
    workspaceRoot: projectA,
    recentProjects: [projectA, projectB],
    autoConnect: false,
    theme: "dark",
  }),
);
const sourceSession = path.join(
  grokHome,
  "sessions",
  encodeURIComponent(projectA),
  sessionId,
);
await mkdir(sourceSession, { recursive: true });
await writeFile(
  path.join(sourceSession, "summary.json"),
  JSON.stringify({
    info: { id: sessionId, cwd: projectA },
    session_summary: sessionTitle,
    num_chat_messages: 4,
    updated_at: "2026-08-12T00:00:00.000Z",
  }),
);
await writeFile(
  path.join(sourceSession, "chat_history.jsonl"),
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

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector("#btnProject");
  await page.waitForFunction((title) =>
    Array.from(document.querySelectorAll(".project-chat-title"))
      .some((node) => node.textContent?.includes(title)), sessionTitle);

  // Reproduce the original failing path: the native picker persists a folder,
  // then the renderer must still run the shared selectProject transition.
  await electronApp.evaluate(({ ipcMain }, selected) => {
    ipcMain.removeHandler("app:pickWorkspace");
    ipcMain.handle("app:pickWorkspace", async () => selected);
  }, projectB);
  await page.locator("#btnProject").click();
  await page.locator('#menuProject [data-value="__open__"]').click();
  await page.waitForSelector("#projectModal:not(.hidden)");
  await page.locator("#btnAddProjectFolder").click();
  await page.waitForFunction((name) =>
    Array.from(document.querySelectorAll(".project-folder-name"))
      .some((node) => node.textContent === name),
  path.basename(projectB));
  await page.locator("#btnConfirmProjectModal").click();
  await page.waitForFunction((selected) =>
    document.querySelector("#workspaceLabel")?.textContent === selected &&
    document.querySelector("#projectModal")?.classList.contains("hidden"),
  projectB);

  const sync = await page.evaluate((selected) => ({
    workspace: document.querySelector("#workspaceLabel")?.textContent || "",
    chip: document.querySelector("#projectChipLabel")?.textContent || "",
    activeProject: document.querySelector(".project-item.active")?.getAttribute("title") || "",
    freshTitle: document.querySelector("#convTitle")?.textContent || "",
    tabCount: document.querySelectorAll(".session-tab").length,
    selected,
  }), projectB);
  assert.equal(sync.workspace, projectB);
  assert.equal(sync.chip, path.basename(projectB));
  assert.equal(sync.activeProject, projectB);
  assert.equal(sync.freshTitle, path.basename(projectB));
  assert.equal(sync.tabCount, 0);

  await page.locator(".project-item").filter({ hasText: path.basename(projectA) }).click();
  await page.waitForFunction(({ selected, name }) =>
    document.querySelector("#workspaceLabel")?.textContent === selected &&
    document.querySelector(".empty-hero h2")?.textContent === name &&
    document.querySelectorAll(".session-tab").length === 0,
  { selected: projectA, name: path.basename(projectA) });
  await page.locator(".project-item").filter({ hasText: path.basename(projectB) }).click();
  await page.waitForFunction(({ selected, name }) =>
    document.querySelector("#workspaceLabel")?.textContent === selected &&
    document.querySelector(".empty-hero h2")?.textContent === name,
  { selected: projectB, name: path.basename(projectB) });

  const sessionRow = page.locator(".project-chat-item").filter({ hasText: sessionTitle }).first();
  const dragContract = await sessionRow.evaluate((row) => ({
    rowDraggable: row.draggable,
    projectBlockDraggable: row.closest(".project-block")?.draggable,
    projectHeaderDraggable: row.closest(".project-block")?.querySelector(".project-item")?.draggable,
    ariaLabel: row.getAttribute("aria-label") || "",
  }));
  assert.equal(dragContract.rowDraggable, true);
  assert.equal(dragContract.projectBlockDraggable, false);
  assert.equal(dragContract.projectHeaderDraggable, true);
  assert.match(dragContract.ariaLabel, /Drag to another project|Kéo sang dự án khác/);
  const targetProject = page.locator(".project-block").filter({
    has: page.getByTitle(projectB, { exact: true }),
  });
  async function openMoveMenuFromRow(row) {
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    await page.waitForSelector("#sidebarCtx:not(.hidden)");
    await page.locator('#sidebarCtx [data-sidebar-act="move"]').click();
    await page.waitForSelector("#sessionMoveMenu:not(.hidden)");
  }

  await openMoveMenuFromRow(sessionRow);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-move-menu-dark-1440x900.png"),
  });
  await page.locator("#btnTheme").click();
  await page.waitForTimeout(100);
  await openMoveMenuFromRow(sessionRow);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-move-menu-light-1440x900.png"),
  });
  await page.keyboard.press("Escape");
  const lightDragData = await page.evaluateHandle(({ id, title, cwd }) => {
    const data = new DataTransfer();
    data.setData("application/x-grok-build-session", JSON.stringify({ id, title, cwd }));
    return data;
  }, { id: sessionId, title: sessionTitle, cwd: projectA });
  await targetProject.dispatchEvent("dragover", { dataTransfer: lightDragData });
  assert.equal(await targetProject.evaluate((node) => node.classList.contains("chat-drag-over")), true);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-drag-target-light-1440x900.png"),
  });
  await page.locator("#colSidebar").screenshot({
    path: path.join(evidenceDir, "project-session-drag-target-light-sidebar.png"),
  });
  await targetProject.dispatchEvent("dragleave", { dataTransfer: lightDragData });
  await lightDragData.dispose();
  await page.locator("#btnTheme").click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 640);
  });
  await page.waitForTimeout(80);
  await openMoveMenuFromRow(sessionRow);
  const compactMenu = await page.evaluate(() => {
    const rect = document.querySelector("#sessionMoveMenu")?.getBoundingClientRect();
    return rect ? {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    } : null;
  });
  assert.ok(compactMenu);
  assert.ok(compactMenu.left >= 0 && compactMenu.top >= 0);
  assert.ok(compactMenu.right <= compactMenu.viewportWidth && compactMenu.bottom <= compactMenu.viewportHeight);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-move-menu-dark-1000x640.png"),
  });
  await page.keyboard.press("Escape");
  const darkDragData = await page.evaluateHandle(({ id, title, cwd }) => {
    const data = new DataTransfer();
    data.setData("application/x-grok-build-session", JSON.stringify({ id, title, cwd }));
    return data;
  }, { id: sessionId, title: sessionTitle, cwd: projectA });
  await targetProject.dispatchEvent("dragover", { dataTransfer: darkDragData });
  assert.equal(await targetProject.evaluate((node) => node.classList.contains("chat-drag-over")), true);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-drag-target-dark-1000x640.png"),
  });
  await page.locator("#colSidebar").screenshot({
    path: path.join(evidenceDir, "project-session-drag-target-dark-sidebar.png"),
  });
  await targetProject.dispatchEvent("dragleave", { dataTransfer: darkDragData });
  await darkDragData.dispose();
  await sessionRow.dragTo(targetProject.locator(".project-item"));
  await page.waitForFunction(({ title, target }) => {
    const block = Array.from(document.querySelectorAll(".project-block"))
      .find((node) => node.dataset.projectPath === target);
    return Boolean(block && Array.from(block.querySelectorAll(".project-chat-title"))
      .some((node) => node.textContent?.includes(title)));
  }, { title: sessionTitle, target: projectB });
  const sidebarAfterDrop = await page.evaluate(({ title, source, target }) => {
    const blocks = Array.from(document.querySelectorAll(".project-block"));
    const contains = (project) => {
      const block = blocks.find((node) => node.dataset.projectPath === project);
      return Boolean(block && Array.from(block.querySelectorAll(".project-chat-title"))
        .some((node) => node.textContent?.includes(title)));
    };
    return {
      sourceContainsChat: contains(source),
      targetContainsChat: contains(target),
      lingeringDragState: Boolean(document.querySelector(".dragging, .chat-drag-over, .drag-over")),
    };
  }, { title: sessionTitle, source: projectA, target: projectB });
  assert.equal(sidebarAfterDrop.sourceContainsChat, false);
  assert.equal(sidebarAfterDrop.targetContainsChat, true);
  assert.equal(sidebarAfterDrop.lingeringDragState, false);
  await page.screenshot({
    path: path.join(evidenceDir, "project-session-after-drop-dark-1000x640.png"),
  });

  const movedSummaryPath = path.join(
    grokHome,
    "sessions",
    encodeURIComponent(projectB),
    sessionId,
    "summary.json",
  );
  const movedSummary = JSON.parse(await readFile(movedSummaryPath, "utf8"));
  assert.equal(movedSummary.info.cwd, projectB);
  const persistedDesktopState = JSON.parse(await readFile(path.join(profileDir, "desktop-state.json"), "utf8"));
  assert.deepEqual(persistedDesktopState.recentProjects, [projectA, projectB]);
  console.log("Project/session UI synchronization: passed");
} finally {
  await electronApp.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
