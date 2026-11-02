import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page, type TestInfo } from "@playwright/test";
import { WebSocket } from "ws";

const sessionFixtureMarker = resolve(".session-fixture");

const isolatedEnv = (requestLog: string, approvalResponseLog: string): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  CODEX_PANE_LOAD_DIST: "1",
  CODEX_PANE_USER_DATA_DIR: resolve("test-results", `remote-user-data-${randomUUID()}`),
  CODEX_PANE_REQUEST_LOG: requestLog,
  CODEX_PANE_APPROVAL_ON_TURN_START: "1",
  CODEX_PANE_MCP_APPROVAL_AFTER_COMMAND: "1",
  CODEX_PANE_DESKTOP_TURN_ON_THREAD_B: "1",
  CODEX_PANE_APPROVAL_RESPONSE_LOG: approvalResponseLog,
  CODEX_PANE_DISABLE_HARDWARE_ACCELERATION: "1"
});

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a relay port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
};

const waitForRelay = async (origin: string, process: ChildProcess): Promise<void> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Relay exited with code ${process.exitCode}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch { /* Relay is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("Relay did not become healthy");
};

const terminateApplication = async (application: ElectronApplication): Promise<void> => {
  const pid = application.process().pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* The application may already be closed. */ }
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => { try { killer.kill(); } catch { /* The cleanup process may already be closed. */ } finish(); }, 5_000);
    killer.once("error", finish);
    killer.once("exit", finish);
  });
};

const expectMobileRejected = async (origin: string, attach: (challenge: { connectionId: string; nonce: string }) => unknown): Promise<string> => new Promise((resolvePromise, reject) => {
  const url = new URL(origin);
  url.protocol = "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/ws`;
  const socket = new WebSocket(url);
  const timeout = setTimeout(() => { socket.terminate(); reject(new Error("Unknown mobile connection was not rejected")); }, 5_000);
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw)) as { type?: string; connectionId?: string; nonce?: string };
    if (message.type === "relay.challenge" && message.connectionId && message.nonce) socket.send(JSON.stringify(attach({ connectionId: message.connectionId, nonce: message.nonce })));
  });
  socket.on("close", (code, reason) => {
    clearTimeout(timeout);
    if (code !== 1008) return reject(new Error(`Unknown mobile closed with unexpected code ${code}`));
    resolvePromise(String(reason));
  });
  socket.on("error", reject);
});

const openMobileWindow = async (application: ElectronApplication, url: string, partition?: string): Promise<Page> => {
  const existing = new Set(application.windows());
  await application.evaluate(async ({ BrowserWindow }, { target, sessionPartition }) => {
    const window = new BrowserWindow({
      show: true,
      width: 402,
      height: 874,
      resizable: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, ...(sessionPartition ? { partition: sessionPartition } : {}) }
    });
    await window.loadURL(target, { userAgent: "Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36" });
  }, { target: url, sessionPartition: partition });
  await expect.poll(() => application.windows().length).toBeGreaterThan(existing.size);
  const mobile = application.windows().find((window) => !existing.has(window));
  if (!mobile) throw new Error("Mobile test window was not created");
  return mobile;
};

const attachScreenshot = async (testInfo: TestInfo, name: string, page: Page): Promise<void> => {
  const screenshot = await page.screenshot({ type: "png" });
  const auditDirectory = process.env.CODEX_PANE_AUDIT_SCREENSHOT_DIR;
  if (auditDirectory) await writeFile(resolve(auditDirectory, `${name}.png`), screenshot);
  await testInfo.attach(name, { body: screenshot, contentType: "image/png" });
};

