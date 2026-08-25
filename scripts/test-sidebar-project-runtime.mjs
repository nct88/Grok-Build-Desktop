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
const packaged = process.argv.includes("--packaged");
const packagedExecutable = path.join(root, "dist", "desktop", "win-unpacked", "Grok Build.exe");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "grok-build-sidebar-runtime-"));
const profileDir = path.join(fixtureRoot, "profile");
const grokHome = path.join(fixtureRoot, "grok-home");
const projectA = path.join(fixtureRoot, "project-alpha");
const projectB = path.join(fixtureRoot, "project-beta");
const sessionB = "sidebar-project-beta-session";
const sessionTitle = "Trao đổi trong project beta";

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

const storedSession = path.join(grokHome, "sessions", encodeURIComponent(projectB), sessionB);
await mkdir(storedSession, { recursive: true });
await writeFile(
  path.join(storedSession, "summary.json"),
  JSON.stringify({
    info: { id: sessionB, cwd: projectB },
    session_summary: sessionTitle,
    num_chat_messages: 2,
    updated_at: "2026-08-24T00:00:00.000Z",
  }),
);
await writeFile(
  path.join(storedSession, "chat_history.jsonl"),
  [
    { type: "user", content: "Mở nội dung project beta." },
    { type: "assistant", content: "Nội dung beta đã lưu." },
  ].map((row) => JSON.stringify(row)).join("\n"),
);

const electronApp = await electron.launch({
  executablePath: packaged ? packagedExecutable : electronExecutable,
  args: packaged
    ? [`--user-data-dir=${profileDir}`]
    : [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: {
    ...process.env,
    GROK_HOME: grokHome,
    GROK_EXECUTABLE: path.join(fixtureRoot, "missing-grok.exe"),
  },
});

async function emit(event) {
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send("agent:event", payload);
  }, event);
}

try {
  const page = await electronApp.firstWindow();
  await page.waitForSelector(".composer");
  await page.waitForFunction((title) =>
    Array.from(document.querySelectorAll(".project-chat-title"))
      .some((node) => node.textContent?.includes(title)), sessionTitle);

  await electronApp.evaluate(({ ipcMain }, runtimeProjectA) => {
    globalThis.__sidebarRuntimeCalls = { connect: [], setActive: [], stop: [] };
    ipcMain.removeHandler("agent:connect");
    ipcMain.handle("agent:connect", async (_event, workspace, options) => {
      globalThis.__sidebarRuntimeCalls.connect.push({ workspace, options });
      return { ok: true, workspace, reused: false, isRecents: false };
    });
    ipcMain.removeHandler("agent:slots");
    ipcMain.handle("agent:slots", async () => ({
      connected: true,
      state: "running",
      sessionId: "session-alpha-running",
      workspace: runtimeProjectA,
      activeSlotId: "primary",
      maxSlots: 2,
      slots: [{
        id: "primary",
        label: "Primary agent",
        active: true,
        workspace: runtimeProjectA,
        sessionId: "session-alpha-running",
        state: "running",
        warm: true,
      }],
    }));
    ipcMain.removeHandler("agent:setActiveSlot");
    ipcMain.handle("agent:setActiveSlot", async (_event, slotId) => {
      globalThis.__sidebarRuntimeCalls.setActive.push(slotId);
      return { ok: true, activeId: slotId };
    });
    ipcMain.removeHandler("agent:stopSlot");
    ipcMain.handle("agent:stopSlot", async (_event, slotId) => {
      globalThis.__sidebarRuntimeCalls.stop.push(slotId);
      return { ok: true };
    });
  }, projectA);

  // Bind the currently visible Project A tab to the running primary slot.
  await emit({ type: "session", sessionId: "session-alpha-running", slotId: "primary" });
  await emit({ type: "state", state: "running", detail: "Working", slotId: "primary" });
  await page.waitForFunction(() => document.querySelector("#status")?.dataset.state === "running");

  // Project-header navigation is presentation-only: it must neither reconnect
  // nor stop Project A, and it must preserve a visible running owner tab.
  await page.getByTitle(projectB, { exact: true }).click();
  await page.waitForFunction((cwd) => document.querySelector("#workspaceLabel")?.textContent === cwd, projectB);
  const afterProjectSwitch = await page.evaluate(() => ({
    tabChips: document.querySelectorAll(".session-tab").length,
    railHidden: document.querySelector("#sessionTabs")?.classList.contains("session-tabs-empty"),
    activeProject: document.querySelector(".project-item.active")?.getAttribute("title") || "",
  }));
  assert.equal(afterProjectSwitch.tabChips, 0);
  assert.equal(afterProjectSwitch.railHidden, true);
  assert.equal(afterProjectSwitch.activeProject, projectB);

  let calls = await electronApp.evaluate(() => globalThis.__sidebarRuntimeCalls);
  assert.deepEqual(calls.connect, []);
  assert.deepEqual(calls.stop, []);

  const markerOne = "PROJECT ALPHA BACKGROUND MARKER ONE";
  await emit({
    type: "assistant_delta",
    messageId: "alpha-background-one",
    text: markerOne,
    slotId: "primary",
  });
  await page.waitForTimeout(80);
  assert.equal((await page.locator("#messages").textContent()).includes(markerOne), false);

  await page.getByTitle(projectA, { exact: true }).click();
  await page.waitForFunction((marker) => document.querySelector("#messages")?.textContent?.includes(marker), markerOne);
  assert.equal(await page.locator("#workspaceLabel").textContent(), projectA);

  // A nested chat row follows the same ownership rule. Its persisted transcript
  // may load, but the running primary slot remains attached to Project A.
  await page.locator(".project-chat-item").filter({ hasText: sessionTitle }).first().click();
  await page.waitForFunction((text) => document.querySelector("#messages")?.textContent?.includes(text), "Nội dung beta đã lưu.");
  assert.equal(await page.locator("#workspaceLabel").textContent(), projectB);
  assert.equal(await page.locator(".session-tab").count(), 0);
  assert.equal(await page.locator("#sessionTabs").evaluate((el) => el.classList.contains("session-tabs-empty")), true);

  const markerTwo = "PROJECT ALPHA BACKGROUND MARKER TWO";
  await emit({
    type: "assistant_delta",
    messageId: "alpha-background-two",
    text: markerTwo,
    slotId: "primary",
  });
  await page.waitForTimeout(80);
  const betaTimeline = await page.locator("#messages").textContent();
  assert.equal(betaTimeline.includes(markerOne), false);
  assert.equal(betaTimeline.includes(markerTwo), false);

  await page.getByTitle(projectA, { exact: true }).click();
  await page.waitForFunction((marker) => document.querySelector("#messages")?.textContent?.includes(marker), markerTwo);
  const alphaTimeline = await page.locator("#messages").textContent();
  assert.equal(alphaTimeline.includes(markerOne), true);
  assert.equal(alphaTimeline.includes(markerTwo), true);

  calls = await electronApp.evaluate(() => globalThis.__sidebarRuntimeCalls);
  assert.deepEqual(calls.connect, []);
  assert.deepEqual(calls.stop, []);
  assert.ok(calls.setActive.includes("primary"));
  console.log(`Sidebar project/chat runtime isolation (${packaged ? "packaged" : "source"}): passed`);
} finally {
  await electronApp.close();
  await rm(fixtureRoot, { recursive: true, force: true });
}
