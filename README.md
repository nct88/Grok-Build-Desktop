# Grok Build Desktop

<p align="center">
  <a href="./README.en.md">🇬🇧 English</a> | <strong>🇻🇳 Tiếng Việt</strong>
</p>

Grok Build Desktop là ứng dụng **agent desktop** chạy trên Electron, sử dụng **Grok CLI chính thức** qua giao thức ACP (`grok agent stdio`). Ứng dụng tập trung vào trải nghiệm trò chuyện, quản lý phiên, duyệt thay đổi mã nguồn, terminal và điều phối công việc; vòng lặp agent, công cụ, xác thực và phiên làm việc vẫn do Grok CLI quản lý.

> **CLI là lõi · Desktop là giao diện.** Grok Build Desktop không phải Grok Build IDE, không phải bản đổi giao diện của VS Code, và không triển khai một agent runtime thứ hai.

Phiên bản source hiện tại: **0.5.43** — xem [`product/VERSION`](product/VERSION).

## Tải xuống

Release được phát hành công khai tại GitHub Releases:

| Gói | Mục đích | Tải xuống |
|---|---|---|
| NSIS Setup | Cài vào Windows, tạo Start Menu/shortcut | [Grok-Build-Setup-0.5.43.exe](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.43/Grok-Build-Setup-0.5.43.exe) |
| Portable EXE | Chạy dạng file tự giải nén | [Grok-Build-0.5.43-win32-x64-portable.exe](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.43/Grok-Build-0.5.43-win32-x64-portable.exe) |
| Portable ZIP | Giải nén một lần, phù hợp dùng lâu dài | [Grok-Build-0.5.43-win32-x64.zip](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.43/Grok-Build-0.5.43-win32-x64.zip) |
| Manifest | Kích thước và SHA-256 của artifact | [MANIFEST.json](https://github.com/nct88/Grok-Build-Desktop/releases/download/v0.5.43/MANIFEST.json) |

Trang phát hành: [Grok Build Desktop v0.5.43](https://github.com/nct88/Grok-Build-Desktop/releases/tag/v0.5.43).

Các file Windows hiện chưa được ký Authenticode. SmartScreen có thể cảnh báo trong lần chạy đầu; hãy kiểm tra SHA-256 trong `MANIFEST.json` trước khi mở file.

## Grok Build Desktop và Grok Build IDE

| Trường | Grok Build Desktop (repo này) | Grok Build IDE |
|---|---|---|
| Tên sản phẩm | **Grok Build Desktop** | **Grok Build IDE** |
| GitHub | [`nct88/Grok-Build-Desktop`](https://github.com/nct88/Grok-Build-Desktop) | [`nct88/Grok-Build-IDE`](https://github.com/nct88/Grok-Build-IDE) |
| Nền tảng | Electron, **không** dùng Code-OSS | Code-OSS + Grok Build Workbench |
| Tên Windows / Start Menu | Grok Build (`Grok Build.exe`) | Grok Build IDE (`Grok Build IDE.exe`) |
| Vai trò | Giao diện agent, phiên, review, terminal | Editor, Explorer, SCM, debug và agent |
| Engine bắt buộc | **Grok CLI** (`grok` trên `PATH`, `~/.grok/bin/grok.exe` hoặc `GROK_EXECUTABLE`) | cùng Grok CLI |

```text
Grok Build Desktop (Electron)
    → AgentSupervisor (Electron main process)
        → packages/acp-client (GrokClient)
            → grok agent stdio
                → ~/.grok (xác thực, phiên, cấu hình CLI)
```

## Tính năng chính

### Trò chuyện và agent

- Hiển thị nội dung trả lời theo luồng, Markdown, thinking, plan và trạng thái công cụ.
- Gom các lời gọi công cụ thành nhóm; câu trả lời cuối được hiển thị phía dưới hoạt động công cụ.
- Chọn model, reasoning effort, mode và chính sách quyền ngay tại composer.
- Lệnh `/` của Grok CLI chạy trong composer, gồm session (`/new`, `/resume`, `/fork`, `/quit`, `/home`), model (`/model`, `/effort`, `/plan`), MCP/trust (`/mcps`, `/hooks-trust`), memory/workflow (`/remember`, `/loop`, `/goal`) và Settings (`/settings`, `/theme`, `/privacy`).
- Resume hiện recap và tóm tắt lượt gần nhất; ACP gửi reasoning effort khi mở hoặc tải phiên (CLI 1.0.5).
- Hỗ trợ hủy lượt chạy và xếp hàng prompt tiếp theo khi agent đang bận.
- `AgentSupervisor` giữ kết nối ấm, tự kết nối lại và hỗ trợ tối đa hai slot tương tác.

### Dự án, phiên và lịch sử

- Projects chỉ chứa thư mục thật; cuộc trò chuyện được lồng dưới từng dự án.
- Khu vực Recents dành riêng cho cuộc trò chuyện không gắn dự án.
- Có thể trò chuyện không cần chọn project; agent dùng thư mục `~/.grok/desktop-recents`.
- Mở lại phiên, phát lại lịch sử, đổi phiên, xuất Markdown hoặc xóa phiên cục bộ.
- Hỗ trợ nhiều tab phiên và chuyển slot agent.

### Tệp, review và terminal

- Đính kèm tệp, kéo-thả, dán ảnh và chèn tham chiếu `@file`.
- Theo dõi các tệp agent đã chỉnh sửa trong panel Files/Review.
- Xem diff và chấp nhận/từ chối toàn bộ thay đổi hoặc từng hunk.
- Terminal tương tác trong workspace và reverse terminal qua ACP khi runtime hỗ trợ.
- Thanh trạng thái Git, thông tin thay đổi và lối tắt tạo Pull Request.

### Manager và hệ sinh thái CLI

- Chạy job headless qua `grok -p`, theo dõi trạng thái và artifact.
- Giao diện quản lý worktree, MCP server và plugin theo các cờ của Grok CLI.
- Các lối tắt cho `doctor`, đăng nhập/đăng xuất, phiên bản CLI và danh sách cấu hình.
- Hiển thị usage/plan dựa trên cùng nguồn dữ liệu mà Grok CLI sử dụng.

### Media và trải nghiệm desktop

- `/imagine` tạo ảnh và hiển thị preview từ thư mục media của phiên.
- `/imagine-video` có bước kiểm tra quyền riêng tư trước khi gửi yêu cầu.
- Lightbox ảnh, mở thư mục, sao chép và phát video qua blob URL.
- Giao diện tiếng Anh/tiếng Việt, theme sáng/tối/theo hệ thống.
- Nút **Open IDE** mở Grok Build IDE và truyền workspace hiện tại.
- Có menu ứng dụng, phím tắt, About và kiểm tra update feed.

## Yêu cầu hệ thống

### Người dùng

- Windows x64.
- Grok CLI đã được cài đặt.
- Tài khoản đã xác thực bằng `grok login` hoặc cơ chế tương đương của CLI.

Thứ tự tìm Grok CLI:

1. Biến môi trường `GROK_EXECUTABLE`.
2. Lệnh `grok` trên `PATH`.
3. `%USERPROFILE%\.grok\bin\grok.exe`.

### Phát triển

- Node.js 20 trở lên.
- npm hỗ trợ workspaces.
- Windows cần thiết khi tạo NSIS/portable executable.

## Cài đặt và sử dụng nhanh

### Cách 1: NSIS Setup

1. Tải `Grok-Build-Setup-0.5.43.exe` từ release.
2. Kiểm tra checksum trong `MANIFEST.json`.
3. Chạy installer và mở **Grok Build** từ Start Menu.
4. Chọn project hoặc bắt đầu một cuộc trò chuyện không có project.
5. Nhấn **Connect** để khởi tạo `grok agent stdio`.

Đường dẫn cài mặc định:

```text
%LOCALAPPDATA%\Programs\Grok Build\Grok Build.exe
```

### Cách 2: Portable ZIP

1. Tải file ZIP.
2. Giải nén vào một thư mục cố định.
3. Chạy `Grok Build.exe` trong thư mục vừa giải nén.

ZIP phù hợp hơn portable EXE nếu sử dụng hằng ngày vì không phải tự giải nén lại mỗi lần chạy.

## Chạy từ mã nguồn

```powershell
git clone https://github.com/nct88/Grok-Build-Desktop.git
cd Grok-Build-Desktop
npm install
npm start
```

Lệnh tương đương trên Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dev-desktop.ps1
```

Các lệnh thường dùng:

| Lệnh | Công dụng |
|---|---|
| `npm start` | Build các package và chạy Electron Desktop |
| `npm run desktop` | Alias tương thích của `npm start` |
| `npm run build` | Build ACP client và session package |
| `npm run icons` | Sinh/stamp bộ icon Desktop |
| `npm run check` | Chạy toàn bộ cổng architecture, packaging, brand, test và visual |
| `npm test` | Chạy bộ kiểm thử desktop |
| `npm run dist:desktop` | Tạo output electron-builder |
| `npm run portable` | Cài bản ZIP vào LocalAppData và chạy |
| `npm run portable:shortcut` | Cài bản ZIP và tạo shortcut Desktop |

## Kiến trúc

### Ranh giới bắt buộc

- Agent loop chỉ tồn tại trong Grok CLI.
- Renderer không tự spawn agent process và không gọi trực tiếp model HTTP API.
- Desktop giao tiếp với CLI qua ACP trong `packages/acp-client`.
- Repository này không chứa cây mã nguồn Code-OSS; IDE nằm ở repository riêng.

### Các module Electron chính

| Module | Trách nhiệm |
|---|---|
| `main.cjs` | Tạo cửa sổ, đăng ký IPC và nối các module |
| `agentSupervisor.cjs` | Quản lý vòng đời ACP, reconnect và slot agent |
| `launchArgs.cjs` | Chuẩn hóa quyền và tạo danh sách tham số CLI |
| `productPaths.cjs` | Tìm đường dẫn Desktop/IDE trên Windows |
| `ipcContract.cjs` | Danh sách invoke/event được preload cho phép |
| `security.cjs` | Giới hạn workspace, URL và lệnh CLI |
| `jobRunner.cjs` | Chạy job headless qua `grok -p` |
| `artifactStore.cjs` | Lưu và lập chỉ mục artifact của job |
| `controlPlane.cjs` | Snapshot health và capability |
| `telemetry.cjs` | Các bucket hiệu năng cục bộ, chỉ bật khi người dùng chọn |

Xem chi tiết tại [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Dữ liệu và bảo mật

- Xác thực và phiên của CLI nằm trong `%USERPROFILE%\.grok`.
- State của ứng dụng Desktop mặc định nằm trong `%APPDATA%\@grok-build\desktop`.
- Truy cập tệp được giới hạn theo workspace, trừ khi người dùng bật quyền ngoài workspace.
- URL ngoài ứng dụng chỉ chấp nhận chính sách HTTP(S) an toàn; URL chứa credential bị chặn.
- Các lệnh CLI từ giao diện đi qua allowlist thay vì chạy chuỗi tùy ý.
- Telemetry hiệu năng của Desktop là opt-in và được lưu cục bộ.

Không commit file xác thực, token, cookie, `.env`, private key hoặc dữ liệu phiên cá nhân vào repository.

## Kiểm thử và cổng chất lượng

```powershell
npm run check
```

Lệnh trên lần lượt kiểm tra:

1. Ranh giới kiến trúc.
2. Hợp đồng đóng gói Electron/NSIS.
3. Đồng bộ và chất lượng brand asset.
4. Hợp đồng release/version.
5. Bộ test desktop.
6. Layout/render ở viewport hỗ trợ.

Chạy kiểm thử có kết nối Grok CLI thật khi cần:

```powershell
$env:GROK_E2E_LIVE = '1'
npm test
```

## Đóng gói và phát hành Windows

### 1. Tạo local candidate bất biến

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\publish-release.ps1 `
  -Version <semver>
```

Mỗi version là bất biến; script sẽ dừng nếu `dist/<version>` đã tồn tại.

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

### 2. Commit và push source của release

```powershell
npm run check
git add -A
git commit -m "release: Grok Build Desktop <semver>"
git push origin main
```

### 3. Kiểm tra và phát hành GitHub Release

```powershell
# Chỉ kiểm tra; không tạo tag hoặc release
npm run release:github -- -Version <semver> -DryRun

# Artifact đã ký Authenticode
npm run release:github -- -Version <semver>

# Ngoại lệ chưa ký: chỉ dùng khi maintainer phê duyệt
npm run release:github -- -Version <semver> -AllowUnsigned
```

Publisher chỉ chạy khi worktree sạch, `HEAD` khớp `origin/main`, version đồng bộ, cặp README Việt–Anh và release notes song ngữ hợp lệ, đồng thời SHA-256 của artifact khớp `MANIFEST.json`. Script tạo annotated tag `v<semver>`, push tag, tạo GitHub Release mới nhất và upload Setup, Portable EXE, Portable ZIP cùng manifest. Tag/release đã tồn tại sẽ không bị ghi đè.

Phát hành công khai chuẩn yêu cầu HTTPS và chữ ký Authenticode hợp lệ. Bản chưa ký phải có phê duyệt maintainer bằng cờ `-AllowUnsigned` và luôn kèm cảnh báo SmartScreen. Release notes phải bắt đầu từ [`docs/releases/TEMPLATE.md`](docs/releases/TEMPLATE.md) và giữ nội dung `Tiếng Việt | English` song song. `README.md` và `README.en.md` phải cùng version, cùng link tải và liên kết chuyển ngôn ngữ hai chiều. Xem [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## Cấu trúc repository

```text
Grok-Build-Desktop/
├─ apps/desktop/           Electron main, preload, renderer và packaging
├─ packages/acp-client/    ACP client và Node filesystem host
├─ packages/sessions/      Chỉ mục phiên Grok cục bộ
├─ product/                Version và nhận diện sản phẩm
├─ logo/                   Nguồn và ma trận icon đã xử lý
├─ scripts/                Dev, test, kiểm tra và release automation
├─ docs/                   Kiến trúc, phân phối, roadmap và release notes
├─ CHANGELOG.md            Thay đổi theo phiên bản
└─ dist/                   Artifact build cục bộ, thường không commit
```

## Khắc phục sự cố

### Không tìm thấy Grok CLI

Chạy:

```powershell
grok --version
grok doctor
```

Nếu lệnh không tồn tại, thêm Grok CLI vào `PATH` hoặc đặt `GROK_EXECUTABLE` trỏ đến file `grok.exe`.

### Không kết nối được agent

Kiểm tra đăng nhập:

```powershell
grok login
grok doctor
```

Sau đó mở lại Grok Build và nhấn **Connect**.

### SmartScreen cảnh báo

Build hiện chưa ký số. So sánh SHA-256 với `MANIFEST.json`; chỉ chọn **More info → Run anyway** khi checksum khớp và file được tải từ release chính thức.

### Icon cũ vẫn xuất hiện sau khi nâng cấp

Windows có thể giữ cache icon của shortcut đã ghim. Gỡ shortcut cũ khỏi Taskbar/Start, mở bản mới một lần rồi ghim lại shortcut từ ứng dụng vừa cài.

### `/imagine-video` bị chặn

Tính năng video yêu cầu tài khoản cho phép lưu dữ liệu coding (`coding_data_retention_opt_out: false`). Thiết lập này thuộc tài khoản/Grok TUI, không được Electron tự thay đổi.

### Nút Open IDE không tìm thấy IDE

Ứng dụng tìm theo Settings, biến `GROK_BUILD_IDE`, đường dẫn cài mặc định và một số vị trí phổ biến. Có thể đặt `GROK_BUILD_IDE` bằng đường dẫn đầy đủ đến `Grok Build IDE.exe`.

## Tài liệu liên quan

| Tài liệu | Nội dung |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Ranh giới kiến trúc và module chính |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Cài dependency, chạy source và kiểm tra |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Ship line và hướng phát triển tiếp theo |
| [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) | Kênh phát hành, signing và SmartScreen |
| [`docs/INSTALL_PATHS.md`](docs/INSTALL_PATHS.md) | Đường dẫn cài Desktop/IDE |
| [`product/PRODUCT_IDENTITY.md`](product/PRODUCT_IDENTITY.md) | Tên sản phẩm Desktop và IDE |
| [`CHANGELOG.md`](CHANGELOG.md) | Thay đổi theo phiên bản |

## Đóng góp

1. Tạo nhánh riêng cho thay đổi.
2. Không đưa secret hoặc dữ liệu phiên cá nhân vào commit.
3. Chạy `npm run check` trước khi mở Pull Request.
4. Mô tả rõ hành vi thay đổi và bằng chứng kiểm thử trong PR.

## Giấy phép và tuyên bố

Copyright © 2026 Grok Build contributors. **All rights reserved.** Repository này không cấp giấy phép mã nguồn mở (**No open-source license is granted**); xem [`LICENSE`](LICENSE).

Các thành phần bên thứ ba tuân theo giấy phép và thông báo riêng của chúng.

Grok CLI và các model Grok thuộc chủ sở hữu tương ứng trong hệ sinh thái xAI/Grok. Grok Build Desktop là giao diện desktop độc lập sử dụng CLI chính thức qua ACP; không tuyên bố liên kết chính thức nếu chưa có xác nhận bằng văn bản.
