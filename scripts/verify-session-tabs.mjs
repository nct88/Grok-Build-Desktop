import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const developmentElectron = desktopRequire("electron");
const version = (await readFile(path.join(root, "product", "VERSION"), "utf8")).trim();
const evidenceDir = path.join(root, "docs", "reports", "evidence", version);
const profileDir = path.join(root, ".build", `tabs-profile-${process.pid}`);
await mkdir(evidenceDir, { recursive: true });

const electronApp = await electron.launch({
  executablePath: developmentElectron,
  args: [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: { ...process.env, GROK_EXECUTABLE: path.join(profileDir, "missing-grok.exe") },
});

try {
  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1000, 640);
    window.show();
  });
  await page.waitForSelector("#sessionTabs");
  await page.waitForFunction(() => typeof globalThis.GrokSessionTabs?.create === "function");
  await page.evaluate(() => {
    const rootEl = document.createElement("div");
    rootEl.id = "qaSessionTabs";
    rootEl.className = "session-tabs";
    document.querySelector("#sessionTabs").after(rootEl);
    let tabs;
    tabs = globalThis.GrokSessionTabs.create({
      root: rootEl,
      onActivate() {},
      onRename(tab) {
        tabs.updateTab(tab.id, { title: "Renamed review tab" });
      },
    });
    const first = tabs.getActive();
    tabs.updateTab(first.id, {
      title: "Implement LiveKit lifecycle recovery",
      sessionId: "session-a",
      slotId: "primary",
      busy: true,
      turnPhase: "tools",
      turnStartedAt: Date.now() - 65_000,
    });
    tabs.addTab(
      {
        title: "Review permission contention edge cases with a deliberately long title",
        sessionId: "session-b",
        cwd: "C:\\workspace\\review",
      },
      true,
    );
    globalThis.__tabsQa = tabs;
  });

  await page.waitForTimeout(1100);
  const before = await page.evaluate(() => {
    const rootEl = document.querySelector("#qaSessionTabs");
    const rail = rootEl.querySelector(".session-tabs-rail");
    const running = rootEl.querySelector('.session-tab[data-busy="true"]');
    const runtime = running?.querySelector(".session-tab-runtime");
    const active = rootEl.querySelector(".session-tab.active");
    const rect = (el) => {
      const value = el?.getBoundingClientRect();
      return value
        ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height }
        : null;
    };
    return {
      root: rect(rootEl),
      rail: rect(rail),
      running: rect(running),
      active: rect(active),
      runtime: runtime?.textContent || "",
      hasDot: Boolean(running?.querySelector(".session-tab-running")),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      railScrollable: rail ? rail.scrollWidth >= rail.clientWidth : false,
    };
  });

  const failures = [];
  if (!before.root || before.root.height < 30 || before.root.height > 48) failures.push(`tab rail height ${before.root?.height}`);
  if (!before.running || !before.active) failures.push("running/active tab missing");
  if (!before.hasDot) failures.push("running indicator missing");
  if (!/^1:0[5-9]$/.test(before.runtime)) failures.push(`runtime did not advance: ${before.runtime}`);
  if (before.horizontalOverflow) failures.push("page has horizontal overflow");
  if (!before.railScrollable) failures.push("tab rail lacks bounded overflow policy");

  await page.locator("#qaSessionTabs .session-tab.active .session-tab-label").dblclick();
  const renamed = await page.locator("#qaSessionTabs .session-tab.active .session-tab-label").textContent();
  if (renamed !== "Renamed review tab") failures.push(`direct rename failed: ${renamed}`);

  await page.screenshot({ path: path.join(evidenceDir, "session-tabs-dark-1000x640.png") });
  await page.locator("#qaSessionTabs").screenshot({ path: path.join(evidenceDir, "session-tabs-dark-detail.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(evidenceDir, "session-tabs-light-1000x640.png") });
  await page.locator("#qaSessionTabs").screenshot({ path: path.join(evidenceDir, "session-tabs-light-detail.png") });

  for (const scale of [1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, zoomFactor) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoomFactor);
    }, scale);
    const scaled = await page.evaluate(() => {
      const rootEl = document.querySelector("#qaSessionTabs");
      const buttons = [...rootEl.querySelectorAll(".session-tab")];
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        clipped: buttons.some((button) => button.scrollHeight > button.clientHeight + 1),
        reachable: rootEl.scrollWidth <= document.querySelector(".conversation").scrollWidth + 1,
      };
    });
    if (scaled.pageOverflow || scaled.clipped || !scaled.reachable) {
      failures.push(`scale ${scale} tab geometry: ${JSON.stringify(scaled)}`);
    }
    if (scale === 1.5) {
      await page.screenshot({ path: path.join(evidenceDir, "session-tabs-light-1000x640-scale150.png") });
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    window.setContentSize(1440, 900);
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(evidenceDir, "session-tabs-dark-1440x900.png") });

  await page.evaluate(() => {
    const tabs = globalThis.__tabsQa;
    const running = tabs.tabs.find((tab) => tab.busy);
    if (running) tabs.updateTab(running.id, { busy: false });
  });

  if (failures.length) throw new Error(failures.join("; "));
  console.log(
    `Session tabs OK (${version}): cache rail, rename, running dot, elapsed=${before.runtime}, dark/light, 1000x640 + 1440x900, 125/150%.`,
  );
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
}
