import { basename, dirname, extname, join, resolve, relative } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat as statFile } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, protocol, safeStorage, screen, shell, Tray, Menu, nativeImage } from "electron";
import { isAsarPath } from "./native-working-directory.js";
import { AppServerSupervisor } from "./app-server-supervisor.js";
import { FileStore } from "./file-store.js";
import { MediaStore } from "./media-store.js";
import { StateStore, workspaceStateSchema, type WorkspaceState } from "./persistence.js";
import { remoteCredentialIdSchema, remoteSettingsSchema, safeRequestSchema, serverResponseSchema, type AttachmentBatch, type FileReference, type MediaAttachment, type ProtocolEvent } from "../shared/contracts.js";
import { RuntimeProtocolValidator } from "../../packages/protocol/src/runtime-validator.js";
import { DiagnosticLog } from "./diagnostic-log.js";
import { useCodexArgsPrefixForTests, useCodexFixtureForTests } from "./codex-process.js";
import { prepareUserDataLocation } from "./user-data-location.js";
import { isTrustedRendererUrl, rendererEntryUrl } from "./renderer-trust.js";
import { fitWindowBounds } from "./window-bounds.js";
import { mediaRequestId } from "./media-protocol.js";
import { redactSensitiveText } from "./sensitive-data.js";
import { RemoteQueueStore } from "./remote-queue-store.js";
import { RemoteRequestStore } from "./remote-request-store.js";
import { RemoteBridge } from "./remote-bridge.js";
import { RemoteAuditLog } from "./remote-audit-log.js";
import { RemoteCredentialStore } from "./remote-credential-store.js";
import { ProcessOwnershipLease } from "./process-ownership-lease.js";
import { DeploymentManager } from "./deployment-manager.js";
import { UpdateManager } from "./update-manager.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "codex-media", privileges: { secure: true, standard: true, supportFetchAPI: true } }
]);

if (!app.isPackaged && (process.env.CODEX_PANE_PERFORMANCE_FIXTURE === "1" || process.env.CODEX_PANE_DISABLE_HARDWARE_ACCELERATION === "1")) app.disableHardwareAcceleration();

if (!app.isPackaged && (existsSync(join(app.getAppPath(), ".approval-fixture")) || existsSync(join(app.getAppPath(), ".session-fixture")))) {
  useCodexFixtureForTests(join(app.getAppPath(), "tests", "fixtures", "fake-codex", "fake-app-server.mjs"));
}
if (!app.isPackaged && process.env.CODEX_PANE_PERFORMANCE_FIXTURE === "1") {
  useCodexFixtureForTests(join(app.getAppPath(), "tests", "fixtures", "fake-codex", "performance-app-server.mjs"));
}
if (!app.isPackaged && existsSync(join(app.getAppPath(), ".user-approval-fixture"))) {
  useCodexArgsPrefixForTests(["-c", "approvals_reviewer='user'"]);
}

const fallbackUserDataPath = join(app.getPath("appData"), app.getName());
const userDataLocation = prepareUserDataLocation({
  explicitPath: process.env.CODEX_PANE_USER_DATA_DIR || process.argv.find(value => value.startsWith("--paneflow-data-directory="))?.slice("--paneflow-data-directory=".length),
  executablePath: app.getPath("exe"),
  applicationPath: app.getAppPath(),
  fallbackUserDataPath,
  packaged: app.isPackaged
});
app.setPath("userData", userDataLocation.path);
const upgradeReadyFile = process.env.PANEFLOW_UPGRADE_READY_FILE;
const upgradeRelative = upgradeReadyFile ? relative(join(userDataLocation.path, "updates"), resolve(upgradeReadyFile)) : "";
const upgradeDirectory = upgradeReadyFile && basename(upgradeReadyFile) === "ready.json" && upgradeRelative && !upgradeRelative.startsWith("..") && !upgradeRelative.includes(":") && /^[a-f0-9]{32}$/.test(process.env.PANEFLOW_UPGRADE_NONCE ?? "") ? dirname(resolve(upgradeReadyFile)) : null;
const confirmUpgradeShutdown = () => { if (upgradeDirectory) writeFileSync(join(upgradeDirectory, "stopped.json"), JSON.stringify({ processId: process.pid, nonce: process.env.PANEFLOW_UPGRADE_NONCE })); };
const chromiumRoot = join(userDataLocation.path, "chromium");
const primarySessionLock = join(chromiumRoot, ".primary-instance-lock");
const primarySessionLockPid = join(primarySessionLock, "pid");

const processExists = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const removePrimarySessionLock = (): void => {
  try {
    if (existsSync(primarySessionLockPid)) unlinkSync(primarySessionLockPid);
    if (existsSync(primarySessionLock)) rmdirSync(primarySessionLock);
  } catch {
    // A concurrent process may have observed or replaced a stale lock.
  }
};

const acquirePrimarySession = (): boolean => {
  mkdirSync(chromiumRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(primarySessionLock);
      writeFileSync(primarySessionLockPid, String(process.pid), { encoding: "utf8", flag: "wx" });
      return true;
    } catch {
      let ownerPid = 0;
      try {
        ownerPid = Number(readFileSync(primarySessionLockPid, "utf8").trim());
      } catch {
        return false;
      }
      if (processExists(ownerPid)) return false;
      removePrimarySessionLock();
    }
  }
  return false;
};

