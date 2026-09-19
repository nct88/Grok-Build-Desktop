# Báo cáo chi tiết xử lý sự cố: Mất tiêu đề và nội dung tin nhắn người dùng gửi (v0.5.62)

- **Ngày thực hiện:** 2026-09-19
- **Phiên bản mục tiêu:** 0.5.62
- **Tác giả:** Grok Build Desktop Agent

---

## 1. Tóm tắt sự cố (Incident Overview)

Người dùng gửi phản hồi kèm ảnh chụp màn hình thực tế:
1. **Mất nội dung người dùng gửi:** Trong phiên trò chuyện đã có sẵn (hoặc khi mở lại phiên từ sidebar), sau khi người dùng nhập câu lệnh và nhấn gửi (ở lượt trao đổi về `lock-horizontal-rail` và chuột cuộn Top 10), toàn bộ bong bóng tin nhắn của người dùng (`.msg.user`) biến mất khỏi dòng thời gian (timeline). Ngay bên dưới câu trả lời của lượt trước ("Plan ... Không nên deploy CMS này..."), lập tức xuất hiện khối suy nghĩ (`◆ Đã suy nghĩ 12s`) và câu trả lời của AI (`Chuột nằm trong hàng Top 10 đang bị khóa cuộn dọc...`), không hề có nội dung người dùng đã gửi ở giữa.
2. **Mất tiêu đề cuộc trò chuyện / câu hỏi gửi:** Thanh tiêu đề phía trên (`#convTitle`) chỉ hiển thị tên thư mục dự án đơn thuần (`📁 xemph.im`), hoàn toàn không hiển thị tiêu đề tóm tắt của phiên hay tiêu đề nội dung người dùng gửi (`xemph.im · <Tiêu đề>`).

---

## 2. Phân tích nguyên nhân gốc rễ (Root Cause Analysis)

### 2.1. Tranh chấp tiến trình (Race Condition) xóa sạch tin nhắn người dùng khi gửi ở phiên Resume:
- Khi người dùng chọn một phiên từ sidebar, phiên được nạp ở trạng thái chờ (`deferLoad: true`, chưa khởi chạy process slot).
- Khi người dùng gõ tin nhắn mới và nhấn `send()`:
  - `send()` gọi `await ensureActiveTabAgent()`.
  - Trong `ensureActiveTabAgent()`, hệ thống gọi `await api.loadSession(sessionId)` để kết nối slot với phiên này.
  - Backend ACP phát ra sự kiện IPC `{ type: "session", sessionId, resumed: true }`.
  - Tại `apps/desktop/renderer/app.js` (dòng 6737 cũ):
    ```javascript
    case "session":
      ...
      if (event.resumed) {
        if (activeSessionId) void paintTranscript(activeSessionId).then(() => unlockChatInput());
      }
    ```
    Hàm `void paintTranscript(...)` được gọi **bất đồng bộ không `await` (fire-and-forget)**.
  - Trong khi đó, `send()` chạy tiếp đến dòng 7357 và thực thi ngay lập tức:
    ```javascript
    eventStore.append("user", displayText || text, { attachments });
    ```
    Tin nhắn người dùng vừa được đưa vào bộ nhớ `eventStore`.
  - Vài mili-giây sau, lệnh `paintTranscript` đọc xong file `chat_history.jsonl` cũ từ ổ đĩa (lúc này backend Grok CLI chưa kịp lưu câu hỏi mới xuống đĩa) và gọi:
    ```javascript
    eventStore.loadTurns(turns || []);
    ```
  - Trong `eventStore.js`:
    ```javascript
    loadTurns(turns) {
      items.length = 0; // <--- XÓA TOÀN BỘ STORE!
    ```
    Lệnh `items.length = 0` đã **xóa sổ vĩnh viễn** tin nhắn của người dùng vừa được append!
  - Sau đó, mô hình AI bắt đầu stream deltas (`pushDelta("thought")`, `pushDelta("assistant")`) và được append vào store sau các tin nhắn cũ từ ổ đĩa.
  - **Hậu quả:** Tin nhắn người dùng bị mất sạch, AI trả lời đè ngay sau lượt trả lời trước đó!

### 2.2. Tiêu đề cuộc trò chuyện bị triệt tiêu (`void explicit;`):
- Trong `apps/desktop/renderer/app.js` (dòng 936 cũ):
  ```javascript
  function syncConvTitle(explicit) {
    if (!convTitle) return;
    void explicit; // <--- CỐ TÌNH BỎ QUA THAM SỐ TIÊU ĐỀ ĐƯỢC TRUYỀN VÀO!
    const projectName = workspaceRoot ? basen(workspaceRoot) : tt("noProject", "No project");
    convTitle.textContent = projectName;
    convTitle.title = workspaceRoot || projectName;
  }
  ```
- Dù ở khắp mọi nơi (`selectSession`, `send()`, `agent:session`, `tabs`) đều truyền tiêu đề phiên hoặc câu hỏi của người dùng vào `syncConvTitle(title)`, hàm này cố tình bỏ qua và luôn gán cứng `#convTitle` bằng tên thư mục dự án (`xemph.im`).
- Thêm vào đó, khi người dùng gửi câu hỏi đầu tiên hoặc câu hỏi mới trong tab, dòng cập nhật tiêu đề tab không gọi lại `syncConvTitle`.

