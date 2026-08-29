import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function isAlive(child: ChildProcess): child is ChildProcess & { pid: number } {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

/**
 * Stop a spawned Grok process and every descendant it created.
 *
 * On Windows, ChildProcess.kill() only terminates the direct process. Grok may
 * leave child grok.exe or tool processes alive unless taskkill receives /T.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  force = false,
): Promise<void> {
  if (!isAlive(child)) return;

  if (process.platform === "win32") {
    const args = force
      ? ["/T", "/F", "/PID", String(child.pid)]
      : ["/T", "/PID", String(child.pid)];
    try {
      await execFileAsync("taskkill", args, { windowsHide: true, timeout: 8_000 });
      return;
    } catch {
      // Fall through to the direct process signal if taskkill is unavailable
      // or the process exited while taskkill was being started.
    }
  }

  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {
    // Process already exited.
  }
}
