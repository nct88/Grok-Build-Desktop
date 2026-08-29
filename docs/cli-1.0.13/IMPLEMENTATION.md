# Kế hoạch triển khai — Grok CLI 1.0.13

Ngày lập: 2026-08-29  
Phạm vi: nâng **Grok Build Desktop** và **Grok Build IDE** cho tương thích Grok CLI **1.0.9–1.0.13**.

| Sản phẩm | Repo | Bản hiện tại | Bản đề xuất sau triển khai |
|---|---|---|---|
| Grok CLI (upstream) | [xai-org/grok-build](https://github.com/xai-org/grok-build) | **1.0.13** (2026-08-28) | Người dùng `grok update` |
| Grok Build Desktop | `E:\projects\Grok-Build` | **0.5.48** | **0.5.49** |
| Grok Build IDE | `E:\projects\grok-build-ide` | **1.0.11** | **1.0.12** |

Hai app là **ACP host** (`grok agent stdio`). Không viết lại agent loop. Phần lớn 1.0.13 nằm trong `grok.exe`; app chỉ sửa chỗ host làm **ngược** CLI.

---

## 0. Việc làm ngay (không đụng source)

Cập nhật CLI trên máy dev và máy user:

```text
grok --version
grok update
```

Desktop đã có Settings → **Update Grok CLI** (`app:updateCli` → `grok update`).

Sau khi CLI = 1.0.13, app **vẫn chạy**. Lợi ích có sẵn (không cần ship app):

- Vá bảo mật SessionStart hook + sandbox
- Retry sampler lỗi tạm; tool đã xong vẫn chạy khi turn bị Length-truncate
- MCP OAuth không chặn spawn; MCP start không batch cap; MCP retry tạm (1.0.12)
- Clamp ảnh 2000px phía CLI; Windows home cho agent con
- `/loop` giữ UUID đầy đủ, dừng task lặp đã xong
- mkdir/touch không hỏi trong Auto; subagent message Auto-allow (1.0.11)

---

## 1. Nguồn và phiên bản CLI

| Nguồn | Ghi chú |
|---|---|
| `https://x.ai/cli/stable` | Latest = **1.0.13** |
| npm `@xai-official/grok@1.0.13` | 2026-08-28 |
| GitHub commit `bc7f02e` | Sync monorepo 1.0.13 (`SOURCE_REV` `d5a0335…`) |
| `crates/codegen/xai-grok-shell/CHANGELOG.md` | Công khai mới tới **1.0.12** |
| `https://x.ai/build/changelog` | Website mới tới **1.0.5** (lạc hậu) |

Ghi chú 1.0.13 lấy từ commit message `bc7f02e`, không từ CHANGELOG.md.

Hợp đồng an toàn cho host: **CLI ≥ 1.0.11 khuyến nghị, ≥ 1.0.5 sàn cứng** (`_meta.reasoningEffort`).

---

## 2. Nguyên tắc triển khai

1. Agent loop chỉ sống trong `grok.exe`. Desktop/IDE không tự gọi model HTTP.
2. Permission host **không được yolo hơn CLI**. Auto của CLI vẫn có thể hiện thẻ khi classifier chặn hoặc hook `ask`.
3. `dontAsk` CLI = **từ chối** nếu chưa allow-list. Không map thành Full access.
4. Full access = `--permission-mode bypassPermissions`, không chỉ `--always-approve`.
5. VS Code `workspace.isTrusted` **không** thay `/hooks-trust` / `trusted_folders.toml` của CLI.
6. Không port tính năng **chỉ TUI**: `/minimal`, `/fullscreen`, status line TUI, Ctrl+S stash, copy bảng wrap, Kitty/Warp ghost.
7. Mọi thay đổi UI: kiểm tra desktop + hẹp, dark/light. Desktop: `npm run check`. IDE: skill `/run-check` + `/verify-ui`.

---

## 3. Thứ tự làm

```text
[A] grok update → 1.0.13
    ↓
[B] Desktop 0.5.49 — permission + worktree resume + process tree
    ↓
[C] IDE 1.0.12 — dontAsk/Full + hooks-trust + permission live
    ↓
[D] Polish chung — effort max, headless history, resume footer, ảnh 2000px
```

B và C có thể song song. D không chặn phát hành nếu A–C xong.

---

# Phần A — Grok Build Desktop 0.5.49

Repo: `E:\projects\Grok-Build`  
Hiện tại bám CLI **1.0.5** (effort `_meta`, recap). Composer mặc định **Ask** (`--permission-mode default`). Job headless mặc định **auto**.

## A1. Must

### A1.1 Auto / dontAsk không được nuốt mọi permission

**Vấn đề:** `AgentSupervisor.createPermissionHandler` auto-chọn allow khi mode là `bypassPermissions` **hoặc** `dontAsk` **hoặc** `auto`. CLI 1.0.11 vẫn gửi thẻ khi classifier chặn; CLI 1.0.13 hook `PreToolUse { decision: "ask" }` bắt hỏi dù Auto / Always allow. Host đang chặn UI.

**File**

- `apps/desktop/src/agentSupervisor.cjs` — `createPermissionHandler`
- `apps/desktop/src/main.cjs` — `connectAgentHost` (auto/dontAsk/bypass ép `allowOutside`)
- Test e2e permission nếu có

**Hành vi đích**

| Mode CLI | Host |
|---|---|
| `bypassPermissions` | Auto-allow (Full access). Vẫn hiện UI nếu request đánh dấu hook-ask (nếu CLI vẫn gửi RPC). |
| `dontAsk` | **Không** auto-allow. Để CLI deny nếu chưa grant. Hiện UI khi CLI hỏi. |
| `auto` | Chỉ auto-allow kind an toàn (`read`, `search`, `think`, `fetch`) **hoặc** không auto gì cả — để CLI classifier quyết. Mọi execute/bash/MCP hiện card. |
| `acceptEdits` | Auto edit/write/read/search như hiện tại. Execute vẫn hỏi. |
| `default` / `plan` | Luôn hiện card. |

**Hook-ask:** nếu `request._meta`, `title`, option, hoặc field hook name/reason cho thấy PreToolUse `ask` → **luôn hiện UI**, kể cả Full/Auto.

### A1.2 Forward metadata permission lên card

**File**

- `apps/desktop/src/agentSupervisor.cjs` (payload `permission_request`)
- `apps/desktop/renderer/lib/timelineView.js` (perm card)
- `apps/desktop/renderer/lib/i18n.js` nếu thêm nhãn

**Gửi thêm (nếu có trên ACP request):** `_meta`, hook name, reason, `additionalContext`, đủ `options[]` (Always allow / Never allow 1.0.7). Không chỉ `title` / `kind` / path đầu.

Card hiện: tên hook (mô tả thân thiện, không ID nội bộ), lý do, nút đúng `optionId` CLI gửi.

### A1.3 Resume worktree không gắn `--worktree` thừa

**Vấn đề:** Settings isolation đẩy `--worktree` mọi spawn, kể cả resume session đã nằm trong worktree. CLI 1.0.13: Grove create/fork gate khi resume worktree mới → có thể tạo worktree lần hai.

**File**

- `apps/desktop/src/launchArgs.cjs`
- `apps/desktop/src/agentSupervisor.cjs` / `main.cjs` `connectOpts()`
- `apps/desktop/src/jobRunner.cjs` nếu job resume worktree

**Hành vi đích:** Resume theo `sessionId` đã có worktree → **không** thêm `--worktree` / `--worktree-ref`. Chỉ gắn khi **tạo** isolation mới.

### A1.4 Kill process tree khi disconnect (Windows)

IDE 1.0.11 đã `taskkill /T`. Desktop `GrokClient.stopProcess` chỉ `child.kill()` → sót `grok.exe` cháu.

**File**

- `packages/acp-client/src/grokClient.ts` `stopProcess`
- Thêm helper kiểu IDE `processTree.ts` (hoặc port)

Windows: `taskkill /PID <pid> /T` rồi `/T /F`. Unix: process group.

---

## A2. Should

### A2.1 `permissionMode` trên `session/new` và `session/load` `_meta`

**File:** `packages/acp-client/src/sessionMeta.ts`, `grokClient.ts` `sessionOpenFields()`

Hiện chỉ gửi `reasoningEffort` / `reasoning_effort`. Thêm `permissionMode` (và snake_case) để `/new` / resume không restart process vẫn đúng mode (CLI 1.0.4 welcome-screen mode).

Đổi chip quyền: reconnect **hoặc** `_meta` / config option. Hiện `agent:setPermissionMode` chỉ sửa supervisor + STATE, **không** nói với process CLI.

### A2.2 Reasoning effort `max`

**File**

- `packages/acp-client/src/sessionMeta.ts` — `REASONING_EFFORT_VALUES`
- `packages/acp-client/src/types.ts` — `REASONING_EFFORTS`
- `apps/desktop/renderer/app.js` — `EFFORT_LEVELS`

Thêm `max` (trên `xhigh`, CLI 0.2.109+). Không thì chọn max bị nuốt.

### A2.3 Lọc / badge session headless trong History

CLI 1.0.11 tách headless khỏi resume picker. Desktop `jobRunner` dùng `grok -p`. `packages/sessions` đọc mọi `summary.json`, không lọc `headless` / `sessionKind`.

**File:** `packages/sessions/src/index.ts`, renderer history

Ẩn khỏi chat History mặc định, hoặc nhóm “Headless / Jobs”. Giữ Manager jobs như cũ.

### A2.4 Clamp ảnh 2000px trước ACP

Paste/drop gửi raw base64, không resize. CLI clamp sau khi nhận; paste lớn tốn RAM, dễ `image_dropped` (Desktop không consume notification này).

**File:** `apps/desktop/renderer/app.js` `addImageFromBlob`

Long edge ≤ 2000px, giữ MIME, giữ giới hạn dung lượng nếu đã có.

### A2.5 Soft min-version CLI

**File:** `apps/desktop/src/main.cjs` `app:cliStatus`, `renderer/app.js` banner

Cảnh báo nếu CLI < 1.0.5 (sàn effort `_meta`); khuyến nghị ≥ 1.0.13. Không hard-block trừ khi chủ đích.

### A2.6 Không strip UUID trên status nếu hiện job `/loop`

`humanizeStatusDetail()` xóa UUID → mất scheduler id. 1.0.13 CLI giữ UUID đầy đủ.

**File:** `apps/desktop/renderer/app.js`

---

## A3. Nice / backlog

| ID | Việc | Ghi chú |
|---|---|---|
| A3.1 | Mid-turn interject (`_x.ai/interject` hoặc prompt khi `running`) | Hiện từ chối: “turn already running”, queue tới `turn_complete`. CLI 1.0.8 gửi follow-up khi chờ subagent. |
| A3.2 | Consume `_x.ai/session_notification` | `auto_compact_completed`, `image_dropped`, `subagent_*`. `sessionUpdates.ts` đang drop unknown. |
| A3.3 | Resume footer “Worked for / cancelled / failed” + duration (1.0.11) | Hiện chỉ recap / last-turn 1.0.5. |
| A3.4 | `/plugin` alias, `/workflow --agent-budget` / `--effort` trong slash expand | Đã có `/workflow`. |
| A3.5 | MCP OAuth / URL consent (ACP questions, 1.0.8) | Enable/disable MCP đã có. |
| A3.6 | `/compact` native nếu CLI expose RPC | Hiện prompt rewrite. |
| A3.7 | ACP `session/list` thay scrape disk | Khi agent advertise. |
| A3.8 | `GROK_SHELL` trên spawn Windows | Tùy chọn. |

**Cố ý không làm:** `/minimal`, `/fullscreen`, TUI status line.

---

## A4. File Desktop cần đụng (checklist)

```text
apps/desktop/src/agentSupervisor.cjs
apps/desktop/src/launchArgs.cjs
apps/desktop/src/main.cjs
apps/desktop/src/jobRunner.cjs
apps/desktop/renderer/app.js
apps/desktop/renderer/lib/timelineView.js
apps/desktop/renderer/lib/i18n.js
apps/desktop/renderer/lib/slashCommands.js
packages/acp-client/src/grokClient.ts
packages/acp-client/src/sessionMeta.ts
packages/acp-client/src/types.ts
packages/acp-client/src/sessionUpdates.ts
packages/sessions/src/index.ts
product/VERSION                    → 0.5.49
package.json
CHANGELOG.md
docs/releases/0.5.49.md
```

**Cổng:** `npm test` · `npm run check` · e2e permission Auto vs Ask · resume worktree · disconnect không sót `grok.exe`.

---

# Phần B — Grok Build IDE 1.0.12

Repo: `E:\projects\grok-build-ide`  
Workbench: `extensions/grok-build-workbench`  
Hiện tại: effort `_meta` 1.0.5, recap, **process tree kill đã có**. Default permission **ask**. Smoke test còn expect CLI **1.0.3**.

## B1. Must

### B1.1 Sửa `dontAsk` và Full access

**Vấn đề**

- `dontAsk` trên CLI = deny trừ khi đã allow. IDE `permissionPolicy.ts` auto `allow_always` giống Full.
- Full spawn `--always-approve`, không `--permission-mode bypassPermissions`.
- Type `PermissionMode` không có `bypassPermissions`.

**File**

- `extensions/grok-build-workbench/src/vscode/permissionPolicy.ts`
- `extensions/grok-build-workbench/src/vscode/launchConfiguration.ts`
- `extensions/grok-build-workbench/src/acp/types.ts`
- `extensions/grok-build-workbench/src/vscode/launchConfiguration.test.ts`
- `extensions/grok-build-workbench/src/vscode/permissionPolicy.test.ts`

**Hành vi đích**

| Mode IDE | Spawn | Client auto |
|---|---|---|
| `ask` | không flag / `default` | không |
| `auto` | `--permission-mode auto` | chỉ kind an toàn **hoặc** không auto (để CLI) |
| `acceptEdits` | `--permission-mode acceptEdits` | read/search + edit |
| `plan` | `--permission-mode plan` | không |
| `dontAsk` | `--permission-mode dontAsk` | **không** auto-allow |
| `full` | `--permission-mode bypassPermissions` | allow_always, trừ hook-ask |

Hook-ask: luôn hiện UI.

### B1.2 Folder trust CLI (`/hooks-trust`)

VS Code `workspace.isTrusted` **không** ghi `trusted_folders.toml`. Project hooks / MCP local bị skip hoặc chạy khác Desktop. 1.0.13 vá SessionStart + sandbox — IDE cần cùng cổng trust CLI.

**File**

- `extensions/grok-build-workbench/src/vscode/grokController.ts`
- Slash / command palette: `/hooks-trust`, `/hooks-untrust`
- Có thể spawn `grok` với `--trust` lần connect đầu nếu user xác nhận

Desktop tham chiếu: `apps/desktop/src/folderTrust.cjs`.

### B1.3 Permission mode live = process CLI

`setPermissionMode` chỉ ghi VS Code config. `--permission-mode` trên child **cũ** tới reconnect. `requestPermission` dùng setting mới nhưng CLI classifier vẫn mode spawn.

**Đích:** reconnect khi đổi mode, **hoặc** gửi `_meta.permissionMode` / session config. Thêm `permissionMode` vào `sessionRequestMeta` (`src/acp/sessionMeta.ts`).

### B1.4 `session/cancel` timeout

`grokClient.cancel()` không timeout. CLI `cancel()` có timeout từ 0.2.81. Disconnect/stop có thể treo.

**File:** `extensions/grok-build-workbench/src/acp/grokClient.ts`

Bọc `withTimeout` giống RPC khác.

### B1.5 Bump expected CLI trong test / docs

**File**

- `src/acp/grokClient.real.test.ts` — bỏ default `1.0.3`; sàn 1.0.5, khuyến nghị 1.0.13
- `docs/releases/1.0.12.md` (khi ship)
- Comment `sessionMeta.ts` “CLI 1.0.5+” cập nhật thêm permission `_meta`

---

## B2. Should

### B2.1 Effort `max`

`src/acp/sessionMeta.ts`, `src/acp/types.ts`, UI effort picker (`media/main.js` / settings).

### B2.2 History: tách headless + footer resume

`src/vscode/sessionService.ts` / `listLocalSessions` — lọc `headless` / `sessionKind`.  
`media/main.js` — “Worked for / cancelled / failed” + duration (1.0.11). Hiện chỉ recap.

### B2.3 Clamp ảnh 2000px

`media/main.js` paste/drop và `chatViewProvider.ts` file picker (đang 5MB, không resize).

### B2.4 Slash: `/plugin`, `/hooks-trust`, workflow

`media/slashCommands.js` — `/plugin` → `/plugins`; `/hooks-trust` gọi trust thật (B1.2); `/workflow` / `/workflows` nếu muốn first-class (unknown `/` đang passthrough model).

### B2.5 Thống nhất cờ deny-tools với Desktop

IDE: `--disallowed-tools`. Desktop: `--denied-tools`. Đối chiếu `grok agent --help` trên 1.0.13, một flag duy nhất.

---

## B3. Nice / backlog

| ID | Việc |
|---|---|
| B3.1 | MCP status / reconnect / OAuth host callback |
| B3.2 | ACP `session/list` khi advertise |
| B3.3 | Compact native + truncation error copy |
| B3.4 | Recency-ordered `/` menu (CLI 1.0.9) |
| B3.5 | Worktree badge trên session chip |
| B3.6 | Min-version banner trong Workbench |

**Không làm:** `/edit-prompt`, `/minimal`, `/fullscreen` (TUI).

---

## B4. File IDE cần đụng (checklist)

```text
extensions/grok-build-workbench/src/acp/types.ts
extensions/grok-build-workbench/src/acp/sessionMeta.ts
extensions/grok-build-workbench/src/acp/grokClient.ts
extensions/grok-build-workbench/src/acp/grokClient.real.test.ts
extensions/grok-build-workbench/src/vscode/permissionPolicy.ts
extensions/grok-build-workbench/src/vscode/permissionPolicy.test.ts
extensions/grok-build-workbench/src/vscode/launchConfiguration.ts
extensions/grok-build-workbench/src/vscode/launchConfiguration.test.ts
extensions/grok-build-workbench/src/vscode/grokController.ts
extensions/grok-build-workbench/src/vscode/sessionService.ts
extensions/grok-build-workbench/media/main.js
extensions/grok-build-workbench/media/slashCommands.js
build/grok/VERSION                 → 1.0.12
CHANGELOG.md
docs/releases/1.0.12.md
```

**Cổng:** `/run-check`, `/verify-ui`, smoke ACP với CLI 1.0.13, permission dontAsk ≠ Full, hooks-trust ghi `trusted_folders.toml`.

---

# Phần C — Việc CLI lo (không code app)

Cập nhật `grok.exe` là đủ:

- 1.0.13: SessionStart sandbox, truncated turn chạy tool đã xong, sampler retry, MCP OAuth off spawn, MCP no batch cap, image 2000px engine, scheduler UUID, worktree identity/heal, Windows home resolver, compaction error thật
- 1.0.12: MCP retry tạm, context bar compact (TUI), token usage sau rewind
- 1.0.11: headless picker (TUI), default permission configurable (TUI `config.toml`), turn duration trong TUI, mkdir/touch Auto
- 1.0.9–1.0.10: `grok clone` worktree reuse, workflow budget/effort **trong TUI**, `/minimal` instant
- 1.0.7: Always/Never allow **trong agent** — host chỉ cần **render** `options` CLI gửi
- 1.0.8: MCP elicitation popup TUI; follow-up khi chờ subagent (TUI)

Desktop đã set `GROK_HOME` + `USERPROFILE` + `HOME` khi spawn — khớp vá Windows 1.0.4 / 1.0.13.

---

# Phần D — Hook PreToolUse (tham chiếu host)

JSON stdout hook (chỉ settings file, không SDK):

```json
{"decision": "allow"}
{"decision": "deny", "reason": "..."}
{"decision": "ask", "reason": "Confirm this deploy"}
{"decision": "defer"}
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "..."}}
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": {}}}
```

`ask`: hiện permission prompt; Auto / Always allow / safe-command **không** bỏ qua. Policy deny / plan mode vẫn thắng. `allow` = không chặn, không tự duyệt.

ACP: CLI gửi `requestPermission` → host **phải hiện UI**, không auto-allow.

---

# Phần E — Tiêu chí xong

## Desktop 0.5.49

- [ ] Auto mode: classifier-block hoặc hook-ask **hiện card**
- [ ] dontAsk không auto-allow
- [ ] Full = `bypassPermissions`; hook-ask vẫn hỏi nếu CLI gửi RPC
- [ ] Card hiện Always/Never + tên hook khi CLI gửi
- [ ] Resume session worktree không tạo worktree mới
- [ ] Stop/disconnect Windows không sót `grok.exe` con
- [ ] `npm test` và `npm run check` pass

## IDE 1.0.12

- [ ] dontAsk ≠ Full trong policy + spawn flags
- [ ] Full = `--permission-mode bypassPermissions`
- [ ] `/hooks-trust` hoặc `--trust` ghi trust CLI
- [ ] Đổi permission trên UI khớp process (reconnect hoặc `_meta`)
- [ ] `cancel()` có timeout
- [ ] Smoke không hard-code 1.0.3
- [ ] `/run-check` pass

## Cả hai (Should, có thể cùng bản hoặc bản sau)

- [ ] Effort `max` trong picker + `_meta`
- [ ] History không trộn session headless vào chat mặc định
- [ ] Ảnh paste long edge ≤ 2000px
- [ ] Banner khuyến nghị CLI ≥ 1.0.13

---

# Phần F — Gợi ý phát hành

**Desktop 0.5.49 (vi/en trong `docs/releases/0.5.49.md`)**

- Permission Auto/dontAsk không nuốt hook-ask / classifier-block (CLI 1.0.11–1.0.13)
- Resume worktree không tạo isolation lần hai
- Ngắt agent Windows theo process tree

**IDE 1.0.12**

- `dontAsk` đúng nghĩa CLI; Full dùng `bypassPermissions`
- Folder trust CLI cho hooks/MCP repo
- Cancel ACP có timeout; nhận diện CLI khuyến nghị 1.0.13

Ghi `FIX_LOG.md` theo SOP từng repo sau khi sửa.

---

# Phần G — Lệnh `/` — không port từ TUI

| Lệnh CLI | Desktop | IDE | Ghi chú |
|---|---|---|---|
| `/hooks-trust` | Đã có | **Phải thêm** | Trust CLI |
| `/plugin` | Alias nên thêm | Alias nên thêm | = `/plugins` |
| `/workflow` | Có expand | Passthrough | Budget/effort tùy chọn |
| `/minimal` `/fullscreen` | Không | Không | TUI |
| `/edit-prompt` | Không | Không | TUI editor |
| `/compact` | Prompt rewrite | Prompt rewrite | RPC native = nice |

---

## Bản sao tài liệu

| Vị trí | Mục đích |
|---|---|
| `E:\projects\Agents CLI\docs\cli-1.0.13\IMPLEMENTATION.md` | Bản gốc workspace này |
| `E:\projects\Grok-Build\docs\cli-1.0.13\IMPLEMENTATION.md` | Triển khai Desktop |
| `E:\projects\grok-build-ide\docs\cli-1.0.13\IMPLEMENTATION.md` | Triển khai IDE |
