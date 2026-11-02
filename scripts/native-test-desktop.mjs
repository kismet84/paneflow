// Explicit, isolated live test instance. Control is stdin only; no HTTP control API.
import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
if (!process.argv.includes('--live')) throw new Error('Explicit --live is required');
const root = resolve(import.meta.dirname, '..');
const stage = process.env.PANEFLOW_TEST_STAGE || '0.5';
if (!/^0\.[5678]$/.test(stage)) throw new Error('Unsupported test stage');
const output = resolve(root, `outputs/stage-${stage}/second-computer`);
// Retain the isolated computer identity across stage upgrades. Never use production data.
const testData = resolve(root, 'outputs/stage-0.5/second-computer/desktop-data');
await mkdir(resolve(output, 'workspace'), { recursive: true });
const origin = 'http://localhost:48433';
const relay = spawn(process.execPath, [resolve(root, 'remote/relay/dist/server.js')], { cwd: resolve(root, 'remote/relay'), windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: '48433', PUBLIC_ORIGIN: origin }, stdio: 'ignore' });
let app;
try {
  await expect.poll(async () => { if (relay.exitCode !== null) throw new Error('Owned test relay exited'); return fetch(origin+'/health').then(r=>r.ok).catch(()=>false); }).toBe(true);
  app = await electron.launch({ args: ['--disable-gpu', '--in-process-gpu', root], env: { ...process.env, CODEX_PANE_LOAD_DIST: '1', CODEX_PANE_USER_DATA_DIR: testData, CODEX_PANE_DISABLE_HARDWARE_ACCELERATION: '1' } });
  const desktop = await app.firstWindow();
  await expect.poll(async () => (await desktop.evaluate(()=>window.codexPane.bootstrap())).connection.phase, {timeout:60000}).toBe('ready');
  await desktop.evaluate(url=>window.codexPane.updateRemoteSettings({enabled:true,relayUrl:url}),origin);
  await expect.poll(async () => (await desktop.evaluate(()=>window.codexPane.getRemoteAccessStatus())).phase).toBe('connected');
  const call = request => desktop.evaluate(request=>window.codexPane.request(request),request);
  console.log(JSON.stringify({ready:true,origin,isolatedDesktop:true,physicalSecondComputer:false}));
  for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
    try {
      const command=JSON.parse(line); let result;
      if(command.action==='close')break;
      if(command.action==='pair')result=(await desktop.evaluate(()=>window.codexPane.beginRemotePairing())).pairing;
      else if(command.action==='queue') {
        const encrypted = await readFile(resolve(testData, 'remote/queue.enc'));
        result = await app.evaluate(({safeStorage}, bytes) => {
          const state = JSON.parse(safeStorage.decryptString(Buffer.from(bytes)));
          return {paused:state.paused,pauseReason:state.pauseReason,tasks:state.tasks.map(({text,deviceId,...task})=>task)};
        }, [...encrypted]);
        await writeFile(resolve(output,'queue-observation.json'),JSON.stringify({observedAt:new Date().toISOString(),...result},null,2));
      }
      else if(command.action==='status')result=await desktop.evaluate(()=>window.codexPane.getRemoteAccessStatus());
      else if(command.action==='confirm') {
        const pairing=(await desktop.evaluate(()=>window.codexPane.getRemoteAccessStatus())).pairing;
        if(!pairing?.readyToConfirm||command.code!==pairing.code)throw new Error('Phone code must match the current desktop pairing');
        result=await desktop.evaluate(id=>window.codexPane.confirmRemotePairing(id),pairing.pairingId);
      } else if(command.action==='thread') {
        const response=await call({method:'thread/start',params:{cwd:resolve(output,'workspace'),model:'gpt-6.1-sol',ephemeral:false}});
        const id=response.thread.id;
        await call({method:'thread/settings/update',params:{threadId:id,permissions:':read-only',approvalPolicy:'on-request',approvalsReviewer:'user'}});
        await call({method:'thread/name/set',params:{threadId:id,name:command.name||`${stage} 隔离电脑验收`}});
        result={threadId:id};
        await writeFile(resolve(output,'thread.json'),JSON.stringify(result));
      } else if(command.action==='read') result=await call({method:'thread/turns/list',params:{threadId:command.threadId,cursor:null,limit:20,sortDirection:'desc',itemsView:'full'}});
      else if(command.action==='browser') {
        const pairing=(await desktop.evaluate(()=>window.codexPane.beginRemotePairing())).pairing;
        const existing=new Set(app.windows());
        await app.evaluate(async({BrowserWindow},url)=>{const w=new BrowserWindow({width:402,height:874,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});await w.loadURL(url);},pairing.url);
        const mobile=app.windows().find(w=>!existing.has(w));
        const cdp=await app.context().newCDPSession(mobile);
        await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
        await mobile.getByRole('button',{name:'创建 Passkey'}).click();
        await expect.poll(async()=>(await desktop.evaluate(()=>window.codexPane.getRemoteAccessStatus())).pairing?.readyToConfirm,{timeout:20000}).toBe(true);
        const confirmed=(await desktop.evaluate(()=>window.codexPane.getRemoteAccessStatus())).pairing;
        await expect(mobile.locator('.code')).toHaveText(confirmed.code);
        await desktop.evaluate(id=>window.codexPane.confirmRemotePairing(id),confirmed.pairingId);
        await mobile.getByRole('button',{name:'使用 Passkey 登录'}).click();
        const frame=mobile.frameLocator('#mobile-frame');await frame.getByRole('button',{name:'打开会话列表'}).click();
        await frame.getByRole('button',{name:new RegExp(command.title)}).click();
        await expect(frame.getByRole('heading',{name:command.title})).toBeVisible();
        await mobile.screenshot({path:resolve(output,'second-client.png')});
        result={selectedTitle:command.title,physicalPhone:false,virtualAuthenticator:true};
      }
      else throw new Error('Unknown test action');
      console.log(JSON.stringify({action:command.action,result}));
    }catch(error){console.log(JSON.stringify({error:String(error)}));}
  }
}finally{await app?.close().catch(()=>{});if(relay.exitCode===null)relay.kill();process.stdin.pause();}