const ownsPrimarySession = acquirePrimarySession();
app.setPath("sessionData", join(chromiumRoot, ownsPrimarySession ? "primary" : String(process.pid)));

let mainWindow: BrowserWindow | null = null;
const fallbackAppServerWorkingDirectory = app.isPackaged ? dirname(app.getPath("exe")) : app.getAppPath();
const loadBundledRenderer = app.isPackaged || process.env.CODEX_PANE_LOAD_DIST === "1";
const trustedRendererUrl = rendererEntryUrl(app.getAppPath(), loadBundledRenderer);
const supervisor = new AppServerSupervisor(fallbackAppServerWorkingDirectory, app.getVersion());
let mediaStore: MediaStore;
let fileStore: FileStore;
let stateStore: StateStore;
let diagnosticLog: DiagnosticLog;
let remoteBridge: RemoteBridge;
let deploymentManager: DeploymentManager;
let updateManager: UpdateManager;
let maintenanceMode = Boolean(upgradeDirectory);
let desktopRequests = 0;
let remoteBridgeLease: ProcessOwnershipLease;
let remoteBridgeStopPromise: Promise<void> | null = null;
let forceClosing = false;
let backgroundTray: Tray | null = null;
let explicitTrayQuit = false;
let shutdownInProgress = false;
let closeRequestInFlight = false;
let workspaceSaveConfirmed = false;
let closeRequestTimer: NodeJS.Timeout | null = null;
let windowSaveTimer: NodeJS.Timeout | null = null;
const execFileAsync = promisify(execFile);
const isExistingDirectory = async (path: string): Promise<boolean> => {
  if (!path || isAsarPath(path)) return false;
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      statFile(path).then((metadata) => metadata.isDirectory()).catch(() => false),
      new Promise<boolean>((resolvePromise) => { timer = setTimeout(() => resolvePromise(false), 2_000); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const listWindowsFonts = async (): Promise<string[]> => {
  if (process.platform !== "win32") return [];
  const registryKeys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    "HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts"
  ];
  const results = await Promise.allSettled(registryKeys.map((key) => execFileAsync("reg.exe", ["query", key], { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })));
  const fontNames = results.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    return result.value.stdout.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s{4}(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+/);
      if (!match?.[1]) return [];
      const name = match[1].replace(/\s+\((?:TrueType|OpenType)\)$/i, "").trim();
      return name ? [name] : [];
    });
  });
  return [...new Set(fontNames)].sort((left, right) => left.localeCompare(right, "zh-CN"));
};

const relinquishRemoteBridge = (): Promise<void> => {
  remoteBridgeStopPromise ??= remoteBridge?.stop() ?? Promise.resolve();
  remoteBridgeLease?.release();
  return remoteBridgeStopPromise;
};

const shutdownApplication = async (): Promise<void> => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  try {
    await relinquishRemoteBridge();
    await deploymentManager?.stop({ shutdown: true });
    await supervisor.stop();
    confirmUpgradeShutdown();
    if (ownsPrimarySession) removePrimarySessionLock();
    forceClosing = true;
    mainWindow?.destroy();
    app.exit(0);
  } catch (error) {
    shutdownInProgress = false;
    mainWindow?.webContents.send("codex:state", {
      ...supervisor.state,
      phase: "error",
      message: `无法安全退出 Codex：${error instanceof Error ? error.message : String(error)}`
    });
  }
};

const continueCloseAfterSave = (): void => {
  workspaceSaveConfirmed = false;
  if (!supervisor.hasActiveWork) {
    void shutdownApplication();
    return;
  }
  void dialog.showMessageBox(mainWindow!, {
    type: "warning",
    title: "Codex 仍在运行",
    message: "仍有任务或确认请求未完成。要先中断它们再退出吗？",
    detail: "工作台草稿已经保存。退出不会让 Codex 在后台继续运行，也不会自动重发未完成的操作。",
    buttons: ["返回", "中断并退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }).then(async ({ response }) => {
    if (response !== 1) return;
    await supervisor.interruptActiveWork();
    await shutdownApplication();
  });
};

const scheduleWindowStateSave = (): void => {
  if (!mainWindow || !stateStore) return;
  if (windowSaveTimer) clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    void stateStore.updateWindow({ ...bounds, maximized: mainWindow.isMaximized() });
  }, 300);
};

