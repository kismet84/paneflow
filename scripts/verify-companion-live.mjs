// Explicit opt-in: uses the current Codex login for three small, text-only turns.
import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run real model requests.');
const root = resolve(import.meta.dirname, '..');
for (const marker of ['.session-fixture', '.approval-fixture']) {
  if (existsSync(resolve(root, marker))) throw new Error(`Remove the owned test fixture before live verification: ${marker}`);
}
const runId = randomUUID();
const output = resolve(root, 'outputs', `companion-live-${runId}`);
await mkdir(output, { recursive: true });
const workspace = resolve(output, 'workspace');
await mkdir(workspace);
const origin = 'http://localhost:48322';
const report = { runId, realCodex: true, physicalAndroid: false, passkey: 'virtual CTAP2 authenticator', checks: [], threadId: null };
let relay;
let application;
let mobile;
const startRelay = async () => {
  relay = spawn(process.execPath, [resolve(root, 'remote/relay/dist/server.js')], {
    cwd: resolve(root, 'remote/relay'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '48322', PUBLIC_ORIGIN: origin }, stdio: 'ignore'
  });
  await expect.poll(async () => {
    if (relay.exitCode !== null) throw new Error('Owned relay failed to start; check port 48322.');
    return fetch(`${origin}/health`).then(r => r.ok).catch(() => false);
  }, { timeout: 15000 }).toBe(true);
};
const stopRelay = async () => {
  if (!relay || relay.exitCode !== null) return;
  const exited = new Promise(resolve => relay.once('exit', resolve));
  relay.kill();
  await exited;
};
const check = name => { report.checks.push(name); console.log(`PASS ${name}`); };
try {
  await startRelay();
  application = await electron.launch({
    args: ['--disable-gpu', '--in-process-gpu', '--use-angle=swiftshader', '--use-gl=angle', root],
    env: { ...process.env, CODEX_PANE_LOAD_DIST: '1', CODEX_PANE_USER_DATA_DIR: resolve(output, 'desktop-data'), CODEX_PANE_DISABLE_HARDWARE_ACCELERATION: '1' }
  });
  const desktop = await application.firstWindow();
  await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.bootstrap())).connection.phase, { timeout: 60000 }).toBe('ready');
  const connection = (await desktop.evaluate(() => window.codexPane.bootstrap())).connection;
  report.codexVersion = connection.codexVersion;
  const call = request => desktop.evaluate(request => window.codexPane.request(request), request);
  const started = await call({ method: 'thread/start', params: { cwd: workspace, model: 'gpt-6.1-sol', ephemeral: false } });
  const threadId = started.thread.id;
  report.threadId = threadId;
  await call({ method: 'thread/settings/update', params: { threadId, permissions: ':read-only', approvalPolicy: 'on-request', approvalsReviewer: 'user' } });
  const title = `Android 原型验收 ${runId.slice(0, 8)}`;
  await call({ method: 'thread/name/set', params: { threadId, name: title } });
  await desktop.evaluate(() => { window.__liveEvents = []; window.codexPane.onProtocolEvent(e => window.__liveEvents.push(e)); });
  const token = `PANE_${runId.slice(0, 8)}`;
  await call({ method: 'turn/start', params: { threadId, model: 'gpt-6.1-sol', effort: 'low', input: [{ type: 'text', text: `只回复 ${token}_DESKTOP，不调用工具，不读写文件。记住代号 ${token}，供后续验证会话连续性。`, text_elements: [] }] } });
  await expect.poll(() => desktop.evaluate(id => window.__liveEvents.some(e => e.payload?.method === 'turn/completed' && e.payload.params.threadId === id), threadId), { timeout: 180000 }).toBe(true);
  check('real desktop turn completed');
  await desktop.evaluate(url => window.codexPane.updateRemoteSettings({ enabled: true, relayUrl: url }), origin);
  await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).phase, { timeout: 15000 }).toBe('connected');
  const pairing = (await desktop.evaluate(() => window.codexPane.beginRemotePairing())).pairing;
  const existing = new Set(application.windows());
  await application.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ width: 402, height: 874, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(url, { userAgent: 'Mozilla/5.0 (Linux; Android 15; Mobile) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36' });
  }, pairing.url);
  mobile = application.windows().find(w => !existing.has(w));
  const cdp = await application.context().newCDPSession(mobile);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await mobile.getByRole('button', { name: '创建 Passkey' }).click();
  await expect.poll(async () => (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).pairing?.readyToConfirm, { timeout: 20000 }).toBe(true);
  const confirmed = (await desktop.evaluate(() => window.codexPane.getRemoteAccessStatus())).pairing;
  await expect(mobile.locator('.code')).toHaveText(confirmed.code);
  await desktop.evaluate(id => window.codexPane.confirmRemotePairing(id), confirmed.pairingId);
  await mobile.getByRole('button', { name: '使用 Passkey 登录' }).click();
  const frame = mobile.frameLocator('#mobile-frame');
  await frame.getByRole('button', { name: '打开会话列表' }).click();
  await frame.getByRole('button', { name: new RegExp(title) }).click();
  await expect(frame.locator('.markdown').filter({ hasText: `${token}_DESKTOP` }).first()).toBeVisible({ timeout: 30000 });
  check('paired, authenticated and loaded real desktop history');
  // A stale UI must not redirect a message to another task.
  await frame.locator('body').evaluate(() => window.parent.postMessage({ source: 'codex-pane-mobile-ui', type: 'command', command: { type: 'turn.send', requestId: crypto.randomUUID(), threadId: 'wrong-thread', text: 'must not be sent' } }, '*'));
  await expect(frame.getByText('会话已切换，请重新打开目标会话后发送。')).toBeVisible();
  check('stale target rejected');
  const send = async (prompt, expected) => {
    await frame.getByPlaceholder('输入消息…').fill(prompt);
    await frame.getByRole('button', { name: '发送', exact: true }).click();
    await expect(frame.locator('.markdown').filter({ hasText: expected }).first()).toBeVisible({ timeout: 180000 });
  };
  await send('回复刚才记住的代号，并加后缀 _MOBILE。只回复结果，不调用工具。', `${token}_MOBILE`);
  check('mobile continued same real conversation with retained context');
  await mobile.screenshot({ path: resolve(output, 'conversation.png') });
  await stopRelay();
  await expect(mobile.getByText(/连接中断|网络连接异常/).first()).toBeVisible({ timeout: 15000 });
  await startRelay();
  await mobile.getByRole('button', { name: '使用 Passkey 登录' }).click({ timeout: 60000 });
  await expect(frame.getByRole('heading', { name: title })).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('.markdown').filter({ hasText: `${token}_MOBILE` }).first()).toBeVisible();
  await send('回复此前记住的代号，并加后缀 _RECONNECTED。只回复结果，不调用工具。', `${token}_RECONNECTED`);
  check('relay restart, reauthentication, history recovery and real follow-up');
  await mobile.screenshot({ path: resolve(output, 'reconnected.png') });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  if (mobile) await mobile.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${output}`);
  await application?.close().catch(() => {});
  await stopRelay();
}
