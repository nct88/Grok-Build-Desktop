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
const profileDir = path.join(root, ".build", `visual-profile-${process.pid}`);
await mkdir(evidenceDir, { recursive: true });

const electronApp = await electron.launch({
  executablePath: packaged
    ? path.join(root, "dist", "desktop", "win-unpacked", "Grok Build.exe")
    : developmentElectron,
  args: packaged
    ? [`--user-data-dir=${profileDir}`]
    : [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: { ...process.env, GROK_EXECUTABLE: path.join(profileDir, "missing-grok.exe") },
});

try {
  const page = await electronApp.firstWindow();
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(1000, 640);
    window.show();
  });
  await page.waitForSelector(".composer");
  await page.waitForTimeout(500);

  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      conversation: rect(".conversation"),
      editor: rect(".editor-pane"),
      editorDisplay: getComputedStyle(document.querySelector(".editor-pane")).display,
      panelToggleDisplay: getComputedStyle(document.querySelector("#btnTogglePanel")).display,
      title: rect(".conv-title"),
      actions: rect(".conv-actions"),
      composer: rect(".composer"),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });

  const failures = [];
  if (geometry.viewport.width < 990 || geometry.viewport.height < 600) failures.push(`unexpected viewport ${geometry.viewport.width}x${geometry.viewport.height}`);
  if (geometry.editorDisplay !== "none" || geometry.editor?.width !== 0) failures.push(`right tools pane remains visible: ${JSON.stringify(geometry.editor)}`);
  if (geometry.panelToggleDisplay !== "none") failures.push(`right panel toggle remains visible: ${geometry.panelToggleDisplay}`);
  if (!geometry.conversation || geometry.conversation.width < 620) failures.push(`conversation too narrow: ${geometry.conversation?.width}`);
  if (!geometry.composer || geometry.composer.width < 580) failures.push(`composer too narrow: ${geometry.composer?.width}`);
  if (geometry.title && geometry.actions && geometry.title.right > geometry.actions.left + 1) failures.push("conversation title overlaps header actions");
  if (geometry.horizontalOverflow) failures.push("desktop has horizontal overflow");
  if (geometry.composer?.bottom > geometry.viewport.height + 1) failures.push("composer is outside viewport");

  const evidenceName = packaged ? "desktop-packaged-1000x640.png" : "desktop-1000x640.png";
  await page.screenshot({ path: path.join(evidenceDir, evidenceName) });

  await page.evaluate(() => document.querySelector("#aboutModal")?.classList.remove("hidden"));
  await page.waitForFunction(() => {
    const logo = document.querySelector("#aboutModal .about-logo");
    return logo && logo.complete && logo.naturalWidth === 256 && logo.naturalHeight === 256;
  });
  const about = await page.evaluate(() => {
    const modal = document.querySelector("#aboutModal")?.getBoundingClientRect();
    const logo = document.querySelector("#aboutModal .about-logo")?.getBoundingClientRect();
    return {
      visible: !document.querySelector("#aboutModal")?.classList.contains("hidden"),
      modal: modal ? { left: modal.left, right: modal.right, top: modal.top, bottom: modal.bottom } : null,
      logo: logo ? { left: logo.left, right: logo.right, top: logo.top, bottom: logo.bottom } : null,
      source: document.querySelector("#aboutModal .about-logo")?.getAttribute("src") || "",
    };
  });
  if (!about.visible || !about.modal || !about.logo) failures.push("About/brand surface is not visible");
  if (about.logo && about.modal && (
    about.logo.left < about.modal.left || about.logo.right > about.modal.right ||
    about.logo.top < about.modal.top || about.logo.bottom > about.modal.bottom
  )) failures.push("About logo is clipped outside the modal");
  if (!about.source.endsWith("assets/logo.png")) failures.push(`About uses unexpected logo source: ${about.source}`);
  const aboutEvidenceName = packaged ? "desktop-packaged-about-1000x640.png" : "desktop-about-1000x640.png";
  await page.screenshot({ path: path.join(evidenceDir, aboutEvidenceName) });
  if (failures.length) throw new Error(failures.join("; "));
  console.log(`Desktop ${packaged ? "packaged " : ""}layout OK (${version}): 1000x640, conversation=${geometry.conversation.width.toFixed(0)}px, composer=${geometry.composer.width.toFixed(0)}px.`);
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  try {
    await Promise.race([
      electronApp.close(),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  } catch {}
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
