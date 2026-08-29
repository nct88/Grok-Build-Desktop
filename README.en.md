# Grok Build Desktop

<p align="center">
  <strong>🇬🇧 English</strong> | <a href="./README.md">🇻🇳 Tiếng Việt</a>
</p>

Grok Build Desktop is an Electron **agent desktop** powered by the **official Grok CLI** through ACP (`grok agent stdio`). It focuses on conversations, session management, code review, terminal access and task orchestration, while the agent loop, tools, authentication and sessions remain owned by Grok CLI.

> **CLI is the core · Desktop is the interface.** Grok Build Desktop is not Grok Build IDE, is not a reskinned VS Code, and does not implement a second agent runtime.

Current source version: **0.5.49** — see [`product/VERSION`](product/VERSION).

## Downloads

The release is publicly available on GitHub Releases:

| Package | Purpose | Download |
|---|---|---|
| NSIS Setup | Install on Windows with Start Menu and shortcut integration | [Grok-Build-Setup-0.5.49.exe](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.49/Grok-Build-Setup-0.5.49.exe) |
| Portable EXE | Run as a self-extracting executable | [Grok-Build-0.5.49-win32-x64-portable.exe](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.49/Grok-Build-0.5.49-win32-x64-portable.exe) |
| Portable ZIP | Extract once; recommended for regular use | [Grok-Build-0.5.49-win32-x64.zip](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.49/Grok-Build-0.5.49-win32-x64.zip) |
| Manifest | Artifact sizes and SHA-256 values | [MANIFEST.json](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.49/MANIFEST.json) |

