# Fix-log index

Đọc 3 dòng trên trước khi sửa vùng liên quan.

1. **Yêu cầu gốc** — Cửa sổ ngữ cảnh hiện occupancy thật, không kẹp 100% vì token cộng dồn.
2. **Ràng buộc** — chip/popover session info hiện có; không Window mới, không ẩn WebView, không `taskkill`.
3. **Sửa nhỏ nhất** — đổi công thức used/size/percent tại session info.

| Ngày | File | Việc | Trạng thái |
|---|---|---|---|
| 2026-09-30 | [2026-09-30-package-0.5.65.md](2026-09-30-package-0.5.65.md) | Local 0.5.65: 4.7 + occupancy | setup sẵn; chờ user đóng app cài |
| 2026-09-30 | [2026-09-30-context-window-100.md](2026-09-30-context-window-100.md) | Chip ngữ cảnh: occupancy, không billed tokens | xong mã; đã đóng gói 0.5.65 |
| 2026-09-30 | [2026-09-30-cli-1.0.44-model-4.7.md](2026-09-30-cli-1.0.44-model-4.7.md) | CLI 1.0.44: chip/menu chọn grok-4.7 | xong mã; chưa đóng gói |
