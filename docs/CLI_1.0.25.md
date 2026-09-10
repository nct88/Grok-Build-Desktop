# Grok CLI 1.0.25 integration note

Checked on 2026-09-10 against the [official Grok Build changelog](https://x.ai/build/changelog).

## Desktop host changes

- Voice dictation now inserts at the composer caret or replaces the selected range, preserving text after the caret.
- The existing `/goal`, `/workflow`, and `/workflows` composer actions already cover the current workflow create/list/pause/resume/stop/save flow.
- The virtualized session timeline fix remains in the 0.5.54 working tree and must be packaged with this source line.

## Deliberately delegated to `grok`

The Desktop ACP host does not duplicate Grok CLI 1.0.25 runtime behavior: successful hooks are silent, Bash results are complete in the pager, `grok -c` selects the correct resumed session, and headless prompts use the CLI timeout behavior. Updating the installed CLI to 1.0.25 supplies those changes for Desktop and IDE alike.

## Packaging handoff

This commit is intentionally independent of the pending 0.5.54 session-timeline and sidebar changes already present in the Desktop worktree. The packaging agent should retain both source lines, verify `grok --version` reports `1.0.25`, and run `node scripts/test-voice-transcript.mjs`, `npm test`, and `npm run check:visual` from the final combined tree before producing artifacts.
