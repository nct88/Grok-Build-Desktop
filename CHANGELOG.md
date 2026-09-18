# Changelog

Public, versioned changes for Grok Build Desktop.

## Unreleased

## 0.5.59 — 2026-09-18

- Timeline virtualization black overlay gap fix: completely eliminated the issue where scrolling up in long chat sessions displayed an empty black spacer gap covering message content.
- Accurate Thought height estimation: collapsed reasoning thoughts now estimate at their true DOM height (~32px) rather than expanded size (~888px), preventing spacerTop inflation by thousands of pixels.
- SpacerTop invariant enforcement: enforced `spacerTop <= scrollTop` during history browsing, mathematically guaranteeing that the empty top spacer div can never enter the visible viewport.
- Real DOM scroll anchoring: anchored viewport position to actual DOM element boundaries, eliminating scroll jumps when off-thread markdown finishes rendering.
- Immediate upward scroll unsticking: removed artificial `nearEnd` tail pinning and detects upward scrolling immediately across both mouse wheel and scrollbar thumb drag.

Release details are maintained in `docs/releases/0.5.59.md`.

## 0.5.58 — 2026-09-18

- Recursive Markdown inline token unpack: completely resolved an issue where inline code nested inside file links (e.g. `[`docs/06-...md`](docs/...)`) was rendered as raw placeholder digits (e.g. `0`).
- Parity between main-thread parser and `contentWorker.js`: ensured off-thread Markdown rendering resolves nested token trees identically to the UI thread.
- Regression test coverage: added automated test cases in `e2e-desktop.mjs` verifying that code-in-link document paths never render as bare '0' tokens.

Release details are maintained in `docs/releases/0.5.58.md`.

## 0.5.57 — 2026-09-17

- Smooth scroll-up freedom during reasoning/streaming: immediately unbinds tail-follow when scrolling up, eliminating lock-in and allowing fluid review of earlier conversation history.
- Restricted `scrollEnd` scheduling: virtualization passes are triggered only on deliberate forced scrolls (turn completion / prompt submit), preventing stream delta contention.
- Isolated finalize/markdown updates: layout refresh during assistant completion respects user reading position and will not pull the viewport back down if scrolled up.

Release details are maintained in `docs/releases/0.5.57.md`.

## 0.5.56 — 2026-09-17

- Timeline virtualization tail pinning fix: eliminated empty blank gap at the bottom of the session timeline when assistant reasoning or response streaming finishes, without requiring manual upward scroll.
- Enhanced bottom detection: increased `isAtBottom()` threshold to 48px to cleanly account for container scroll-padding (24px), window padding (36px), and Windows DPI zoom rounding.
- Automated sliding window sync: ensured `scrollEnd(force)` and Markdown `applyFinal` schedule layout recalculation so tail items are always mounted in DOM.

Release details are maintained in `docs/releases/0.5.56.md`.

## 0.5.55 — 2026-09-17

- Live Markdown streaming rendering: assistant responses now format headings, lists, tables, and code fences in real-time during streaming.
- Integrated Markdown document reader: clicking a `.md` file path in the session timeline opens the rendered preview directly in the right workbench pane.
- Automated cleanup tool: added `npm run clean:dist` to safely purge superseded build outputs and test scratch folders while preserving the active release.
- Compatibility alignment with Grok Build CLI 1.0.34: support cross-session memory GA, verified Markdown heading theme colors, and updated slash command catalog.

Release details are maintained in `docs/releases/0.5.55.md`.

## 0.5.54 — 2026-09-10

- Voice dictation inserts at the cursor position or replaces active selection, matching Grok Build CLI 1.0.25.
- The left project list promotes the folder you are working in to the top when you open that project or one of its chats.
- Project rows and nested chats show a compact last-active age, localized with the app language (EN `45m`/`7d`, VI `45p`/`7ng`).
- Long conversations keep the last messages mounted when you scroll to the end, instead of dropping them into the virtualized spacer.

Release details are maintained in `docs/releases/0.5.54.md`.

## 0.5.53 — 2026-09-09

- Accepting a Markdown review (`plan.md` and other relative tool paths) writes into the open project instead of failing with `Path outside workspace is not allowed.`

Release details are maintained in `docs/releases/0.5.53.md`.

## 0.5.52 — 2026-09-09

- Markdown plans, reports and other `.md` files now render as readable documents after the agent finishes writing them: headings, bold, tables, colored code and Mermaid diagrams instead of a raw source dump.
- File preview defaults to the rendered document for Markdown, with a Source toggle. The review pane can switch between the document and the diff.

Release details are maintained in `docs/releases/0.5.52.md`.

## 0.5.51 — 2026-09-08

- Session info popover (Usage → Session) now sizes to the live field list instead of scrolling. Rows stay one line; Refresh/Manage billing stay on Context and Account.

Release details are maintained in `docs/releases/0.5.51.md`.