test("completes the real thin-relay pairing, Passkey, E2EE, UI delivery, and conversation flow", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const requestLog = resolve("test-results", `remote-app-server-${randomUUID()}.jsonl`);
  const approvalResponseLog = resolve("test-results", `remote-approval-${randomUUID()}.jsonl`);
  await Promise.all([writeFile(sessionFixtureMarker, "", "utf8"), writeFile(requestLog, "", "utf8"), writeFile(approvalResponseLog, "", "utf8")]);
  const port = await freePort();
  const publicOrigin = `http://localhost:${port}`;
  const relayBasePath = "/codex-pane-relay";
  const relayOrigin = `${publicOrigin}${relayBasePath}`;
  const relay = spawn(process.execPath, [resolve("remote", "relay", "dist", "server.js")], {
    cwd: resolve("remote", "relay"),
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), PUBLIC_ORIGIN: publicOrigin, BASE_PATH: relayBasePath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  relay.stderr?.on("data", (data) => process.stdout.write(`[relay:stderr] ${String(data)}`));
  await waitForRelay(relayOrigin, relay);

  const desktopEnvironment = isolatedEnv(requestLog, approvalResponseLog);
  const applications: ElectronApplication[] = [];
  const application = await electron.launch({ args: ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle", resolve(".")], env: desktopEnvironment });
  applications.push(application);
  let mobile: Page | null = null;
  let secondMobile: Page | null = null;
  try {
    application.process().stderr?.on("data", (data) => process.stdout.write(`[remote-electron:stderr] ${String(data)}`));
    const desktop = await application.firstWindow();
    await desktop.getByRole("button", { name: "设置" }).click();
    const settings = desktop.getByRole("dialog").filter({ hasText: "远程访问" });
    await settings.waitFor({ state: "visible" });
    await desktop.waitForTimeout(250);
    await settings.locator(".n-radio-button").filter({ hasText: "浅色" }).click();
    await attachScreenshot(testInfo, "remote-settings-initial", desktop);
    await settings.locator(".n-form-item").filter({ hasText: "启用远程访问" }).getByRole("switch").click();
    await settings.getByPlaceholder("https://pane.example.com").fill(relayOrigin);
    await settings.getByRole("button", { name: "保存并连接" }).click();
    await expect(settings.getByText("已连接中转服务", { exact: true })).toBeVisible({ timeout: 10_000 });
    await settings.getByRole("button", { name: "生成配对二维码" }).click();
    await attachScreenshot(testInfo, "remote-settings-pairing", desktop);
    const pairingStatus = await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus());
    if (!pairingStatus.pairing) throw new Error("Desktop did not create a pairing URL");
    const pairingPayload = new URL(pairingStatus.pairing.url).hash.slice(1);
    const encodedPairing = new URLSearchParams(pairingPayload).get("pair");
    if (!encodedPairing) throw new Error("Pairing URL did not contain protected channel data");
    const pairingData = JSON.parse(Buffer.from(encodedPairing, "base64url").toString("utf8")) as { channelId: string };
    await expect(expectMobileRejected(relayOrigin, ({ connectionId, nonce }) => ({
      type: "mobile.attach", protocolVersion: 1, mode: "device", channelId: pairingData.channelId,
      deviceId: randomUUID(), timestamp: Date.now(), signature: Buffer.from(`${connectionId}:${nonce}`).toString("base64url")
    }))).resolves.toBe("Access denied");

    mobile = await openMobileWindow(application, pairingStatus.pairing.url);
    await mobile.emulateMedia({ colorScheme: "light" });
    await expect(mobile.locator(".mark")).toHaveAttribute("src", "./icon.svg");
    expect(await mobile.locator("body").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(243, 245, 247)");
    const cdp = await application.context().newCDPSession(mobile);
    await cdp.send("WebAuthn.enable");
    const authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    await mobile.bringToFront();
    await mobile.getByRole("button", { name: "创建 Passkey" }).click();
    await mobile.waitForTimeout(2_000);
    await expect(settings.getByText("手机已登记，请核对确认码", { exact: true })).toBeVisible({ timeout: 15_000 });
    await attachScreenshot(testInfo, "remote-pairing-confirmation", desktop);
    await attachScreenshot(testInfo, "mobile-pairing-confirmation", mobile);
    await settings.getByRole("button", { name: "确认并完成绑定" }).click();
    await expect(settings.getByText("手机已绑定", { exact: true })).toBeVisible({ timeout: 10_000 });
    const firstCredentialId = (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).passkeys[0]!.id;

    await expect(mobile.getByRole("button", { name: "使用 Passkey 登录" })).toBeVisible({ timeout: 15_000 });
    await mobile.getByRole("button", { name: "使用 Passkey 登录" }).click();
    const frame = mobile.frameLocator("#mobile-frame");
    const sessionMenu = frame.getByRole("button", { name: "打开会话列表" });
    await expect(sessionMenu).toBeVisible({ timeout: 20_000 });
    await expect(frame.getByRole("button", { name: "新会话", exact: true })).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "切换会话", exact: true })).toHaveCount(0);
    await expect(frame.locator(".app-shell")).toHaveClass(/theme-light/);
    expect(await frame.locator(".app-shell").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(243, 245, 247)");
    expect(await mobile.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(420);
    const mobileLayout = await frame.locator(".app-shell").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const textarea = document.querySelector("textarea");
      const footer = document.querySelector("footer")?.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        height: bounds.height,
        bottom: bounds.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        footerBottom: footer?.bottom ?? 0,
        inputFontSize: textarea ? Number.parseFloat(getComputedStyle(textarea).fontSize) : 0
      };
    });
    expect(mobileLayout.left).toBeGreaterThanOrEqual(0);
    expect(mobileLayout.right).toBeLessThanOrEqual(mobileLayout.viewportWidth + 1);
    expect(mobileLayout.height).toBeGreaterThanOrEqual(mobileLayout.viewportHeight - 1);
    expect(mobileLayout.bottom).toBeLessThanOrEqual(mobileLayout.viewportHeight + 1);
    expect(mobileLayout.footerBottom).toBeGreaterThanOrEqual(mobileLayout.viewportHeight - 1);
    expect(mobileLayout.documentWidth).toBeLessThanOrEqual(mobileLayout.viewportWidth);
    expect(mobileLayout.inputFontSize).toBeGreaterThanOrEqual(16);
    const scrollCheck = await frame.locator(".conversation").evaluate((element) => {
      const marker = document.createElement("div");
      marker.style.height = "2000px";
      element.append(marker);
      element.scrollTop = element.scrollHeight;
      const result = { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
      marker.remove();
      return result;
    });
    expect(scrollCheck.scrollHeight).toBeGreaterThan(scrollCheck.clientHeight);
    expect(scrollCheck.scrollTop).toBeGreaterThan(0);
    await attachScreenshot(testInfo, "mobile-conversation", mobile);
    await frame.locator("body").evaluate(() => window.parent.postMessage({
      source: "codex-pane-mobile-ui",
      type: "command",
      command: { type: "turn.send", requestId: crypto.randomUUID(), threadId: "missing", text: "未选择会话时发送" }
    }, "*"));
    const commandError = frame.getByText("请先选择或新建会话。", { exact: true });
    await expect(commandError).toBeVisible();
    expect((await frame.locator(".connection-alert").boundingBox())?.y ?? 999).toBeLessThan(180);
    await attachScreenshot(testInfo, "mobile-visible-command-error", mobile);
    await frame.locator(".connection-alert .n-base-close").click();
    await sessionMenu.click();
    await frame.getByRole("button", { name: "新建会话", exact: true }).click();
    await expect.poll(async () => (await readFile(requestLog, "utf8")).includes('"method":"thread/start"')).toBe(true);
    await expect.poll(async () => {
      const requests = (await readFile(requestLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      return requests.some((request) => request.method === "thread/start" && request.params.approvalPolicy === "on-request" && request.params.approvalsReviewer === "user" && request.params.permissions === ":workspace");
    }).toBe(true);
    await expect(frame.getByRole("heading", { name: "手机新会话" })).toBeVisible();
    await sessionMenu.click();
    await expect(frame.getByRole("complementary", { name: "最近会话" })).toBeVisible();
    await expect(frame.getByRole("button", { name: "关闭远程访问" })).toBeVisible();
    await expect(frame.locator(".drawer-backdrop")).toBeVisible();
    await attachScreenshot(testInfo, "mobile-session-drawer", mobile);
    await frame.locator(".drawer-header").getByRole("button", { name: "关闭会话列表" }).click();
    await expect(frame.getByRole("complementary", { name: "最近会话" })).toBeHidden();
    await expect(sessionMenu).toBeFocused();
    await sessionMenu.click();
    await expect.poll(async () => (await readFile(requestLog, "utf8")).includes('"method":"thread/list"')).toBe(true);
    await expect.poll(() => frame.locator("body").textContent()).toContain("示例会话 A");
    await frame.getByRole("button", { name: /示例会话 B/ }).click();
    await expect(frame.getByRole("button", { name: "追加", exact: true })).toBeVisible();
    await frame.getByPlaceholder("输入消息…").fill("不能追加到桌面任务");
    await frame.getByRole("button", { name: "追加", exact: true }).click();
    await expect(frame.getByText("当前任务正在桌面端运行，完成后再发送。", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const requests = (await readFile(requestLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      return requests.some((request) => request.method === "turn/steer" && request.params.threadId === "fixture-thread-b");
    }).toBe(false);
    await frame.locator(".connection-alert .n-base-close").click();
    await sessionMenu.click();
    await frame.getByRole("button", { name: /示例会话 A/ }).click();
    await expect(frame.getByRole("heading", { name: "示例会话 A" })).toBeVisible();
    await expect(frame.getByText("已通过兼容分页加载历史", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const requests = (await readFile(requestLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      return requests.some((request) => request.method === "thread/items/list")
        && requests.some((request) => request.method === "thread/turns/list" && request.params.itemsView === "full");
    }).toBe(true);
    await frame.getByPlaceholder("输入消息…").fill("来自手机端的加密消息");
    await frame.getByRole("button", { name: "发送" }).click();

    await expect.poll(async () => {
      const lines = (await readFile(requestLog, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
      return lines.some((line) => line.method === "turn/start" && line.params.threadId === "fixture-thread-a" && line.params.approvalPolicy === undefined && line.params.permissions === undefined && line.params.model === undefined && line.params.effort === undefined);
    }).toBe(true);

    const mobileApproval = frame.locator(".approval-card").filter({ hasText: "验证完整审批链路" });
    await expect(mobileApproval).toBeVisible({ timeout: 10_000 });
    await expect(mobileApproval).toContainText("Get-ChildItem");
    await expect(desktop.getByText("命令需要确认", { exact: true })).toBeVisible();
    await expect(mobileApproval.getByRole("button", { name: "拒绝" })).toBeEnabled();
    await expect(mobileApproval.getByRole("button", { name: "仅本次同意" })).toBeEnabled();
    await attachScreenshot(testInfo, "mobile-command-approval", mobile);
    await mobileApproval.getByRole("button", { name: "仅本次同意" }).click();
    await expect(mobileApproval).toBeHidden();
    await expect.poll(async () => (await readFile(approvalResponseLog, "utf8")).trim()).toContain('"decision":"accept"');
    await expect(desktop.getByText("命令需要确认", { exact: true })).toHaveCount(0);

    const mcpApproval = frame.locator(".approval-card").filter({ hasText: "选择部署环境" });
    await expect(mcpApproval).toBeVisible({ timeout: 10_000 });
    await expect(mcpApproval.getByRole("button", { name: "测试", exact: true })).toBeEnabled();
    await expect(mcpApproval.getByRole("button", { name: "生产", exact: true })).toBeEnabled();
    await expect(mcpApproval.getByRole("button", { name: "仅本次同意" })).toHaveCount(0);
    await mcpApproval.getByRole("button", { name: "测试", exact: true }).click();
    await expect.poll(async () => (await readFile(approvalResponseLog, "utf8")).trim()).toContain('"action":"accept","content":{"environment":"测试"}');

    await settings.getByRole("button", { name: "添加手机" }).click();
    const secondPairingStatus = await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus());
    if (!secondPairingStatus.pairing) throw new Error("Desktop did not create the second pairing URL");
    secondMobile = await openMobileWindow(application, secondPairingStatus.pairing.url, `persist:remote-second-${randomUUID()}`);
    const secondCdp = await application.context().newCDPSession(secondMobile);
    await secondCdp.send("WebAuthn.enable");
    await secondCdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    await secondMobile.bringToFront();
    await secondMobile.getByRole("button", { name: "创建 Passkey" }).click();
    await expect(settings.getByText("手机已登记，请核对确认码", { exact: true })).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("button", { name: "确认并完成绑定" }).click();
    await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).passkeys.length).toBe(2);
    const twoDeviceStatus = await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus());
    expect(new Set(twoDeviceStatus.passkeys.map((passkey) => passkey.name)).size).toBe(2);
    const secondCredentialId = twoDeviceStatus.passkeys.find((passkey) => passkey.id !== firstCredentialId)?.id;
    if (!secondCredentialId) throw new Error("Desktop did not preserve two independent mobile credentials");
    await secondMobile.getByRole("button", { name: "使用 Passkey 登录" }).click();
    const secondFrame = secondMobile.frameLocator("#mobile-frame");
    await expect(secondFrame.getByRole("button", { name: "打开会话列表" })).toBeVisible({ timeout: 15_000 });
    await settings.getByText("已绑定手机", { exact: true }).scrollIntoViewIfNeeded();
    await attachScreenshot(testInfo, "remote-settings-two-mobiles", desktop);
    await desktop.evaluate((credentialId) => window.codexPane.revokeRemotePasskey(credentialId), secondCredentialId);
    await expect(secondMobile.getByText("这部手机的绑定已失效，请在桌面端重新生成二维码。", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(frame.getByRole("button", { name: "打开会话列表" })).toBeVisible();

    await frame.getByRole("button", { name: "打开会话列表" }).click();
    await frame.getByRole("button", { name: "关闭远程访问" }).click();
    await frame.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase).toBe("disabled");
    await desktop.evaluate((url) => window.codexPane.updateRemoteSettings({ enabled: true, relayUrl: url }), relayOrigin);
    await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase).toBe("connected");
    await mobile.reload();
    await mobile.getByRole("button", { name: "使用 Passkey 登录" }).click();
    await expect(mobile.frameLocator("#mobile-frame").getByRole("button", { name: "打开会话列表" })).toBeVisible({ timeout: 15_000 });

    const standbyApplication = await electron.launch({ args: ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle", resolve(".")], env: desktopEnvironment });
    applications.push(standbyApplication);
    standbyApplication.process().stderr?.on("data", (data) => process.stdout.write(`[standby-electron:stderr] ${String(data)}`));
    const standbyDesktop = await standbyApplication.firstWindow();
    await expect.poll(async () => (await standbyDesktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase).toBe("standby");
    await standbyDesktop.getByRole("button", { name: "设置" }).click();
    const standbySettings = standbyDesktop.getByRole("dialog").filter({ hasText: "远程访问" });
    await standbySettings.waitFor({ state: "visible" });
    await standbyDesktop.waitForTimeout(250);
    await expect(standbySettings.getByText("同一时间只有一个应用实例提供远程访问", { exact: false })).toBeVisible();
    await expect(standbySettings.getByRole("button", { name: "保存并连接" })).toBeDisabled();
    await attachScreenshot(testInfo, "remote-settings-standby", standbyDesktop);
    await expect(frame.getByRole("button", { name: "打开会话列表" })).toBeVisible();

    await desktop.evaluate(() => window.codexPane.logoutAllRemoteMobiles());
    await expect(mobile.getByRole("button", { name: "使用 Passkey 登录" })).toBeVisible({ timeout: 15_000 });
    await mobile.getByRole("button", { name: "使用 Passkey 登录" }).click();
    await expect(mobile.frameLocator("#mobile-frame").getByRole("button", { name: "打开会话列表" })).toBeVisible({ timeout: 15_000 });

    await desktop.evaluate((credentialId) => window.codexPane.revokeRemotePasskey(credentialId), firstCredentialId);
    await expect(mobile.getByText("这部手机的绑定已失效，请在桌面端重新生成二维码。", { exact: true })).toBeVisible({ timeout: 10_000 });
    await attachScreenshot(testInfo, "mobile-access-revoked", mobile);

    await application.close();
    applications.splice(applications.indexOf(application), 1);
    await expect.poll(async () => (await standbyDesktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase).toBe("standby");
    await expect(standbySettings.locator(".n-alert").getByText("请重启本窗口接管", { exact: false })).toBeVisible();
    await standbyApplication.close();
    applications.splice(applications.indexOf(standbyApplication), 1);

    const replacementApplication = await electron.launch({ args: ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle", resolve(".")], env: desktopEnvironment });
    applications.push(replacementApplication);
    const replacementDesktop = await replacementApplication.firstWindow();
    await expect.poll(async () => (await replacementDesktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase, { timeout: 15_000 }).toBe("connected");
  } finally {
    await testInfo.attach("remote-app-server-requests", { body: await readFile(requestLog, "utf8"), contentType: "application/jsonl" });
    await testInfo.attach("remote-approval-response", { body: await readFile(approvalResponseLog, "utf8"), contentType: "application/jsonl" });
    await Promise.allSettled(applications.map(terminateApplication));
    relay.kill();
    await Promise.all([rm(sessionFixtureMarker, { force: true }), rm(requestLog, { force: true }), rm(approvalResponseLog, { force: true })]);
  }
});
