/**
 * ACP reverse-terminal host (Node child processes) + interactive user shell runner.
 * Ported from grok-build-workbench terminalHost for desktop.
 */
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const pty = require("node-pty");

function resolveTerminalSpawn(command, args, platform = process.platform, comspec = process.env.ComSpec) {
  const providedArgs = args ?? [];
  if (providedArgs.length > 0) {
    return { command, args: [...providedArgs] };
  }
  const trimmed = String(command || "").trim();
  if (!trimmed) throw new Error("Terminal command must not be empty.");
  if (platform === "win32") {
    return {
      command: comspec && comspec.trim() ? comspec : "cmd.exe",
      args: ["/d", "/s", "/c", trimmed],
    };
  }
  return { command: "/bin/sh", args: ["-c", trimmed] };
}

function exitStatus(exitCode, signal) {
  return { exitCode, signal };
}

class TerminalHost {
  constructor() {
    this.terminals = new Map();
  }

  async createTerminal(request) {
    const id = randomUUID();
    const env = { ...process.env };
    for (const item of request.env ?? []) {
      env[item.name] = item.value;
    }
    const resolved = resolveTerminalSpawn(request.command, request.args);
    const child = spawn(resolved.command, resolved.args, {
      cwd: request.cwd ?? undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const managed = {
      id,
      process: child,
      output: "",
      exitCode: null,
      signal: null,
      maxOutputBytes: request.outputByteLimit ?? 64_000,
      exitWaiters: [],
    };
    const append = (chunk) => {
      managed.output = `${managed.output}${chunk}`;
      if (managed.output.length > managed.maxOutputBytes) {
        managed.output = managed.output.slice(-managed.maxOutputBytes);
      }
    };
    const finish = (exitCode, signal) => {
      if (managed.exitCode !== null || managed.signal) return;
      managed.exitCode = exitCode;
      managed.signal = signal;
      const status = exitStatus(exitCode, signal);
      for (const w of managed.exitWaiters) w(status);
      managed.exitWaiters = [];
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (error) => {
      append(`\n${error.message}`);
      finish(1, null);
    });
    child.once("exit", (code, signal) => finish(code, signal));
    this.terminals.set(id, managed);
    return { terminalId: id };
  }

  async terminalOutput(request) {
    const terminal = this.require(request.terminalId);
    return {
      output: terminal.output,
      truncated: terminal.output.length >= terminal.maxOutputBytes,
      exitStatus:
        terminal.exitCode !== null || terminal.signal
          ? exitStatus(terminal.exitCode, terminal.signal)
          : null,
    };
  }

  async releaseTerminal(request) {
    const terminal = this.terminals.get(request.terminalId);
    if (!terminal) return;
    if (terminal.exitCode === null && terminal.signal === null) terminal.process.kill();
    this.terminals.delete(request.terminalId);
  }

  async waitForExit(request) {
    const terminal = this.require(request.terminalId);
    if (terminal.exitCode !== null || terminal.signal) {
      return exitStatus(terminal.exitCode, terminal.signal);
    }
    return new Promise((resolve) => {
      terminal.exitWaiters.push(resolve);
    });
  }

  async killTerminal(request) {
    const terminal = this.terminals.get(request.terminalId);
    if (!terminal) return;
    if (terminal.exitCode === null && terminal.signal === null) terminal.process.kill();
  }

  dispose() {
    for (const terminal of this.terminals.values()) {
      if (terminal.exitCode === null && terminal.signal === null) terminal.process.kill();
    }
    this.terminals.clear();
  }

  require(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
    return terminal;
  }
}

/** Interactive one-shot user shell command (UI Terminal panel). */
function runUserShell(command, cwd, onChunk) {
  return new Promise((resolve) => {
    const resolved = resolveTerminalSpawn(command, []);
    const child = spawn(resolved.command, resolved.args, {
      cwd: cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    let out = "";
    const append = (c) => {
      out += c;
      onChunk?.(c);
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", (err) => {
      append(err.message);
      resolve({ code: 1, output: out });
    });
    child.once("exit", (code) => resolve({ code: code ?? 1, output: out }));
  });
}

/**
 * Long-lived interactive shell for the Terminal dock.
 * Always started with an explicit project cwd (never silent process.cwd()).
 */
class PtyShell {
  constructor() {
    this.child = null;
    this.cwd = null;
    this.onData = null;
  }

  /**
   * @param {string} cwd Absolute project folder (required)
   * @param {(chunk: string) => void} onData
   */
  start(cwd, onData) {
    this.stop();
    const root = String(cwd || "").trim();
    if (!root) {
      throw new Error("Open a project folder first.");
    }
    this.cwd = root;
    this.onData = onData;
    const isWin = process.platform === "win32";
    let command;
    let args;
    const env = { ...process.env };
    if (isWin) {
      // A real ConPTY, rather than stdout/stderr pipes. PowerShell is the
      // native Windows shell shown by default in Codex's integrated terminal.
      command = "powershell.exe";
      args = [];
    } else {
      command = process.env.SHELL || "/bin/bash";
      args = ["-i"];
    }
    this.child = pty.spawn(command, args, {
      cwd: this.cwd,
      env,
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      useConpty: isWin,
    });
    const append = (chunk) => {
      this.onData?.(String(chunk));
    };
    const shell = this.child;
    shell.onData(append);
    shell.onExit(({ exitCode }) => {
      append(`\r\n[exited ${exitCode}]\r\n`);
      // A previous shell can finish after Restart has already created a new
      // one; never let that stale exit clear the live PTY reference.
      if (this.child === shell) this.child = null;
    });
  }

  write(data) {
    if (!this.child) {
      throw new Error("Shell not running.");
    }
    this.child.write(String(data ?? ""));
  }

  resize(cols, rows) {
    if (!this.child || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    this.child.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)));
  }

  /** Soft interrupt (Ctrl+C) delivered through the real PTY. */
  interrupt() {
    if (!this.child || this.child.killed) return;
    try {
      if (process.platform === "win32") {
        this.child.write("\x03");
      } else {
        this.child.kill("SIGINT");
      }
    } catch {
      // ignore
    }
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
    }
    this.child = null;
  }

  get running() {
    return Boolean(this.child);
  }
}

module.exports = {
  TerminalHost,
  resolveTerminalSpawn,
  runUserShell,
  PtyShell,
};
