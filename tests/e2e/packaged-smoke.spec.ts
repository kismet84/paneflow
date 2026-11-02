import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { chromium, expect, test, type Browser, type Page } from "@playwright/test";

const runLiveChecks = existsSync(resolve(".packaged-live"));
const electronFlags = ["--no-sandbox", "--disable-gpu", "--in-process-gpu", "--use-angle=swiftshader", "--use-gl=angle"];
type ProcessIdentity = { id: number; startedAt: string };

const codexProcesses = (): ProcessIdentity[] => {
  const command = "@(Get-Process codex -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ id = $_.Id; startedAt = $_.StartTime.ToUniversalTime().ToString('O') } }) | ConvertTo-Json -Compress";
  const output = execFileSync("pwsh", ["-NoProfile", "-Command", command], { encoding: "utf8" }).trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as ProcessIdentity | ProcessIdentity[];
  return Array.isArray(parsed) ? parsed : [parsed];
};

const waitForGone = async (processes: ProcessIdentity[]): Promise<void> => {
  await expect.poll(() => {
    const alive = codexProcesses();
    return processes.filter((process) => alive.some((candidate) => candidate.id === process.id && candidate.startedAt === process.startedAt));
  }, { timeout: 7_000, intervals: [100, 250, 500] }).toEqual([]);
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve a packaged-app debugging port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
};

class PackagedApplication {
  readonly #child: ChildProcess;
  readonly #browser: Browser;

  constructor(child: ChildProcess, browser: Browser) {
    this.#child = child;
    this.#browser = browser;
  }

  process(): ChildProcess { return this.#child; }

  async firstWindow(): Promise<Page> {
    await expect.poll(() => this.#browser.contexts().flatMap((context) => context.pages()).length, { timeout: 20_000 }).toBeGreaterThan(0);
    return this.#browser.contexts().flatMap((context) => context.pages())[0]!;
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null) {
      await this.#browser.close().catch(() => undefined);
      return;
    }
    const page = this.#browser.contexts().flatMap((context) => context.pages()).find((candidate) => !candidate.isClosed());
    try { await page?.getByRole("button", { name: "关闭" }).click({ timeout: 3_000 }); } catch { /* The window may already be closing. */ }
    const exited = this.#child.exitCode !== null || await new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), 7_000);
      this.#child.once("exit", () => { clearTimeout(timer); resolvePromise(true); });
    });
    if (!exited && this.#child.pid) {
      try { execFileSync("taskkill.exe", ["/pid", String(this.#child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* The application may have exited during fallback cleanup. */ }
    }
    await this.#browser.close().catch(() => undefined);
  }
}

const launchPackaged = async (executablePath: string, environment: Record<string, string>): Promise<PackagedApplication> => {
  const port = await freePort();
  const child = spawn(executablePath, [...electronFlags, `--remote-debugging-port=${port}`], { env: environment, stdio: "ignore", windowsHide: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged application exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return new PackagedApplication(child, await chromium.connectOverCDP(`http://127.0.0.1:${port}`));
    } catch { /* Chromium is still starting. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (child.pid) {
    try { execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true }); } catch { /* The process may already have exited. */ }
  }
  throw new Error("Packaged application did not expose its test-only Chromium endpoint");
};

const launch = (executablePath: string, userDataPath: string): Promise<PackagedApplication> => launchPackaged(executablePath, {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !["CODEX_PANE_E2E_EXE", "CODEX_PANE_PACKAGED_LIVE", "CODEX_PANE_PACKAGED_CONCURRENCY"].includes(entry[0]) && typeof entry[1] === "string")),
  CODEX_PANE_USER_DATA_DIR: userDataPath
});

const launchWithDefaultDataPath = (executablePath: string, appDataPath: string): Promise<PackagedApplication> => launchPackaged(executablePath, {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !["APPDATA", "CODEX_PANE_USER_DATA_DIR", "PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_FILE"].includes(entry[0]) && typeof entry[1] === "string")),
  APPDATA: appDataPath
});

const waitForWorkbench = async (window: Page): Promise<void> => {
  await expect(window.getByRole("button", { name: "设置" })).toBeVisible({ timeout: 20_000 });
  await expect(window.locator(".pane").first()).toBeVisible();
};

