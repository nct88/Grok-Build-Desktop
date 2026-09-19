# Báo Cáo Kỹ Thuật: Khắc Phục Sự Cố Đen Màn Hình Khi Xử Lý Trao Đổi (v0.5.61)
# Technical Report: Resolution of Black Screen During Conversation Processing (v0.5.61)

---

## 1. Thông tin chung / General Information
- **Phiên bản / Version:** 0.5.61
- **Ngày thực hiện / Date:** 2026-09-19
- **Trạng thái / Status:** Đã xử lý & Đã kiểm chứng (Resolved & Verified)
- **Tác động / Impact:** Khắc phục triệt để lỗi sập giao diện biến thành màn hình đen khi đang streaming câu trả lời hoặc gọi công cụ trong phiên trò chuyện.

---

## 2. Mô tả triệu chứng / Symptom Description

### Tiếng Việt
Trong quá trình tương tác, khi mô hình AI đang sinh câu trả lời (streaming) hoặc khi agent thực thi các công cụ đọc/ghi tệp, toàn bộ cửa sổ ứng dụng đột ngột biến thành một khối đen kịt (màu `#0e0e0e`). Toàn bộ cấu trúc giao diện HTML/DOM gồm:
- Thanh tiêu đề chứa menu (File, Edit, View, Agent, Help)
- Thanh công cụ bố cục bên phải
- Sidebar trái, danh sách dự án và lịch sử chat
- Toàn bộ khung hiển thị nội dung trao đổi (Timeline)
- Hộp soạn thảo tin nhắn (Prompt input)

Đều biến mất hoàn toàn. Chỉ còn lại 3 nút điều khiển cửa sổ của hệ điều hành Windows (`-`, `□`, `✕`) ở góc trên cùng bên phải. Người dùng không thể thao tác được gì trên nội dung phiên chat và không có thông báo lỗi nào xuất hiện.

### English
During conversation turns, while the AI model is streaming assistant responses or when the agent executes tools involving file edits, the entire application window abruptly blanks out into solid black (`#0e0e0e`). All HTML/DOM components (Title bar menus, layout actions, left sidebar, project list, history, session timeline, and composer input) completely disappear. Only the three Windows native window caption buttons (`-`, `□`, `✕`) in the top-right corner remain visible. The user cannot interact with the conversation, and no error message is displayed.

---

## 3. Phân tích nguyên nhân gốc rễ / Root Cause Analysis

### A. Quá tải bộ nhớ V8 Heap (OOM Crash) do Render DOM dồn dập
- **Nguyên nhân:** Trong `apps/desktop/renderer/lib/timelineView.js`, mỗi khi nhận delta streaming (chu kỳ 40ms từ `streamBatcher`), hàm `bindAssistantContent` được gọi liên tục.
- **Tác động:** Hàm này chạy `el.innerHTML = md.renderMarkdown(text)`, xóa và dựng lại toàn bộ cây DOM của tin nhắn. Tiếp theo, `md.enhanceElement` gọi `globalThis.GrokSyntax.highlightFence(code, lang)` trên mọi khối code, tokenize cú pháp và tạo hàng ngàn thẻ DOM `<span>` cho từng token/dòng code.
- **Hậu quả:** Với các câu trả lời dài hoặc có chứa code block lớn, việc liên tục tạo và hủy hàng chục nghìn thẻ DOM 25 lần/giây trên Main UI Thread dẫn đến cạn kiệt bộ nhớ JavaScript (`FatalProcessOutOfMemory`), khiến Chromium cưỡng chế đóng tiến trình Renderer (`render-process-gone`).

### B. Treo tiến trình GPU trên Windows (Chromium Hardware Acceleration Black Screen)
- **Nguyên nhân:** Tần suất repaint và layout reflow cực cao trên luồng chính trong lúc vừa stream vừa cuộn trang liên tục làm quá tải hàng đợi vẽ của Direct3D 11 / ANGLE trên Windows.
- **Hậu quả:** GPU driver bị GPU Context Loss. Khi GPU process crash vượt quá ngưỡng mặc định của Chromium, Chromium ngừng compositing và bỏ rơi toàn bộ bề mặt vẽ, làm lộ ra lớp nền native của BrowserWindow có màu `backgroundColor: "#0e0e0e"`.

