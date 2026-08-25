# Changelog

Public, versioned changes for Grok Build Desktop.

## Unreleased

- New chats from the left sidebar bind to the selected project folder. A warm agent still connected to another project no longer stores the conversation under that other cwd.
- Project Files lists the sidebar-selected folder even when the agent is still connected to another project. Retry reloads that folder instead of repeating the outside-workspace error.

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