const transformManagedAttachments = (value: unknown, depth = 0, budget = { nodes: 50_000 }, ancestors = new WeakSet<object>()): unknown => {
  if (budget.nodes-- <= 0 || depth > 32) throw new Error("Codex 请求内容过于复杂，已停止处理以保护应用。");
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("Codex 请求内容包含循环引用。");
    ancestors.add(value);
    try {
      return value.map((entry) => transformManagedAttachments(entry, depth + 1, budget, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "managedImage" && typeof record.id === "string") {
    return { type: "localImage", path: mediaStore.resolveAttachment(record.id), detail: record.detail ?? "high" };
  }
  if (record.type === "managedRemoteImage" && typeof record.url === "string") {
    const url = new URL(record.url);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("远程图片必须使用不含账号信息的 HTTPS 地址。" );
    }
    return { type: "image", url: url.toString(), detail: record.detail ?? "high" };
  }
  if (record.type === "managedFile" && typeof record.id === "string" && typeof record.name === "string") {
    return { type: "mention", name: record.name, path: fileStore.resolveAttachment(record.id, record.name) };
  }
  if (ancestors.has(record)) throw new Error("Codex 请求内容包含循环引用。");
  ancestors.add(record);
  try {
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, transformManagedAttachments(entry, depth + 1, budget, ancestors)]));
  } finally {
    ancestors.delete(record);
  }
};

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const importAttachmentPaths = async (paths: string[]): Promise<AttachmentBatch> => {
  const results = new Array<MediaAttachment | FileReference | null>(paths.length).fill(null);
  const errors = new Array<string | null>(paths.length).fill(null);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, paths.length) }, async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      const path = paths[index]!;
      try {
        results[index] = IMAGE_EXTENSIONS.has(extname(path).toLocaleLowerCase())
          ? await mediaStore.importPath(path)
          : await fileStore.importPath(path);
      } catch (error) {
        errors[index] = `${basename(path)}：${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });
  await Promise.all(workers);
  return {
    images: results.filter((result): result is MediaAttachment => Boolean(result && "url" in result)),
    files: results.filter((result): result is FileReference => Boolean(result && !('url' in result))),
    errors: errors.filter((error): error is string => Boolean(error))
  };
};

const clipboardFilePaths = async (): Promise<string[]> => {
  const paths: string[] = [];
  for (const item of await clipboard.read()) {
    for (const type of item.types) {
      const match = type.match(/(?:^|format=")filename(w?)(?:"|$)/i);
      if (!match) continue;
      const value = await item.getType(type);
      if (!(value instanceof Blob)) continue;
      const buffer = Buffer.from(await value.arrayBuffer());
      paths.push(...buffer.toString(match[1] ? "utf16le" : "utf8").split("\0").map((path) => path.trim()).filter(Boolean));
    }
  }
  return [...new Set(paths)].filter((path) => existsSync(path) && statSync(path).isFile());
};

const protectRemoteUrls = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const workspace = value as Record<string, unknown>;
  if (!Array.isArray(workspace.panes)) return value;
  return {
    ...workspace,
    panes: workspace.panes.map((rawPane) => {
      if (!rawPane || typeof rawPane !== "object") return rawPane;
      const pane = rawPane as Record<string, unknown>;
      const attachments = Array.isArray(pane.attachments) ? pane.attachments.map((rawAttachment) => {
        if (!rawAttachment || typeof rawAttachment !== "object") return rawAttachment;
        const attachment = rawAttachment as Record<string, unknown>;
        if (attachment.kind !== "remote" || typeof attachment.sourceUrl !== "string") return attachment;
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据保护当前不可用，暂时无法保存远程图片草稿。" );
        const { sourceUrl, ...rest } = attachment;
        return { ...rest, protectedSourceUrl: safeStorage.encryptString(sourceUrl).toString("base64") };
      }) : pane.attachments;
      return { ...pane, attachments };
    })
  };
};

const unprotectRemoteUrls = (workspace: WorkspaceState | null): WorkspaceState | null => {
  if (!workspace) return null;
  return {
    ...workspace,
    panes: workspace.panes.map((pane) => ({
      ...pane,
      attachments: pane.attachments.flatMap((attachment) => {
        if (attachment.kind !== "remote" || !attachment.protectedSourceUrl) return [attachment];
        try {
          const sourceUrl = safeStorage.decryptString(Buffer.from(attachment.protectedSourceUrl, "base64"));
          const { protectedSourceUrl: _protectedSourceUrl, ...rest } = attachment;
          return [{ ...rest, sourceUrl }];
        } catch {
          return [];
        }
      })
    }))
  };
};

const createWindow = async (): Promise<void> => {
  const workspace = await stateStore.load();
  const displays = screen.getAllDisplays();
  const primaryDisplay = screen.getPrimaryDisplay();
  const restoredBounds = fitWindowBounds({
    width: workspace?.window.width ?? 1480,
    height: workspace?.window.height ?? 920,
    x: workspace?.window.x,
    y: workspace?.window.y
  }, displays.map((display) => display.workArea), Math.max(0, displays.findIndex((display) => display.id === primaryDisplay.id)));
  mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: 960,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: workspace?.appearance?.theme === "light" || workspace?.appearance?.theme === "system" && !nativeTheme.shouldUseDarkColors ? "#ffffff" : "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(app.getAppPath(), "dist-electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      allowRunningInsecureContent: false
    }
  });
  if (workspace?.window.maximized) {
    mainWindow.maximize();
  }
  const isTrustedLocalPage = (url: string): boolean => isTrustedRendererUrl(url, trustedRendererUrl);
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return webContents === mainWindow?.webContents
      && String(permission) === "local-fonts"
      && isTrustedLocalPage(webContents.getURL())
      && (isTrustedLocalPage(requestingOrigin) || loadBundledRenderer && requestingOrigin === "file://");
  });
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(webContents === mainWindow?.webContents
      && String(permission) === "local-fonts"
      && isTrustedLocalPage(webContents.getURL())
      && isTrustedLocalPage(details.requestingUrl));
  });
  mainWindow.once("ready-to-show", () => {
    if (process.env.PANEFLOW_BACKGROUND !== "1") mainWindow?.show();
  });
  if (process.env.PANEFLOW_BACKGROUND === "1") {
    const pixels = Buffer.alloc(32 * 32 * 4);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      const white = ((x === 7 || x === 24) && y >= 7 && y <= 24) || ((y === 7 || y === 12 || y === 24) && x >= 7 && x <= 24) || (x === 13 && y >= 12 && y <= 24);
      const i = (y * 32 + x) * 4;
      pixels[i] = 255; pixels[i+1] = white ? 255 : 122; pixels[i+2] = white ? 255 : 0; pixels[i+3] = 255;
    }
    backgroundTray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }));
    const show = () => { mainWindow?.show(); mainWindow?.focus(); };
    backgroundTray.setToolTip("PaneFlow Desktop · 手机连接服务");
    backgroundTray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开 PaneFlow Desktop", click: show },
      { type: "separator" },
      { label: "退出并停止手机连接", click: () => { explicitTrayQuit = true; mainWindow?.show(); mainWindow?.close(); } }
    ]));
    backgroundTray.on("double-click", show);
  }
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`PaneFlow Desktop renderer exited: ${details.reason} (${details.exitCode})`);
  });
  mainWindow.on("resize", scheduleWindowStateSave);
  mainWindow.on("move", scheduleWindowStateSave);
  mainWindow.on("maximize", scheduleWindowStateSave);
  mainWindow.on("unmaximize", scheduleWindowStateSave);
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:maximized-changed", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:maximized-changed", false));
  mainWindow.on("enter-full-screen", () => mainWindow?.webContents.send("window:fullscreen-changed", true));
  mainWindow.on("leave-full-screen", () => mainWindow?.webContents.send("window:fullscreen-changed", false));
  mainWindow.on("close", (event) => {
    if (forceClosing) return;
    event.preventDefault();
    if (backgroundTray && !explicitTrayQuit) { mainWindow?.hide(); return; }
    explicitTrayQuit = false;
    if (workspaceSaveConfirmed) {
      continueCloseAfterSave();
      return;
    }
    if (closeRequestInFlight) return;
    closeRequestInFlight = true;
    mainWindow?.webContents.send("window:close-requested");
    if (closeRequestTimer) clearTimeout(closeRequestTimer);
    closeRequestTimer = setTimeout(() => {
      closeRequestTimer = null;
      closeRequestInFlight = false;
      mainWindow?.webContents.send("codex:state", { ...supervisor.state, phase: "error", message: "退出前保存工作台超时；窗口已保持打开，请重试。" });
    }, 10_000);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedLocalPage(url)) event.preventDefault();
  });
  if (loadBundledRenderer) {
    await mainWindow.loadFile(join(app.getAppPath(), "dist/index.html"));
  } else {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  }
};

const registerIpc = (): void => {
  const assertTrustedSender = (event: Electron.IpcMainInvokeEvent): void => {
    if (!mainWindow
      || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame
      || !isTrustedRendererUrl(event.senderFrame.url, trustedRendererUrl)) {
      throw new Error("已拒绝来自未知页面的应用调用。" );
    }
  };
  ipcMain.handle("app:bootstrap", async (event) => {
    assertTrustedSender(event);
    const loadedWorkspace = unprotectRemoteUrls(await stateStore.load());
    const savedDirectories = loadedWorkspace ? [loadedWorkspace.defaultCwd, ...loadedWorkspace.panes.map((pane) => pane.cwd)] : [];
    const uniqueDirectories = [...new Set(savedDirectories.filter(Boolean))];
    const directoryChecks = await Promise.all(uniqueDirectories.map(async (path) => [path, await isExistingDirectory(path)] as const));
    const validDirectories = new Set(directoryChecks.filter(([, valid]) => valid).map(([path]) => path));
    const invalidDirectoryCount = savedDirectories.filter((path) => path && !validDirectories.has(path)).length;
    const workspace = loadedWorkspace ? {
      ...loadedWorkspace,
      defaultCwd: validDirectories.has(loadedWorkspace.defaultCwd) ? loadedWorkspace.defaultCwd : "",
      panes: loadedWorkspace.panes.map((pane) => ({ ...pane, cwd: validDirectories.has(pane.cwd) ? pane.cwd : "" }))
    } : null;
    return {
      appVersion: app.getVersion(),
      connection: supervisor.state,
      workspace,
      workspaceWarning: [userDataLocation.warning, stateStore.loadWarning, invalidDirectoryCount ? `上次保存的 ${invalidDirectoryCount} 个工作目录已不存在，已改用安全默认目录。` : null].filter(Boolean).join(" ") || null
    };
  });
  ipcMain.handle("system:fonts", async (event) => {
    assertTrustedSender(event);
    return listWindowsFonts();
  });
  ipcMain.handle("codex:request", async (event, rawRequest: unknown) => {
    assertTrustedSender(event);
    if (maintenanceMode) throw new Error("升级维护中，暂不接受新操作。");
    const request = safeRequestSchema.parse(rawRequest);
    desktopRequests++;
    try {
    if (request.method === "thread/unsubscribe") {
      await remoteBridge.releaseDesktopThread(request.params.threadId);
      return {};
    }
    const result = await supervisor.call(request.method, transformManagedAttachments(request.params));
    if (request.method === "thread/resume") remoteBridge.acquireDesktopThread(request.params.threadId);
    return result;
    } finally { desktopRequests--; }
  });
  ipcMain.handle("codex:respond", async (event, rawResponse: unknown) => {
    assertTrustedSender(event);
    const response = serverResponseSchema.parse(rawResponse);
    supervisor.respondToServer(response.generation, response.id, response.result, response.error);
    remoteBridge.handleDesktopResponse(response.id);
  });
  ipcMain.handle("codex:reconnect", async (event) => {
    assertTrustedSender(event);
    await supervisor.stop();
    await supervisor.start();
  });
  ipcMain.handle("codex:working-directory", async (event, rawPath: unknown) => {
    assertTrustedSender(event);
    if (rawPath !== null && (typeof rawPath !== "string" || rawPath.length > 32_768)) throw new Error("全局默认工作目录无效。");
    const workingDirectory = rawPath ? resolve(rawPath) : fallbackAppServerWorkingDirectory;
    if (!await isExistingDirectory(workingDirectory)) throw new Error("全局默认工作目录不存在、不是目录或检查超时。");
    supervisor.setWorkingDirectory(workingDirectory);
  });
  ipcMain.handle("dialog:directory", async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, { title: "选择 Codex 工作目录", properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("attachment:choose", async (event, rawLimit: unknown) => {
    assertTrustedSender(event);
    if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) throw new Error("可添加附件数量无效。");
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "添加附件（可多选）",
      properties: ["openFile", "multiSelections"]
    });
    if (result.canceled) return { images: [], files: [], errors: [] };
    return importAttachmentPaths(result.filePaths.slice(0, Number(rawLimit)));
  });
  ipcMain.handle("attachment:paste", async (event, rawPaths: unknown, rawLimit: unknown) => {
    assertTrustedSender(event);
    if (!Array.isArray(rawPaths) || rawPaths.length > 20 || rawPaths.some((path) => typeof path !== "string" || path.length > 32_768)) throw new Error("剪贴板文件路径无效。");
    if (!Number.isInteger(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 20) throw new Error("可添加附件数量无效。");
    const suggestedPaths = rawPaths.map((path) => resolve(path)).filter((path) => existsSync(path) && statSync(path).isFile());
    const paths = (suggestedPaths.length ? suggestedPaths : await clipboardFilePaths()).slice(0, Number(rawLimit));
    if (paths.length) return importAttachmentPaths(paths);
    return { images: [await mediaStore.pasteClipboard()], files: [], errors: [] };
  });
  ipcMain.handle("media:path", (event, path: unknown) => {
    assertTrustedSender(event);
    if (typeof path !== "string" || path.length > 32_768) {
      throw new Error("图片路径无效。" );
    }
    return mediaStore.importPath(path);
  });
  ipcMain.handle("media:remote", (event, rawUrl: unknown) => {
    assertTrustedSender(event);
    if (typeof rawUrl !== "string" || rawUrl.length > 8_192) {
      throw new Error("图片地址无效。" );
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("远程图片必须使用不含账号信息的 HTTPS 地址。" );
    }
    const extension = url.pathname.match(/\.(png|jpe?g|webp|gif|bmp)$/i)?.[1];
    if (!extension) {
      throw new Error("这个地址看起来不是受支持的图片。请使用以 png、jpg、webp、gif 或 bmp 结尾的 HTTPS 地址。" );
    }
    const id = crypto.randomUUID();
    return { id, name: url.pathname.split("/").pop() || `远程图片.${extension}`, url: "codex-media://media/remote", size: 0, kind: "remote", sourceUrl: url.toString() };
  });
  ipcMain.handle("workspace:save", async (event, state: unknown) => {
    assertTrustedSender(event);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("工作台状态无效。" );
    }
    const bounds = mainWindow?.getBounds();
    if (!bounds) {
      throw new Error("主窗口尚未就绪。" );
    }
    const workspace = workspaceStateSchema.parse({
      ...state,
      window: {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: mainWindow?.isMaximized() ?? false
      }
    });
    await stateStore.save(protectRemoteUrls(workspace));
    const focusedPane = workspace.panes.find((pane) => pane.id === workspace.focusedPaneId) ?? workspace.panes[0];
    remoteBridge.updateSessionDefaults({ cwd: workspace.defaultCwd || null, model: focusedPane?.model ?? null });
    remoteBridge.updateAppearance({ theme: workspace.appearance.theme, accentColor: workspace.appearance.accentColor });
  });
  ipcMain.handle("window:fullscreen", (event, fullScreen: unknown) => {
    assertTrustedSender(event);
    if (typeof fullScreen !== "boolean") {
      throw new Error("全屏参数无效。" );
    }
    mainWindow?.setFullScreen(fullScreen);
  });
  ipcMain.handle("window:control", (event, action: unknown) => {
    assertTrustedSender(event);
    if (action === "minimize") mainWindow?.minimize();
    else if (action === "maximize") mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize();
    else if (action === "close") mainWindow?.close();
    else throw new Error("窗口操作无效。");
  });
  ipcMain.handle("window:is-maximized", (event) => {
    assertTrustedSender(event);
    return mainWindow?.isMaximized() ?? false;
  });
  ipcMain.handle("window:close-response", (event, allow: unknown) => {
    assertTrustedSender(event);
    if (typeof allow !== "boolean") throw new Error("退出确认参数无效。");
    if (closeRequestTimer) clearTimeout(closeRequestTimer);
    closeRequestTimer = null;
    closeRequestInFlight = false;
    if (!allow) return;
    workspaceSaveConfirmed = true;
    mainWindow?.close();
  });
  ipcMain.handle("clipboard:write-text", async (event, rawValue: unknown) => {
    assertTrustedSender(event);
    if (typeof rawValue !== "string" || rawValue.length > 2_000_000) throw new Error("复制内容无效。");
    await clipboard.writeText(rawValue);
  });
  ipcMain.handle("external:open", async (event, rawUrl: unknown) => {
    assertTrustedSender(event);
    if (typeof rawUrl !== "string" || rawUrl.length > 8_192) {
      throw new Error("链接无效。" );
    }
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("只允许打开 HTTP 或 HTTPS 链接。" );
    }
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      title: "打开外部链接？",
      message: `即将在系统浏览器中打开 ${url.host}`,
      detail: "请确认这是你信任的网站。PaneFlow Desktop 不会在应用内加载该页面。",
      buttons: ["取消", "打开"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (confirmation.response !== 1) return;
    await shell.openExternal(url.toString());
  });
  ipcMain.handle("diagnostics:read", (event) => { assertTrustedSender(event); return diagnosticLog.tail(); });
  ipcMain.handle("remote:status", (event) => { assertTrustedSender(event); return remoteBridge.status; });
  ipcMain.handle("remote:settings", (event, rawSettings: unknown) => {
    assertTrustedSender(event);
    return remoteBridge.updateSettings(remoteSettingsSchema.parse(rawSettings));
  });
  ipcMain.handle("remote:pairing-begin", (event) => { assertTrustedSender(event); return remoteBridge.beginPairing(); });
  ipcMain.handle("remote:pairing-confirm", (event, rawPairingId: unknown) => {
    assertTrustedSender(event);
    return remoteBridge.confirmPairing(remoteCredentialIdSchema.parse(rawPairingId));
  });
  ipcMain.handle("remote:passkey-revoke", (event, rawCredentialId: unknown) => {
    assertTrustedSender(event);
    return remoteBridge.revokePasskey(remoteCredentialIdSchema.parse(rawCredentialId));
  });
  ipcMain.handle("remote:logout-all", (event) => { assertTrustedSender(event); remoteBridge.logoutAllMobiles(); });
  ipcMain.handle("deployment:get", async event => {
    assertTrustedSender(event);
    const locate = async (name: string) => { try { return (await execFileAsync("where.exe", [name], { windowsHide: true, timeout: 5000 })).stdout.split(/\r?\n/).find(line => /\.exe$/i.test(line.trim()))?.trim() ?? ""; } catch { return ""; } };
    const [nodePath, cloudflaredPath] = await Promise.all([locate("node.exe"), locate("cloudflared.exe")]);
    return { config: await deploymentManager.getConfig(), status: deploymentManager.status(), defaults: { nodePath, cloudflaredPath, cwd: (await stateStore.load())?.defaultCwd || fallbackAppServerWorkingDirectory } };
  });
  ipcMain.handle("deployment:check", (event, raw: unknown) => { assertTrustedSender(event); return deploymentManager.check(raw); });
  ipcMain.handle("deployment:save", (event, raw: unknown) => { assertTrustedSender(event); return deploymentManager.save(raw); });
  ipcMain.handle("deployment:start", event => { assertTrustedSender(event); return deploymentManager.start(); });
  ipcMain.handle("deployment:stop", event => { assertTrustedSender(event); return deploymentManager.stop(); });
  ipcMain.handle("deployment:autostart", (event, enabled: unknown) => { assertTrustedSender(event); if (typeof enabled !== "boolean") throw new Error("无效自启设置"); return deploymentManager.setAutostart(enabled); });
  ipcMain.handle("update:check", event => { assertTrustedSender(event); return updateManager.check(); });
  ipcMain.handle("update:prepare", event => { assertTrustedSender(event); return updateManager.prepare(); });
  ipcMain.handle("update:install", async event => {
    assertTrustedSender(event);
    const answer = await dialog.showMessageBox(mainWindow!, { type: "question", title: "确认升级 PaneFlow", message: "备份配置和旧程序后安装更新？", detail: "仅在所有任务已结束时升级。安装失败将恢复旧程序并保留恢复材料。当前 Windows 包未配置代码签名，请确认信任此项目。", buttons: ["取消", "备份并安装"], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await updateManager.install();
  });
};

const pendingDeltaEvents = new Map<string, ProtocolEvent>();
let deltaBatchTimer: NodeJS.Timeout | null = null;
const flushDeltaEvents = (): void => {
  if (deltaBatchTimer) clearTimeout(deltaBatchTimer);
  deltaBatchTimer = null;
  if (!pendingDeltaEvents.size) return;
  const events = [...pendingDeltaEvents.values()];
  pendingDeltaEvents.clear();
  const generations = new Map<number, ProtocolEvent[]>();
  for (const event of events) {
    const generationEvents = generations.get(event.generation) ?? [];
    generationEvents.push(event);
    generations.set(event.generation, generationEvents);
  }
  for (const [generation, generationEvents] of generations) {
    mainWindow?.webContents.send("codex:event", { generation, kind: "notification-batch", payload: generationEvents });
  }
};
const bufferDeltaEvent = (event: ProtocolEvent): boolean => {
  if (event.kind !== "notification") return false;
  const envelope = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
  const method = typeof envelope.method === "string" ? envelope.method : "";
  if (!method.includes("/delta") && !method.endsWith("outputDelta")) return false;
  const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
  const field = typeof params.delta === "string" ? "delta" : typeof params.output === "string" ? "output" : null;
  if (!field) return false;
  const key = [event.generation, method, params.threadId, params.turnId, params.itemId].map(String).join(":");
  const previous = pendingDeltaEvents.get(key);
  if (previous) {
    const previousEnvelope = previous.payload as Record<string, unknown>;
    const previousParams = previousEnvelope.params as Record<string, unknown>;
    previousParams[field] = `${typeof previousParams[field] === "string" ? previousParams[field] : ""}${typeof params[field] === "string" ? params[field] : ""}`;
  } else {
    pendingDeltaEvents.set(key, { ...event, payload: { ...envelope, params: { ...params } } });
  }
  if (!deltaBatchTimer) deltaBatchTimer = setTimeout(flushDeltaEvents, 0);
  return true;
};
supervisor.on("state", (state) => {
  if (pendingDeltaEvents.size) flushDeltaEvents();
  mainWindow?.webContents.send("codex:state", state);
  remoteBridge?.handleConnectionState(state);
});
supervisor.on("protocol", (event) => {
  if (event.kind === "diagnostic") {
    void diagnosticLog?.write(event.payload).catch(() => undefined);
    return;
  }
  remoteBridge?.handleProtocolEvent(event);
  if (bufferDeltaEvent(event)) return;
  if (event.kind === "notification" && pendingDeltaEvents.size) flushDeltaEvents();
  mainWindow?.webContents.send("codex:event", event);
});

app.whenReady().then(async () => {
  const dataDirectory = app.getPath("userData");
  mediaStore = new MediaStore(join(dataDirectory, "media"));
  fileStore = new FileStore(join(dataDirectory, "files"));
  await Promise.all([mediaStore.initialize(), fileStore.initialize()]);
  stateStore = new StateStore(join(dataDirectory, "workspaces", "default.json"));
  const persistedWorkspace = await stateStore.load();
  const initialWorkingDirectory = persistedWorkspace?.defaultCwd || fallbackAppServerWorkingDirectory;
  if (await isExistingDirectory(initialWorkingDirectory)) {
    supervisor.setWorkingDirectory(initialWorkingDirectory);
  }
  diagnosticLog = new DiagnosticLog(join(dataDirectory, "logs"));
  await diagnosticLog.initialize();
  remoteBridge = new RemoteBridge(
    supervisor,
    new RemoteCredentialStore(join(dataDirectory, "remote", "credentials.json")),
    new RemoteAuditLog(join(dataDirectory, "remote", "audit.jsonl")),
    new RemoteRequestStore(join(dataDirectory, "remote", "requests.enc")),
    new RemoteQueueStore(join(dataDirectory, "remote", "queue.enc"))
  );
  remoteBridgeLease = new ProcessOwnershipLease(join(dataDirectory, "remote", ".bridge-owner"));
  const initialRemotePane = persistedWorkspace?.panes.find((pane) => pane.id === persistedWorkspace.focusedPaneId) ?? persistedWorkspace?.panes[0];
  remoteBridge.updateSessionDefaults({ cwd: persistedWorkspace?.defaultCwd || null, model: initialRemotePane?.model ?? null });
  remoteBridge.updateAppearance({ theme: persistedWorkspace?.appearance.theme ?? "system", accentColor: persistedWorkspace?.appearance.accentColor ?? "#10a37f" });
  remoteBridge.on("status", (status) => mainWindow?.webContents.send("remote:status-changed", status));
  const ownsRemoteBridge = remoteBridgeLease.acquire();
  await remoteBridge.initialize(ownsRemoteBridge, Boolean(upgradeDirectory));
  const pendingWork = () => [...remoteBridge.getPendingWork(), ...(desktopRequests ? [{ kind: "request", state: "in-flight" }] : [])];
  deploymentManager = new DeploymentManager({ dataDirectory, relayEntry: app.isPackaged ? join(process.resourcesPath, "relay", "dist", "server.js") : join(app.getAppPath(), "remote", "relay", "dist", "server.js"), childWrapper: app.isPackaged ? join(process.resourcesPath, "deployment-child.mjs") : join(app.getAppPath(), "scripts", "deployment-child.mjs"), version: app.getVersion(), pendingWork,
    setRemoteSettings: async origin => { await remoteBridge.updateSettings({ enabled: true, relayUrl: origin }); },
    setWorkingDirectory: cwd => supervisor.setWorkingDirectory(cwd),
    loginItem: { get: () => app.getLoginItemSettings().openAtLogin, set: enabled => app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath("exe"), args: [`--paneflow-data-directory=${dataDirectory}`] }) }
  });
  updateManager = new UpdateManager({ version: app.getVersion(), dataDirectory, executable: app.getPath("exe"), helperScript: app.isPackaged ? join(process.resourcesPath, "apply-update.ps1") : join(app.getAppPath(), "scripts", "apply-update.ps1"), packaged: app.isPackaged, pendingWork,
    maintenance: async enabled => { maintenanceMode = enabled; try { await remoteBridge.setMaintenance(enabled); } catch (error) { maintenanceMode = false; throw error; } }, quit: () => { void shutdownApplication(); }
  });
  if (upgradeDirectory) {
    const abortWatcher = setInterval(() => { if (existsSync(join(upgradeDirectory, "abort.json"))) { clearInterval(abortWatcher); void shutdownApplication(); } }, 250);
    abortWatcher.unref();
  }
  const launcherRelayUrl = process.env.CODEX_PANE_RELAY_URL?.trim();
  if (ownsRemoteBridge && launcherRelayUrl) {
    await remoteBridge.updateSettings(remoteSettingsSchema.parse({ enabled: true, relayUrl: launcherRelayUrl }));
  }
  protocol.handle("codex-media", async (request) => {
    const id = mediaRequestId(request.url, request.method);
    if (!id) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "X-Content-Type-Options": "nosniff" } });
    try {
      const bytes = await mediaStore.read(id);
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new Response(body, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") void diagnosticLog.write({ level: "warning", message: "无法读取托管图片", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
  });
  registerIpc();
  await createWindow();
  try {
    supervisor.setRuntimeValidator(new RuntimeProtocolValidator(join(app.getAppPath(), "packages", "protocol", "schema", "generated")));
  } catch (error) {
    mainWindow?.webContents.send("codex:event", {
      generation: 0,
      kind: "diagnostic",
      payload: { level: "warning", message: `协议 Schema 加载失败，已保留基础消息校验：${error instanceof Error ? error.message : String(error)}` }
    });
    mainWindow?.webContents.send("codex:state", {
      phase: "error",
      generation: 0,
      codexVersion: null,
      compatible: false,
      message: "固定协议 Schema 加载失败。为避免错误审批或写入，PaneFlow Desktop 已停止连接；请重新安装应用。"
    });
    return;
  }
  try {
    await supervisor.start();
  } catch (error) {
    mainWindow?.webContents.send("codex:state", { ...supervisor.state, phase: "error", message: error instanceof Error ? error.message : String(error) });
  }
  if (ownsRemoteBridge && (await deploymentManager.getConfig())?.enabled) {
    await deploymentManager.start().catch(error => diagnosticLog.write({ level: "warning", message: "公网服务未启动", error: String(error) }));
  }
  if (upgradeDirectory && supervisor.state.phase === "ready" && (!(await deploymentManager.getConfig())?.enabled || deploymentManager.status().phase === "running")) {
    writeFileSync(join(upgradeDirectory, "ready.json"), JSON.stringify({ version: app.getVersion(), readyAt: Date.now(), processId: process.pid, nonce: process.env.PANEFLOW_UPGRADE_NONCE, codex: "ready", deployment: deploymentManager.status().phase }));
    await remoteBridge.setMaintenance(false); maintenanceMode = false;
  }
}).catch(async (error) => {
  const detail = redactSensitiveText(error instanceof Error ? error.message : String(error), true);
  dialog.showErrorBox("无法启动 PaneFlow Desktop", `应用数据或运行环境初始化失败。\n\n${detail}\n\n请检查数据目录权限和可用磁盘空间后重试。`);
  try {
    await deploymentManager?.stop({ shutdown: true }); await relinquishRemoteBridge(); await supervisor.stop(); confirmUpgradeShutdown();
    if (ownsPrimarySession) removePrimarySessionLock();
    app.exit(1);
  } catch { /* Keep the process and data in place if owned writers cannot be confirmed stopped. */ }
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  void relinquishRemoteBridge();
  if (ownsPrimarySession) removePrimarySessionLock();
});
app.on("before-quit", (event) => {
  void relinquishRemoteBridge();
  if (forceClosing || !supervisor.isRunning) return;
  event.preventDefault();
  void shutdownApplication();
});
