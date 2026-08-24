/**
 * Grok folder-trust store (`trusted_folders.toml`).
 * Same gate the CLI uses for repo-local MCP, LSP, and hooks.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function stripBom(text) {
  const value = String(text ?? "");
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function trustedFoldersPath(grokHome) {
  return path.join(String(grokHome || ""), "trusted_folders.toml");
}

function normalizeFolder(folder) {
  return path.resolve(String(folder || "")).replace(/[\\/]+$/, "");
}

function sameFolder(a, b) {
  const left = normalizeFolder(a);
  const right = normalizeFolder(b);
  if (!left || !right) return false;
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function escapeTomlSingle(value) {
  return String(value || "").replace(/'/g, "''");
}

/**
 * @param {string} text
 * @returns {{ path: string, trusted: boolean, decidedAt: number }[]}
 */
function parseTrustedFolders(text) {
  const folders = [];
  const chunks = stripBom(text).split(/(?=\[folders\.')/);
  for (const chunk of chunks) {
    const header = chunk.match(/\[folders\.'((?:''|[^'])*)'\]/);
    if (!header) continue;
    const trustedMatch = chunk.match(/^\s*trusted\s*=\s*(true|false)\s*$/im);
    const decidedMatch = chunk.match(/^\s*decided_at\s*=\s*(-?\d+)\s*$/im);
    folders.push({
      path: header[1].replace(/''/g, "'"),
      trusted: trustedMatch ? trustedMatch[1].toLowerCase() === "true" : false,
      decidedAt: decidedMatch ? Number(decidedMatch[1]) : 0,
    });
  }
  return folders;
}

function serializeTrustedFolders(folders) {
  return (Array.isArray(folders) ? folders : [])
    .map((row) => {
      const folderPath = String(row.path || "");
      const trusted = row.trusted ? "true" : "false";
      const decidedAt = Number.isFinite(Number(row.decidedAt)) ? Number(row.decidedAt) : 0;
      return `[folders.'${escapeTomlSingle(folderPath)}']\ntrusted = ${trusted}\ndecided_at = ${decidedAt}\n`;
    })
    .join("\n");
}

function readTrustedFolders(grokHome) {
  const file = trustedFoldersPath(grokHome);
  try {
    return parseTrustedFolders(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function getFolderTrust(grokHome, folder) {
  const resolved = normalizeFolder(folder);
  const hit = readTrustedFolders(grokHome).find((row) => sameFolder(row.path, resolved));
  return {
    path: resolved,
    trusted: Boolean(hit?.trusted),
    decidedAt: hit?.decidedAt || 0,
    file: trustedFoldersPath(grokHome),
  };
}

function setFolderTrust(grokHome, folder, trusted) {
  const resolved = normalizeFolder(folder);
  if (!resolved) {
    throw new Error("No folder to trust");
  }
  const folders = readTrustedFolders(grokHome);
  const now = Math.floor(Date.now() / 1000);
  const idx = folders.findIndex((row) => sameFolder(row.path, resolved));
  const row = {
    path: idx >= 0 ? folders[idx].path : resolved,
    trusted: Boolean(trusted),
    decidedAt: now,
  };
  if (idx >= 0) folders[idx] = row;
  else folders.push(row);
  const file = trustedFoldersPath(grokHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeTrustedFolders(folders), "utf8");
  return getFolderTrust(grokHome, resolved);
}

module.exports = {
  trustedFoldersPath,
  parseTrustedFolders,
  serializeTrustedFolders,
  readTrustedFolders,
  getFolderTrust,
  setFolderTrust,
  sameFolder,
  normalizeFolder,
};
