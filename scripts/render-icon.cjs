const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { app, BrowserWindow } = require("electron");

app.whenReady().then(async () => {
  const svg = readFileSync(resolve("assets/icon.svg"), "utf8");
  const window = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false });
  await window.loadURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(resolve("assets/icon.png"), image.toPNG());
  window.destroy();
  app.quit();
});