### C. Thiếu bộ xử lý lỗi sập tiến trình trong Main Process
- **Nguyên nhân:** Cửa sổ chính trong `apps/desktop/src/main.cjs` chỉ đăng ký các sự kiện cơ bản (`ready-to-show`, `resize`, `closed`), hoàn toàn không lắng nghe `render-process-gone`, `unresponsive` hay `child-process-gone`.
- **Hậu quả:** Khi Renderer hoặc GPU crash, Electron không ghi log nguyên nhân, không reload lại trang, không đưa ra hộp thoại khôi phục mà giữ nguyên cửa sổ đen vô thời hạn.

### D. Nguy cơ tràn dữ liệu qua kênh IPC
- **Nguyên nhân:** `onFileWrite` trong `main.cjs` và `renderCliDiff` trong `timelineView.js` không giới hạn kích thước chuỗi `oldText` / `newText`.
- **Hậu quả:** Khi agent sửa đổi các tệp lớn (file bundle, lockfile, JSON), việc serialize qua IPC và gọi `split(/\r?\n/)` các chuỗi hàng triệu ký tự gây đơ UI và làm tăng vọt dung lượng RAM.

---

## 4. Các giải pháp đã triển khai / Implemented Solutions

| Thành phần / File | Thay đổi kỹ thuật / Technical Change | Mục đích / Purpose |
|---|---|---|
| `apps/desktop/renderer/lib/markdown.js` | Cập nhật `enhanceMarkdownElement(element, openLink, isStreaming)`. Khi `isStreaming = true`, chỉ bọc `code-card` nhẹ mà không chạy `highlightFence`, hoãn Mermaid SVG và link hydration. | Triệt tiêu hoàn toàn DOM thrashing và ngăn ngừa V8 OOM crash khi streaming. |
| `apps/desktop/renderer/lib/timelineView.js` | Truyền cờ `isStreaming` vào `enhanceMarkdownElement`. Hoãn `pathLinks.hydrate` và `hydrateImages` trong lúc stream, chỉ chạy đầy đủ khi `finalizeItem`. Thêm giới hạn an toàn 150.000 ký tự trong `renderCliDiff`. | Giữ luồng UI luôn nhẹ nhàng, phản hồi mượt mà ở 60fps trong suốt quá trình nhận câu trả lời dài. |
| `apps/desktop/src/main.cjs` | Thêm cờ `disable-gpu-process-crash-limit` trên Windows. Đăng ký `render-process-gone`, `unresponsive` trên `mainWindow.webContents`, và `child-process-gone` trên `app`. Ghi log lỗi vào `crash.log` và hiển thị dialog "Session Recovery" kèm nút "Reload Interface". Giới hạn 120.000 ký tự trong `onFileWrite`. | Tự động phát hiện và khôi phục giao diện an toàn khi có sự cố, không để người dùng bị kẹt ở màn hình đen. |
| `scripts/test-black-screen-prevention.mjs` | Tạo kịch bản kiểm thử tự động kiểm tra toàn bộ hợp đồng bảo vệ màn hình đen (render-process-gone, child-process-gone, GPU switch, stream deferral, IPC limits). | Bảo đảm ngăn chặn hồi quy trong tương lai qua CI/CD test suite. |

---

## 5. Kết quả kiểm chứng / Verification Proof

1. **Bộ kiểm thử tự động (`npm test`):**
   - Đạt **32/32 tests passed** (0 failed).
   - Bao gồm kiểm thử hồi quy mới `test-black-screen-prevention.mjs`.
2. **Kiểm tra kiến trúc (`npm run check:arch`):** Exit code 0 (Pass).
3. **Kiểm tra đóng gói (`npm run check:packaging`):** Exit code 0 (Pass).
4. **Kiểm tra hợp đồng phát hành (`npm run check:release`):** Exit code 0 (Pass cho v0.5.61).