Release page: [Grok Build Desktop v0.5.49](https://github.com/nct88/Grok-Build-Desktop/releases/tag/v0.5.49).

Windows artifacts are currently unsigned and may trigger SmartScreen on first run. Verify their SHA-256 values against `MANIFEST.json` before opening them.

## Grok Build Desktop and Grok Build IDE

| Field | Grok Build Desktop (this repo) | Grok Build IDE |
|---|---|---|
| Product name | **Grok Build Desktop** | **Grok Build IDE** |
| GitHub | [`nct88/Grok-Build-Desktop`](https://github.com/nct88/Grok-Build-Desktop) | [`nct88/Grok-Build-IDE`](https://github.com/nct88/Grok-Build-IDE) |
| Runtime | Electron, **not** Code-OSS | Code-OSS + Grok Build Workbench |
| Windows / Start Menu name | Grok Build (`Grok Build.exe`) | Grok Build IDE (`Grok Build IDE.exe`) |
| Role | Agent UI, sessions, review, terminal | Editor, Explorer, SCM, debug, and agent |
| Required engine | **Grok CLI** (`grok` on `PATH`, `~/.grok/bin/grok.exe`, or `GROK_EXECUTABLE`) | the same Grok CLI |

```text
Grok Build Desktop (Electron)
    → AgentSupervisor (Electron main process)
        → packages/acp-client (GrokClient)
            → grok agent stdio
                → ~/.grok (authentication, sessions and CLI configuration)
```

## Key features

### Conversations and agents

- Streams responses with Markdown, thinking, plans and tool state.
- Groups tool calls while keeping the final answer below tool activity.
- Select model, reasoning effort, mode and permission policy directly in the composer.
- Grok CLI slash commands run from the composer, including session (`/new`, `/resume`, `/fork`, `/quit`, `/home`), model (`/model`, `/effort`, `/plan`), MCP/trust (`/mcps`, `/hooks-trust`), memory/workflow (`/remember`, `/loop`, `/goal`) and Settings (`/settings`, `/theme`, `/privacy`).
- Resume shows recap and last-turn summaries; ACP sends reasoning effort when opening or loading a session (CLI 1.0.5).
- Cancel an active turn or queue the next prompt while the agent is busy.
- `AgentSupervisor` keeps warm connections, reconnects automatically and supports up to two interactive slots.

### Projects, sessions and history

- Projects contain real folders only, with conversations nested under each project.
- Recents is reserved for conversations that are not attached to a project.
- Start a conversation without selecting a project; the agent uses `~/.grok/desktop-recents`.
- Reopen sessions, replay history, switch sessions, export Markdown or remove a local session.
- Supports multiple session tabs and agent-slot switching.

### Files, review and terminal

- Attach files, drag and drop, paste images and insert `@file` references.
- Track files edited by the agent in the Files/Review panel.
- Inspect diffs and accept or reject all changes or individual hunks.
- Use an interactive workspace terminal and ACP reverse terminal when supported by the runtime.
- Git status, change summary and a shortcut for creating pull requests.

### Manager and CLI ecosystem

- Run headless jobs through `grok -p`, then track status and artifacts.
- Manage worktrees, MCP servers and plugins using Grok CLI capabilities.
- Shortcuts for `doctor`, login/logout, CLI version and configuration listing.
- Display usage and plan information from the same data source used by Grok CLI.

### Media and desktop experience

- `/imagine` creates images and previews them from the session media directory.
- `/imagine-video` performs a privacy preflight before sending the request.
- Image lightbox, folder reveal, copy actions and video playback through blob URLs.
- English/Vietnamese interface with light, dark and system themes.
- **Open IDE** launches Grok Build IDE with the active workspace.
- Application menu, shortcuts, About dialog and update-feed checks.

## System requirements

### Users

- Windows x64.
- Grok CLI installed.
- An authenticated account through `grok login` or the equivalent CLI mechanism.

Grok CLI lookup order:

1. `GROK_EXECUTABLE` environment variable.
2. `grok` command on `PATH`.
3. `%USERPROFILE%\.grok\bin\grok.exe`.

### Development

- Node.js 20 or later.
- npm with workspace support.
- Windows is required to build NSIS and portable executables.

## Quick installation and use

### Option 1: NSIS Setup

1. Download `Grok-Build-Setup-0.5.46.exe` from the release.
2. Verify its checksum in `MANIFEST.json`.
3. Run the installer and open **Grok Build** from the Start Menu.
4. Select a project or start a conversation without one.
5. Select **Connect** to start `grok agent stdio`.

Default installation path:

```text
%LOCALAPPDATA%\Programs\Grok Build\Grok Build.exe
```

### Option 2: Portable ZIP

1. Download the ZIP file.
2. Extract it into a fixed directory.
3. Run `Grok Build.exe` from the extracted directory.

The ZIP is preferable to the portable EXE for daily use because it does not self-extract again on every launch.

## Run from source

```powershell
git clone https://github.com/nct88/Grok-Build-Desktop.git
cd Grok-Build-Desktop
npm install
npm start
```

Equivalent Windows command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-desktop.ps1
```

Common commands:

| Command | Purpose |
|---|---|
| `npm start` | Build packages and run Electron Desktop |
| `npm run desktop` | Compatibility alias for `npm start` |
| `npm run build` | Build the ACP client and sessions package |
| `npm run icons` | Generate and stamp Desktop icons |
| `npm run check` | Run architecture, packaging, brand, tests and visual gates |
| `npm test` | Run the Desktop test suite |
| `npm run dist:desktop` | Create electron-builder output |
| `npm run portable` | Install the ZIP into LocalAppData and run it |
| `npm run portable:shortcut` | Install the ZIP and create a Desktop shortcut |

## Architecture

### Required boundaries

- The agent loop exists only in Grok CLI.
- The renderer does not spawn agent processes or call model HTTP APIs directly.
- Desktop communicates with the CLI through ACP in `packages/acp-client`.
- This repository does not contain a Code-OSS source tree; the IDE lives in a separate repository.

### Main Electron modules

| Module | Responsibility |
|---|---|
| `main.cjs` | Create windows, register IPC and connect modules |
| `agentSupervisor.cjs` | Manage ACP lifecycle, reconnects and agent slots |
| `launchArgs.cjs` | Normalize permissions and construct CLI arguments |
| `productPaths.cjs` | Locate Desktop/IDE installation paths on Windows |
| `ipcContract.cjs` | Define invoke/events allowed through preload |
| `security.cjs` | Enforce workspace, URL and CLI-command boundaries |
| `jobRunner.cjs` | Run headless work through `grok -p` |
| `artifactStore.cjs` | Store and index job artifacts |
| `controlPlane.cjs` | Provide health and capability snapshots |
| `telemetry.cjs` | Local opt-in performance buckets |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for details.

## Data and security

- CLI authentication and sessions live under `%USERPROFILE%\.grok`.
- Desktop application state defaults to `%APPDATA%\@grok-build\desktop`.
- File access is workspace-scoped unless the user enables outside-workspace access.
- External URLs follow a guarded HTTP(S) policy; URLs containing credentials are blocked.
- UI-triggered CLI commands pass through an allowlist instead of executing arbitrary strings.
- Desktop performance telemetry is opt-in and stored locally.

Never commit authentication files, tokens, cookies, `.env` files, private keys or personal session data.

## Tests and quality gates

```powershell
npm run check
```

This command verifies, in order:

1. Architecture boundaries.
2. Electron/NSIS packaging contract.
3. Brand-asset synchronization and quality.
4. Release/version contract.
5. Desktop test suite.
6. Layout and rendering at supported viewports.

Run authenticated Grok CLI integration tests when needed:

```powershell
$env:GROK_E2E_LIVE = '1'
npm test
```

## Package and publish for Windows

### 1. Build an immutable local candidate

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\publish-release.ps1 `
  -Version <semver>
```

Every version is immutable; the script stops if `dist/<version>` already exists.

```text
dist/<version>/
├─ install/
│  └─ Grok-Build-Setup-<version>.exe
├─ portable/
│  ├─ Grok-Build-<version>-win32-x64-portable.exe
│  └─ Grok-Build-<version>-win32-x64.zip
├─ update/
│  ├─ app.asar
│  ├─ packages/
│  └─ apply-update.ps1
├─ MANIFEST.json
└─ latest.json
```

### 2. Commit and push the release source

```powershell
npm run check
git add -A
git commit -m "release: Grok Build Desktop <semver>"
git push origin main
```

### 3. Verify and publish the GitHub Release

```powershell
# Preflight only; do not create a tag or release
npm run release:github -- -Version <semver> -DryRun

# Authenticode-signed artifacts
npm run release:github -- -Version <semver>

# Unsigned exception: explicit maintainer approval required
npm run release:github -- -Version <semver> -AllowUnsigned
```

The publisher runs only when the worktree is clean, `HEAD` matches `origin/main`, versions are synchronized, the Vietnamese/English README pair and bilingual release notes are valid, and artifact SHA-256 values match `MANIFEST.json`. It creates and pushes annotated tag `v<semver>`, publishes the latest GitHub Release, and uploads Setup, Portable EXE, Portable ZIP and the manifest. Existing tags/releases are never overwritten.

Standard public releases require HTTPS and valid Authenticode signatures. Unsigned builds require explicit maintainer approval through `-AllowUnsigned` and must retain the SmartScreen warning. Release notes must start from [`docs/releases/TEMPLATE.md`](docs/releases/TEMPLATE.md) and keep Vietnamese and English content side by side. `README.md` and `README.en.md` must use the same version, download links and reciprocal language switch. See [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## Repository structure

```text
Grok-Build-Desktop/
├─ apps/desktop/           Electron main, preload, renderer and packaging
├─ packages/acp-client/    ACP client and Node filesystem host
├─ packages/sessions/      Local Grok session index
├─ product/                Version and product identity
├─ logo/                   Source and processed icon matrix
├─ scripts/                Development, tests, checks and release automation
├─ docs/                   Architecture, distribution, roadmap and release notes
├─ CHANGELOG.md            Versioned product changes
└─ dist/                   Local build artifacts, normally not committed
```

## Troubleshooting

### Grok CLI not found

Run:

```powershell
grok --version
grok doctor
```

If the command does not exist, add Grok CLI to `PATH` or set `GROK_EXECUTABLE` to the full path of `grok.exe`.

### Agent cannot connect

Verify authentication:

```powershell
grok login
grok doctor
```

Then reopen Grok Build and select **Connect**.

### SmartScreen warning

The build is currently unsigned. Compare its SHA-256 with `MANIFEST.json`; select **More info → Run anyway** only when the checksum matches and the file came from the official release.

### Old icon remains after upgrade

Windows may retain the icon cache for a pinned shortcut. Unpin the old shortcut, launch the new build once and pin the shortcut from the newly installed application.

### `/imagine-video` is blocked

Video generation requires the account to allow coding-data retention (`coding_data_retention_opt_out: false`). This account/Grok TUI setting cannot be changed automatically by Electron.

### Open IDE cannot find the IDE

The application checks Settings, `GROK_BUILD_IDE`, default installation paths and common locations. Set `GROK_BUILD_IDE` to the full path of `Grok Build IDE.exe` when necessary.

## Related documentation

| Document | Content |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture boundaries and main modules |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Install dependencies, run source and verify |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Ship line and future direction |
| [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) | Release channels, signing and SmartScreen |
| [`docs/INSTALL_PATHS.md`](docs/INSTALL_PATHS.md) | Desktop/IDE installation paths |
| [`product/PRODUCT_IDENTITY.md`](product/PRODUCT_IDENTITY.md) | Desktop and IDE product names |
| [`CHANGELOG.md`](CHANGELOG.md) | Versioned product changes |

## Contributing

1. Create a dedicated branch for the change.
2. Do not add secrets or personal session data to commits.
3. Run `npm run check` before opening a pull request.
4. Describe the changed behavior and verification evidence in the pull request.

## License and notices

Copyright © 2026 Grok Build contributors. **All rights reserved.** This repository does not grant an open-source license (**No open-source license is granted**); see [`LICENSE`](LICENSE).

Third-party components follow their own licenses and notices.

Grok CLI and Grok models belong to their respective owners in the xAI/Grok ecosystem. Grok Build Desktop is an independent desktop interface that uses the official CLI through ACP; it does not claim official affiliation without written confirmation.
