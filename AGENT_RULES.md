# QUY TRÌNH RÀ SOÁT VÀ NGUYÊN TẮC VẬN HÀNH DÀNH CHO AGENT GEMINI (AGENT OPERATIONAL SOP & GUIDELINES)

> **TÀI LIỆU QUY CHUẨN BẮT BUỘC DÀNH CHO TẤT CẢ CÁC AGENT GEMINI / AI CODING ASSISTANTS.**
> Mọi agent khi nhận nhiệm vụ trên codebase này **BẮT BUỘC ĐỌC VÀ TUÂN THỦ 100%** các bước trong quy trình dưới đây. Tuyệt đối không được bỏ qua bất kỳ bước kiểm tra nào.

---

## 1. NGUYÊN TẮC TỐI THƯỢNG (CORE MANDATES)

1. **CHÚ TÂM & CẨN TRỌNG TỐI ĐA**:
   - Nghiêm cấm việc sửa code vội vàng, cẩu thả, đoán mò hoặc sửa "mù" (chưa xem kỹ ngữ cảnh xung quanh).
   - Tuyệt đối không để xảy ra các lỗi sơ đẳng: biến chưa khai báo (`ReferenceError`), gọi sai phương thức (`TypeError`), thiếu import, hoặc vô tình xóa mất biến khởi tạo/logic sẵn có.
2. **KIỂM TRA 3 LỚP TRƯỚC KHI BÁO HOÀN TẤT**:
   - Mọi chỉnh sửa mã nguồn đều phải vượt qua:
     - **Lớp 1: Cú pháp & Scope** (Syntax / Static Scope / Module Load check).
     - **Lớp 2: Bộ kiểm thử tự động** (Unit Test / E2E test suite: `npm test` hoặc `npm run check`).
     - **Lớp 3: Build & Package Verification** (Đóng gói không lỗi, hash nhất quán).
3. **MINH BẠCH & GHI LOG ĐẦY ĐỦ**:
   - Mọi tác vụ sửa lỗi/nâng cấp sau khi hoàn thành đều phải được ghi lại chi tiết vào [`fix-bug/FIX_LOG.md`](fix-bug/FIX_LOG.md) theo mẫu quy định.

---

## 2. QUY TRÌNH 5 BƯỚC XỬ LÝ NHIỆM VỤ (5-STEP SOP)

```
[BƯỚC 1: ĐIỀU TRA & ĐỊNH VỊ] ──> [BƯỚC 2: SỬA ĐỔI AN TOÀN] ──> [BƯỚC 3: KIỂM TRA ĐA TẦNG]
                                                                        │
[BƯỚC 5: ĐÓNG GÓI & PHÁT HÀNH] <── [BƯỚC 4: CẬP NHẬT FIX_LOG] <────────┘
```

### Bước 1: Điều tra & Định vị chính xác (Analyze & Trace)
- Đọc kỹ yêu cầu người dùng, ảnh chụp lỗi, log lỗi hoặc stack trace.
- Dùng `grep_search` / `find_by_name` để định vị chính xác file và hàm liên quan.
- **Bắt buộc đọc ít nhất 30-50 dòng code trước và sau vùng cần sửa** bằng `view_file` để hiểu rõ toàn bộ biến, hàm, tham số và scope của block code.

### Bước 2: Sửa đổi an toàn (Safe Code Editing)
- Khi dùng công cụ sửa file (`replace_file_content` hoặc `write_to_file`):
  - **Giữ toàn vẹn các biến phụ thuộc**: Đảm bảo tất cả các biến được sử dụng trong block thay thế (ví dụ: `sup`, `getClient()`, `slot`, `options`, `ipcMain`, v.v.) đều đã được khởi tạo/import hợp lệ trong cùng scope.
  - **Không xóa nhầm code lân cận**: Kiểm tra kỹ StartLine và EndLine để không cắt xén các dòng code khác.
  - **Chuẩn hóa đường dẫn hệ điều hành**: Trên Windows, luôn chú ý chuẩn hóa đường dẫn (`path.resolve`, `path.normalize`, xử lý ký tự ổ đĩa không phân biệt hoa/thường `c:` vs `C:`).

### Bước 3: Kiểm tra đa tầng (Multi-Layer Verification)
Sau khi chỉnh sửa code, **BẮT BUỘC** thực hiện lần lượt các bước kiểm tra sau:
1. **Kiểm tra cú pháp & module loading**:
   ```bash
   node -e "['apps/desktop/src/main.cjs', ...].forEach(f => ...)" # hoặc npm run build
   ```
2. **Chạy toàn bộ bài test tự động**:
   ```bash
   npm test
   # hoặc
   npm run check
   ```
