# Fix log

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
