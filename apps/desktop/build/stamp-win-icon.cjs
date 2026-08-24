/**
 * afterPack: stamp Windows app icon and product metadata onto
 * "Grok Build.exe" only.
 *
 * Do NOT run rcedit on NSIS Setup / portable wrappers — rcedit rewrites the PE
 * and destroys the embedded 7z/NSIS payload (artifacts drop from ~75MB to ~400KB).
 *
 * signAndEditExecutable stays false (winCodeSign extract needs symlink privilege
 * on this machine), so electron-builder itself never rcedits. This hook fills
 * that gap for the unpacked app executable only.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function findRcedit() {
  const candidateRoots = [
    path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache", "winCodeSign"),
    path.join(process.env.USERPROFILE || "", "AppData", "Local", "electron-builder", "Cache", "winCodeSign"),
    "C:\\Users\\truongit\\AppData\\Local\\electron-builder\\Cache\\winCodeSign",
    path.join(__dirname, "../../../node_modules/electron-winstaller/vendor"),
    path.join(__dirname, "../node_modules/electron-winstaller/vendor"),
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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const rcedit = findRcedit();
  if (!rcedit) {
    throw new Error("[stamp-win-icon] CRITICAL: rcedit not found. Cannot stamp custom icon onto Windows executable.");
  }

  const productName = context.packager.appInfo.productFilename || "Grok Build";
  const version = context.packager.appInfo.version;
  const exe = path.join(context.appOutDir, `${productName}.exe`);
  const ico = path.join(context.packager.projectDir, "build", "icon.ico");

  if (!fs.existsSync(exe)) {
    console.warn(`[stamp-win-icon] exe missing: ${exe}`);
    return;
  }
  if (!fs.existsSync(ico)) {
    console.warn(`[stamp-win-icon] ico missing: ${ico}`);
    return;
  }

  const rceditArgs = [
    exe,
    "--set-icon", ico,
    "--set-file-version", version,
    "--set-product-version", version,
    "--set-version-string", "ProductName", "Grok Build",
    "--set-version-string", "FileDescription", "Grok Build Desktop",
    "--set-version-string", "CompanyName", "Grok Build contributors",
    "--set-version-string", "LegalCopyright", "Copyright (c) 2026 Grok Build contributors. All rights reserved.",
    "--set-version-string", "InternalName", "Grok Build",
    "--set-version-string", "OriginalFilename", "Grok Build.exe",
  ];

  console.log(`[stamp-win-icon] ${path.basename(exe)} <- ${path.basename(ico)} + Grok Build metadata ${version}`);
  execFileSync(rcedit, rceditArgs, {
    stdio: "inherit",
    windowsHide: true,
  });
  console.log("[stamp-win-icon] afterPack OK (icon + metadata; app exe only — not Setup/portable)");
};
