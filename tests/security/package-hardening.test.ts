import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop package hardening", () => {
  it("ships application code in an integrity-checked asar with unsafe Electron entry points disabled", async () => {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8"));

    expect(packageJson.build.asar).toBe(true);
    expect(packageJson.build.electronFuses).toMatchObject({
      runAsNode: false,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true
    });
    expect(packageJson.scripts["package:win"]).toContain("electron-builder --win dir");
    expect(packageJson.build.win.target).toEqual(["dir"]);
    expect(packageJson.build).not.toHaveProperty("nsis");
    expect(packageJson.build).not.toHaveProperty("portable");
  });

  it("waits for the renderer workspace flush before every native window close", async () => {
    const [main, preload, app] = await Promise.all([
      readFile(resolve("electron/main/index.ts"), "utf8"),
      readFile(resolve("electron/preload/index.ts"), "utf8"),
      readFile(resolve("src/App.vue"), "utf8")
    ]);
    expect(main).toContain('webContents.send("window:close-requested")');
    expect(main).toContain('ipcMain.handle("window:close-response"');
    expect(preload).toContain("onCloseRequested:");
    expect(app).toContain("store.flushSave().then(");
  });

  it("loads the signed mobile UI through a Safari-compatible isolated document", async () => {
    const [bootstrap, bootstrapSource, bootstrapHtml, bootstrapCss, desktopIcon, mobileIcon, mobileApp, mobileCss, bundler, viteConfig] = await Promise.all([
      readFile(resolve("remote/relay/public/bootstrap.js"), "utf8"),
      readFile(resolve("remote/relay/src/mobile-bootstrap.js"), "utf8"),
      readFile(resolve("remote/relay/public/index.html"), "utf8"),
      readFile(resolve("remote/relay/public/bootstrap.css"), "utf8"),
      readFile(resolve("assets/icon.svg"), "utf8"),
      readFile(resolve("remote/relay/public/icon.svg"), "utf8"),
      readFile(resolve("remote/mobile/src/App.vue"), "utf8"),
      readFile(resolve("remote/mobile/src/styles.css"), "utf8"),
      readFile(resolve("remote/mobile/scripts/bundle.mjs"), "utf8"),
      readFile(resolve("remote/mobile/vite.config.ts"), "utf8")
    ]);
    expect(bootstrapSource).toContain("mountedFrame.srcdoc = html");
    expect(bootstrapSource).toContain('mountedFrame.sandbox = "allow-scripts allow-forms allow-popups"');
    expect(bootstrapSource).not.toContain("URL.createObjectURL(new Blob");
    expect(bootstrapSource).not.toContain("allow-same-origin");
    expect(bootstrapSource).toContain('setStatus("验证身份后即可连接桌面端")');
    expect(bootstrapSource).not.toContain('setStatus("请使用 Passkey 登录")');
    expect(bootstrap.length).toBeLessThan(bootstrapSource.length * 0.7);
    expect(bootstrap).not.toContain("mountedFrame");
    expect(bootstrap).not.toContain("sourceMappingURL");
    expect(bootstrapHtml).toContain('<img class="mark" src="./icon.svg"');
    expect(mobileIcon.replaceAll("\r\n", "\n")).toBe(desktopIcon.replaceAll("\r\n", "\n"));
    expect(bootstrapCss).toContain("@media (prefers-color-scheme: light)");
    expect(mobileApp).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(mobileCss).toContain("--bg: #f3f5f7");
    expect(bundler).toContain("Mobile bundle must be a classic self-contained script");
    expect(viteConfig).toContain('format: "iife"');
  });
});
