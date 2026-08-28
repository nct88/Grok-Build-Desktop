import { readFile, writeFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { GrokHost } from "./types.js";

export interface NodeFsHostOptions {
  /** Absolute workspace root; writes outside require allowOutside. */
  workspaceRoot: string;
  extraRoots?: string[];
  allowOutside?: boolean;
  requestPermission?: GrokHost["requestPermission"];
  selectAuthMethod?: GrokHost["selectAuthMethod"];
  onFileWrite?: (change: { path: string; oldText?: string; newText: string }) => void;
}

function isInsideRoot(resolved: string, root: string): boolean {
  if (!root) return false;
  const normResolved = process.platform === "win32" ? path.resolve(resolved).toLowerCase() : path.resolve(resolved);
  const normRoot = process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
  const rel = path.relative(normRoot, normResolved);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function assertPath(
  filePath: string,
  root: string,
  allowOutside: boolean,
  extraRoots: string[] = [],
): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`ACP path must be absolute: ${filePath}`);
  }
  const resolved = path.resolve(filePath);
  const allowed = [root, ...extraRoots.filter(Boolean)];
  const inside = allowed.some((candidate) => isInsideRoot(resolved, candidate));
  if (!inside && !allowOutside) {
    throw new Error(`Path outside workspace: ${resolved}`);
  }
  return resolved;
}

/**
 * Minimal ACP host for desktop / CLI shells (no VS Code APIs).
 */
export function createNodeFsHost(options: NodeFsHostOptions): GrokHost {
  const allowOutside = Boolean(options.allowOutside);
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots : [];

  return {
    async requestPermission(request) {
      if (options.requestPermission) {
        return options.requestPermission(request);
      }
      // Default: auto-approve first allow-ish option for MVP desktop.
      const allow =
        request.options.find((o) => /allow|accept|yes/i.test(o.optionId + o.name)) ??
        request.options[0];
      if (!allow) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: allow.optionId } };
    },

    async readTextFile(request) {
      const filePath = assertPath(request.path, options.workspaceRoot, allowOutside, extraRoots);
      let content = await readFile(filePath, "utf8");
      if (request.line !== undefined && request.line !== null) {
        const lines = content.split(/\r?\n/);
        const start = Math.max(0, request.line - 1);
        const limit = request.limit ?? lines.length;
        content = lines.slice(start, start + limit).join("\n");
      }
      return { content };
    },

    async writeTextFile(request) {
      const filePath = assertPath(request.path, options.workspaceRoot, allowOutside, extraRoots);
      let oldText: string | undefined;
      try {
        oldText = await readFile(filePath, "utf8");
      } catch {
        // new file
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, request.content, "utf8");
      options.onFileWrite?.({
        path: filePath,
        ...(oldText !== undefined ? { oldText } : {}),
        newText: request.content,
      });
      return {};
    },

    async selectAuthMethod(methods) {
      if (options.selectAuthMethod) {
        return options.selectAuthMethod(methods);
      }
      return methods[0];
    },
  };
}
