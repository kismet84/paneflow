import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateConfig(config) {
  const url = new URL(config.origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('固定公网入口必须是 HTTPS 域名');
  if (url.hostname.endsWith('.trycloudflare.com')) throw new Error('自启不能使用临时 Quick Tunnel 地址');
  if (!/^[a-f0-9-]{36}$/.test(config.tunnelId)) throw new Error('无效的固定隧道 ID');
  return { ...config, origin: url.origin };
}

export async function main() {
  const root = resolve(import.meta.dirname, '..');
  const data = resolve(root, 'data/public-companion');
  const config = validateConfig(JSON.parse(await readFile(resolve(data, 'persistent.json'), 'utf8')));
  await mkdir(resolve(data, 'logs'), { recursive: true });
  // An OS-owned loopback listener is released on crash; no stale PID cleanup or process-name kills.
  const lock = createServer(socket => socket.end());
  try { await new Promise((ok, fail) => { lock.once('error', fail); lock.listen(48326, '127.0.0.1', ok); }); }
  catch (e) { if (e.code === 'EADDRINUSE') { console.log('PaneFlow 公网守护已运行。'); return; } throw e; }
  const children = new Map();
  const childPids = new Map();
  const timers = new Set();
  let stopping = false;
  const log = message => console.log(new Date().toISOString(), message);
  const state = () => writeFile(resolve(data, 'launcher.json'), JSON.stringify({ supervisorPid: process.pid, ...Object.fromEntries([...childPids].map(([name, pid]) => [name+'Pid', pid])), origin: config.origin, port: 48322, mode: 'persistent', updatedAt: new Date().toISOString() }, null, 2));
  let stateWrites = Promise.resolve();
  const saveState = () => { stateWrites = stateWrites.then(state).catch(e => log('状态写入失败：'+e.code)); };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    // Only handles created by this supervisor are eligible for termination.
    await Promise.all([...children.values()].map(child => new Promise(done => {
      if (child.exitCode !== null || !child.pid) return done();
      const timer = setTimeout(done, 5000); child.once('exit', () => { clearTimeout(timer); done(); });
      if (child.connected) child.send({type:'stop'}); else child.kill();
    })));
    await stateWrites; lock.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { void stop().then(() => process.exit(0)); });
  const supervise = async (name, executable, args, options = {}, attempt = 0) => {
    if (stopping) return;
    const file = await open(resolve(data, 'logs', name+'.log'), 'a');
    const started = Date.now();
    const child = spawn(process.execPath, [resolve(root,'scripts/public-companion-child.mjs')], { cwd: root, windowsHide: true, stdio: ['ignore', file.fd, file.fd, 'ipc'] });
    children.set(name, child); saveState();
    child.on('message', message => { if (message?.type === 'started') { childPids.set(name,message.pid); saveState(); } });
    child.once('spawn', () => child.send({type:'start',executable,args,cwd:options.cwd ?? root,env:options.env ?? process.env}));
    let settled = false;
    const ended = async (code, error) => {
      if (settled) return; settled = true;
      children.delete(name); childPids.delete(name); saveState(); await file.close();
      if (stopping) return;
      // Explicit tray Quit is respected; a crash is recovered with bounded backoff.
      if (name === 'desktop' && code === 0) { log('桌面主动退出，停止本次公网服务。'); await stop(); return; }
      const next = Date.now()-started > 60000 ? 0 : Math.min(attempt+1, 5);
      const delay = Math.min(30000, 1000 * 2**next);
      log(`${name} 退出 (${error?.code ?? code})，${delay}ms 后恢复`);
      const timer = setTimeout(() => { timers.delete(timer); void supervise(name, executable, args, options, next).catch(e => { log(e.message); process.exitCode=1; void stop(); }); }, delay);
      timers.add(timer);
    };
    child.once('error', e => { void ended(null, e); });
    child.once('exit', code => { void ended(code); });
  };
  try {
    await supervise('relay', process.execPath, [resolve(root, 'remote/relay/dist/server.js')], { cwd: resolve(root, 'remote/relay'), env: { ...process.env, HOST: '127.0.0.1', PORT: '48322', PUBLIC_ORIGIN: config.origin } });
    await supervise('tunnel', config.cloudflared, ['tunnel', '--config', resolve(data, 'named-tunnel.yml'), '--no-autoupdate', 'run', config.tunnelId]);
    await supervise('desktop', resolve(root, 'release/win-unpacked/PaneFlow Desktop.exe'), (config.inspectUi === true || process.argv.includes('--inspect-ui')) ? ['--remote-debugging-address=127.0.0.1','--remote-debugging-port=48325'] : [], { env: { ...process.env, CODEX_PANE_LOAD_DIST: '1', CODEX_PANE_USER_DATA_DIR: data, CODEX_PANE_RELAY_URL: config.origin, PANEFLOW_BACKGROUND: '1' } });
    await writeFile(resolve(data, '公网地址.txt'), config.origin+'\n');
    log('固定公网入口：'+config.origin);
  } catch (e) { await stop(); throw e; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
