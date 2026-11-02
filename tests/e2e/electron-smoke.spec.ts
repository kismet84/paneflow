import { resolve } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const approvalFixtureMarker = resolve(".approval-fixture");
const runLiveApproval = existsSync(resolve(".live-approval"));
const userApprovalFixtureMarker = resolve(".user-approval-fixture");
const sessionFixtureMarker = resolve(".session-fixture");
rmSync(approvalFixtureMarker, { force: true });
rmSync(sessionFixtureMarker, { force: true });
if (!runLiveApproval) rmSync(userApprovalFixtureMarker, { force: true });

const isolatedEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !["CODEX_PANE_E2E_EXE", "CODEX_PANE_LIVE_TURN", "CODEX_PANE_LIVE_CONCURRENCY", "CODEX_PANE_SCREENSHOT_PATH"].includes(entry[0]) && typeof entry[1] === "string")),
  ...(!process.env.CODEX_PANE_E2E_EXE ? { CODEX_PANE_LOAD_DIST: "1" } : {}),
  CODEX_PANE_USER_DATA_DIR: resolve("test-results", `user-data-${randomUUID()}`)
});

const envWithoutCodex = (): Record<string, string> => {
  const env = Object.fromEntries(Object.entries(isolatedEnv()).filter(([key]) => key.toLowerCase() !== "path"));
  env.Path = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`;
  return env;
};

const electronFlags = ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle"];
const launchApplication = (env: Record<string, string>) => process.env.CODEX_PANE_E2E_EXE
  ? electron.launch({ executablePath: resolve(process.env.CODEX_PANE_E2E_EXE), args: electronFlags, env })
  : electron.launch({ args: [...electronFlags, resolve(".")], env });

const selectLayout = async (window: Awaited<ReturnType<ElectronApplication["firstWindow"]>>, label: string): Promise<void> => {
  await window.getByRole("button", { name: "切换窗格布局" }).click();
  await window.locator('[data-dropdown-option="true"]').getByText(label, { exact: true }).click();
};

test("stays usable and explains how to recover when codex is missing", async () => {
  const application = await launchApplication(envWithoutCodex());
  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("Codex Pane");
    await expect(window.getByText(/无法读取 Codex 版本|找不到 codex 命令|无法启动 Codex/).first()).toBeVisible({ timeout: 20_000 });
    await expect(window.getByRole("button", { name: "重新连接 app-server" })).toBeVisible();
  } finally {
    await application.close();
  }
});

test("supports two application instances with isolated Chromium data", async () => {
  const sharedUserData = resolve("test-results", `multi-instance-${randomUUID()}`);
  const env = { ...envWithoutCodex(), CODEX_PANE_USER_DATA_DIR: sharedUserData };
  const first = await launchApplication(env);
  let second: ElectronApplication | null = null;
  try {
    const firstWindow = await first.firstWindow();
    await expect(firstWindow).toHaveTitle("Codex Pane");
    second = await launchApplication(env);
    const secondWindow = await second.firstWindow();
    await expect(secondWindow).toHaveTitle("Codex Pane");
    await expect(firstWindow.getByText("Codex Pane", { exact: true })).toBeVisible();
    await expect(secondWindow.getByText("Codex Pane", { exact: true })).toBeVisible();
    const firstSessionData = await first.evaluate(({ app }) => app.getPath("sessionData"));
    const secondSessionData = await second.evaluate(({ app }) => app.getPath("sessionData"));
    expect(firstSessionData).not.toBe(secondSessionData);
    expect(firstSessionData).toContain(sharedUserData);
    expect(secondSessionData).toContain(sharedUserData);
  } finally {
    await first.close();
    await second?.close();
  }
});

test("switches sessions in the persistent session-sidebar mode", async () => {
  await writeFile(sessionFixtureMarker, "", "utf8");
  const env = isolatedEnv();
  let application: ElectronApplication | null = null;
  try {
    application = await launchApplication(env);
    let window = await application.firstWindow();
    await expect(window.getByRole("button", { name: "设置" })).toBeVisible({ timeout: 20_000 });
    await window.getByRole("button", { name: "设置" }).click();
    const settingsDialog = window.getByRole("dialog").filter({ hasText: "工作台模式" });
    await settingsDialog.getByText("会话侧栏", { exact: true }).click();
    await settingsDialog.getByRole("button", { name: /关闭|close/i }).click();
    await expect(window.locator(".session-sidebar")).toBeVisible();
    await window.getByRole("button", { name: "收起会话列表" }).click();
    await expect(window.locator(".session-sidebar")).toBeHidden();
    await window.getByRole("button", { name: "展开会话列表" }).click();
    await expect(window.locator(".session-sidebar")).toBeVisible();
    await expect(window.locator(".pane")).toHaveCount(1);
    await expect.poll(() => window.locator("section.pane").evaluate((pane) => {
      const composer = pane.querySelector<HTMLElement>(".composer");
      return composer ? Math.round(pane.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom) : -1;
    })).toBeLessThanOrEqual(1);
    await expect(window.getByText("示例会话 A", { exact: true })).toBeVisible();
    await window.getByText("示例会话 B", { exact: true }).click();
    await expect(window.locator("section.pane")).toHaveAttribute("aria-label", "示例会话 B");
    await window.waitForTimeout(700);

    await application.close();
    application = await launchApplication(env);
    window = await application.firstWindow();
    await expect(window.locator(".session-sidebar")).toBeVisible({ timeout: 20_000 });
    await expect(window.locator(".pane")).toHaveCount(1);
    await expect(window.locator("section.pane")).toHaveAttribute("aria-label", "示例会话 B");
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(sessionFixtureMarker, { force: true });
    }
  }
});

test("starts the desktop workbench and connects to Codex", async () => {
  const pageErrors: string[] = [];
  const application = await launchApplication(isolatedEnv());
  try {
    application.process().stdout?.on("data", (data) => process.stdout.write(`[electron:stdout] ${String(data)}`));
    application.process().stderr?.on("data", (data) => process.stdout.write(`[electron:stderr] ${String(data)}`));
    const window = await application.firstWindow();
    window.on("console", (message) => process.stdout.write(`[renderer:${message.type()}] ${message.text()}\n`));
    window.on("pageerror", (error) => {
      pageErrors.push(error.message);
      process.stdout.write(`[renderer:error] ${error.message}\n`);
    });
    await expect(window).toHaveTitle("Codex Pane");
    await expect(window.getByRole("button", { name: "设置" })).toBeVisible();
    await expect(window.getByText("Codex Pane", { exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toBeVisible({ timeout: 20_000 });
    const chromeMetrics = await window.evaluate(() => {
      const shellScroller = document.querySelector<HTMLElement>(".app-shell > .n-layout-scroll-container");
      const titlebar = document.querySelector<HTMLElement>(".custom-titlebar")!;
      const closeButton = document.querySelector<HTMLElement>('.window-control[aria-label="关闭"]')!;
      const closeGlyph = closeButton.querySelector<HTMLElement>(".window-close-icon")!;
      const titlebarBox = titlebar.getBoundingClientRect();
      const buttonBox = closeButton.getBoundingClientRect();
      const glyphBox = closeGlyph.getBoundingClientRect();
      return {
        documentOverflow: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        bodyOverflow: document.body.scrollHeight - document.body.clientHeight,
        shellOverflow: shellScroller ? shellScroller.scrollHeight - shellScroller.clientHeight : null,
        shellOverflowStyle: shellScroller ? getComputedStyle(shellScroller).overflow : null,
        buttonCenterOffset: Math.abs((buttonBox.top + buttonBox.height / 2) - (titlebarBox.top + titlebarBox.height / 2)),
        glyphCenterOffset: Math.abs((glyphBox.top + glyphBox.height / 2) - (buttonBox.top + buttonBox.height / 2))
      };
    });
    expect(chromeMetrics).toMatchObject({ documentOverflow: 0, bodyOverflow: 0, shellOverflow: 0, shellOverflowStyle: "hidden" });
    expect(chromeMetrics.buttonCenterOffset).toBeLessThanOrEqual(0.5);
    expect(chromeMetrics.glyphCenterOffset).toBeLessThanOrEqual(0.5);
    await selectLayout(window, "六宫格");
    await expect(window.locator(".pane")).toHaveCount(6);
    const secondModelSelect = window.locator("[data-pane-id='pane-2'] .model-select");
    const secondComposer = window.locator("[data-pane-id='pane-2'] textarea");
    await secondModelSelect.click();
    await expect(window.locator(".n-base-select-menu")).toBeVisible();
    expect(Number.parseFloat(await window.locator(".n-base-select-menu").evaluate((element) => getComputedStyle(element).borderTopWidth))).toBeGreaterThanOrEqual(0.5);
    await expect(secondComposer).not.toBeFocused();
    await window.keyboard.press("Escape");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(960, 680));
    await window.waitForTimeout(150);
    const narrowStatus = window.locator(".status-line").first();
    const narrowComposerActions = window.locator(".composer-actions").first();
    expect(await narrowStatus.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("wrap");
    expect(await narrowComposerActions.evaluate((element) => getComputedStyle(element).flexWrap)).toBe("wrap");
    expect((await window.locator(".model-select").first().boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(116);
    expect(await narrowStatus.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await narrowComposerActions.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(Number.parseFloat(await narrowStatus.evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    expect(Number.parseFloat(await window.locator(".cwd-text").first().evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1480, 920));
    await selectLayout(window, "横向四栏");
    await expect(window.locator(".pane")).toHaveCount(4);
    const columnBoxes = await window.locator(".pane").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top };
    }));
    expect(Math.max(...columnBoxes.map((box) => box.top)) - Math.min(...columnBoxes.map((box) => box.top))).toBeLessThanOrEqual(2);
    expect(new Set(columnBoxes.map((box) => Math.round(box.left))).size).toBe(4);
    expect(columnBoxes.map((box) => box.left)).toEqual([...columnBoxes.map((box) => box.left)].sort((left, right) => left - right));
    await selectLayout(window, "纵向四栏");
    await expect(window.locator(".pane")).toHaveCount(4);
    const rowBoxes = await window.locator(".pane").evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top };
    }));
    expect(Math.max(...rowBoxes.map((box) => box.left)) - Math.min(...rowBoxes.map((box) => box.left))).toBeLessThanOrEqual(2);
    expect(new Set(rowBoxes.map((box) => Math.round(box.top))).size).toBe(4);
    expect(rowBoxes.map((box) => box.top)).toEqual([...rowBoxes.map((box) => box.top)].sort((top, bottom) => top - bottom));
    await selectLayout(window, "四宫格");
    await expect(window.locator(".pane")).toHaveCount(4);
    await expect(window.getByRole("textbox", { name: "消息输入框" })).toHaveCount(4);
    const firstComposer = window.getByRole("textbox", { name: "消息输入框" }).first();
    expect(await firstComposer.evaluate((element) => (element as HTMLTextAreaElement).spellcheck)).toBe(false);
    const composerSurface = window.locator("[data-pane-id='pane-1'] .n-input");
    const composerBackgroundBeforeFocus = await composerSurface.evaluate((element) => getComputedStyle(element).backgroundColor);
    await firstComposer.focus();
    const focusMetrics = await window.locator("[data-pane-id='pane-1']").evaluate((element) => {
      const highlight = getComputedStyle(element, "::after");
      const selectionBorder = getComputedStyle(element.querySelector(".model-select .n-base-selection__state-border")!);
      const composer = getComputedStyle(element.querySelector(".composer .n-input")!);
      return {
        highlightDisplay: highlight.display,
        highlightTop: highlight.borderTopWidth,
        highlightBottom: highlight.borderBottomWidth,
        highlightLeft: highlight.borderLeftWidth,
        highlightRight: highlight.borderRightWidth,
        selectionBorder: selectionBorder.borderTopWidth,
        composerBackground: composer.backgroundColor
      };
    });
    expect(focusMetrics.highlightDisplay).toBe("block");
    for (const edge of [focusMetrics.highlightTop, focusMetrics.highlightBottom, focusMetrics.highlightLeft, focusMetrics.highlightRight]) {
      expect(Number.parseFloat(edge)).toBeGreaterThanOrEqual(1.5);
    }
    expect(Number.parseFloat(focusMetrics.selectionBorder)).toBeGreaterThanOrEqual(0.5);
    expect(focusMetrics.composerBackground).toBe(composerBackgroundBeforeFocus);
    await firstComposer.fill("/");
    await expect(window.getByText("/new", { exact: true })).toBeVisible();
    await firstComposer.fill("");
    await application.evaluate(({ clipboard }) => clipboard.writeText("https://example.com/codex-pane-test.png"));
    await firstComposer.focus();
    await window.keyboard.press("Control+V");
    await expect(firstComposer).toHaveValue("https://example.com/codex-pane-test.png");
    await expect(window.getByText("codex-pane-test.png", { exact: true })).toHaveCount(0);
    const userDataPath = await application.evaluate(({ app }) => app.getPath("userData"));
    await firstComposer.fill("");
    await firstComposer.fill("/resume");
    await firstComposer.press("Enter");
    await expect(firstComposer).toHaveValue(/^\/resume\s*$/);
    await firstComposer.press("Enter");
    await expect(window.getByText("恢复会话", { exact: true })).toBeVisible();
    await expect(window.getByPlaceholder("按标题或内容搜索历史会话")).toBeVisible();
    await expect(window.getByRole("button", { name: "仅当前目录" })).toBeVisible();
    await expect(window.getByRole("button", { name: "仅当前目录" })).toBeDisabled();
    await expect(window.getByText("正在显示所有工作目录", { exact: true })).toBeVisible();
    const sessionPage = window.locator("[data-pane-id='pane-1'] .session-pane-page");
    await expect(sessionPage).toBeVisible();
    const paneBox = await window.locator("[data-pane-id='pane-1']").boundingBox();
    const sessionBox = await sessionPage.boundingBox();
    expect(Math.abs((paneBox?.width ?? 0) - (sessionBox?.width ?? 0))).toBeLessThanOrEqual(4);
    expect(Math.abs((paneBox?.height ?? 0) - (sessionBox?.height ?? 0))).toBeLessThanOrEqual(4);
    await expect(window.locator("[data-pane-id='pane-2'] .session-pane-page")).toHaveCount(0);
    await window.keyboard.press("Escape");
    await expect(sessionPage).toHaveCount(0);
    await expect(firstComposer).toBeFocused();
    await window.waitForTimeout(700);
    const persisted = JSON.parse(await readFile(resolve(userDataPath, "workspaces/default.json"), "utf8")) as { layout: string; panes: unknown[] };
    expect(persisted.layout).toBe("quad");
    expect(persisted.panes).toHaveLength(6);
    await window.getByRole("button", { name: "设置" }).click();
    await expect(window.getByText("设置", { exact: true })).toBeVisible();
    await expect(window.getByText("默认模型", { exact: true })).toBeVisible();
    await expect(window.getByText("权限配置", { exact: true })).toBeVisible();
    await expect(window.getByText("pwsh 路径", { exact: true })).toBeVisible();
    await expect(window.getByText(/新会话默认使用这里的目录/)).toHaveCount(0);
    await expect(window.getByText(/这些值由本机 Codex 决定/)).toHaveCount(0);
    const fontReadback = window.getByText(/已读取 \d+ 个字体系列/);
    await expect(fontReadback).toBeVisible();
    expect(Number((await fontReadback.textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(0);
    const settingsDialog = window.getByRole("dialog").filter({ hasText: "Codex 运行环境" });
    const settingsControlBorders = await settingsDialog.locator(".n-input__state-border, .n-base-selection__state-border, .n-color-picker").evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).borderTopWidth)));
    expect(settingsControlBorders.length).toBeGreaterThanOrEqual(4);
    expect(settingsControlBorders.every((width) => width >= 0.7)).toBe(true);
    const settingsBox = await settingsDialog.boundingBox();
    expect(settingsBox?.height ?? 1000).toBeLessThanOrEqual(720);
    expect((await window.evaluate(() => innerHeight)) - (settingsBox?.height ?? 0)).toBeGreaterThanOrEqual(90);
    await settingsDialog.getByText("会话侧栏", { exact: true }).click();
    await expect(window.locator(".session-sidebar")).toBeVisible();
    await expect(window.locator(".pane")).toHaveCount(1);
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toHaveCount(0);
    await settingsDialog.getByRole("button", { name: /关闭|close/i }).click();
    await expect(settingsDialog).toHaveCount(0);
    await expect(window.getByRole("button", { name: "新建会话" })).toBeVisible();
    await expect(window.locator(".session-list-scroll")).toBeVisible();
    const sessionModeMetrics = await window.locator(".session-workspace").evaluate((element) => {
      const sidebar = element.querySelector<HTMLElement>(".session-sidebar")!;
      const newSessionButton = sidebar.querySelector<HTMLElement>(".session-new-button")!;
      const pane = element.querySelector<HTMLElement>(".session-workspace-pane")!;
      const sidebarBounds = sidebar.getBoundingClientRect();
      const buttonBounds = newSessionButton.getBoundingClientRect();
      return {
        overflow: element.scrollWidth - element.clientWidth,
        newButtonLeftInset: buttonBounds.left - sidebarBounds.left,
        newButtonRightInset: sidebarBounds.right - buttonBounds.right,
        sidebarHeight: sidebar.getBoundingClientRect().height,
        paneHeight: pane.getBoundingClientRect().height,
        totalHeight: element.getBoundingClientRect().height,
        focusBorderDisplay: getComputedStyle(pane.querySelector(".pane")!, "::after").display
      };
    });
    expect(sessionModeMetrics.overflow).toBe(0);
    expect(sessionModeMetrics.newButtonLeftInset).toBeGreaterThanOrEqual(11);
    expect(sessionModeMetrics.newButtonRightInset).toBeGreaterThanOrEqual(11);
    expect(Math.abs(sessionModeMetrics.sidebarHeight - sessionModeMetrics.totalHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(sessionModeMetrics.paneHeight - sessionModeMetrics.totalHeight)).toBeLessThanOrEqual(2);
    expect(sessionModeMetrics.focusBorderDisplay).toBe("none");
    await window.waitForTimeout(700);
    const sessionModeState = JSON.parse(await readFile(resolve(userDataPath, "workspaces/default.json"), "utf8")) as { workspaceMode: string; layout: string };
    expect(sessionModeState).toMatchObject({ workspaceMode: "sessionSidebar", layout: "quad" });
    await window.getByRole("button", { name: "设置" }).click();
    const sessionModeSettings = window.getByRole("dialog").filter({ hasText: "工作台模式" });
    await sessionModeSettings.getByText("多窗格", { exact: true }).click();
    await sessionModeSettings.getByRole("button", { name: /关闭|close/i }).click();
    await expect(window.locator(".pane")).toHaveCount(4);
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toBeVisible();
    await selectLayout(window, "单窗格");
    await expect(window.locator(".pane")).toHaveCount(1);
    expect(await window.locator(".pane").evaluate((element) => getComputedStyle(element, "::after").display)).toBe("none");
    await selectLayout(window, "四宫格");
    await expect(window.locator(".pane")).toHaveCount(4);
    if (process.env.CODEX_PANE_SCREENSHOT_PATH) {
      await window.screenshot({ path: process.env.CODEX_PANE_SCREENSHOT_PATH, fullPage: true });
    }
  } finally {
    await application.close();
  }
  expect(pageErrors).toEqual([]);
});

test("completes a server-request approval through renderer, preload, IPC, and app-server stdio", async () => {
  const responseLog = resolve("test-results", "approval-response.jsonl");
  await writeFile(responseLog, "", "utf8");
  await writeFile(approvalFixtureMarker, "", "utf8");
  const env = isolatedEnv();
  let application: ElectronApplication | null = null;
  try {
    application = await launchApplication(env);
    const window = await application.firstWindow();
    await expect(window.getByText("命令需要确认", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(window.getByText("验证完整审批链路", { exact: true })).toBeVisible();
    await expect.poll(() => window.evaluate(() => document.activeElement?.textContent?.trim())).toContain("允许一次");
    await window.keyboard.press("Enter");
    await expect(window.getByText("命令需要确认", { exact: true })).toHaveCount(0);
    await expect.poll(async () => {
      try {
        return (await readFile(responseLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    }).toEqual([{ id: "approval-fixture-1", result: { decision: "accept" } }]);
  } finally {
    try {
      await application?.close();
    } finally {
      await rm(approvalFixtureMarker, { force: true });
    }
  }
});

test("completes a real Codex turn", async () => {
  test.skip(process.env.CODEX_PANE_LIVE_TURN !== "1", "Set CODEX_PANE_LIVE_TURN=1 for the authenticated live smoke test.");
  test.setTimeout(120_000);
  const application = await launchApplication(isolatedEnv());
  try {
    const window = await application.firstWindow();
    window.on("pageerror", (error) => process.stdout.write(`[live-renderer:error] ${error.message}\n`));
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toBeVisible({ timeout: 20_000 });
    await selectLayout(window, "单窗格");
    const composer = window.getByRole("textbox", { name: "消息输入框" }).first();
    const initialAgentMessageCount = await window.locator(".message-agent").count();
    await composer.fill("只回复“Codex Pane 联调成功”，不要调用任何工具。" );
    await composer.press("Enter");
    await expect(window.locator(".message-agent")).toHaveCount(initialAgentMessageCount + 1, { timeout: 90_000 });
    await expect(window.locator(".message-agent").last()).toContainText("Codex Pane 联调成功");
    await expect(window.getByText(/Working/)).toHaveCount(0, { timeout: 20_000 });

    const imagePath = resolve("node_modules/app-builder-lib/templates/icons/electron-linux/64x64.png");
    await application.evaluate(async ({ ClipboardItem, clipboard, nativeImage }, path) => {
      const png = Uint8Array.from(nativeImage.createFromPath(path).toPNG());
      await clipboard.write([new ClipboardItem({ "image/png": new Blob([png], { type: "image/png" }) })]);
    }, imagePath);
    await composer.focus();
    await window.keyboard.press("Control+V");
    await expect(window.getByRole("button", { name: "移除 剪贴板图片.png" })).toBeVisible();
    await composer.fill("只回复“图片附件联调成功”，不要调用任何工具。" );
    await composer.press("Enter");
    await expect(window.locator(".message-agent")).toHaveCount(initialAgentMessageCount + 2, { timeout: 90_000 });
    await expect(window.locator(".message-agent").last()).toContainText("图片附件联调成功");
  } finally {
    await application.close();
  }
});

test("rejects a real Codex command approval without executing the command", async () => {
  test.skip(!runLiveApproval, "Run npm run test:approval:live for the authenticated approval smoke test.");
  test.setTimeout(120_000);
  const targetPath = `C:\\codex-pane-approval-smoke-${randomUUID()}.txt`;
  expect(existsSync(targetPath)).toBe(false);
  const application = await launchApplication(isolatedEnv());
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toBeVisible({ timeout: 20_000 });
    await selectLayout(window, "单窗格");
    const composer = window.getByRole("textbox", { name: "消息输入框" }).first();
    await composer.fill(`请只尝试通过命令工具执行 PowerShell 命令 Set-Content -LiteralPath '${targetPath}' -Value 'must-not-exist'。必须第一次就使用 require_escalated 请求批准，不要先在普通沙箱执行；如果我拒绝就立即停止，不要重试，也不要改用文件编辑工具。`);
    await composer.press("Enter");
    await expect(window.getByText("命令需要确认", { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(window.getByText(targetPath, { exact: false })).toBeVisible();
    await window.getByRole("button", { name: /拒绝/ }).first().click();
    await expect(window.getByText("命令需要确认", { exact: true })).toHaveCount(0);
    await expect(window.getByText(/Working/)).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await application.close();
  }
  expect(existsSync(targetPath)).toBe(false);
});

test("routes four concurrent Codex turns to their own panes", async () => {
  test.skip(process.env.CODEX_PANE_LIVE_CONCURRENCY !== "1", "Set CODEX_PANE_LIVE_CONCURRENCY=1 for the authenticated concurrency smoke test.");
  test.setTimeout(120_000);
  const application = await launchApplication(isolatedEnv());
  try {
    const window = await application.firstWindow();
    await expect(window.getByRole("button", { name: "切换窗格布局" })).toBeVisible({ timeout: 20_000 });
    await selectLayout(window, "四宫格");
    const panes = window.locator(".pane");
    await expect(panes).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      const pane = window.locator(`[data-pane-id="pane-${index + 1}"]`);
      const paneComposer = pane.getByRole("textbox", { name: "消息输入框" });
      await paneComposer.fill("/new");
      await paneComposer.press("Enter");
      await paneComposer.press("Enter");
      await expect(pane.locator(".message-agent")).toHaveCount(0);
    }
    for (let index = 0; index < 4; index += 1) {
      const composer = window.locator(`[data-pane-id="pane-${index + 1}"]`).getByRole("textbox", { name: "消息输入框" });
      await composer.fill(`只回复“PANE-${index + 1}-OK”，不要调用任何工具。`);
    }
    for (let index = 0; index < 4; index += 1) {
      const composer = window.locator(`[data-pane-id="pane-${index + 1}"]`).getByRole("textbox", { name: "消息输入框" });
      await composer.press("Enter");
    }
    await window.waitForTimeout(15_000);
    for (let index = 0; index < 4; index += 1) {
      const paneText = await window.locator(`[data-pane-id="pane-${index + 1}"]`).innerText();
      process.stdout.write(`[pane-${index + 1}] ${paneText.slice(-800)}\n`);
    }
    for (let index = 0; index < 4; index += 1) {
      const messages = window.locator(`[data-pane-id="pane-${index + 1}"]`).locator(".message-agent");
      await expect(messages).toHaveCount(1, { timeout: 90_000 });
      await expect(messages.last()).toContainText(`PANE-${index + 1}-OK`);
    }
  } finally {
    await application.close();
  }
});
