# Fix log

## 2026-08-29 — Grok CLI 1.0.13 ACP host compatibility (v0.5.49)

- **Target version:** 0.5.49
- **Yêu cầu gốc / Triệu chứng (Symptom):** Desktop vẫn tự cấp quyền cho `dontAsk`/Auto và có thể bỏ qua `PreToolUse { decision: "ask" }`; resume có thể truyền lại worktree flags; dừng agent Windows chỉ kết thúc process cha.
- **Nguyên nhân gốc rễ (Root Cause):** Permission handler gộp `bypassPermissions`, `dontAsk` và Auto thành một nhánh allow; launch args không phân biệt resume; ACP client không kết thúc process tree.
- **Giải pháp chi tiết (Resolution):** Chỉ Full access tự duyệt toàn bộ; Auto chỉ duyệt read/search/think/fetch; `dontAsk` và hook ask luôn tạo card. Card nhận metadata hook/options; resume bỏ worktree flags; client dùng `taskkill /T` trên Windows và metadata session gửi permission mode.
- **Danh sách file tác động:** `agentSupervisor.cjs`, `launchArgs.cjs`, `main.cjs`, renderer permission card, ACP client/process tree/session metadata, tests và release metadata 0.5.49.
- **Kiểm chứng (Verification Proof):** `grok --version` = 1.0.13, `grok update` báo already up to date; `npm run check` pass với 30 E2E và toàn bộ visual/release gates.
- **Bài học rút ra:** Không suy diễn `dontAsk` thành bypass permissions; mọi hook yêu cầu xác nhận phải thắng host auto-approval.

---

## 2026-08-28 — Sửa lỗi `ReferenceError: sup is not defined` (v0.5.48)

- **Target version:** 0.5.48
- **Yêu cầu gốc / Triệu chứng (Symptom):** Khi mở ứng dụng Grok Build Desktop, màn hình hiển thị popup lỗi: `Error invoking remote method 'agent:connect': ReferenceError: sup is not defined`.
- **Nguyên nhân gốc rễ (Root Cause):**
  - Trong hàm `connectAgentHost(acp, slot, mode)` tại `apps/desktop/src/main.cjs`, dòng khởi tạo `const sup = getSupervisor();` bị thiếu khi sửa đổi code, nhưng bên dưới lại gọi `requestPermission: sup.createPermissionHandler(slot, mode)`.
- **Danh sách file & Dòng tác động (Affected Files & Line Numbers):**
  - `apps/desktop/src/main.cjs` (Dòng 409-411): Thêm `const sup = getSupervisor();` vào đầu hàm `connectAgentHost`.
  - `apps/desktop/src/agentSupervisor.cjs` (Dòng 493-500): Nâng cấp `setPermissionMode` để cập nhật đồng bộ cho toàn bộ slot active và slot trong pool khi không truyền `slotId`.
  - `package.json`, `apps/desktop/package.json`, `package-lock.json`, `product/VERSION`: Bump version 0.5.48.
  - `CHANGELOG.md`, `docs/releases/0.5.48.md`, `README.md`, `README.en.md`: Cập nhật tài liệu release 0.5.48.
- **Giải pháp chi tiết (Resolution):**
  - Khai báo đúng `const sup = getSupervisor();` trước khi sử dụng.
  - Cải tiến hàm `setPermissionMode` để lặp qua `this.slots.values()` cập nhật `permissionMode` cho toàn bộ slot.
- **Kiểm chứng (Verification Proof):**
  - `npm test`: 30 passed, 0 failed.
  - Đóng gói thành công `Grok-Build-Setup-0.5.48.exe`, portable EXE, portable ZIP.
  - Đã phát hành GitHub Release `v0.5.48` và tải lên Cloudflare R2 bucket `ai-clone`.
- **Bài học rút ra:** Luôn kiểm tra scope của tất cả các biến sau khi thay thế block code trong file CJS/JS.

---

## 2026-08-28 — Sửa lỗi Tool Call không chạy / Chỉ trả lời text dù đã cấp Full quyền (v0.5.47)

