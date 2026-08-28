import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRequire = createRequire(path.join(root, "apps", "desktop", "package.json"));
const electronExecutable = desktopRequire("electron");
const version = (await readFile(path.join(root, "product", "VERSION"), "utf8")).trim();
const evidenceDir = path.join(root, "docs", "reports", "evidence", version);
const profileDir = path.join(root, ".build", `codex-visual-profile-${process.pid}`);
const grokHome = path.join(profileDir, "grok-home");
const persistedSessionId = "codex-reasoning-fixture";
const persistedSessionDir = path.join(
  grokHome,
  "sessions",
  encodeURIComponent("C:\\work\\grok-build"),
  persistedSessionId,
);
await mkdir(evidenceDir, { recursive: true });
await mkdir(persistedSessionDir, { recursive: true });
await writeFile(
  path.join(persistedSessionDir, "summary.json"),
  JSON.stringify({ info: { id: persistedSessionId, cwd: "C:\\work\\grok-build" } }),
);
await writeFile(
  path.join(persistedSessionDir, "chat_history.jsonl"),
  [
    { type: "system", content: "hidden" },
    { type: "user", content: [{ type: "text", text: "Kiểm tra lại reasoning khi mở session." }] },
    {
      type: "reasoning",
      id: "persisted-reasoning-1",
      status: "completed",
      summary: [{ type: "summary_text", text: "Đối chiếu session đã lưu với timeline hiện tại và giữ nguyên thứ tự sự kiện." }],
      encrypted_content: "encrypted-payload-must-not-render",
    },
    { type: "assistant", content: "Reasoning summary đã được khôi phục trong một hàng có thể mở." },
    { type: "user", content: [{ type: "text", text: "Nội dung mã hóa có xuất hiện trên giao diện không?" }] },
    {
      type: "reasoning",
      id: "persisted-reasoning-2",
      status: "completed",
      summary: [{ type: "summary_text", text: "Chỉ summary_text đi qua IPC; encrypted_content bị loại ở package sessions." }],
      encrypted_content: "second-secret-ciphertext",
    },
    { type: "assistant", content: "Không. Renderer chỉ nhận phần summary an toàn để hiển thị." },
  ].map((row) => JSON.stringify(row)).join("\n"),
);

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: [path.join(root, "apps", "desktop"), `--user-data-dir=${profileDir}`],
  env: {
    ...process.env,
    GROK_HOME: grokHome,
    GROK_EXECUTABLE: path.join(profileDir, "missing-grok.exe"),
  },
});

async function setWindowSize(width, height) {
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.show();
  }, { width, height });
}

async function emit(events) {
  await electronApp.evaluate(async ({ BrowserWindow }, payload) => {
    const window = BrowserWindow.getAllWindows()[0];
    for (const event of payload) {
      window.webContents.send("agent:event", event);
      await new Promise((resolve) => setTimeout(resolve, 24));
    }
  }, events);
}