## 0.5.50 — 2026-08-31

- Replaced the line-mode dock with a ConPTY PowerShell terminal and xterm.js so ANSI, resize and interactive TUI input work in the project folder.
- Fixed the titlebar terminal toggle so a second click closes the dock; Electron drag regions no longer swallow the click after the layout shift.
- Added a Codex-style right-click menu on project folders and nested chats, mapped to Desktop APIs (rename, move, copy, export, delete, open folder).
- Added a theme-aware busy spinner on the conversation header and the active chat row while the agent is working.

Release details are maintained in `docs/releases/0.5.50.md`.

## 0.5.49 — 2026-08-29

- Align permission handling with Grok CLI 1.0.13: `dontAsk` stays deny-by-default, Auto only approves safe tool kinds, and `PreToolUse` hook asks stay interactive.
- Forward Grok permission hook metadata and exact options to Desktop confirmation cards.
- Prevent resumed sessions from creating a second worktree and terminate the full Grok process tree on disconnect.

Release details are maintained in `docs/releases/0.5.49.md`.

## 0.5.48 — 2026-08-28

- Fixed `ReferenceError: sup is not defined` in `connectAgentHost` during `agent:connect`.

Release details are maintained in `docs/releases/0.5.48.md`.

## 0.5.47 — 2026-08-28

- Added real-time permission sync via `agent:setPermissionMode` IPC channel.
- Automatically allowed outside filesystem writes and auto-approved tool calls when Full Access (`bypassPermissions`) is active.
- Automatically switched from `plan` mode to `build` mode when granting edit permissions so the agent directly edits files.
- Fixed Windows path normalization and drive letter casing in `nodeFsHost`.

Release details are maintained in `docs/releases/0.5.47.md`.

## 0.5.46 — 2026-08-25

- Hid the session tab rail. Project folders and nested chats in the left sidebar are the session switcher.
- New chats start from the sidebar **New chat** button. Running tasks keep their slot, queue and background content when switching projects.

Release details are maintained in `docs/releases/0.5.46.md`.

## 0.5.45 — 2026-08-24

- Renamed the Windows desktop shortcut to "Grok Build Desktop" in installer and portable scripts for clearer identification.

Release details are maintained in `docs/releases/0.5.45.md`.

## 0.5.44 — 2026-08-24

- Fixed Windows PE icon and product metadata stamping in `stamp-win-icon.cjs` with multi-path `rcedit` resolution and strict verification.
- Re-packaged and published release artifacts with embedded Grok Build branding.

Release details are maintained in `docs/releases/0.5.44.md`.

## 0.5.43 — 2026-08-24

- Updated File Preview and Review diff panes with responsive, soft-wrapping flex lines that dynamically adapt to pane and window resizing without horizontal overflow.
- Added a "Toggle word wrap" button to the file preview header with an interactive `wrap` icon and persisted layout setting.
- Ensured code line numbers stay top-aligned with selectable content indented cleanly when lines wrap.

Release details are maintained in `docs/releases/0.5.43.md`.

## 0.5.42 — 2026-08-24

- Fixed project and nested-chat navigation in the left sidebar so switching away from a running task no longer reconnects, stops or replaces its agent slot.
- Preserved project-owned tab state, queued prompts, elapsed runtime and cached background events, and replayed those events only when returning to their owning project.
- Reused existing session tabs and pristine project drafts to avoid duplicate chats when selecting stored history.
- Added a real-Electron regression covering project headers, nested chat rows, zero connect/stop calls, event isolation and return navigation.

Release details are maintained in `docs/releases/0.5.42.md`.

## 0.5.41 — 2026-08-24

- Added visible, accessible vertical separators for the sidebar, right panel and Files explorer/preview split, with mouse and keyboard resizing, bounded widths, reset and persisted layout state.
- Added independent collapse/restore controls for the Project Explorer and file preview while keeping a reachable restore rail and preventing both panes from being hidden together.
- Fixed Quick add and shared tool preset chips so their backgrounds size to their labels and wrap cleanly in compact panels.
- Added runtime visual regression coverage for resizing, collapse/restore, persistence, minimum widths, light/dark themes and 150% Windows scale.

Release details are maintained in `docs/releases/0.5.41.md`.

## 0.5.40 — 2026-08-24

- Preserved independent running tasks, prompt queues, elapsed runtime and cached content across session-tab switches, with persistent direct tab renaming.
- Reworked Files into a dedicated lazy Project Explorer beside the preview, including folder/file hierarchy, language labels, useful states and safe refresh/retry behavior.
- Added language-aware, line-numbered syntax coloring for common source, configuration and markup formats, while keeping large-file and unsupported-language fallbacks.
- Simplified the session header to the project name and expanded Desktop's Grok CLI command/trust workflow, including `/hooks-trust` and MCP reconnect controls.

Release details are maintained in `docs/releases/0.5.40.md`.

