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
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "grok-build-sidebar-plus-"));
const profileDir = path.join(fixtureRoot, "profile");
const grokHome = path.join(fixtureRoot, "grok-home");
const projectA = path.join(fixtureRoot, "project-alpha");
const projectB = path.join(fixtureRoot, "project-beta");
const sessionIdA = "session-alpha-test";
const sessionTitleA = "Alpha initial session";

await mkdir(profileDir, { recursive: true });
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

const storedSession = path.join(grokHome, "sessions", encodeURIComponent(projectA), sessionIdA);
await mkdir(storedSession, { recursive: true });
await writeFile(
  path.join(storedSession, "summary.json"),
  JSON.stringify({
    info: { id: sessionIdA, cwd: projectA },
    session_summary: sessionTitleA,
    num_chat_messages: 2,
    updated_at: "2026-09-01T00:00:00.000Z",
  }),
);
await writeFile(
  path.join(storedSession, "chat_history.jsonl"),
  `${JSON.stringify({ type: "user", content: sessionTitleA })}\n`,
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
  await page.waitForSelector(".project-item");
  await page.waitForFunction(
    (title) =>
      Array.from(document.querySelectorAll(".project-chat-title")).some((node) =>
        node.textContent?.includes(title),
      ),
    sessionTitleA,
  );

  // 1. Verify that project items have .project-actions with more and plus buttons
  const projectItems = await page.evaluate(() => {
    return Array.from(document.querySelectorAll(".project-item")).map((el) => {
      const moreBtn = el.querySelector(".project-more-btn");
      const addBtn = el.querySelector(".project-add-chat-btn");
      return {
        title: el.getAttribute("title"),
        hasActions: Boolean(el.querySelector(".project-actions")),
        hasMoreBtn: Boolean(moreBtn),
        hasAddBtn: Boolean(addBtn),
        addBtnTitle: addBtn?.getAttribute("title") || "",
        moreBtnTitle: moreBtn?.getAttribute("title") || "",
        hasPlusIcon: Boolean(addBtn?.querySelector('[data-icon="plus"] svg, svg.icon')),
        hasMoreIcon: Boolean(moreBtn?.querySelector('[data-icon="moreVertical"] svg, svg.icon')),
      };
    });
  });

  assert.equal(projectItems.length, 2, "Expected 2 projects rendered in sidebar");
  for (const item of projectItems) {
    assert.equal(item.hasActions, true, `Project ${item.title} must have .project-actions`);
    assert.equal(item.hasMoreBtn, true, `Project ${item.title} must have .project-more-btn`);
    assert.equal(item.hasAddBtn, true, `Project ${item.title} must have .project-add-chat-btn`);
    assert.ok(item.hasPlusIcon, `Project ${item.title} must have plus SVG mounted`);
    assert.ok(item.hasMoreIcon, `Project ${item.title} must have moreVertical SVG mounted`);
  }

  // 2. Click the 3-dots (.project-more-btn) on project-beta to verify context menu opens
  const betaRow = page.locator(".project-item").filter({ hasText: path.basename(projectB) }).first();
  // Before hover, actions are hidden (display: none)
  const visibleBeforeHover = await betaRow.locator(".project-actions").isVisible();
  assert.equal(visibleBeforeHover, false, "Actions should be hidden before hover");

  // Hover to reveal actions
  await betaRow.hover();
  await page.waitForFunction(() => {
    const actions = document.querySelectorAll(".project-item .project-actions");
    return Array.from(actions).some((el) => getComputedStyle(el).display !== "none");
  });

  const betaMoreBtn = betaRow.locator(".project-more-btn");
  await betaMoreBtn.click();
  await page.waitForSelector("#sidebarCtx:not(.hidden)");
  const menuOpened = await page.evaluate(() => {
    const ctx = document.querySelector("#sidebarCtx");
    return !ctx?.classList.contains("hidden");
  });
  assert.equal(menuOpened, true, "Clicking 3-dots button must open #sidebarCtx");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#sidebarCtx")?.classList.contains("hidden"));

  // 3. Click the plus button (.project-add-chat-btn) on project-beta
  await betaRow.hover();
  const betaAddBtn = betaRow.locator(".project-add-chat-btn");
  await betaAddBtn.click();

  // Verify that workspace switched to project-beta and active project is project-beta
  await page.waitForFunction(
    (cwd) => document.querySelector("#workspaceLabel")?.textContent === cwd,
    projectB,
  );
  const stateAfterBetaAdd = await page.evaluate(() => {
    return {
      activeProject: document.querySelector(".project-item.active")?.getAttribute("title") || "",
      workspaceLabel: document.querySelector("#workspaceLabel")?.textContent || "",
      promptFocused: document.activeElement?.id === "prompt",
    };
  });

  assert.equal(stateAfterBetaAdd.activeProject, projectB, "Active project must be project-beta");
  assert.equal(stateAfterBetaAdd.workspaceLabel, projectB, "Workspace label must match project-beta");

  // 4. Click the plus button on project-alpha
  const alphaRow = page.locator(".project-item").filter({ hasText: path.basename(projectA) }).first();
  await alphaRow.hover();
  const alphaAddBtn = alphaRow.locator(".project-add-chat-btn");
  await alphaAddBtn.click();

  await page.waitForFunction(
    (cwd) => document.querySelector("#workspaceLabel")?.textContent === cwd,
    projectA,
  );
  const stateAfterAlphaAdd = await page.evaluate(() => {
    return {
      activeProject: document.querySelector(".project-item.active")?.getAttribute("title") || "",
      workspaceLabel: document.querySelector("#workspaceLabel")?.textContent || "",
    };
  });

  assert.equal(stateAfterAlphaAdd.activeProject, projectA, "Active project must be project-alpha");
  assert.equal(stateAfterAlphaAdd.workspaceLabel, projectA, "Workspace label must match project-alpha");

  console.log("Sidebar project plus button & more button test: passed");
} finally {
  await electronApp.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
