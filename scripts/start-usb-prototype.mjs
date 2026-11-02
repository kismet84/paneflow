import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(import.meta.dirname, '..');
const adb = process.env.ADB_PATH || join(process.env.LOCALAPPDATA, 'Android/Sdk/platform-tools/adb.exe');
const port = 48321;
const origin = `http://localhost:${port}`;
const data = resolve(root, 'data/usb-prototype');
await mkdir(data, { recursive: true });
const devices = execFileSync(adb, ['devices'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/).filter(line => /\tdevice$/.test(line)).map(line => line.split('\t')[0]);
if (devices.length !== 1) throw new Error('请只连接一部已授权 USB 调试的安卓手机。');
const serial = devices[0];
const mappings = execFileSync(adb, ['-s', serial, 'reverse', '--list'], { encoding: 'utf8', windowsHide: true });
if (mappings.split(/\r?\n/).some(line => line.split(/\s+/)[1] === `tcp:${port}`)) throw new Error(`USB 端口 ${port} 已被占用，未覆盖现有转发。`);
const require = createRequire(import.meta.url);
const packaged = resolve(root, 'release/win-unpacked/PaneFlow Desktop.exe');
const executable = existsSync(packaged) ? packaged : require('electron');
let relay;
let desktop;
let forwarded = false;
let stopPromise;
const stop = () => stopPromise ??= (async () => {
  if (relay && relay.exitCode === null && relay.pid) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      relay.once('exit', () => { clearTimeout(timer); resolve(); });
      relay.kill();
    });
    if (relay.connected) relay.disconnect();
  }
  if (forwarded) {
    try { execFileSync(adb, ['-s', serial, 'reverse', '--remove', `tcp:${port}`], { windowsHide: true }); } catch { /* Phone may already be unplugged. */ }
  }
})();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
  console.log('正在回收本轮中继和 USB 转发；已打开的桌面窗口保留，避免丢失输入。');
  void stop().then(() => process.exit(0));
});
try {
  relay = spawn(process.execPath, [resolve(root, 'remote/relay/dist/server.js')], {
    cwd: resolve(root, 'remote/relay'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin }, stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本轮中继启动超时。')), 15000);
    relay.once('error', error => { clearTimeout(timer); reject(error); });
    relay.once('exit', () => { clearTimeout(timer); reject(new Error('本机中继启动失败；未连接已有服务。')); });
    relay.on('message', message => {
      if (message?.type === 'relay.ready' && message.port === port) { clearTimeout(timer); resolve(); }
    });
  });
  execFileSync(adb, ['-s', serial, 'reverse', '--no-rebind', `tcp:${port}`, `tcp:${port}`], { windowsHide: true });
  forwarded = true;
  desktop = spawn(executable, existsSync(packaged) ? [] : [root], {
    cwd: root, windowsHide: false,
    env: { ...process.env, CODEX_PANE_LOAD_DIST: '1', CODEX_PANE_USER_DATA_DIR: data }, stdio: 'ignore'
  });
  const desktopExited = new Promise((resolve, reject) => { desktop.once('exit', resolve); desktop.once('error', reject); });
  // Attach immediately, even while the launcher journal is being written.
  void desktopExited.catch(() => undefined);
  await writeFile(resolve(data, 'launcher.json'), JSON.stringify({ relayPid: relay.pid, desktopPid: desktop.pid, port, startedAt: new Date().toISOString() }, null, 2));
  console.log(`Windows 设置 → 远程访问 → ${origin} → 保存并连接 → 生成配对二维码。`);
  console.log('手机 APP 粘贴配对链接，创建 Passkey，核对双方确认码后在 Windows 确认。');
  console.log('关闭 Windows 配套端后，本启动器回收本轮中继和 USB 转发。');
  await desktopExited;
} finally { await stop(); }
