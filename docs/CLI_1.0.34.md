# Grok CLI 1.0.34 integration note

Checked on 2026-09-17 against the [official Grok Build changelog](https://x.ai/build/changelog).

## Upstream CLI 1.0.34 Highlights

- **Memory is now generally available (GA)**: Cross-session memory (`MEMORY.md`, `.grok/memory`, and the `grok memory` command) is officially generally available.
- **Markdown headings now receive theme colors correctly**: Markdown headers across transcript blocks and previews render with accurate syntax theme colors in dark and light themes.
- **Cumulative upstream fixes (1.0.26 – 1.0.33)**:
  - Structured JSON data included in MCP tool results when server provides it.
  - MCP tool calls listed directly show name, arguments, and error message.
  - Background subagent tasks mark cancelled status when parent session closes.
  - Subagents dock cleans up finished tasks properly.
  - Safe `/rewind` without failing when older compaction checkpoints are absent.
  - Large skill bodies capped at 25k tokens with clear truncation notice.
  - Auto recaps suppressed while scheduled tasks, monitors, or workflows run.
  - Windows git config quote/backslash handling in `grok clone`.
  - Slash command execution during plan approval (e.g. `/feedback`).

## Desktop host alignment

- Cross-session memory is recognized as generally available; launch configuration maintains backward-compatible pass-through.
- Markdown headings (`.md-body .md-h`, `.md-h1`–`.md-h6`, `.cli-md-preview`) verify theme-aware palette colors (`--syntax-heading`, `--syntax-type`, `--syntax-literal`) across both dark and light modes.
- Slash command menu retains `/memory` (with memory tools direction), `/remember`, `/flush`, `/dream`, `/goal`, and `/workflow` support.

## Deliberately delegated to `grok`

The Desktop ACP host does not duplicate Grok CLI 1.0.34 runtime behaviors:
- Direct cross-session memory SQLite index and recall scoring.
- Silent execution of successful hooks.
- MCP server structured JSON dispatch and timeout cancel propagation.
- Subagent process lifecycles and background task cleanup.
- Automatic compaction and 30-day session retention sweeps.

Updating the installed CLI to 1.0.34 (`grok 1.0.34 (3736acbc8658)`) automatically supplies these behaviors for Desktop.

## Verification & Handoff

Verify `grok --version` reports `1.0.34` or newer. Run `npm test`, `npm run check:arch`, `npm run check:brand`, `npm run check:packaging`, and `npm run check:release` before packaging candidate builds.