const verifyWindowChrome = async (window: Page): Promise<void> => {
  const metrics = await window.evaluate(() => {
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
  expect(metrics).toMatchObject({ documentOverflow: 0, bodyOverflow: 0, shellOverflow: 0, shellOverflowStyle: "hidden" });
  expect(metrics.buttonCenterOffset).toBeLessThanOrEqual(0.5);
  expect(metrics.glyphCenterOffset).toBeLessThanOrEqual(0.5);
};

const selectLayout = async (window: Page, label: string): Promise<void> => {
  await window.getByRole("button", { name: /切换窗格布局/ }).click();
  await window.locator('[data-dropdown-option="true"]').getByText(label, { exact: true }).click();
};

test("keeps Electron and Chromium data beside the unpacked executable", async () => {
  test.setTimeout(120_000);
  const sourceExecutable = process.env.CODEX_PANE_PACKAGED_EXE;
  test.skip(!sourceExecutable, "Set CODEX_PANE_PACKAGED_EXE to run the unpacked executable data-path test.");
  const runRoot = resolve("E:\\AI-Workspace\\tmp", `codex-pane-unpacked-${randomUUID()}`);
  const unpackedRoot = join(runRoot, "win-unpacked");
  const isolatedAppData = join(runRoot, "appdata");
  const executablePath = join(unpackedRoot, "Codex Pane.exe");
  const expectedDataPath = join(unpackedRoot, "data");
  let application: PackagedApplication | null = null;
  let secondApplication: PackagedApplication | null = null;
  try {
    await mkdir(runRoot, { recursive: true });
    await cp(dirname(sourceExecutable!), unpackedRoot, { recursive: true });
    await rm(expectedDataPath, { recursive: true, force: true });
    const existingBrowserDirectory = join(expectedDataPath, "Local Storage");
    const existingMarker = join(existingBrowserDirectory, "existing-browser-data.txt");
    await mkdir(existingBrowserDirectory, { recursive: true });
    await writeFile(existingMarker, "preserve", "utf8");
    application = await launchWithDefaultDataPath(executablePath, isolatedAppData);
    const window = await application.firstWindow();
    await waitForWorkbench(window);
    await verifyWindowChrome(window);
    const primarySessionPath = join(expectedDataPath, "chromium", "primary");
    await expect.poll(() => existsSync(primarySessionPath)).toBe(true);
    await selectLayout(window, "四宫格");
    await window.waitForTimeout(800);
    const secondModelSelect = window.locator("[data-pane-id='pane-2'] .model-select");
    const secondComposer = window.locator("[data-pane-id='pane-2'] textarea");
    await secondModelSelect.click();
    await expect(window.locator(".n-base-select-menu")).toBeVisible();
    await expect(secondComposer).not.toBeFocused();
    await window.keyboard.press("Escape");
    expect(Number.parseFloat(await window.locator(".status-line").first().evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    expect(Number.parseFloat(await window.locator(".cwd-text").first().evaluate((element) => getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);

    expect(existsSync(join(expectedDataPath, "workspaces", "default.json"))).toBe(true);
    expect(await readFile(existingMarker, "utf8")).toBe("preserve");
    secondApplication = await launchWithDefaultDataPath(executablePath, isolatedAppData);
    const secondWindow = await secondApplication.firstWindow();
    await waitForWorkbench(secondWindow);
    await expect.poll(() => existsSync(join(expectedDataPath, "chromium", String(secondApplication!.process().pid)))).toBe(true);
    expect(secondApplication.process().pid).not.toBe(application.process().pid);
    await application.close();
    application = null;
    await expect(secondWindow.getByRole("button", { name: "设置" })).toBeVisible();
  } finally {
    await application?.close();
    await secondApplication?.close();
    await rm(runRoot, { recursive: true, force: true });
  }
});

test("verifies the packaged Windows executable, protected persistence, reconnect, and shutdown", async () => {
  test.setTimeout(runLiveChecks ? 240_000 : 90_000);
  const executablePath = process.env.CODEX_PANE_PACKAGED_EXE;
  test.skip(!executablePath, "Set CODEX_PANE_PACKAGED_EXE to run the packaged executable smoke test.");
  const userDataPath = resolve("test-results", `packaged-user-data-${randomUUID()}`);
  const baselineCodexPids = new Set(codexProcesses().map((process) => process.id));
  const testCodexProcesses = (): ProcessIdentity[] => codexProcesses().filter((process) => !baselineCodexPids.has(process.id));
  let application = await launch(executablePath!, userDataPath);
  let trackedProcesses: ProcessIdentity[] = [];
  try {
    const window = await application.firstWindow();
    const securityViolations: string[] = [];
    await window.exposeFunction("recordSecurityViolation", (directive: string) => securityViolations.push(directive));
    await window.evaluate(() => document.addEventListener("securitypolicyviolation", (event) => {
      void (window as unknown as { recordSecurityViolation: (directive: string) => Promise<void> }).recordSecurityViolation(event.violatedDirective);
    }));
    await expect(window).toHaveTitle("Codex Pane");
    await waitForWorkbench(window);
    const csp = await window.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
    expect(csp).not.toContain("__CODEX_PANE_CSP__");
    expect(csp).not.toMatch(/localhost|127\.0\.0\.1|ws:|unsafe-eval/i);

    const composer = window.getByRole("textbox", { name: "消息输入框" }).first();
    await window.evaluate(() => (globalThis as typeof globalThis & { codexPane: { copyText: (value: string) => Promise<void> } }).codexPane.copyText("Codex Pane 复制测试"));
    await composer.focus();
    await window.keyboard.press("Control+V");
    await expect(composer).toHaveValue("Codex Pane 复制测试");
    await composer.fill("");
    execFileSync("pwsh", ["-NoProfile", "-Command", "Set-Clipboard -Value $env:CODEX_PANE_CLIPBOARD_TEXT"], {
      windowsHide: true,
      env: { ...process.env, CODEX_PANE_CLIPBOARD_TEXT: "https://example.com/pasted-image.png" }
    });
    await composer.focus();
    await window.keyboard.press("Control+V");
    await expect(composer).toHaveValue("https://example.com/pasted-image.png");
    await expect(window.getByText("pasted-image.png", { exact: true })).toHaveCount(0);
    await composer.fill("");

    const firstTree = testCodexProcesses();
    expect(firstTree.length).toBeGreaterThan(0);
    await window.evaluate(() => (globalThis as typeof globalThis & { codexPane: { reconnect: () => Promise<void> } }).codexPane.reconnect());
    await waitForGone(firstTree);
    await expect.poll(() => testCodexProcesses().length, { timeout: 20_000 }).toBeGreaterThan(0);
    trackedProcesses = testCodexProcesses();
    expect(trackedProcesses.length).toBeGreaterThan(0);
    expect(securityViolations).toEqual([]);

    if (runLiveChecks) {
      await selectLayout(window, "单窗格");
      await composer.fill("只回复“Codex Pane 联调成功”，不要调用任何工具。");
      await composer.press("Enter");
      await expect(window.locator(".message-agent").last()).toContainText("Codex Pane 联调成功", { timeout: 90_000 });
      const shortReply = window.locator(".message-agent").last();
      expect((await shortReply.boundingBox())?.height ?? 1000).toBeLessThan(64);
      expect(await shortReply.locator(".copy-message-button").evaluate((element) => getComputedStyle(element).position)).toBe("absolute");
      const imagePath = resolve("node_modules/app-builder-lib/templates/icons/electron-linux/64x64.png");
      execFileSync("pwsh", ["-Sta", "-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile($env:CODEX_PANE_CLIPBOARD_IMAGE); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }"], {
        windowsHide: true,
        env: { ...process.env, CODEX_PANE_CLIPBOARD_IMAGE: imagePath }
      });
      await composer.focus();
      await window.keyboard.press("Control+V");
      await expect(window.getByRole("button", { name: "移除 剪贴板图片.png" })).toBeVisible();
      await composer.fill("只回复“图片附件联调成功”，不要调用任何工具。");
      await composer.press("Enter");
      await expect(window.locator(".message-agent").last()).toContainText("图片附件联调成功", { timeout: 90_000 });
      await composer.fill("请使用命令工具执行 PowerShell 命令 Get-Location，然后用一句话说明当前目录。不要修改任何文件。");
      await composer.press("Enter");
      await expect(window.getByRole("heading", { name: /^已运行命令/ }).last()).toBeVisible({ timeout: 90_000 });
      await expect(window.getByText(/Working/)).toHaveCount(0, { timeout: 30_000 });
    }
  } finally {
    await application.close();
  }
  await waitForGone(trackedProcesses);

  application = await launch(executablePath!, userDataPath);
  try {
    const window = await application.firstWindow();
    await waitForWorkbench(window);
    if (!runLiveChecks) await expect(window.getByRole("textbox", { name: "消息输入框" }).first()).toHaveValue("");
    if (runLiveChecks) {
      await selectLayout(window, "四宫格");
      for (let index = 0; index < 4; index += 1) {
        const pane = window.locator(`[data-pane-id="pane-${index + 1}"]`);
        const paneComposer = pane.getByRole("textbox", { name: "消息输入框" });
        await paneComposer.fill("/new");
        await paneComposer.press("Enter");
        await paneComposer.press("Enter");
        await paneComposer.fill(`只回复“PANE-${index + 1}-OK”，不要调用任何工具。`);
      }
      for (let index = 0; index < 4; index += 1) {
        await window.locator(`[data-pane-id="pane-${index + 1}"]`).getByRole("textbox", { name: "消息输入框" }).press("Enter");
      }
      for (let index = 0; index < 4; index += 1) {
        const messages = window.locator(`[data-pane-id="pane-${index + 1}"] .message-agent`);
        await expect(messages).toHaveCount(1, { timeout: 90_000 });
        await expect(messages.last()).toContainText(`PANE-${index + 1}-OK`, { timeout: 90_000 });
      }
    }
    trackedProcesses = testCodexProcesses();
  } finally {
    await application.close();
  }
  await waitForGone(trackedProcesses);
});
