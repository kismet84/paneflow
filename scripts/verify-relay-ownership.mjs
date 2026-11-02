import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const socket = createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const children = [];
function launch() {
  const child = spawn(process.execPath, [resolve(root, 'remote/relay/dist/server.js')], {
    cwd: resolve(root, 'remote/relay'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: `http://localhost:${port}` },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  children.push(child);
  return child;
}
try {
  const owner = launch();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readiness timeout')), 10000);
    owner.once('error', reject);
    owner.once('message', message => { clearTimeout(timer); assert.deepEqual(message, { type: 'relay.ready', port }); resolve(); });
  });
  const duplicate = launch();
  let duplicateReady = false;
  duplicate.on('message', () => { duplicateReady = true; });
  const code = await new Promise((resolve, reject) => { duplicate.once('error', reject); duplicate.once('exit', resolve); });
  assert.notEqual(code, 0);
  assert.equal(duplicateReady, false);
  assert.equal((await fetch(`http://localhost:${port}/health`)).ok, true);
  console.log('PASS owned relay IPC readiness; occupied port rejects without impersonating or terminating existing service');
} finally {
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill();
  })));
}
