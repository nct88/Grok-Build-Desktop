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
  await page.waitForSelector("#sessionTabs", { state: "attached" });
  await page.waitForSelector("#btnNew");
  await page.waitForFunction(() => typeof globalThis.GrokSessionTabs?.create === "function");

  const failures = [];

  async function railState() {
    return page.evaluate(() => {
      const rootEl = document.querySelector("#sessionTabs");
      const rect = rootEl?.getBoundingClientRect();
      return {
        hiddenAttr: rootEl?.hasAttribute("hidden"),
        emptyClass: rootEl?.classList.contains("session-tabs-empty"),
        chips: document.querySelectorAll("#sessionTabs .session-tab").length,
        height: rect ? rect.height : -1,
        display: rootEl ? getComputedStyle(rootEl).display : "",
        sidebarProjects: Boolean(document.querySelector("#projectList, .project-list, #colSidebar")),
        newChat: Boolean(document.querySelector("#btnNew")),
      };
    });
  }

  const before = await railState();
  if (!before.emptyClass) failures.push("live #sessionTabs missing session-tabs-empty");
  if (!before.hiddenAttr && before.display !== "none") failures.push("session tab rail is visible");
  if (before.chips !== 0) failures.push(`session tab chips still painted: ${before.chips}`);
  if (before.height > 2 && before.display !== "none") failures.push(`tab rail still occupies layout: ${before.height}`);
  if (!before.sidebarProjects) failures.push("left sidebar project list missing");
  if (!before.newChat) failures.push("sidebar New chat button missing");

  // Creating a second in-memory chat must not revive the rail.
  await page.evaluate(() => {
    const rootEl = document.querySelector("#sessionTabs");
    const tabs = globalThis.GrokSessionTabs.create({
      root: rootEl,
      onActivate() {},
    });
    tabs.addTab({ title: "Second sidebar chat", sessionId: "session-b" }, true);
    globalThis.__tabsQa = tabs;
  });
  const afterTwo = await railState();
  if (!afterTwo.emptyClass || afterTwo.chips !== 0 || afterTwo.display !== "none") {
    failures.push(`rail reappeared after second chat: ${JSON.stringify(afterTwo)}`);
  }

  await page.screenshot({ path: path.join(evidenceDir, "session-tabs-dark-1000x640.png") });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: path.join(evidenceDir, "session-tabs-light-1000x640.png") });

  for (const scale of [1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, zoomFactor) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoomFactor);
    }, scale);
    const scaled = await railState();
    if (scaled.chips !== 0 || scaled.display !== "none") {
      failures.push(`scale ${scale} tab rail visible: ${JSON.stringify(scaled)}`);
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

  if (failures.length) throw new Error(failures.join("; "));
  console.log(
    `Session tabs OK (${version}): rail hidden; sidebar New chat + project list remain; dark/light, 1000x640 + 1440x900, 125/150%.`,
  );
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
}