## 0.5.39 — 2026-08-20

- Added workspace Grok skills (`/verify-ui`, `/use-mcp`, `/write-fix-log`, `/run-check`), always-on `.grok/rules`, and Chrome DevTools MCP so Desktop sessions know how to verify UI and call integrations.

Release details are maintained in `docs/releases/0.5.39.md`.

## 0.5.38 — 2026-08-18

- Aligned Desktop with Grok CLI 1.0.5: ACP `session/new` and `session/load` now send reasoning effort, and resume surfaces last-turn / recap summaries.
- Added common TUI slash commands to the composer (`/new`, `/session-info`, `/context`, `/compact`, `/recap`, `/rewind`, `/model`, `/effort`, `/plan`, `/btw`, `/docs`, and related aliases).
- Improved session reasoning context with a header flow strip, sidebar last-turn previews, early title refresh, and readable preparing-tool labels.

Release details are maintained in `docs/releases/0.5.38.md`.

## 0.5.37 — 2026-08-17

- Added workspace/profile Grok skills to the Desktop slash menu through the local `grok inspect` catalog.
- Limited dynamic shortcuts to user-invocable skills stored under the active workspace or `%GROK_HOME%`, avoiding bundled and marketplace cache noise.
- Added explicit skill invocation, fail-closed discovery, request race protection and stable built-in command precedence.
- Improved long-command overflow, tooltips, scrolling and titlebar-safe menu height at 100%, 125% and 150% scale.
- Added local catalog and visual regression gates for filtering, keyboard insertion, no-match, unavailable and many-item states.

Release details are maintained in `docs/releases/0.5.37.md`.

## 0.5.36 — 2026-08-13

- Added a Grok CLI 1.0.3-style Session info surface with separate Session, Context and Account tabs.
- Added safe local metadata for session title, CLI version, authentication method, session ID, workspace, model, API backend, sandbox, turns, reasoning effort and permission mode.
- Added cumulative token, cache, reasoning, model-call, API-time and cost details without depending on account billing availability.
- Added click-to-copy rows and Copy all, with responsive English/Vietnamese layouts and regression coverage at 1000×640 and 1440×900.

Release details are maintained in `docs/releases/0.5.36.md`.

## 0.5.35 — 2026-08-13

- Stopped creating leftover Chat tabs when opening or switching a project; conversations stay under the left sidebar project.
- Hid the session tab rail unless two chats are open at once, and started new chats from the sidebar instead.
- Compacted the session header by removing the git hash and Create PR control.
- Added an Open project dialog that can attach multiple source folders to one conversation.

Release details are maintained in `docs/releases/0.5.35.md`.

## 0.5.34 — 2026-08-13

- Moved the project folder picker from the conversation header to sit on the top-left of the composer, just above the message box.

Release details are maintained in `docs/releases/0.5.34.md`.

## 0.5.33 — 2026-08-13

- Kept the composer project and left sidebar on the same open folder after sending a message, and refreshed project chat history when a turn completes.
- Added automatic Grok CLI version and model detection, with an in-app prompt that runs `grok update`.
- Moved Usage next to Effort in the composer while keeping the Settings usage panel.
- Set Effort to `low` / `medium` / `high` / `xhigh` with `high` as the default and `xhigh` for grok-4.6+, and removed `(default)` from the model chip.
- Moved the project folder picker to the top-left of the chat frame.

Release details are maintained in `docs/releases/0.5.33.md`.

## 0.5.32 — 2026-08-12

- Added direct drag-and-drop of an individual chat from one project to another.
- Restricted project reordering to the project header so dragging a nested chat cannot move the whole project group.
- Added clear light/dark drop-target feedback and localized drag accessibility text.
- Preserved the Move menu as a keyboard-friendly fallback.

Release details are maintained in `docs/releases/0.5.32.md`.

## 0.5.31 — 2026-08-12

- Kept the composer project picker, sidebar project, active tab and restored session timeline synchronized.
- Added safe movement of an existing chat between projects, including persisted session metadata.
- Localized dynamic Tool and Review surfaces when Vietnamese is enabled.
- Improved local folder/file links, including paths containing spaces and source-line suffixes.
- Added a localized right-click menu for copying or selecting ordinary session content.
- Kept internal runtime bundles in `extraResources` while classifying workspace links as build-only dependencies, avoiding Windows junction traversal during packaging.

Release details are maintained in `docs/releases/0.5.31.md`.

## 0.5.30 — 2026-08-12

- Added a Codex-aligned session timeline with restored reasoning summaries.
- Added framed Markdown tables, flat tool/review surfaces and responsive right-panel hiding.
- Added navigable local paths with folder actions.
- Standardized source startup as `npm install` followed by `npm start`.
- Added a centered English/Vietnamese language switch to both README pages.

Release details are maintained in `docs/releases/0.5.30.md`.
