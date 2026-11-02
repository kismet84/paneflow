import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { generateKeyPairSync, createHash, sign, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { validateConfig } from './public-companion-supervisor.mjs';
test('persistent configuration refuses temporary or untrusted origins', () => {
  const config={origin:'https://paneflow.example.com',tunnelId:randomUUID()};
  assert.equal(validateConfig(config).origin,config.origin);
  for(const origin of ['https://random.trycloudflare.com','http://example.com','https://u:p@example.com','https://example.com/?a=1']) assert.throws(()=>validateConfig({...config,origin}));
});
test('policy startup is retryable; ready device reconnects; revoked device is rejected', {timeout:20000}, async () => {
  const root=resolve(import.meta.dirname,'..');
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[resolve(root,'remote/relay/dist/server.js')],{cwd:resolve(root,'remote/relay'),windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:origin},stdio:['ignore','ignore','ignore','ipc']});
  const sockets=[];
  try {
    await once(child,'message');
    const key=()=>generateKeyPairSync('ec',{namedCurve:'P-256',publicKeyEncoding:{format:'jwk'},privateKeyEncoding:{format:'jwk'}});
    const desktop=key(),mobile=key(),deviceId=randomUUID();
    const canonical=k=>JSON.stringify({crv:k.crv,kty:k.kty,x:k.x,y:k.y});
    const channelId=createHash('sha256').update(canonical(desktop.publicKey)).digest('hex');
    const signature=(k,proof)=>sign('sha256',Buffer.from(proof),{key:k.privateKey,format:'jwk',dsaEncoding:'ieee-p1363'}).toString('base64url');
    const connect=()=>{const ws=new WebSocket(origin.replace('http','ws')+'/ws',{origin});sockets.push(ws);return ws;};
    const d=connect();const dc=JSON.parse((await once(d,'message'))[0]);const time=Date.now();
    d.send(JSON.stringify({type:'desktop.attach',protocolVersion:1,channelId,publicKey:desktop.publicKey,timestamp:time,signature:signature(desktop,`desktop.attach\n1\n${dc.connectionId}\n${dc.nonce}\n${channelId}\n${time}`)}));
    assert.equal(JSON.parse((await once(d,'message'))[0]).type,'relay.attached');
    const attach=async()=>{const m=connect(),c=JSON.parse((await once(m,'message'))[0]),timestamp=Date.now();m.send(JSON.stringify({type:'mobile.attach',protocolVersion:1,mode:'device',channelId,deviceId,timestamp,signature:signature(mobile,`mobile.attach\n1\n${c.connectionId}\n${c.nonce}\n${channelId}\n${deviceId}\n${timestamp}`)}));return m;};
    const early=await attach();assert.equal((await once(early,'close'))[0],1013);
    d.send(JSON.stringify({type:'channel.policy',revision:1,devices:[{deviceId,publicKey:mobile.publicKey}],pairing:null}));
    await new Promise(r=>setTimeout(r,80));
    const valid=await attach();assert.equal(JSON.parse((await once(valid,'message'))[0]).type,'relay.attached');
    d.send(JSON.stringify({type:'channel.policy',revision:2,devices:[],pairing:null}));
    assert.equal((await once(valid,'close'))[0],1008);
    const revoked=await attach();assert.equal((await once(revoked,'close'))[0],1008);
  } finally { for(const ws of sockets)ws.terminate();child.kill();await once(child,'exit'); }
});
