import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionPath = path.join(root, "product/VERSION");
if (!fs.existsSync(versionPath)) {
  console.error("Missing product/VERSION");
  process.exit(1);
}
const currentVersion = fs.readFileSync(versionPath, "utf8").trim();
const distDir = path.join(root, "dist");
const desktopDistDir = path.join(distDir, "desktop");
// Chính sách portfolio: giữ 2 bản build mới nhất (bản hiện tại luôn nằm trong số đó).
const KEEP_NEWEST = 2;
const versionPattern = /(\d+)\.(\d+)\.(\d+)/;

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  return 0;
}

function collectVersions() {
  const found = new Set([currentVersion]);
  for (const dir of [distDir, desktopDistDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const match = versionPattern.exec(name);
      if (match) found.add(match[0]);
    }
  }
  return [...found].sort(compareVersions);
}

const keptVersions = new Set(collectVersions().slice(0, KEEP_NEWEST));
keptVersions.add(currentVersion);
const isKept = (name) => {
  const match = versionPattern.exec(name);
  return !match || keptVersions.has(match[0]);
};

console.log(`Cleaning dist artifacts, keeping ${[...keptVersions].join(", ")}...`);

// 1. Clean old files in dist/desktop
if (fs.existsSync(desktopDistDir)) {
  for (const file of fs.readdirSync(desktopDistDir)) {
    if (file === "win-unpacked" || file === "builder-debug.yml" || isKept(file)) {
      continue;
    }
    const fullPath = path.join(desktopDistDir, file);
    try {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`  Removed desktop artifact: ${file}`);
    } catch (e) {
      console.warn(`  Could not remove ${file}: ${e.message}`);
    }
  }
}

// 2. Clean temporary pty scratch folders in dist/
if (fs.existsSync(distDir)) {
  for (const dir of fs.readdirSync(distDir)) {
    if (dir.startsWith("pty-")) {
      const fullPath = path.join(distDir, dir);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`  Removed scratch folder: ${dir}`);
      } catch (e) {
        console.warn(`  Could not remove ${dir}: ${e.message}`);
      }
    }
  }
}

// 3. Clean old release trees in dist/ (older than currentVersion)
if (fs.existsSync(distDir)) {
  for (const dir of fs.readdirSync(distDir)) {
    if (/^\d+\.\d+\.\d+/.test(dir) && !isKept(dir)) {
      const fullPath = path.join(distDir, dir);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`  Removed old release folder: ${dir}`);
      } catch (e) {
        console.warn(`  Could not remove ${dir}: ${e.message}`);
      }
    }
  }
}

console.log(`Dist cleanup completed. Kept ${[...keptVersions].join(", ")}.`);
