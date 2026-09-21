/**
 * Product install layout (Windows defaults).
 * Keep in sync with docs/INSTALL_PATHS.md and product/PRODUCT_IDENTITY.md.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

function createProductPaths(homedir = os.homedir()) {
  return {
    desktop: {
      productName: "Grok Build",
      installDir: path.join(homedir, "AppData", "Local", "Programs", "Grok Build"),
      exeNames: ["Grok Build.exe", "GrokBuild.exe"],
    },
    ide: {
      productName: "Grok Build IDE",
      installDir: path.join(homedir, "AppData", "Local", "Programs", "Grok Build IDE"),
      exeNames: ["Grok Build IDE.exe", "GrokBuildIDE.exe", "Code.exe", "code.exe"],
      downloadUrl: "https://github.com/nct88/Grok-Build-IDE/releases/latest",
    },
  };
}

const PRODUCT_PATHS = createProductPaths();

function isExecutableFile(p) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    return fs.statSync(p).isFile() && /\.(exe|cmd|bat|app)$/i.test(p);
  } catch {
    return false;
  }
}

/** Resolve .exe under a folder (or return path if already an exe). */
function resolveExeInDir(dirOrExe, exeNames) {
  if (!dirOrExe) return null;
  try {
    if (isExecutableFile(dirOrExe)) return path.resolve(dirOrExe);
    if (!fs.existsSync(dirOrExe) || !fs.statSync(dirOrExe).isDirectory()) return null;
    for (const name of exeNames || []) {
      const candidate = path.join(dirOrExe, name);
      if (isExecutableFile(candidate)) return candidate;
    }
    const files = fs.readdirSync(dirOrExe);
    for (const f of files) {
      if (/grok.*ide|ide.*grok|code\.exe/i.test(f) && /\.exe$/i.test(f)) {
        const full = path.join(dirOrExe, f);
        if (isExecutableFile(full)) return full;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getHostProfilePaths() {
  const homes = [];
  const localAppDatas = [];
  const appDatas = [];

  const addPath = (arr, p) => {
    if (!p) return;
    const clean = String(p).trim();
    if (clean && !arr.includes(clean)) arr.push(clean);
  };

  // 1. Current process environment & node os defaults
  try {
    addPath(homes, os.homedir());
  } catch {
    // ignore
  }
  addPath(homes, process.env.USERPROFILE);
  addPath(homes, process.env.HOME);
  addPath(localAppDatas, process.env.LOCALAPPDATA);
  addPath(appDatas, process.env.APPDATA);

  // 2. Real Windows host profile discovery (when running inside CloneManager / sandbox)
  if (process.platform === "win32") {
    const probeList = [os.homedir(), process.env.USERPROFILE, process.env.HOME, process.env.LOCALAPPDATA];
    for (const h of probeList) {
      if (!h) continue;
      const m = String(h).match(/^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/i);
      if (m && fs.existsSync(m[1])) {
        const root = m[1];
        addPath(homes, root);
        addPath(localAppDatas, path.join(root, "AppData", "Local"));
        addPath(appDatas, path.join(root, "AppData", "Roaming"));
      }
    }

    if (process.env.USERNAME) {
      const drive = process.env.SystemDrive || "C:";
      const uPath = path.join(drive, "Users", process.env.USERNAME);
      if (fs.existsSync(uPath)) {
        addPath(homes, uPath);
        addPath(localAppDatas, path.join(uPath, "AppData", "Local"));
        addPath(appDatas, path.join(uPath, "AppData", "Roaming"));
      }
    }

    try {
      const cp = require("node:child_process");
      const out = cp.execFileSync(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders", "/v", "Local AppData"],
        { encoding: "utf8", timeout: 800, stdio: ["ignore", "pipe", "ignore"] }
      );
      const regPath = out.match(/Local AppData\s+REG_SZ\s+(.*)/i)?.[1]?.trim();
      if (regPath && fs.existsSync(regPath)) {
        addPath(localAppDatas, regPath);
      }
    } catch {
      // ignore
    }

    try {
      const drive = process.env.SystemDrive || "C:";
      const usersDir = path.join(drive, "Users");
      if (fs.existsSync(usersDir)) {
        const entries = fs.readdirSync(usersDir, { withFileTypes: true });
        for (const ent of entries) {
          if (
            ent.isDirectory() &&
            !ent.name.startsWith(".") &&
            !["Public", "Default", "Default User", "All Users"].includes(ent.name)
          ) {
            const uHome = path.join(usersDir, ent.name);
            const uLocal = path.join(uHome, "AppData", "Local");
            if (fs.existsSync(uLocal)) {
              addPath(homes, uHome);
              addPath(localAppDatas, uLocal);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    homes,
    localAppDatas,
    appDatas,
  };
}

function readInstalledVersion(installDir) {
  if (!installDir) return null;
  try {
    const vFile = path.join(installDir, "VERSION");
    if (fs.existsSync(vFile)) {
      const v = fs.readFileSync(vFile, "utf8").trim();
      if (v) return v;
    }
    const pkgFile = path.join(installDir, "resources", "app", "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (pkg && typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * @param {{
 *   loadState: () => object,
 *   productPaths?: ReturnType<typeof createProductPaths>,
 * }} deps
 */
function resolveIdeInstall(deps) {
  const PRODUCT = deps.productPaths || PRODUCT_PATHS;
  const state = (deps.loadState && deps.loadState()) || {};
  const downloadUrl =
    (typeof state.ideDownloadUrl === "string" && state.ideDownloadUrl.trim()) ||
    PRODUCT.ide.downloadUrl;
  const productName = PRODUCT.ide.productName;
  const exeNames = PRODUCT.ide.exeNames;
  const host = getHostProfilePaths();

  const candidates = [
    { src: "settings", path: state.idePath },
    { src: "env", path: process.env.GROK_BUILD_IDE },
    { src: "default", path: PRODUCT.ide.installDir },
  ];

  for (const lad of host.localAppDatas) {
    candidates.push({ src: "localappdata", path: path.join(lad, "Programs", "Grok Build IDE") });
    candidates.push({ src: "localappdata-alt", path: path.join(lad, "Programs", "grok-build-ide") });
  }

  for (const h of host.homes) {
    candidates.push({ src: "home-programs", path: path.join(h, "AppData", "Local", "Programs", "Grok Build IDE") });
    candidates.push({ src: "home-programs-alt", path: path.join(h, "AppData", "Local", "Programs", "grok-build-ide") });
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  candidates.push(
    { src: "program-files", path: path.join(programFiles, "Grok Build IDE") },
    { src: "program-files-x86", path: path.join(programFilesX86, "Grok Build IDE") },
    { src: "dev", path: "H:\\projects\\grok-build-ide" },
    { src: "dev-e", path: "E:\\projects\\grok-build-ide" },
  );

  const realHostUser = host.homes.find((h) => !/CloneManager|antigravity-clone/i.test(h)) || host.homes[0] || null;
  const realHostLocal = host.localAppDatas.find((l) => !/CloneManager|antigravity-clone/i.test(l)) || host.localAppDatas[0] || null;
  const realHostApp = host.appDatas.find((a) => !/CloneManager|antigravity-clone/i.test(a)) || host.appDatas[0] || null;

  for (const c of candidates) {
    if (!c.path || !String(c.path).trim()) continue;
    const exe = resolveExeInDir(String(c.path).trim(), exeNames);
    if (exe) {
      const installDir = path.dirname(exe);
      const version = readInstalledVersion(installDir);
      return {
        installed: true,
        installDir,
        executable: exe,
        version,
        source: c.src,
        productName,
        downloadUrl,
        hostUserProfile: realHostUser,
        hostLocalAppData: realHostLocal,
        hostAppData: realHostApp,
      };
    }
  }
  return {
    installed: false,
    installDir: PRODUCT.ide.installDir,
    executable: null,
    version: null,
    source: null,
    productName,
    downloadUrl,
    hostUserProfile: realHostUser,
    hostLocalAppData: realHostLocal,
    hostAppData: realHostApp,
  };
}

/**
 * Launch IDE app (not open folder). Phase C4: deep-link file:line:col.
 * @param {object} opts
 * @param {{
 *   loadState: () => object,
 *   getWorkspace?: () => string|null,
 *   getAllowOutside?: () => boolean,
 *   assertWorkspacePath?: (p: string, ctx: object) => string,
 *   grokHome?: () => string,
 *   productPaths?: ReturnType<typeof createProductPaths>,
 * }} deps
 */
async function openIdeApp(opts, deps) {
  /** @type {{ workspace?: string, file?: string, line?: number, column?: number }} */
  let options = {};
  if (typeof opts === "string") options = { workspace: opts };
  else if (opts && typeof opts === "object") options = opts;

  const ide = resolveIdeInstall(deps);
  if (!ide.installed || !ide.executable) {
    return {
      ok: false,
      reason: "not_installed",
      productName: ide.productName,
      expectedDir: ide.installDir,
      downloadUrl: ide.downloadUrl,
      message: `${ide.productName} is not installed.`,
    };
  }
  const workspace =
    (options.workspace && String(options.workspace).trim()) ||
    (deps.getWorkspace && deps.getWorkspace()) ||
    deps.loadState().workspaceRoot ||
    "";
  let file = "";
  if (options.file && typeof deps.assertWorkspacePath === "function") {
    try {
      file = deps.assertWorkspacePath(String(options.file), {
        workspaceRoot: workspace || deps.loadState().workspaceRoot,
        allowOutside: Boolean(
          deps.getAllowOutside ? deps.getAllowOutside() : deps.loadState().allowOutside,
        ),
        grokHome: deps.grokHome ? deps.grokHome() : undefined,
      });
    } catch {
      file = "";
    }
  } else if (options.file) {
    file = String(options.file);
  }
  const line = Number(options.line) || 0;
  const column = Number(options.column) || 0;

  const args = [];
  if (workspace && fs.existsSync(workspace)) {
    args.push(workspace);
  }
  if (file && fs.existsSync(file)) {
    if (line > 0) {
      const goto = column > 0 ? `${file}:${line}:${column}` : `${file}:${line}`;
      args.push("-g", goto);
    } else {
      args.push(file);
    }
  }

  const launchEnv = { ...process.env };
  if (process.platform === "win32") {
    if (ide.hostUserProfile && /CloneManager|antigravity-clone/i.test(launchEnv.USERPROFILE || "")) {
      launchEnv.USERPROFILE = ide.hostUserProfile;
      launchEnv.HOME = ide.hostUserProfile;
    }
    if (ide.hostLocalAppData && /CloneManager|antigravity-clone/i.test(launchEnv.LOCALAPPDATA || "")) {
      launchEnv.LOCALAPPDATA = ide.hostLocalAppData;
    }
    if (ide.hostAppData && /CloneManager|antigravity-clone/i.test(launchEnv.APPDATA || "")) {
      launchEnv.APPDATA = ide.hostAppData;
    }
    delete launchEnv.ANTIGRAVITY_AGENTAPI_EXE;
    delete launchEnv.CHROME_DEVTOOLS_MCP_JS;
  }

  try {
    const child = spawn(ide.executable, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      shell: false,
      env: launchEnv,
    });
    child.unref();
    return {
      ok: true,
      path: ide.executable,
      installDir: ide.installDir,
      version: ide.version || null,
      source: ide.source,
      productName: ide.productName,
      workspace: workspace || null,
      file: file || null,
      line: line || null,
      args,
    };
  } catch (e) {
    return {
      ok: false,
      reason: "launch_failed",
      path: ide.executable,
      productName: ide.productName,
      message: e instanceof Error ? e.message : String(e),
      downloadUrl: ide.downloadUrl,
    };
  }
}

module.exports = {
  PRODUCT_PATHS,
  createProductPaths,
  isExecutableFile,
  resolveExeInDir,
  resolveIdeInstall,
  openIdeApp,
  getHostProfilePaths,
  readInstalledVersion,
};
