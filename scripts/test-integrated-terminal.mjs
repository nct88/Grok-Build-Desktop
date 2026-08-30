import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");

const [host, main, preload, renderer, html, css, desktopPackage] = await Promise.all([
  read("apps/desktop/src/terminalHost.cjs"),
  read("apps/desktop/src/main.cjs"),
  read("apps/desktop/src/preload.cjs"),
  read("apps/desktop/renderer/app.js"),
  read("apps/desktop/renderer/index.html"),
  read("apps/desktop/renderer/styles.css"),
  read("apps/desktop/package.json"),
]);

assert.match(host, /require\("node-pty"\)/, "integrated shell must use node-pty");
assert.match(host, /pty\.spawn\(/, "integrated shell must create a PTY");
assert.match(host, /command = "powershell\.exe"/, "Windows default must be PowerShell");
assert.match(host, /useConpty: isWin/, "Windows PTY must opt into ConPTY");
assert.match(main, /new PtyShell\(\)/, "main process must own the PTY shell");
assert.match(main, /ipcMain\.handle\("term:resize"/, "PTY terminal must resize from the renderer");
assert.match(preload, /term:resize/, "resize IPC must be exposed to the renderer");
assert.match(html, /vendor\/xterm\.js/, "renderer must load the xterm emulator");
assert.match(html, /id="termPty"/, "renderer must provide an xterm mount point");
assert.match(renderer, /new globalThis\.Terminal\(/, "renderer must initialize xterm");
assert.match(renderer, /new globalThis\.FitAddon\.FitAddon\(/, "renderer must fit xterm to the dock");
assert.match(renderer, /ptyTerminal\.onData/, "keystrokes must flow from xterm to the PTY");
assert.match(renderer, /ptyTerminal\?\.write/, "PTY output must flow to xterm");
assert.match(renderer, /let termVisible = false/, "terminal visibility must have explicit state");
assert.match(renderer, /function toggleTermVisible\(\)/, "all terminal toggles must share one state transition");
assert.match(
  renderer,
  /addEventListener\("pointerdown", handleTermTogglePointer, \{ capture: true \}\)/,
  "titlebar terminal toggle must activate on pointerdown so Electron drag regions cannot swallow the second click",
);
assert.match(
  renderer,
  /addEventListener\("click", handleTermToggleClick, \{ capture: true \}\)/,
  "titlebar terminal toggle must keep keyboard click activation",
);
assert.match(
  css,
  /\.titlebar-drag\s*\{[^}]*-webkit-app-region:\s*drag/,
  "window drag must be limited to the titlebar spacer, not the toggle buttons",
);
assert.doesNotMatch(
  css,
  /\.titlebar\s*\{[^}]*-webkit-app-region:\s*drag/,
  "the full titlebar must not be a drag region or toggle buttons lose their second click",
);
assert.doesNotMatch(
  renderer,
  /if \(!isTermOpen\(\)\) setTermVisible\(true\);/,
  "background PTY output must not reopen a terminal the user hid",
);
assert.match(desktopPackage, /"node-pty"/, "desktop package must ship node-pty");
assert.match(desktopPackage, /"@xterm\/xterm"/, "desktop package must ship xterm");

console.log("Integrated terminal contract: PTY, PowerShell, xterm, and resize IPC passed.");