- **Target version:** 0.5.47
- **Yêu cầu gốc / Triệu chứng (Symptom):** Người dùng báo: *"ĐANG SỬ DỤNG Grok Build Desktop BÊN A RẤT TỐT. NHƯNG Ở PHIÊN BẢN MỚI HÌNH NHƯ LỖI TOOL CALL ... YÊU CẦU FIX CODE CHỈ TRẢ LỜI CHỨ KHÔNG TÁC ĐỘNG EDIT FIX FILE.. CHO DÙ ĐÃ CẤP FULL QUYỀN Ạ"*.
- **Nguyên nhân gốc rễ (Root Cause):**
  1. **Thiếu kênh IPC đồng bộ quyền:** Hàm `setPermissionValue` trong `apps/desktop/renderer/app.js` chỉ đổi nhãn hiển thị mà không gọi IPC xuống Main process. Supervisor ở backend không nhận được quyền mới.
  2. **Quyền ghi file ngoài workspace bị chặn:** `nodeFsHost.ts` đặt `allowOutside: false` và kiểm tra đường dẫn phân biệt hoa/thường trên Windows (`C:\` vs `c:\`), khiến tool `fs/write_text_file` ném lỗi `Path outside workspace`.
  3. **Kẹt ở Plan mode:** Khi session ở mode `plan`, prompt cấm gọi tool sửa code.
- **Danh sách file & Dòng tác động (Affected Files & Line Numbers):**
  - `packages/acp-client/src/nodeFsHost.ts` (Dòng 16-22, 45-47): Chuẩn hóa `isInsideRoot` bằng `toLowerCase()` trên Windows và hỗ trợ `allowOutside: true`.
  - `apps/desktop/src/main.cjs` (Dòng 410-425, 3032-3037): Mở `allowOutside` khi ở chế độ Full access / Recents; thêm handler `agent:setPermissionMode`.
  - `apps/desktop/src/agentSupervisor.cjs` (Dòng 493-518): Thêm phương thức `setPermissionMode` và dynamic permission checking trong `createPermissionHandler`.
  - `apps/desktop/src/ipcContract.cjs` (Dòng 127): Đăng ký kênh `"agent:setPermissionMode"` trong `INVOKE_CHANNELS`.
  - `apps/desktop/src/preload.cjs` (Dòng 92): Expose `setPermissionMode: (mode) => ipcRenderer.invoke("agent:setPermissionMode", mode)`.
  - `apps/desktop/renderer/app.js` (Dòng 7990-8010): Gọi `api.setPermissionMode` và auto-switch thoát khỏi `plan` mode khi cấp Full access.
- **Kiểm chứng (Verification Proof):**
  - Chạy ACP tool execution test: agent gọi tool `write` ghi file thành công.
  - `npm run check`: 30 E2E passed, layout check passed.
  - Đóng gói và phát hành version 0.5.47.

---

## 2026-08-25 — Session sidebar gắn đúng thư mục dự án

- **Yêu cầu gốc:** Đã ẩn tab session, dùng sidebar trái, nhưng chat của Antigravity-Clone vẫn nằm ở thư mục dự án khác.
- **Ràng buộc:** Giữ `sessionTabs` nội bộ (0.5.42/0.5.46). Không hiện lại thanh tab.
- **Sửa nhỏ nhất:** `ensureActiveTabAgent` chỉ reuse slot ấm khi `slot.workspace` trùng cwd tab. Chat mới gọi `connect(cwd)` thay vì `newSession()` trên agent dự án cũ.

### Symptom
Sidebar chọn Antigravity-Clone, gửi tin, session vẫn ghi dưới cwd project đang warm (ví dụ xemph.im / Recents). `listSessions(projectPath)` không thấy chat.

### Resolution
- `slotMatchesTabWorkspace` trước khi reuse / `newSession`.
- Slot đang chạy ở project khác không bị cướp; idle slot được `connect(cwd)` đúng thư mục.
- Supervisor so sánh workspace không phân biệt hoa thường trên Windows.

### Verification
- `node scripts/e2e-desktop.mjs` 29 passed, gồm send-time slot binding.

### Not done
Không đóng Grok Build đang mở, không đóng gói 0.5.47. Cần build/cài bản mới để thấy trên máy đang chạy 0.5.46.

## 2026-08-25 — Built local candidate Grok Build Desktop 0.5.46

- **Target version:** 0.5.46
- **Symptom:** User asked for a new build after hiding the session tab rail. Installed 0.5.45 under `%LOCALAPPDATA%\Programs\Grok Build` does not include that change.
- **Root cause:** n/a (packaging request).
- **Resolution:** Wrote `docs/releases/0.5.46.md` and CHANGELOG, then `scripts/publish-release.ps1 -Version 0.5.46`. Did not `taskkill` the running installed app. Did not publish GitHub.
- **Affected files:** `product/VERSION`, root/`apps/desktop` `package.json`, `CHANGELOG.md`, `docs/releases/0.5.46.md`, artifacts under `dist/0.5.46/`.
- **Verification:** Script exited 0. VERSION and both package.json files are 0.5.46. Artifacts:
  - Setup `Grok-Build-Setup-0.5.46.exe` 90,893,915 bytes SHA-256 `E38F919A3D82B6D640010E53025B4D86ED708F53C2D82D32380F088F0B343B71`
  - Portable EXE 90,470,903 bytes SHA-256 `962EF858C1A3DF2B21F97D4E0F5DDA9495EE1FF34C94D590BE2648657C255C74`
  - Portable ZIP 145,180,211 bytes SHA-256 `377BBA9EC0B93CC0982A9B7C73B8F615E21ACE14E78C9F5C08115CEAA6B3BAB3`
  - MANIFEST `releaseStatus` = `local-unsigned-candidate`
- **Not done:** GitHub Release / README download links still 0.5.45 until `npm run release:github`. Close the running Grok Build window before installing Setup.

## 2026-08-25 — Hide session tab rail; sidebar project/chat is the switcher

- **Yêu cầu gốc:** Kiểm tra tab trong session; nếu không cần thì loại bỏ. Dùng sidebar thư mục dự án bên trái như tab.
- **Ràng buộc:** Sidebar đã mở dự án (`openProjectTab`) và chat (`openHistorySession`). `sessionTabs` vẫn giữ snapshot/queue/slot khi chuyển dự án (0.5.42).
- **Sửa nhỏ nhất:** Không vẽ thanh tab. Giữ cache nội bộ. Không viết lại session model.

### Symptom
Thanh tab trên khung chat (Chat, tiêu đề phiên, nút +) trùng với danh sách dự án/chat ở sidebar trái.

### Resolution
- `sessionTabs.js` luôn ẩn rail (`session-tabs-empty` + `hidden`). State API giữ nguyên.
- `#sessionTabs` trong `index.html` hidden. Sidebar: click thư mục = đổi dự án; click chat con = mở phiên; **New chat** tạo cuộc mới.
- Test: e2e cache/slot, sidebar runtime isolation, project/session sync, visual rail-hidden.

### Affected files
`apps/desktop/renderer/lib/sessionTabs.js`, `apps/desktop/renderer/index.html`, `apps/desktop/renderer/styles.css`, `apps/desktop/renderer/app.js` (comment), `scripts/e2e-desktop.mjs`, `scripts/verify-session-tabs.mjs`, `scripts/test-sidebar-project-runtime.mjs`.

### Verification
- `node scripts/e2e-desktop.mjs` — 29 passed (sessionTabs rail hidden).
- `node scripts/test-sidebar-project-runtime.mjs` — passed.
- `node scripts/test-project-session-sync-ui.mjs` — passed.
- `node scripts/verify-session-tabs.mjs` — rail hidden, dark/light, 1000×640 + 1440×900, 125/150%.

### Note
App đang chạy cần đóng rồi mở lại từ source `E:\projects\Grok-Build` (không `taskkill`). Bản cài 0.5.45 chưa chứa thay đổi này.

## 2026-08-24 — Released Grok Build Desktop 0.5.42: sidebar project/chat runtime ownership

- **Target version:** 0.5.42
- **Symptom:** A task running in Project A could stop when the user selected Project B from the left sidebar. Selecting a stored chat in another project could also discard the old tab-to-slot owner, allowing later Project A events to render inside Project B.
- **Root cause:** The project header called the destructive `selectProject` path with `forceRestart`, while cross-project history selection called the same path with `resetToOne`. The earlier 0.5.40 regression covered only the internal session-tab rail, not project and nested-chat navigation in the sidebar.
- **Resolution:** Split project UI alignment from agent/session ownership. Sidebar project headers, the composer project menu, project picker, Recents and nested chat rows now restore or create local project-owned tabs without reconnecting or stopping a running slot. Stored chats reuse their existing tab or a pristine project draft. The last coalesced stream chunk is flushed before snapshotting a hidden tab so quick navigation cannot drop visible content.
- **Affected files:** `apps/desktop/renderer/app.js`, `scripts/test-sidebar-project-runtime.mjs`, `scripts/e2e-desktop.mjs`, `package.json`.
- **Verification:** The permanent real-Electron regression switches from a running Project A to Project B by header and stored-chat row, asserts zero `agent:connect`/`agent:stopSlot` calls, verifies one running owner remains, proves two background stream markers never appear in B, and confirms both replay after returning to A. Existing project/session UI synchronization and all 29 E2E checks also pass.
- **Release gate:** Final `npm run check` passed on 0.5.42. The same sidebar regression passed against the packaged executable, packaged layout/slash-menu smokes passed, all manifest byte/SHA-256 values matched, renderer source matched `app.asar`, and a 0.5.41-to-0.5.42 update-pack smoke created a backup and applied the exact manifest hash.
- **Publication:** Commit `5eeea6a73562be1abd8d54c75a5205a19b8841a0` was pushed to `origin/main`; annotated tag and public GitHub Release `v0.5.42` target that commit with four hash-matching assets. R2 catalog reports 0.5.42 and uses the versioned public Setup URL; the downloaded installer returns 90,893,969 bytes and SHA-256 `1F2631877888F00861B999F5C7DBEB4FC6D3A4FCD8AF3FA8C947F8A40A5A9052`.
- **Signing:** Setup and portable EXE remain unsigned; bilingual release notes retain the SmartScreen and SHA-256 verification warning.

## 2026-08-24 — Released Grok Build Desktop 0.5.41

- **Target version:** 0.5.41
- **Change:** Published accessible mouse/keyboard resizing for the sidebar, right panel and Files split; independent Explorer/preview collapse and persisted widths; and content-sized Quick add/preset chips.
- **Release gate:** Final `npm run check` passed against versioned source with 29 E2E checks and all visual gates. Packaged layout/slash-menu runtime smokes, manifest byte/SHA checks, source-to-ASAR matching and a 0.5.40-to-0.5.41 update-pack smoke all passed.
- **Publication:** Commit `41e154382db8928199132b9a9ba9d78401bef4a7` was pushed to `origin/main`; annotated tag and public GitHub Release `v0.5.41` target that commit. All four GitHub asset digests match the local manifest/artifacts. Cloudflare R2 `version.json` reports Grok `0.5.41`, and the public installer returns HTTP 200 with matching 90,893,920 bytes and SHA-256 `B5CE1DC892FB16B2D2BFB9EE3E10E5B00331D0FF135D044EA7BA0D91EC21E66A`.
- **Signing:** Setup and portable EXE remain unsigned; bilingual release notes retain the SmartScreen and SHA-256 verification warning.

## 2026-08-24 — Resizable/collapsible Files panes and content-sized Quick add chips

- **Target version:** next development candidate after 0.5.40
- **Symptom:** The Project Explorer/file-preview divider was fixed, so users could not allocate width to “Select a file” or collapse either inner pane. Existing outer dividers were mouse-only and visually hard to discover. MCP Quick add chip backgrounds stayed 28 px wide while labels such as `Filesystem` overflowed and collided.
- **Root cause:** `.file-workbench` encoded a fixed two-column `clamp(...)` grid with no interactive state or persistence. The shared splitter setup handled only two mouse-driven outer widths. A legacy `.tool-chip` icon alias imposed `width: 28px; display: grid` on text chips, while the later preset rule changed padding/colors but did not reset width/display.
- **Resolution:** Added a visible, accessible Files separator with mouse and keyboard resizing, bounded min widths, double-click reset and persisted width. Explorer and preview now each collapse to a 36 px restore rail, never collapse simultaneously, and retain state across reloads. All three vertical separators expose ARIA values and keyboard controls; outer sidebar/right-panel collapse controls retain their saved widths. Removed the conflicting legacy chip constraint and made preset chips content-sized `inline-flex` controls that wrap with a 6 px gap.
- **Affected files:** `apps/desktop/renderer/index.html`, `apps/desktop/renderer/styles.css`, `apps/desktop/renderer/app.js`, `apps/desktop/renderer/lib/i18n.js`, `scripts/verify-resizable-panes.mjs`, `package.json`.
- **Verification:** `npm run check` passed: architecture, packaging/release contracts, build, security, 29 E2E checks and all visual gates. The focused runtime gate covers mouse/keyboard resize, explorer/preview/sidebar/right-panel collapse and restore, reload persistence, compact right-panel bounds, Quick add text containment/wrapping, dark/light at 1181×700 and 1904×1000, plus a native 2160×1200 render at 150%. Existing Project Explorer empty/error and 125%/150% matrices remain green.

## 2026-08-24 — Released Grok Build Desktop 0.5.40

- **Target version:** 0.5.40
- **Change:** Published independent multi-tab runtime/queues/cache and rename behavior, the project-only session header, dedicated Project Explorer, language labels and syntax-colored previews, plus the expanded Grok CLI `/hooks-trust` and MCP trust workflow.
- **Release gate:** Final `npm run check` passed against versioned source with 29 E2E checks and all visual gates. Packaged layout and packaged 67-row slash-menu smoke checks passed. Manifest byte counts and SHA-256 values matched all four checked artifacts.
- **Publication:** Commit `2dbac1283f02d1ee7a4aff8f7ab8ac97e7131b8e` was pushed to `origin/main`; tag and public GitHub Release `v0.5.40` target that commit. GitHub asset sizes/digests match the local manifest. Cloudflare R2 `version.json` reports Grok `0.5.40`, and the public installer returns HTTP 200 with `Content-Length: 90893418`.
- **Signing:** Setup and portable EXE remain unsigned; bilingual release notes retain the SmartScreen and SHA-256 verification warning.

## 2026-08-24 — Project-only session header, syntax-colored preview and dedicated file explorer

- **Target version:** 0.5.40
- **Symptom:** The session header repeated project path/effort metadata instead of staying identifiable at a glance; file previews rendered all source text in one color; the short `Project files` list navigated by replacing itself, shared a narrow vertical stack with the preview, hid useful dot-folders, and reduced failures to an unhelpful `Cannot list directory` message.
- **Root cause:** Header state and session-title state both wrote to `convTitle`; the preview assigned raw content through a single `textContent`; directory browsing had no persistent tree model, lazy expansion, language metadata, or explicit loading/empty/error presentation.
- **Resolution:** Decoupled the header from chat titles so it always shows only the current project basename (full path remains a tooltip/state value); moved Git context into the explorer; split Files into a responsive Project Explorer column and independent code-preview column; added lazy expandable folders, selection, collapse/refresh controls, useful dot-folder visibility, language labels, empty/error/retry states, safe race handling, line numbers, and dependency-free syntax tokenization rendered with DOM `textContent` spans for common programming/config/markup languages.
- **Affected files:** `apps/desktop/renderer/app.js`, `apps/desktop/renderer/index.html`, `apps/desktop/renderer/lib/i18n.js`, `apps/desktop/renderer/lib/syntaxHighlight.js`, `apps/desktop/renderer/styles.css`, `apps/desktop/src/main.cjs`, `scripts/test-syntax-highlight.mjs`, `scripts/verify-project-explorer.mjs`, `package.json`.
- **Verification:** `npm run check` passed: architecture, packaging, brand/release contracts, build, 29 E2E checks, security, existing visual regressions, and the new Project Explorer gate. The new gate verifies project-only header content, lazy/empty/error tree behavior, per-file language labels, distinct Rust keyword/comment/number colors, line rendering and non-overlapping explorer/preview geometry in dark/light at 1181×700, 1440×900 and 1904×1000 plus 125%/150% scale. Release packaging and publication evidence is recorded in the 0.5.40 release entry below.

## 2026-08-24 — Desktop tabs preserve running tasks, cached content and per-tab runtime

- **Target version:** 0.5.40
- **Symptom:** Switching from a running Task A tab to Task B and back could make both appear stopped; inactive/non-running tabs reloaded slowly; tab names were not directly editable; elapsed processing feedback did not continue visibly on background tabs.
- **Root cause:** Session tabs were presentation snapshots over one active ACP process and one global renderer runtime. Activating a tab called `loadSession`, which replaced the process session, while `busy`, elapsed timing, queued prompts and incoming events were not owned by a tab.
- **Resolution:** Made tab activation cache-only; bind/resume an agent only on send; allocate the existing second AgentSupervisor slot when another tab is running; route/coalesce inactive-slot events and replay them on activation; keep runtime and prompt queues per tab; show a running dot plus live elapsed time; add direct double-click/right-click rename with persistence after a new session is created.
- **Affected files:** `apps/desktop/renderer/app.js`, `apps/desktop/renderer/lib/sessionTabs.js`, `apps/desktop/renderer/lib/i18n.js`, `apps/desktop/renderer/styles.css`, `scripts/e2e-desktop.mjs`, `scripts/verify-codex-session-ui.mjs`, `scripts/verify-session-tabs.mjs`, `package.json`.
- **Verification:** `npm run check` passed: architecture, packaging, brand/release contracts, build, 29 E2E checks, security and all visual gates. Regression checks prove tab activation contains no backend resume, a second slot does not stop a running primary client, inactive streams are cached/coalesced, queues are isolated, and direct rename/runtime rendering works. Visual evidence passed dark/light at 1000×640, dark 1440×900 and 125%/150% scale. A live authenticated two-prompt Grok run was not executed; the live smoke gate remained intentionally skipped.

## 2026-08-20 — Desktop slash menu covers Grok CLI commands including /hooks-trust

- **Target version:** 0.5.40
- **Symptom:** `/hooks-trust` (and most other Grok CLI slash commands) did not appear in the Desktop `/` menu, so a project-scoped MCP server such as Chrome DevTools could not be trusted from the composer.
- **Root cause:** Desktop shipped a short curated builtin list plus local skills. Folder trust lived only in the CLI TUI (`/hooks-trust` / `--trust`) and was omitted from the Desktop catalog and MCP panel.
- **Resolution:** Added the remaining Desktop-mappable CLI commands to the composer menu. UI actions open existing surfaces or write `%GROK_HOME%/trusted_folders.toml`; agent-side commands expand to prompts. MCP panel gained Trust/Revoke buttons and reconnects after trust so repo-local MCP can spawn. TUI-only render commands (`/vim-mode`, `/minimal`, `/fullscreen`, `/edit-prompt`) stay omitted.
- **Affected files:** `apps/desktop/renderer/lib/slashCommands.js`, `apps/desktop/renderer/app.js`, `apps/desktop/renderer/index.html`, `apps/desktop/renderer/lib/i18n.js`, `apps/desktop/renderer/lib/timelineView.js`, `apps/desktop/renderer/styles.css`, `apps/desktop/src/folderTrust.cjs`, `apps/desktop/src/main.cjs`, `apps/desktop/src/preload.cjs`, `apps/desktop/src/ipcContract.cjs`, `scripts/test-slash-commands.mjs`, `scripts/verify-slash-menu.mjs`, `scripts/e2e-desktop.mjs`, `README.md`, `README.en.md`, `.grok/skills/use-mcp/SKILL.md`
- **Verification:** `npm run check` passed (architecture, packaging, brand, release contract, slash unit tests, 28 E2E checks including `folderTrust store`, visual gates). Slash menu visual: 67 rows at 1000×640, scroll 218/2143, `/hooks-trust` present, `/work-a` filter + Tab insert still unique.

## 2026-08-20 — Finished 0.5.39 GitHub/R2 publication

- Target version: 0.5.39
- Symptom: Desktop 0.5.39 was packaged, committed, pushed and tagged, but Grok Clone R2 still served 0.5.38. Grok Build IDE 1.0.11 was packed and pushed with README download links, but had no GitHub tag/release and R2 still served 1.0.10.
- Root cause: Local packaging and `origin/main` finished first; GitHub release for IDE and Cloudflare R2 (`dl.truong.it/ai-clone/version.json`) were not run.
- Resolution: Uploaded `Grok-Build-Setup-0.5.39.exe` and `Grok-Build-IDE-Setup-1.0.11.exe` to R2 and created GitHub Release `v1.0.11` with Setup, portable EXE/ZIP, VSIX, MANIFEST and BASE-PROVENANCE. Desktop `v0.5.39` GitHub assets were already present and hash-matched.
- Affected files: R2 `ai-clone/version.json`; GitHub `nct88/Grok-Build-IDE` tag `v1.0.11`. No Desktop source change.
- Verification: R2 HEAD sizes match local Setup (90,875,681 and 201,730,096). Public `version.json` is grok 0.5.39 / grok-ide 1.0.11. GitHub IDE assets SHA-256 match `dist/1.0.11/MANIFEST.json`. Desktop GitHub Setup HEAD is 90,875,681.

## 2026-08-17 — Release 0.5.37: local Grok skill slash commands

- Target version: 0.5.37
- Change: Published workspace/profile `userInvocable` Grok skills in the Desktop slash menu with safe catalog filtering, explicit skill invocation, stable built-ins and responsive long-list behavior.
- Release pipeline fix: Replaced the release scripts' dependency on the intermittently unavailable `Get-FileHash` cmdlet with .NET SHA-256 generation; the incomplete first candidate was isolated under `temp/` and never published.
- Release gate: `npm run check`, packaged layout, packaged slash-menu visual verification and manifest hashes passed. Windows Setup and portable EXE remain unsigned and release notes retain the SmartScreen/SHA-256 warning.

## 2026-08-17 — Workspace/profile Grok skills in the Desktop slash menu

- Target version: next development candidate after 0.5.36
- Symptom: The Desktop composer exposed only six hard-coded slash shortcuts, so the five user-invocable process skills installed for MetaPage (`context-watch`, `keep-request-scope`, `quota-handover`, `work-analysis`, `write-fix-log`) never appeared even though Grok CLI 1.0.4 discovered them. A long or previously scrolled command list could also hide the active first row at high display scale.
- Root cause: `slashCommands.js` had no workspace/profile catalog source; the renderer could distinguish only prompt expansions and four UI actions. Menu rows also had no explicit overflow policy, the list retained stale `scrollTop`, and its fixed 220 px maximum ignored reduced CSS viewport height at 125–150% scale.
- Resolution: Added a safe main-process `grok inspect --json` catalog that keeps only `userInvocable` skills physically stored under the active workspace `.grok/skills` or current `%GROK_HOME%/skills`. Runtime skill shortcuts are merged after stable built-ins and expand to an explicit skill instruction. Added request race protection, fail-closed empty fallback, full-text tooltips, ellipsis, scroll reset, and viewport-aware menu height.
- Affected files: `apps/desktop/src/slashCatalog.cjs`, `apps/desktop/src/main.cjs`, `apps/desktop/src/preload.cjs`, `apps/desktop/src/ipcContract.cjs`, `apps/desktop/renderer/lib/slashCommands.js`, `apps/desktop/renderer/app.js`, `apps/desktop/renderer/styles.css`, `scripts/test-slash-commands.mjs`, `scripts/verify-slash-menu.mjs`, `package.json`.
- Verification: The real isolated MetaPage profile returned exactly the five expected skill IDs through Grok CLI 1.0.4. `npm run check` passed, including build, 26 E2E checks, security/architecture/packaging/release gates, local-catalog unit coverage, dark/light 1000×640 renders, dark 1440×900, filtered/no-match/unavailable states, long content, scrolling, keyboard insertion, and 125%/150% scale geometry.

## 2026-08-13 — Release 0.5.36: Grok CLI 1.0.3 session information

- Target version: 0.5.36
- Change: Added safe, detailed Session/Context/Account information with row copy and Copy all parity for Grok CLI 1.0.3.
- Release gate: Architecture, packaging, brand, security, 26 E2E checks and responsive visual interaction coverage must pass against the final source version before publication.
- Signing: Windows artifacts remain unsigned; release notes retain the SmartScreen and SHA-256 verification warning.

## 2026-08-12 — Project/session synchronization and session interactions

- Target version: 0.5.31 local installation candidate
- Symptom: Choosing a project below the composer could leave the active chat attached to the previous sidebar project; reopening a tab could resume it with the currently selected project instead of its own project. Chats could not be reassigned after a wrong selection. Vietnamese sessions still exposed generic `Tool`/`Review` labels, local paths with spaces or source-line suffixes were not navigable, and ordinary session content had no right-click copy menu.
- Root cause: The native folder picker updated renderer workspace state before the shared project transition, causing its same-path guard to skip the fresh-session transition. Session tabs stored only `sessionId`, not `cwd`. Persisted session relocation had no API. Dynamic timeline labels were not normalized/relocalized, Markdown path parsing excluded spaces, and context menus covered only media/path nodes.
- Resolution: Made the shared project transition the only renderer update path, persisted `cwd` per tab and realigned composer/sidebar before resume, added safe session relocation with `summary.json` synchronization, localized dynamic Tool/Review surfaces, expanded local-path hydration, opened directory links correctly, and added a localized session copy/select context menu.
- Affected files: `apps/desktop/renderer/app.js`, `apps/desktop/renderer/lib/sessionTabs.js`, `apps/desktop/renderer/lib/timelineView.js`, `apps/desktop/renderer/lib/i18n.js`, `apps/desktop/renderer/lib/markdown.js`, `apps/desktop/renderer/lib/workers/contentWorker.js`, `apps/desktop/renderer/lib/pathLinks.js`, `apps/desktop/src/main.cjs`, `apps/desktop/src/preload.cjs`, `packages/sessions/src/index.ts`.
- Verification: `npm run check` passed; 26 E2E checks passed; project-picker/tab/sidebar synchronization and cross-project session move passed in real Electron; dark/light/1000×640 session renders passed; Vietnamese Tool/Review, spaced path with `:line`, and session right-click copy passed in the visual runtime gate.

## 2026-08-12 — Windows packaging junction failure

- Target version: 0.5.31 local installation candidate
- Symptom: `electron-builder` stopped with an `UNKNOWN ... stat` error while traversing `node_modules/@grok-build/acp-client`, so no immutable release directory was created.
- Root cause: Desktop listed internal workspaces as production dependencies even though packaged runtime code is loaded from `extraResources`; npm represented those workspaces as Windows junctions and electron-builder attempted to collect them as application `node_modules`.
- Resolution: Classified the internal workspace links as build-time dependencies while retaining the compiled runtime bundles in `resources/packages` through the existing `extraResources` contract.

## 2026-08-12 — Individual chat drag-and-drop between projects

- Target version: 0.5.32 development candidate
- Symptom: Dragging a nested chat row moved/reordered the entire project group instead of moving that chat to another project. The separate Move menu worked, but it did not satisfy the requested direct drag-and-drop workflow.
- Root cause: `draggable` was attached to the whole `.project-block`, including its nested chat rows. Chat rows had no independent drag payload, and project drop handlers understood only project paths.
- Resolution: Restricted project reordering to the project header, made every chat row independently draggable with a typed session payload, and taught project targets to distinguish chat moves from project reordering. Added visible drop-target and drag-source states while keeping the Move menu as an accessible fallback.
- Affected files: `apps/desktop/renderer/app.js`, `apps/desktop/renderer/styles.css`, `apps/desktop/renderer/lib/i18n.js`, `scripts/test-project-session-sync-ui.mjs`.
- Verification: The Electron integration drags a real fixture chat from project Alpha to project Beta, asserts the source/target trees and persisted `summary.json`, confirms project ordering is unchanged, and captures light/dark target plus post-drop evidence.
