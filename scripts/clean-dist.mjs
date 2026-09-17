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

console.log(`Cleaning dist artifacts older than ${currentVersion}...`);

// 1. Clean old files in dist/desktop
if (fs.existsSync(desktopDistDir)) {
  for (const file of fs.readdirSync(desktopDistDir)) {
    if (file === "win-unpacked" || file === "builder-debug.yml" || file.includes(currentVersion)) {
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
    if (/^\d+\.\d+\.\d+/.test(dir) && dir !== currentVersion) {
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

console.log(`Dist cleanup completed. Current version ${currentVersion} preserved.`);