### 2.3. Parser lịch sử `readSessionTranscript` lọc sót dữ liệu scaffold:
- Trong `packages/sessions/src/index.ts`: các dòng hệ thống dạng `<user_info>` bị nhận diện nhầm thành tin nhắn người dùng vì có `type="user"` nhưng không có bộ lọc loại trừ nếu không chứa thẻ `<user_query>`.

---

## 3. Giải pháp kỹ thuật đã triển khai (Implemented Solutions)

1. **Khử bỏ Race Condition trong `app.js`**:
   - Trong nhánh `case "session":`, chỉ cho phép gọi `paintTranscript` khi `eventStore.length === 0 && !busy`:
     ```javascript
     if (event.resumed) {
       if (activeSessionId && eventStore.length === 0 && !busy) {
         void paintTranscript(activeSessionId).then(() => unlockChatInput());
       }
     }
     ```
   - Ngăn chặn hoàn toàn việc gọi lại đĩa đọc lịch sử cũ đè lên dữ liệu đang active.

2. **Nâng cấp tầng bảo vệ trong `eventStore.js`**:
   - Cập nhật `loadTurns(turns)` để quét phần đuôi của store (`pendingTail`):
     ```javascript
     const turnList = Array.isArray(turns) ? turns : [];
     const pendingTail = [];
     for (let i = items.length - 1; i >= 0; i--) {
       const it = items[i];
       if (
         it.streaming ||
         (it.kind === "user" &&
           !turnList.some((t) => t.role === "user" && String(t.text || "").trim() === String(it.text || "").trim()))
       ) {
         pendingTail.unshift(it);
       } else {
         break;
       }
     }
     ```
   - Sau khi load các turns từ đĩa, nối lại `pendingTail` vào cuối danh sách. Đảm bảo tin nhắn của người dùng không bao giờ bị xóa mất dù có gọi `loadTurns`.

3. **Khôi phục hiển thị Tiêu đề Hội thoại (`#convTitle`)**:
   - Trong `syncConvTitle(explicit)`:
     ```javascript
     function syncConvTitle(explicit) {
       if (!convTitle) return;
       const projectName = workspaceRoot ? basen(workspaceRoot) : tt("noProject", "No project");
       const activeTab = sessionTabs?.getActive?.();
       const rawTitle = (explicit != null ? String(explicit) : (activeTab?.title || "")).trim();
       const isGeneric =
         !rawTitle ||
         /^(?:chat|new\s+chat|new\s+conversation|conversation|resumed|resumed\s+chat|untitled\s+chat)$/i.test(rawTitle);
       if (!isGeneric && rawTitle !== projectName) {
         convTitle.textContent = projectName ? `${projectName} · ${rawTitle}` : rawTitle;
         convTitle.title = `${workspaceRoot ? workspaceRoot + "\n" : ""}${rawTitle}`;
       } else {
         convTitle.textContent = projectName;
         convTitle.title = workspaceRoot || projectName;
       }
     }
     ```
   - Gọi `syncConvTitle(newTitle)` ngay trong `send()` khi tạo tiêu đề từ dòng prompt đầu tiên.
   - Truyền `s.title` vào `syncConvTitle(s.title)` trong `selectSession(s)` và khi đổi tab (`onActivate`).

4. **Lọc sạch thẻ scaffolding trong `packages/sessions/src/index.ts`**:
   - Bỏ qua các dòng có `role === "user"` chứa `<user_info>`, `<system-reminder>`, hoặc `<git_status>` nếu không chứa thẻ `<user_query>`.

5. **Bảo vệ attachments của người dùng trong `timelineView.js`**:
   - Cập nhật hàm xử lý update node để bảo toàn cấu trúc `.media-strip` và chips khi cập nhật tin nhắn người dùng.

---

## 4. Kiểm chứng và Nghiệm thu (Verification & Acceptance)

1. **Kiểm thử tự động chuyên biệt:**
   - Tạo file `scripts/test-user-prompt-persistence.mjs`:
     - Test 1: Kiểm thử hợp đồng mã nguồn trong `app.js` và `timelineView.js`.
     - Test 2: Kiểm thử tính năng `eventStore.loadTurns()` không xóa mất tin nhắn user đang chờ (`pendingTail`).
     - Test 3: Kiểm thử chức năng lọc scaffold của `readSessionTranscript`.
   - Kết quả: **100% Passed**.

2. **Kiểm thử toàn bộ hệ thống (`npm test`):**
   - Chạy thành công toàn bộ 32 suites kiểm thử, xác nhận không có lỗi hồi quy.

3. **Kiểm tra phát hành:**
   - `npm run check:arch` -> Passed
   - `npm run check:packaging` -> Passed
   - `npm run check:brand` -> Passed
   - `npm run check:release` -> Passed (`Release contract OK (0.5.62)`)
