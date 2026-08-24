---
name: use-mcp
description: Use when calling MCP, Chrome DevTools, Figma, Canva, MongoDB, Cloudflare, Supabase, Playwright, GitHub, GitLab, Telegram, or when a plugin tool is missing, needs OAuth, or grok mcp doctor fails. Also /use-mcp.
---

# Use MCP

Call `search_tool` before `use_tool`. Never guess MCP parameter names.

Desktop slash lists only `.grok/skills` and `%GROK_HOME%/skills`. Plugin skills still load for the CLI agent from `~/.grok/installed-plugins/`.

## This workspace

| Server | How it loads | Typical state |
|---|---|---|
| `chrome-devtools` | `.grok/config.toml` | Live (~29 tools). Use for web pages. |
| `mongodb` | user plugin | Live if URI/plugin works. |
| `cloudflare-docs` | user plugin `cloudflare` | Live, no login. |
| `figma`, `canva`, `supabase`, `mongodb-atlas` | user plugins | OAuth. `/mcps` → `i`. |
| `cloudflare-api`, `cloudflare-bindings`, `cloudflare-builds`, `cloudflare-observability` | user plugin `cloudflare` | OAuth. |
| `telegram` | user plugin | Needs `bun` on PATH. |
| `github`, `gitlab`, `playwright` | user plugins | Declared but often not spawned. GitHub needs `GITHUB_PERSONAL_ACCESS_TOKEN`. |

Prefer **chrome-devtools** over Playwright MCP for browser checks here. Prefer repo Playwright scripts (`npm run check:visual`) for the Electron app.

## If a server is missing

```powershell
grok mcp list --json
grok mcp doctor
```

- OAuth handshake fail → user authenticates in `/mcps` (`i`), then `r`.
- Project untrusted → `/hooks-trust` (or Tools → MCP → Trust folder), then reconnect so repo-local servers start.
- `chrome-devtools` down → confirm Node/npm/Chrome; config is `.grok/config.toml`.
- Do not duplicate a healthy user server under a new name.

MongoDB query/schema work: load the `mongodb` plugin skills after the server is connected.