3. **Xác minh lỗi người dùng báo đã được giải quyết triệt để**:
   - Nếu là lỗi tool call / permission: kiểm tra toàn bộ luồng IPC từ renderer -> preload -> main -> supervisor -> ACP client.
   - Nếu là lỗi crash / memory leak / thread dispatcher: kiểm tra luồng async, try/catch và dispatchers.

### Bước 4: Cập nhật `fix-bug/FIX_LOG.md` (Mandatory Fix Log)
Ghi nhận tác vụ vào file [`fix-bug/FIX_LOG.md`](fix-bug/FIX_LOG.md) với định dạng chuẩn:
- **Ngày tháng & Phiên bản**.
- **Yêu cầu gốc của người dùng / Triệu chứng lỗi (Symptom)**.
- **Nguyên nhân gốc rễ (Root Cause Analysis)**.
- **Danh sách file bị tác động & Chi tiết dòng sửa (Affected Files & Line Numbers)**.
- **Giải pháp & Nội dung code đã sửa (Resolution & Code Changes)**.
- **Kết quả kiểm thử & Bằng chứng kiểm tra (Verification Proof)**.
- **Bài học rút ra (Lessons Learned)**.

### Bước 5: Đóng gói & Phát hành chuẩn mực (Package & Release)
- Đảm bảo đồng bộ phiên bản (version consistency) trên toàn bộ dự án:
  - `product/VERSION`
  - `package.json` (root)
  - `package-lock.json` (chạy `npm i --package-lock-only`)
  - `apps/desktop/package.json`
  - `CHANGELOG.md`
  - `docs/releases/<VERSION>.md`
  - `README.md` & `README.en.md`
- Chạy script đóng gói:
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-release.ps1 -Version <VERSION>
  ```
- Commit, push git và phát hành GitHub / Cloudflare R2 theo yêu cầu.

---

## 3. TỔNG HỢP CÁC BÀI HỌC VÀ LỖI CẦN TRÁNH (ANTI-PATTERNS & LESSONS LEARNED)

Dưới đây là danh sách tổng hợp các lỗi nghiêm trọng đã từng xảy ra do các agent xử lý thiếu cẩn thận. **MỌI AGENT PHẢI ĐỌC KỸ ĐỂ KHÔNG BAO GIỜ LẶP LẠI:**

| STT | Lỗi từng xảy ra | Nguyên nhân gốc rễ | Bài học & Cách phòng chống |
|:---:|---|---|---|
| **1** | `ReferenceError: sup is not defined` (v0.5.47) | Khi sửa hàm `connectAgentHost`, agent vô tình thay thế luôn dòng `const sup = getSupervisor();` khiến lời gọi `sup.createPermissionHandler` bên dưới bị crash. | **Luôn rà soát toàn bộ định danh biến** trong block code sau khi replace. Tuyệt đối không xóa biến khởi tạo của hàm. |
| **2** | Bấm Full Access nhưng Tool call không chạy, chỉ trả lời text | Giao diện (`app.js`) cập nhật state chip nhưng **không gửi lệnh IPC `setPermissionMode`** xuống `AgentSupervisor`. Supervisor ở backend vẫn giữ quyền `plan`/`default`. | Khi thêm/sửa tính năng ở UI, phải trace hết toàn bộ luồng dữ liệu xuống Main process / Backend. |
| **3** | Lỗi `Path outside workspace` khi sửa code | `nodeFsHost.ts` đặt `allowOutside: false` và so sánh đường dẫn phân biệt chữ hoa/thường trên Windows (`C:\` vs `c:\`). | Luôn chuẩn hóa đường dẫn `toLowerCase()` trên Windows và mở `allowOutside: true` khi người dùng ở chế độ Full Access hoặc No Project. |
| **4** | Agent kẹt ở Plan mode không chịu sửa file | Khi session ở `plan` mode, system prompt cấm agent gọi tool. | Tự động chuyển mode từ `plan` sang `build` khi người dùng cấp quyền Full Access hoặc Auto edits. |
| **5** | Crash khi xóa Profile trong Grok Clone | Xóa phần tử trong `ObservableCollection` từ background thread hoặc không defer Dispatcher, làm đơ UI thread. | Trong C#/WPF, mọi thao tác sửa đổi UI collection đều phải đưa về UI Dispatcher và giải phóng tài nguyên bất đồng bộ an toàn. |
| **6** | Lỗi mất Icon / Chuyển về icon Electron mặc định | Script đóng gói không stamp lại icon vào file PE hoặc thiếu multi-path resolution cho `rcedit`. | Bắt buộc chạy script kiểm tra brand assets (`check-brand-assets.ps1`) và verify icon PE bằng `check-packaging.mjs`. |
| **7** | Lỗi Version mismatch giữa `package.json` và `package-lock.json` | Agent sửa version trong `package.json` nhưng không chạy `npm i --package-lock-only`, làm fail script release. | Luôn chạy `npm i --package-lock-only` ngay sau khi bump version trong `package.json`. |