try {
  const page = await electronApp.firstWindow();
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  await setWindowSize(1440, 900);
  await page.waitForSelector(".composer");
  // Visual assertions below target the dark Codex reference. The application
  // defaults to the host theme, so pin this isolated evidence profile instead
  // of letting a light-mode CI runner change the expected palette.
  await page.evaluate(async () => {
    await globalThis.grokBuild.setTheme("dark");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.waitForTimeout(700);

  // Replace only the visual-run prompt handler. This keeps renderer submit and
  // queue behavior real without requiring an authenticated network request.
  await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler("app:getAuthProfile");
    ipcMain.handle("app:getAuthProfile", async () => ({
      ok: true,
      loggedIn: true,
      email: "test@example.com",
      authMethod: "OAuth",
      profile: { name: "Test User", email: "test@example.com" },
    }));
    ipcMain.removeHandler("agent:prompt");
    ipcMain.handle("agent:prompt", async () => ({ ok: true }));
    ipcMain.removeHandler("agent:slots");
    ipcMain.handle("agent:slots", async () => ({
      connected: true,
      state: "connected",
      sessionId: "codex-visual-live",
      workspace: "C:\\work\\grok-build",
      activeSlotId: "primary",
      maxSlots: 2,
      slots: [{
        id: "primary",
        label: "Primary agent",
        active: true,
        workspace: "C:\\work\\grok-build",
        sessionId: "codex-visual-live",
        state: "connected",
        warm: true,
      }],
    }));
    ipcMain.removeHandler("agent:setActiveSlot");
    ipcMain.handle("agent:setActiveSlot", async () => ({ ok: true, activeId: "primary" }));
    globalThis.__codexPathActions = [];
    ipcMain.removeHandler("shell:showItemInFolder");
    ipcMain.handle("shell:showItemInFolder", async (_event, target) => {
      globalThis.__codexPathActions.push({ action: "folder", target });
      return { ok: true, path: target };
    });
    ipcMain.removeHandler("shell:openPath");
    ipcMain.handle("shell:openPath", async (_event, target) => {
      globalThis.__codexPathActions.push({ action: "open", target });
      return { ok: true, path: target };
    });
    ipcMain.removeHandler("clipboard:writeText");
    ipcMain.handle("clipboard:writeText", async (_event, target) => {
      globalThis.__codexPathActions.push({ action: "copy", target });
      return { ok: true };
    });
    ipcMain.removeHandler("app:getSessionInfo");
    ipcMain.handle("app:getSessionInfo", async () => ({
      ok: true,
      state: "connected",
      title: "Nâng cấp thông tin session Grok Build",
      shellVersion: "1.0.3",
      authMethod: "OAuth",
      sessionId: "81f5b741-e66d-4a7f-a10a-b2f3799e27db",
      workingDirectory: "C:\\work\\grok-build",
      model: "grok-4.6",
      modelHash: "1a29d5bc12",
      apiBackend: "responses",
      sandbox: "workspace",
      turns: 4,
      reasoningEffort: "high",
      permissionMode: "ask",
      createdAt: "2026-08-13T08:00:00.000Z",
      updatedAt: "2026-08-13T08:30:00.000Z",
      context: {
        used: 32000,
        size: 128000,
        percent: 25,
        inputTokens: 30000,
        outputTokens: 2000,
        reasoningTokens: 800,
        modelCalls: 4,
        apiDurationMs: 9123,
        costUsd: 0.25,
      },
    }));
    BrowserWindow.getAllWindows()[0].webContents.send("agent:event", {
      type: "state",
      state: "connected",
      detail: "Ready",
    });
  });
  await emit([{ type: "context", showReasoning: true }]);
  await page.waitForTimeout(80);

  async function submit(text) {
    await page.locator("#prompt").fill(text);
    await page.locator("#btnSend").click();
    await page.waitForTimeout(60);
  }

  await submit("Khôi phục luồng suy luận của session và giữ giao diện gọn như Codex.");
  await emit([
    { type: "state", state: "running", detail: "Working" },
    { type: "plan", entries: [
      { content: "Kiểm tra bề mặt các mục trong session", status: "completed" },
      { content: "Xác minh Markdown sau khi kết thúc stream", status: "in_progress" },
    ] },
    { type: "thought_delta", messageId: "thought-1", text: "Đối chiếu định dạng reasoning summary trong chat_history.jsonl và xác định ranh giới dữ liệu an toàn." },
    { type: "tool", toolCallId: "tool-1", title: "Tool", status: "running", kind: "read" },
    { type: "tool_update", toolCallId: "tool-1", title: "Tool", status: "completed", kind: "read", detail: "reasoning.summary[] · assistant · tool_result", diffs: [{
      path: "apps/desktop/renderer/styles.css",
      oldText: ".review-chip { background: var(--code-bg); border-radius: 8px; }",
      newText: ".review-chip { background: transparent; border-radius: 0; }",
    }] },
    { type: "thought_delta", messageId: "thought-2", text: "Giữ summary_text để hiển thị, không chuyển encrypted_content qua IPC hoặc renderer." },
    { type: "assistant_delta", messageId: "answer-1", text: "Đã khôi phục **reasoning summary** theo đúng thứ tự session.\n\n## Kiểm tra hiển thị\n\n| Mục | Trạng thái |\n|---|---|\n| Markdown | Hoàn tất |\n\nTệp đầu ra: E:\\work\\grok-build\\dist\\Grok-Build.exe. Báo cáo: apps/desktop/renderer/styles.css. [Báo cáo có khoảng trắng](<E:\\work\\grok build\\docs\\report.md:12>).\n\nNội dung mã hóa vẫn được giữ ngoài giao diện." },
  ]);
  await page.waitForFunction(() => {
    const answers = document.querySelectorAll(".msg.assistant");
    return Boolean(answers[answers.length - 1]?.textContent?.includes("**reasoning summary**"));
  });
  const streamingMarkdown = await page.evaluate(() => {
    const answers = document.querySelectorAll(".msg.assistant");
    const answer = answers[answers.length - 1];
    return {
      streaming: Boolean(answer?.classList.contains("md-streaming")),
      structured: Boolean(answer?.classList.contains("md-structured")),
      rawMarkersVisible: Boolean(answer?.textContent?.includes("**reasoning summary**")),
      strongCount: answer?.querySelectorAll("strong").length || 0,
    };
  });
  const failures = [];
  if (!streamingMarkdown.streaming || streamingMarkdown.structured || !streamingMarkdown.rawMarkersVisible || streamingMarkdown.strongCount !== 0) {
    failures.push(`streaming answer is not plain text ${JSON.stringify(streamingMarkdown)}`);
  }
  await emit([
    { type: "token_usage", totalTokens: 18420, inputTokens: 16980, outputTokens: 1440, thoughtTokens: 620 },
    { type: "turn_complete", stopReason: "end_turn" },
    { type: "state", state: "connected", detail: "Ready" },
  ]);
  await page.waitForTimeout(180);

  await submit("Tiếp tục tinh chỉnh timeline, tool rows và composer theo ảnh tham chiếu.");
  await emit([
    { type: "state", state: "running", detail: "Working" },
    { type: "thought_delta", messageId: "thought-3", text: "Giảm card chrome, giữ nội dung trung tâm hẹp và tách hai pane phụ bằng tương phản bề mặt nhẹ." },
    { type: "tool", toolCallId: "tool-2", title: "Cập nhật giao diện Desktop", status: "running", kind: "edit", locations: [{ path: "apps/desktop/renderer/styles.css", line: 1 }] },
    { type: "tool_update", toolCallId: "tool-2", title: "Cập nhật giao diện Desktop", status: "completed", kind: "edit", locations: [{ path: "apps/desktop/renderer/styles.css", line: 1 }], detail: "Timeline density · panel surfaces · floating composer" },
    { type: "assistant_delta", messageId: "answer-2", text: "Timeline hiện dùng các hàng reasoning/tool có thể mở, user bubble nhỏ lệch phải và composer nổi nhẹ ở đáy giống nhịp thị giác của Codex." },
    { type: "turn_complete", stopReason: "end_turn" },
    { type: "state", state: "connected", detail: "Ready" },
  ]);
  await page.waitForTimeout(500);

  const wide = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
    };
    const css = getComputedStyle(document.documentElement);
    const composerCss = getComputedStyle(document.querySelector(".composer"));
    const thoughts = Array.from(document.querySelectorAll(".cli-thought"));
    const surface = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        radius: Number.parseFloat(style.borderTopLeftRadius),
        borderTop: style.borderTopStyle,
        borderLeft: style.borderLeftStyle,
      };
    };
    const answers = Array.from(document.querySelectorAll(".msg.assistant"));
    const pathNodes = Array.from(document.querySelectorAll(".msg.assistant .md-path-link"));
    return {
      viewport: { width: innerWidth, height: innerHeight },
      conversation: rect(".conversation"),
      timelineWindow: rect(".tl-window"),
      composer: rect(".composer"),
      user: rect(".msg.user"),
      editor: rect(".editor-pane"),
      colors: { canvas: css.getPropertyValue("--bg").trim(), side: css.getPropertyValue("--bg-side").trim() },
      composerRadius: Number.parseFloat(composerCss.borderTopLeftRadius),
      thoughtCount: thoughts.length,
      collapsedThoughts: thoughts.filter((node) => !node.open).length,
      toolCount: document.querySelectorAll(".cli-tool").length,
      collapsedTools: Array.from(document.querySelectorAll(".cli-tool")).filter((node) => !node.open).length,
      thoughtTitles: thoughts.map((node) => node.querySelector(".cli-line-title")?.textContent || ""),
      flatSurfaces: {
        plan: surface(".plan-dock"),
        diff: surface(".cli-diff"),
        review: surface(".review-chip"),
      },
      markdown: {
        answerCount: answers.length,
        structuredCount: answers.filter((node) => node.classList.contains("md-structured")).length,
        streamingCount: answers.filter((node) => node.classList.contains("md-streaming")).length,
        strongCount: answers.reduce((count, node) => count + node.querySelectorAll("strong").length, 0),
        headingCount: answers.reduce((count, node) => count + node.querySelectorAll(".md-h").length, 0),
        tableCount: answers.reduce((count, node) => count + node.querySelectorAll("table").length, 0),
        rawSyntaxVisible: answers.some((node) => /\*\*reasoning summary\*\*|## Kiểm tra hiển thị|\| Mục \| Trạng thái \|/.test(node.textContent || "")),
      },
      tableFrame: (() => {
        const wrap = document.querySelector(".md-table-wrap");
        const cell = wrap?.querySelector("th");
        if (!wrap || !cell) return null;
        const wrapStyle = getComputedStyle(wrap);
        const cellStyle = getComputedStyle(cell);
        return {
          wrapBorder: wrapStyle.borderTopStyle,
          wrapRadius: Number.parseFloat(wrapStyle.borderTopLeftRadius),
          overflowX: wrapStyle.overflowX,
          cellRightBorder: cellStyle.borderRightStyle,
          cellBottomBorder: cellStyle.borderBottomStyle,
        };
      })(),
      pathLinks: pathNodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          path: node.dataset.path || "",
          color: style.color,
          background: style.backgroundColor,
          radius: Number.parseFloat(style.borderTopLeftRadius),
          title: node.getAttribute("title") || "",
        };
      }),
      emptyHeroCount: document.querySelectorAll(".empty-hero").length,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });

  if (wide.colors.canvas.toLowerCase() !== "#181818") failures.push(`unexpected canvas ${wide.colors.canvas}`);
  if (wide.colors.side.toLowerCase() !== "#202020") failures.push(`unexpected side pane ${wide.colors.side}`);
  if (!wide.timelineWindow || wide.timelineWindow.width > 782 || wide.timelineWindow.width < 650) failures.push(`timeline reading width ${wide.timelineWindow?.width}`);
  if (!wide.user || !wide.timelineWindow || Math.abs(wide.user.right - (wide.timelineWindow.right - 16)) > 4) failures.push("user bubble is not right aligned");
  if (!wide.composer || wide.composer.width < 650 || wide.composerRadius < 12) failures.push(`composer geometry ${JSON.stringify(wide.composer)} radius=${wide.composerRadius}`);
  if (wide.thoughtCount < 3 || wide.collapsedThoughts !== wide.thoughtCount) failures.push(`thought disclosure ${wide.collapsedThoughts}/${wide.thoughtCount}`);
  if (wide.toolCount < 2) failures.push(`tool rows ${wide.toolCount}`);
  if (wide.collapsedTools !== wide.toolCount) failures.push(`completed tool disclosure ${wide.collapsedTools}/${wide.toolCount}`);
  if (wide.thoughtTitles.some((title) => !title.trim())) failures.push("empty thought title");
  if (wide.thoughtTitles.some((title) => title.trim() === "Thinking")) failures.push(`unfinished thought title ${wide.thoughtTitles.join(" | ")}`);
  for (const [name, surface] of Object.entries(wide.flatSurfaces)) {
    if (!surface) failures.push(`missing ${name} session surface`);
    else if (surface.background !== "rgba(0, 0, 0, 0)" || surface.radius !== 0 || surface.borderTop !== "none" || surface.borderLeft !== "none") {
      failures.push(`${name} session surface still looks like a card ${JSON.stringify(surface)}`);
    }
  }
  if (
    wide.markdown.answerCount < 2 ||
    wide.markdown.structuredCount !== wide.markdown.answerCount ||
    wide.markdown.streamingCount !== 0 ||
    wide.markdown.strongCount < 1 ||
    wide.markdown.headingCount < 1 ||
    wide.markdown.tableCount < 1 ||
    wide.markdown.rawSyntaxVisible
  ) failures.push(`final answers did not remain structured Markdown ${JSON.stringify(wide.markdown)}`);
  if (
    !wide.tableFrame ||
    wide.tableFrame.wrapBorder !== "solid" ||
    wide.tableFrame.wrapRadius !== 0 ||
    !["auto", "scroll"].includes(wide.tableFrame.overflowX) ||
    wide.tableFrame.cellRightBorder !== "solid" ||
    wide.tableFrame.cellBottomBorder !== "solid"
  ) failures.push(`Markdown table is not framed ${JSON.stringify(wide.tableFrame)}`);
  if (wide.pathLinks.length < 2) failures.push(`raw local paths were not hydrated ${JSON.stringify(wide.pathLinks)}`);
  if (wide.pathLinks.some((link) => !link.path || !link.title || link.radius !== 0 || link.background === "rgba(0, 0, 0, 0)" || link.color === "rgb(243, 243, 243)")) {
    failures.push(`path links are not visibly marked blue ${JSON.stringify(wide.pathLinks)}`);
  }
  if (wide.emptyHeroCount !== 0) failures.push(`empty hero remains with conversation content (${wide.emptyHeroCount})`);
  if (wide.horizontalOverflow) failures.push("wide layout has horizontal overflow");
  if (runtimeErrors.length) failures.push(`renderer errors: ${runtimeErrors.join(" | ")}`);

  const firstPathLink = page.locator(".msg.assistant .md-path-link").first();
  if (await firstPathLink.count()) {
    await firstPathLink.click();
    await page.waitForTimeout(40);
    const leftClickActions = await electronApp.evaluate(() => globalThis.__codexPathActions || []);
    if (!leftClickActions.some((entry) => entry.action === "folder" && /Grok-Build\.exe$/i.test(entry.target))) {
      failures.push(`path left-click did not reveal containing folder ${JSON.stringify(leftClickActions)}`);
    }

    await firstPathLink.click({ button: "right" });
    await page.waitForTimeout(40);
    const pathMenu = await page.evaluate(() => {
      const menu = document.querySelector("#pathCtx");
      const rect = menu?.getBoundingClientRect();
      return {
        visible: Boolean(menu && !menu.classList.contains("hidden")),
        items: menu?.querySelectorAll("[data-path-act]").length || 0,
        insideViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
      };
    });
    if (!pathMenu.visible || pathMenu.items < 3 || !pathMenu.insideViewport) failures.push(`path context menu ${JSON.stringify(pathMenu)}`);
    await page.screenshot({ path: path.join(evidenceDir, "codex-session-path-menu-dark-1440x900.png") });
    await page.locator('#pathCtx [data-path-act="open"]').click();
    await page.waitForTimeout(40);
    const contextActions = await electronApp.evaluate(() => globalThis.__codexPathActions || []);
    if (!contextActions.some((entry) => entry.action === "open" && /Grok-Build\.exe$/i.test(entry.target))) {
      failures.push(`path context menu did not open path ${JSON.stringify(contextActions)}`);
    }
  }

  const spacedPathLink = page.locator(".md-path-link").filter({ hasText: "Báo cáo có khoảng trắng" }).first();
  if (!(await spacedPathLink.count())) {
    failures.push("Markdown path with spaces and line suffix was not hydrated");
  } else {
    await spacedPathLink.click();
    await page.waitForTimeout(40);
    const spacedActions = await electronApp.evaluate(() => globalThis.__codexPathActions || []);
    if (!spacedActions.some((entry) => entry.action === "folder" && /grok build\\docs\\report\.md$/i.test(entry.target))) {
      failures.push(`path line suffix was not stripped ${JSON.stringify(spacedActions)}`);
    }
  }

  await page.locator(".msg.assistant").last().evaluate((node) => {
    const rect = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 24,
      clientY: rect.top + 24,
    }));
  });
  await page.waitForTimeout(30);
  const sessionMenu = await page.evaluate(() => {
    const menu = document.querySelector("#sessionCtx");
    const rect = menu?.getBoundingClientRect();
    return {
      visible: Boolean(menu && !menu.classList.contains("hidden")),
      items: menu?.querySelectorAll("[data-session-act]").length || 0,
      insideViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
    };
  });
  if (!sessionMenu.visible || sessionMenu.items !== 3 || !sessionMenu.insideViewport) {
    failures.push(`session context menu ${JSON.stringify(sessionMenu)}`);
  } else {
    await page.screenshot({ path: path.join(evidenceDir, "codex-session-copy-menu-dark-1440x900.png") });
    await page.locator('#sessionCtx [data-session-act="copy"]').click();
    await page.waitForTimeout(30);
    const copyActions = await electronApp.evaluate(() => globalThis.__codexPathActions || []);
    if (!copyActions.some((entry) => entry.action === "copy" && /Timeline hiện dùng/.test(entry.target))) {
      failures.push(`session content was not copied ${JSON.stringify(copyActions.slice(-4))}`);
    }
  }

  await page.evaluate(() => {
    const firstTool = document.querySelector(".cli-tool");
    if (firstTool) firstTool.open = true;
    const timeline = document.querySelector(".timeline");
    if (timeline) timeline.scrollTop = 0;
  });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-expanded-tool-dark-1440x900.png") });
  await page.evaluate(() => {
    const firstTool = document.querySelector(".cli-tool");
    if (firstTool) firstTool.open = false;
  });
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-dark-1440x900.png") });

  await page.locator("#btnUsage").click();
  await page.locator("#sessionInfoRows .session-info-row").first().waitFor();
  const sessionInfoGeometry = await page.locator("#menuUsage").evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: menu.scrollWidth > menu.clientWidth,
      rows: menu.querySelectorAll("#sessionInfoRows .session-info-row").length,
      tabs: menu.querySelectorAll("[data-session-info-tab]").length,
    };
  });
  if (
    sessionInfoGeometry.left < -1 ||
    sessionInfoGeometry.right > sessionInfoGeometry.viewportWidth + 1 ||
    sessionInfoGeometry.top < -1 ||
    sessionInfoGeometry.bottom > sessionInfoGeometry.viewportHeight + 1 ||
    sessionInfoGeometry.horizontalOverflow ||
    sessionInfoGeometry.rows < 12 ||
    sessionInfoGeometry.tabs !== 3
  ) {
    failures.push(`rich session info layout ${JSON.stringify(sessionInfoGeometry)}`);
  }
  await page.locator("#sessionInfoRows .session-info-row").first().click();
  await page.locator("#btnCopySessionInfo").click();
  await page.waitForTimeout(40);
  const sessionCopyActions = await electronApp.evaluate(() => globalThis.__codexPathActions || []);
  if (!sessionCopyActions.some((entry) => entry.action === "copy" && entry.target === "Nâng cấp thông tin session Grok Build")) {
    failures.push(`session row copy missing ${JSON.stringify(sessionCopyActions.slice(-4))}`);
  }
  if (!sessionCopyActions.some((entry) => entry.action === "copy" && /Session ID: 81f5b741/.test(entry.target))) {
    failures.push(`session Copy all missing fields ${JSON.stringify(sessionCopyActions.slice(-4))}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-info-dark-1440x900.png") });
  await page.locator('[data-session-info-tab="context"]').click();
  const contextInfo = await page.evaluate(() => ({
    active: document.querySelector('[data-session-info-panel="context"]')?.classList.contains("active"),
    width: document.querySelector("#sessionContextBar")?.getBoundingClientRect().width || 0,
    text: document.querySelector("#sessionContextDetail")?.textContent || "",
    rows: document.querySelectorAll(".js-usage-session-rows .usage-row").length,
  }));
  if (!contextInfo.active || contextInfo.width <= 0 || !contextInfo.text.includes("32,000") || contextInfo.rows < 5) {
    failures.push(`session context tab ${JSON.stringify(contextInfo)}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-context-dark-1440x900.png") });
  await page.locator("#btnUsage").click();

  await page.locator("#btnTheme").click();
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-light-1440x900.png") });
  await page.locator("#btnTheme").click();
  await page.waitForTimeout(120);

  await page.locator("#btnLang").click();
  await page.waitForTimeout(160);
  const vietnameseSession = await page.evaluate(() => ({
    genericTools: Array.from(document.querySelectorAll(".cli-tool .cli-line-title"))
      .map((node) => node.textContent?.trim() || "")
      .filter((text) => text === "Công cụ").length,
    reviewButtons: Array.from(document.querySelectorAll(".review-chip .review-btn"))
      .map((node) => node.textContent?.trim() || ""),
    reviewTab: document.querySelector('.rtab[data-panel="review"]')?.textContent?.trim() || "",
    reviewTitle: document.querySelector("#panelReview .panel-bar-title")?.textContent?.trim() || "",
  }));
  if (vietnameseSession.genericTools < 1) failures.push(`generic Tool was not localized ${JSON.stringify(vietnameseSession)}`);
  if (!vietnameseSession.reviewButtons.length || vietnameseSession.reviewButtons.some((text) => text !== "Xem thay đổi")) {
    failures.push(`Review buttons were not localized ${JSON.stringify(vietnameseSession)}`);
  }
  if (vietnameseSession.reviewTab !== "Xem thay đổi" || vietnameseSession.reviewTitle !== "Duyệt chỉnh sửa") {
    failures.push(`Review panel was not localized ${JSON.stringify(vietnameseSession)}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-vietnamese-dark-1440x900.png") });

  await setWindowSize(1000, 640);
  await emit([
    { type: "turn_complete", stopReason: "end_turn" },
    { type: "state", state: "connected", detail: "Ready" },
  ]);
  await page.waitForTimeout(260);
  await page.evaluate(() => {
    const timeline = document.querySelector(".timeline");
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  });
  const compact = await page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
    };
    return {
      composer: rect(".composer"),
      editor: rect(".editor-pane"),
      editorDisplay: getComputedStyle(document.querySelector(".editor-pane")).display,
      panelToggleDisplay: getComputedStyle(document.querySelector("#btnTogglePanel")).display,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  if (compact.editorDisplay !== "none" || compact.editor?.width !== 0) failures.push(`compact right panel remains visible ${JSON.stringify(compact.editor)}`);
  if (compact.panelToggleDisplay !== "none") failures.push(`compact right panel toggle remains visible ${compact.panelToggleDisplay}`);
  if (!compact.composer || compact.composer.bottom > compact.viewport.height + 1 || compact.composer.width < 560) failures.push(`compact composer ${JSON.stringify(compact.composer)}`);
  if (compact.horizontalOverflow) failures.push("compact layout has horizontal overflow");
  const compactPathLink = page.locator(".msg.assistant .md-path-link").first();
  if (await compactPathLink.count()) {
    await compactPathLink.click({ button: "right" });
    await page.waitForTimeout(30);
    const compactPathMenu = await page.evaluate(() => {
      const menu = document.querySelector("#pathCtx");
      const rect = menu?.getBoundingClientRect();
      return {
        visible: Boolean(menu && !menu.classList.contains("hidden")),
        insideViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight),
      };
    });
    if (!compactPathMenu.visible || !compactPathMenu.insideViewport) failures.push(`compact path menu ${JSON.stringify(compactPathMenu)}`);
    await page.keyboard.press("Escape");
  }
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-dark-1000x640.png") });
  await page.locator("#btnUsage").click();
  await page.locator("#menuUsage:not(.hidden)").waitFor();
  const compactSessionInfo = await page.locator("#menuUsage").evaluate((menu) => {
    const rect = menu.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: menu.scrollWidth > menu.clientWidth,
    };
  });
  if (
    compactSessionInfo.left < -1 ||
    compactSessionInfo.right > compactSessionInfo.viewportWidth + 1 ||
    compactSessionInfo.top < -1 ||
    compactSessionInfo.bottom > compactSessionInfo.viewportHeight + 1 ||
    compactSessionInfo.horizontalOverflow
  ) {
    failures.push(`compact session info ${JSON.stringify(compactSessionInfo)}`);
  }
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-info-vietnamese-dark-1000x640.png") });
  await page.locator("#btnUsage").click();

  await setWindowSize(1180, 640);
  await page.waitForTimeout(80);
  const hiddenBoundary = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector(".editor-pane")).display,
    toggle: getComputedStyle(document.querySelector("#btnTogglePanel")).display,
  }));
  if (hiddenBoundary.panel !== "none" || hiddenBoundary.toggle !== "none") failures.push(`1180px boundary is not hidden ${JSON.stringify(hiddenBoundary)}`);

  await setWindowSize(1181, 640);
  await page.waitForTimeout(80);
  const visibleBoundary = await page.evaluate(() => ({
    panel: getComputedStyle(document.querySelector(".editor-pane")).display,
    panelWidth: document.querySelector(".editor-pane")?.getBoundingClientRect().width || 0,
    toggle: getComputedStyle(document.querySelector("#btnTogglePanel")).display,
  }));
  if (visibleBoundary.panel === "none" || visibleBoundary.panelWidth < 220 || visibleBoundary.toggle === "none") failures.push(`1181px boundary did not restore the panel ${JSON.stringify(visibleBoundary)}`);

  // Direct persisted-session path: IPC parser → event store → production timeline.
  await setWindowSize(1440, 900);
  const persisted = await page.evaluate(async (sessionId) => {
    const turns = await globalThis.grokBuild.readTranscript(sessionId);
    const store = globalThis.GrokEventStore.create();
    store.loadTurns(turns);
    const previousRoot = document.querySelector(".timeline");
    const root = document.createElement("div");
    root.id = "persistedTimelineEvidence";
    root.className = "timeline";
    previousRoot.style.visibility = "hidden";
    root.style.position = "absolute";
    root.style.inset = "72px 0 124px";
    root.style.zIndex = "6";
    root.style.background = "var(--bg)";
    document.querySelector(".conversation").appendChild(root);
    const view = globalThis.GrokTimelineView.create(root, {
      store,
      showReasoning: () => true,
      t: (_key, fallback) => fallback,
    });
    view.render();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const thoughtTitles = Array.from(root.querySelectorAll(".cli-thought .cli-line-title"))
      .map((node) => node.textContent || "");
    const rootRect = root.getBoundingClientRect();
    const firstItemRect = root.querySelector(".tl-item")?.getBoundingClientRect();
    return {
      order: store.items.map((item) => item.kind).join(","),
      thoughtTitles,
      thoughtCount: store.items.filter((item) => item.kind === "thought").length,
      encryptedVisible: document.body.innerText.includes("encrypted-payload-must-not-render") || document.body.innerText.includes("second-secret-ciphertext"),
      rootRect: { left: rootRect.left, top: rootRect.top, width: rootRect.width, height: rootRect.height },
      firstItemRect: firstItemRect ? { left: firstItemRect.left, top: firstItemRect.top, width: firstItemRect.width, height: firstItemRect.height } : null,
      rootScroll: { top: root.scrollTop, height: root.scrollHeight, client: root.clientHeight },
    };
  }, persistedSessionId);
  if (persisted.order !== "user,thought,assistant,user,thought,assistant") failures.push(`persisted order ${persisted.order}`);
  if (persisted.thoughtCount !== 2 || persisted.thoughtTitles.some((title) => title === "Thinking" || !title.trim())) failures.push(`persisted thought labels ${persisted.thoughtTitles.join(" | ")}`);
  if (persisted.encryptedVisible) failures.push("encrypted reasoning is visible in persisted-session render");
  if (!persisted.firstItemRect || persisted.firstItemRect.height <= 0 || persisted.firstItemRect.top < persisted.rootRect.top - 1 || persisted.firstItemRect.top > persisted.rootRect.top + persisted.rootRect.height) failures.push(`persisted pixels outside viewport ${JSON.stringify(persisted)}`);
  await page.screenshot({ path: path.join(evidenceDir, "codex-session-resumed-dark-1440x900.png") });

  if (failures.length) throw new Error(failures.join("; "));
  console.log(`Codex-like session UI OK (${version}): live thoughts=${wide.thoughtCount}, tools=${wide.toolCount}, persisted thoughts=${persisted.thoughtCount}, reading=${wide.timelineWindow.width.toFixed(0)}px.`);
  console.log(`Visual evidence written to ${evidenceDir}`);
} finally {
  await electronApp.close();
  await rm(profileDir, { recursive: true, force: true });
}
