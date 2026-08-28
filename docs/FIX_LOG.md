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
