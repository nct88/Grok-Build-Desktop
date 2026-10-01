# 2026-09-30 — Cửa sổ ngữ cảnh 100%

- **Yêu cầu:** Kiểm tra “cửa sổ ngữ cảnh” là gì và vì sao chip luôn 100%.
- **Triệu chứng / trạng thái gặp:** Chip composer và tab Ngữ cảnh hiện `6,410,461 / 256,000 tokens (100%)` trong khi phiên chỉ đầy vài trăm nghìn token.
- **Nguyên nhân:** `%` lấy `usage.totalTokens` (token cộng dồn cả phiên, input+output) chia `models_cache.context_window` (256k). Thanh “Phiên hiện tại” đã đúng số cộng dồn; cửa sổ ngữ cảnh phải là occupancy hiện tại.
- **Cách xử lý:** Occupancy từ ACP `usage_update.used/size` hoặc `_meta.totalTokens`; size từ đó hoặc `context_window`. Token cộng dồn giữ ở “Phiên hiện tại”.
- **File đụng:** `Grok-Build-Desktop/apps/desktop/src/sessionContext.cjs`, `main.cjs`, `renderer/app.js`; `Grok-Build-IDE/.../sessionService.ts`, `sessionService.test.ts`, `media/main.js`.
- **Kiểm chứng:** vitest occupancy 224327/256000 ≈ 87.6%; e2e `sessionContext`; billed 6.4M không thành occupancy.
- **Đừng làm lại:** Không lấy `totalTokens` làm fill cửa sổ ngữ cảnh.
- **Còn mở:** App đang chạy vẫn bản cũ; chưa đóng gói.
