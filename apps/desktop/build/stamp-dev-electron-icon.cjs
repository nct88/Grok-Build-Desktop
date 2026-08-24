/**
 * Dev Windows icon fix:
 *
 * Taskbar uses the *process image* name/path. Running stock `electron.exe` keeps
 * Electron's (or a cached) icon even after rcedit, because Windows IconCache
 * keys heavily on path + AppId.
 *
 * Strategy:
 *  1. Ensure apps/desktop/build/icon.ico exists (caller may regenerate).
 *  2. Copy electron.exe → GrokBuild-dev.exe next to it (same dist folder).
 *  3. rcedit --set-icon on GrokBuild-dev.exe only.
 *  4. write build/dev-electron-path.txt for the start wrapper.
 *
 * Safe: never renames/deletes stock electron.exe.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../..");
const desktopRoot = path.resolve(__dirname, "..");
const ico = path.join(__dirname, "icon.ico");
const pathFile = path.join(__dirname, "dev-electron-path.txt");
const DEV_NAME = "GrokBuild-dev.exe";

function findRcedit() {
  const candidateRoots = [
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign"),
    path.join(process.env.USERPROFILE || "", "AppData", "Local", "electron-builder", "Cache", "winCodeSign"),
    "C:\\Users\\truongit\\AppData\\Local\\electron-builder\\Cache\\winCodeSign",
    path.join(root, "node_modules", "electron-winstaller", "vendor"),
    path.join(desktopRoot, "node_modules", "electron-winstaller", "vendor"),
  ];

  for (const cacheRoot of candidateRoots) {
    if (!fs.existsSync(cacheRoot)) continue;
    for (const name of ["rcedit-x64.exe", "rcedit.exe", "rcedit-ia32.exe"]) {
      const direct = path.join(cacheRoot, name);
      if (fs.existsSync(direct)) return direct;
    }
    try {
      const dirs = fs
        .readdirSync(cacheRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dirs) {
        for (const name of ["rcedit-x64.exe", "rcedit.exe", "rcedit-ia32.exe"]) {
          const p = path.join(cacheRoot, d, name);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {}
  }
  return null;
}

function resolveElectronExe() {
  const candidates = [
    path.join(desktopRoot, "node_modules", "electron", "dist", "electron.exe"),
    path.join(root, "node_modules", "electron", "dist", "electron.exe"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function main() {
  if (process.platform !== "win32") {
    // Non-Windows: start wrapper falls back to `electron` binary from package
    fs.writeFileSync(pathFile, "", "utf8");
    console.log("[stamp-dev-icon] skip stamp (not Windows)");
    return;
  }

  if (!fs.existsSync(ico)) {
    console.warn("[stamp-dev-icon] missing icon.ico — run: node build/generate-icon.mjs");
    process.exitCode = 1;
    return;
  }

  const electronExe = resolveElectronExe();
  if (!electronExe) {
    console.warn("[stamp-dev-icon] electron.exe not found");
    process.exitCode = 1;
    return;
  }

  const distDir = path.dirname(electronExe);
  const devExe = path.join(distDir, DEV_NAME);
  const rcedit = findRcedit();

  try {
    // Always refresh copy from stock electron so upgrades stay in sync
    fs.copyFileSync(electronExe, devExe);
    console.log(`[stamp-dev-icon] copied → ${devExe}`);
  } catch (e) {
    console.warn(
      "[stamp-dev-icon] copy failed (close Grok/Electron windows first):",
      e instanceof Error ? e.message : e,
    );
    process.exitCode = 1;
    return;
  }

  if (rcedit) {
    try {
      execFileSync(rcedit, [devExe, "--set-icon", ico], {
        stdio: "inherit",
        windowsHide: true,
      });
      console.log("[stamp-dev-icon] rcedit OK on", DEV_NAME);
    } catch (e) {
      console.warn(
        "[stamp-dev-icon] rcedit failed:",
        e instanceof Error ? e.message : e,
      );
      process.exitCode = 1;
    }
  } else {
    console.warn(
      "[stamp-dev-icon] rcedit not found — GrokBuild-dev.exe has Electron default icon until cache has rcedit",
    );
  }

  // Also stamp stock electron.exe (helps some environments)
  if (rcedit) {
    try {
      execFileSync(rcedit, [electronExe, "--set-icon", ico], {
        stdio: "pipe",
        windowsHide: true,
      });
      console.log("[stamp-dev-icon] also stamped electron.exe");
    } catch {
      // often locked if app is open — ignore
    }
  }

  fs.writeFileSync(pathFile, devExe, "utf8");
  console.log("[stamp-dev-icon] host path written:", pathFile);
}

main();
