import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const developmentElectron = desktopRequire("electron");
const version = (await readFile(path.join(root, "product", "VERSION"), "utf8")).trim();
const packaged = process.argv.includes("--packaged");
const evidenceDir = path.join(root, "docs", "reports", "evidence", version);
const profileDir = path.join(root, ".build", `slash-visual-profile-${process.pid}`);
await mkdir(evidenceDir, { recursive: true });

const commands = [
  ["context-watch", "Detect when agent reasoning quality drops as the context window fills."],
  ["keep-request-scope", "Keep the change exactly as large as the user's request."],
  ["quota-handover", "Warn before quota or context pressure causes a hard stop."],
  ["work-analysis", "Produce a claims-vs-code analysis report with directly verified evidence."],
  ["write-fix-log", "Write a project fix-log entry for the next agent."],
  [
    "long-local-skill-command-name-used-for-boundary-verification",
    "This deliberately long hint verifies that valid local skill metadata cannot widen or overflow the composer menu.",
  ],
].map(([id, description]) => ({ id, kind: "skill", hint: description, description }));

const electronApp = await electron.launch({
  executablePath: packaged
    ? path.join(root, "dist", "desktop", "win-unpacked", "Grok Build.exe")
    : developmentElectron,
  args: packaged
    ? [`--user-data-dir=${profileDir}`]
    : [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: { ...process.env, GROK_EXECUTABLE: path.join(profileDir, "missing-grok.exe") },
});
const failures = [];
const runtimeErrors = [];

try {
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1000, 640);
    window.show();
  });
  await page.waitForSelector("#prompt");
  await page.waitForTimeout(700);

  const showMenu = async (value, theme = "dark") => {
    await page.evaluate(
      ({ value, theme, commands }) => {
        document.documentElement.setAttribute("data-theme", theme);
        globalThis.GrokSlashCommands.setRuntimeCommands(commands);
        const prompt = document.querySelector("#prompt");
        prompt.value = value;
        prompt.focus();
        prompt.setSelectionRange(value.length, value.length);
        prompt.dispatchEvent(new Event("input", { bubbles: true }));
      },
      { value, theme, commands },
    );
    await page.waitForTimeout(100);
  };

  await showMenu("/", "dark");
  const darkSmall = await page.evaluate(() => {
    const menu = document.querySelector("#slashMenu");
    const box = menu.getBoundingClientRect();
    const rows = [...menu.querySelectorAll(".slash-item")];
    return {
      hidden: menu.classList.contains("hidden"),
      labels: rows.map((row) => row.querySelector(".slash-cmd")?.textContent),
      menuHeight: box.height,
      clientHeight: menu.clientHeight,
      scrollHeight: menu.scrollHeight,
      overflowRows: rows.filter((row) => row.scrollWidth > row.clientWidth + 1).length,
      commandOverflow: rows.filter((row) => {
        const command = row.querySelector(".slash-cmd");
        return command && command.getBoundingClientRect().right > box.right + 1;
      }).length,
      hintStyle: rows.length ? {
        textOverflow: getComputedStyle(rows.at(-1).querySelector(".slash-hint")).textOverflow,
        whiteSpace: getComputedStyle(rows.at(-1).querySelector(".slash-hint")).whiteSpace,
      } : {},
      hasFullTooltips: rows.every((row) => Boolean(row.getAttribute("title"))),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  if (darkSmall.hidden) failures.push("full slash menu is hidden");
  const expectedCount = await page.evaluate(() => globalThis.GrokSlashCommands.COMMANDS.length);
  if (darkSmall.labels.length !== expectedCount) {
    failures.push(`expected ${expectedCount} commands, got ${darkSmall.labels.length}`);
  }
  for (const id of [
    "new",
    "session-info",
    "context",
    "compact",
    "recap",
    "hooks-trust",
    "context-watch",
    "keep-request-scope",
    "quota-handover",
    "work-analysis",
    "write-fix-log",
  ]) {
    if (!darkSmall.labels.includes(`/${id}`)) failures.push(`missing /${id}`);
  }
  if (darkSmall.menuHeight > 222) failures.push(`menu exceeds max height: ${darkSmall.menuHeight}`);
  if (darkSmall.scrollHeight <= darkSmall.clientHeight) failures.push("many-item menu is not scrollable");
  if (darkSmall.overflowRows || darkSmall.commandOverflow || darkSmall.horizontalOverflow) {
    failures.push(`overflow rows=${darkSmall.overflowRows}, commands=${darkSmall.commandOverflow}, page=${darkSmall.horizontalOverflow}`);
  }
  if (darkSmall.hintStyle.textOverflow !== "ellipsis" || darkSmall.hintStyle.whiteSpace !== "nowrap") {
    failures.push("long hints do not use ellipsis");
  }
  if (!darkSmall.hasFullTooltips) failures.push("truncated rows are missing full-text tooltips");
  const evidencePrefix = packaged ? "slash-menu-packaged" : "slash-menu";
  await page.screenshot({ path: path.join(evidenceDir, `${evidencePrefix}-many-dark-1000x640.png`) });
  await page.locator("#slashMenu").screenshot({
    path: path.join(evidenceDir, `${evidencePrefix}-crop-many-dark-1000x640.png`),
  });

  await page.locator("#slashMenu").evaluate((menu) => {
    menu.scrollTop = menu.scrollHeight;
  });
  await showMenu("/work-a", "dark");
  if ((await page.locator("#slashMenu").evaluate((menu) => menu.scrollTop)) !== 0) {
    failures.push("filtered menu retained a stale scroll position");
  }

  const filtered = await page.locator("#slashMenu .slash-item").allTextContents();
  if (filtered.length !== 1 || !filtered[0].includes("/work-analysis")) {
    failures.push(`unexpected /work-a filter: ${JSON.stringify(filtered)}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, `${evidencePrefix}-filtered-dark-1000x640.png`) });
  await page.keyboard.press("Tab");
  if ((await page.locator("#prompt").inputValue()) !== "/work-analysis ") {
    failures.push("Tab did not insert /work-analysis");
  }

  await showMenu("/does-not-exist", "dark");
  if (!(await page.locator("#slashMenu").evaluate((menu) => menu.classList.contains("hidden")))) {
    failures.push("no-match state still shows a menu");
  }

  await showMenu("/", "light");
  await page.screenshot({ path: path.join(evidenceDir, `${evidencePrefix}-many-light-1000x640.png`) });
  await page.locator("#slashMenu").screenshot({
    path: path.join(evidenceDir, `${evidencePrefix}-crop-many-light-1000x640.png`),
  });

  for (const scale of [1.25, 1.5]) {
    await electronApp.evaluate(({ BrowserWindow }, zoomFactor) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoomFactor);
    }, scale);
    await showMenu("/", "dark");
    const scaled = await page.evaluate(() => {
      const menu = document.querySelector("#slashMenu");
      const box = menu.getBoundingClientRect();
      const titlebar = document.querySelector("#titlebar").getBoundingClientRect();
      const rows = [...menu.querySelectorAll(".slash-item")];
      return {
        menuInside: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= titlebar.bottom - 1 && box.bottom <= innerHeight + 1,
        rowOverflow: rows.some((row) => row.scrollWidth > row.clientWidth + 1),
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        scrollTop: menu.scrollTop,
      };
    });
    if (!scaled.menuInside || scaled.rowOverflow || scaled.pageOverflow) {
      failures.push(`scale ${scale} overflow: ${JSON.stringify(scaled)}`);
    }
    if (scale === 1.5) {
      await page.screenshot({ path: path.join(evidenceDir, `${evidencePrefix}-many-dark-1000x640-scale150.png`) });
    }
  }
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1);
  });
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900);
  });
  await showMenu("/", "dark");
  await page.screenshot({ path: path.join(evidenceDir, `${evidencePrefix}-many-dark-1440x900.png`) });

  await page.evaluate(() => {
    globalThis.GrokSlashCommands.setRuntimeCommands([]);
    const prompt = document.querySelector("#prompt");
    prompt.value = "/work-a";
    prompt.setSelectionRange(7, 7);
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  });
  if (!(await page.locator("#slashMenu").evaluate((menu) => menu.classList.contains("hidden")))) {
    failures.push("unavailable catalog fallback still shows local commands");
  }
  if (runtimeErrors.length) failures.push(`renderer errors: ${runtimeErrors.join(" | ")}`);
  if (failures.length) throw new Error(failures.join("; "));
  console.log(
    `Slash menu ${packaged ? "packaged " : ""}visual OK (${version}): ${darkSmall.labels.length} rows, ` +
      `${darkSmall.viewport.width}x${darkSmall.viewport.height}, scroll ${darkSmall.clientHeight}/${darkSmall.scrollHeight}.`,
  );
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
}
