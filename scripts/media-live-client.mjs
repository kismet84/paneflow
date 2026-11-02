// Explicit isolated Node/native-protocol acceptance; never represents a physical phone UI test.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { generateP256KeyPair, deriveSessionKey, signP256, verifyP256, SecureSession } from '../dist-electron/electron/main/remote-crypto.js';
import { mobileAttachProof, sessionHelloProof, sessionWelcomeProof } from '../dist-electron/packages/remote-protocol/src/index.js';

if (!process.argv.includes('--live')) throw new Error('Explicit --live is required');
if (process.argv.some(arg=>arg.startsWith('--')&&arg!=='--live')) throw new Error('No origin or data-directory overrides are allowed');
const root=resolve(import.meta.dirname,'..'),origin='http://localhost:48433';
const testData=resolve(root,'outputs/stage-0.5/second-computer/desktop-data');
assert.equal(await realpath(testData),testData);
const output=resolve(root,'outputs/stage-0.8',`media-live-node-${Date.now()}`);
assert.ok(output.startsWith(resolve(root,'outputs/stage-0.8')+sep));
await mkdir(output,{recursive:true});await mkdir(resolve(output,'workspace'));
const report={layer:'Node client using real encrypted native protocol and real Codex app-server',physicalPhone:false,origin,startedAt:new Date().toISOString(),steps:[]};
const save=()=>writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
const step=async(name,data={})=>{report.steps.push({name,at:new Date().toISOString(),...data});await save();console.log(JSON.stringify({step:name,...data}));};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));

class Cdp {
  constructor(url){this.socket=new WebSocket(url);this.id=0;this.pending=new Map();this.socket.on('message',data=>{const msg=JSON.parse(data.toString());if(!msg.id)return;const job=this.pending.get(msg.id);if(!job)return;this.pending.delete(msg.id);clearTimeout(job.timer);if(msg.error)job.reject(new Error('Isolated CDP request rejected'));else job.resolve(msg.result);});}
  async open(){await new Promise((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});}
  call(method,params){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},90000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(fn,arg){const expression=`(${fn.toString()})(${JSON.stringify(arg)})`;const response=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(response.exceptionDetails)throw new Error('Isolated desktop evaluation failed');return response.result.value;}
  close(){for(const entry of this.pending.values())clearTimeout(entry.timer);this.pending.clear();this.socket.close();}
}
class NativeClient {
  constructor(binding,identity,pairing=false){this.binding=binding;this.identity=identity;this.pairing=pairing;this.sessionId=randomUUID();this.ephemeral=generateP256KeyPair();this.events=[];this.waiters=[];this.failure=null;this.ready=false;this.socket=new WebSocket('ws://localhost:48433/ws',{origin});this.socket.on('message',bytes=>{try{this.receive(JSON.parse(bytes.toString()));}catch{this.failure=new Error('Encrypted isolated connection rejected');this.flush();}});this.socket.on('error',()=>{this.failure=new Error('Isolated transport error');this.flush();});this.socket.on('close',(code)=>{this.failure=new Error(`Isolated socket closed (${code})`);this.flush();});}
  frame(payload){this.socket.send(JSON.stringify(payload));}
  data(payload){this.frame({type:'channel.data',payload:JSON.stringify(payload)});}
  secure(payload){this.data(this.session.encrypt(payload));}
  emit(event){this.events.push(event);this.flush();}
  flush(){for(const entry of [...this.waiters]){const found=this.events.slice(entry.after).find(entry.test);if(found||this.failure){this.waiters.splice(this.waiters.indexOf(entry),1);clearTimeout(entry.timer);if(found)entry.resolve(found);else entry.reject(this.failure);}}}
  wait(test,after=0,timeout=120000){const found=this.events.slice(after).find(test);if(found)return Promise.resolve(found);if(this.failure)return Promise.reject(this.failure);return new Promise((resolve,reject)=>{const entry={test,after,resolve,reject,timer:setTimeout(()=>{this.waiters.splice(this.waiters.indexOf(entry),1);reject(new Error('Isolated event timeout'));},timeout)};this.waiters.push(entry);});}
  receive(message){
    const b=this.binding;
    if(message.type==='relay.challenge'){
      if(this.pairing)this.frame({type:'mobile.attach',protocolVersion:1,mode:'pairing',channelId:b.channelId,pairingId:b.pairingId,pairingSecret:b.pairingSecret});
      else{const timestamp=Date.now();this.frame({type:'mobile.attach',protocolVersion:1,mode:'device',channelId:b.channelId,deviceId:this.identity.deviceId,timestamp,signature:signP256(this.identity.signing.privateKey,mobileAttachProof(message.connectionId,message.nonce,b.channelId,this.identity.deviceId,timestamp))});}return;
    }
    if(message.type==='relay.attached'){
      if(this.pairing){this.session=new SecureSession(this.sessionId,deriveSessionKey(this.ephemeral.privateKey,b.desktopAgreementPublicKey,`pairing\n${b.channelId}\n${b.pairingId}\n${this.sessionId}`));this.data({type:'pairing.hello',sessionId:this.sessionId,pairingId:b.pairingId,mobileAgreementPublicKey:this.ephemeral.publicKey,envelope:this.session.encrypt({type:'pairing.start',authentication:'native',pairingSecret:b.pairingSecret,deviceId:this.identity.deviceId,deviceName:'0.8 isolated Node media test',signingPublicKey:this.identity.signing.publicKey,agreementPublicKey:this.identity.agreement.publicKey})});}
      else{const timestamp=Date.now();this.data({type:'session.hello',sessionId:this.sessionId,deviceId:this.identity.deviceId,mobileEphemeralPublicKey:this.ephemeral.publicKey,timestamp,signature:signP256(this.identity.signing.privateKey,sessionHelloProof(b.channelId,this.sessionId,this.identity.deviceId,this.ephemeral.publicKey,timestamp))});}return;
    }
    if(message.type!=='channel.data')return;
    const payload=JSON.parse(message.payload);
    if(payload.type==='session.welcome'){
      assert.equal(payload.sessionId,this.sessionId);assert.ok(Math.abs(Date.now()-payload.timestamp)<30000);
      assert.ok(verifyP256(b.desktopSigningPublicKey,sessionWelcomeProof(b.channelId,this.sessionId,this.ephemeral.publicKey,payload.desktopEphemeralPublicKey,payload.timestamp),payload.signature));
      this.session=new SecureSession(this.sessionId,deriveSessionKey(this.ephemeral.privateKey,payload.desktopEphemeralPublicKey,`session\n${b.channelId}\n${this.sessionId}\n${this.identity.deviceId}`));return;
    }
    assert.equal(payload.type,'secure');const clear=this.session.decrypt(payload);
    if(clear.type==='native.authentication.challenge'){this.secure({type:'native.authentication.response',challenge:clear.challenge});return;}
    if(clear.type==='error'){this.failure=new Error('Isolated desktop rejected encrypted request');this.flush();return;}
    if(clear.type==='session.ready')this.ready=true;
    this.emit(clear.type==='desktop.event'?clear.event:clear);
  }
  async authenticated(){await this.wait(e=>e.type==='session.ready');const event=await this.wait(e=>e.type==='snapshot');assert.ok(event.snapshot.capabilities.includes('attachmentsV1'));return event.snapshot;}
  async request(command,type='command.result'){
    const requestId=command.requestId??randomUUID(),after=this.events.length;this.secure({type:'mobile.command',command:{...command,requestId}});
    const result=await this.wait(e=>e.requestId===requestId&&(e.type===type||(e.type==='command.result'&&!e.ok)),after);
    if(result.type==='command.result'&&!result.ok)throw new Error(`Isolated command failed: ${command.type}`);
    // Wait for the trailing receipt before deliberate transport closure.
    if(type!=='command.result'){
      const receipt=await this.wait(e=>e.type==='command.result'&&e.requestId===requestId,after);
      if(!receipt.ok)throw new Error(`Isolated command receipt failed: ${command.type}`);
    }
    return result;
  }
  async close(){if(this.socket.readyState===WebSocket.CLOSED)return;await new Promise(resolve=>{const timer=setTimeout(()=>{this.socket.terminate();resolve();},3000);this.socket.once('close',()=>{clearTimeout(timer);resolve();});this.socket.close(1000,'Isolated test reconnect');});}
}
function redPng(){
  const crc=bytes=>{let c=0xffffffff;for(const byte of bytes){c^=byte;for(let bit=0;bit<8;bit++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const chunk=(name,bytes)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([size,type,bytes,sum]);};
  const header=Buffer.alloc(13);header.writeUInt32BE(32);header.writeUInt32BE(32,4);header[8]=8;header[9]=2;const pixels=Buffer.alloc(32*(1+32*3));for(let y=0;y<32;y++)for(let x=0;x<32;x++)pixels[y*97+1+x*3]=255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

let cdp,client,pair;
try{
  const [portText]=String(await readFile(resolve(testData,'chromium/primary/DevToolsActivePort'),'utf8')).split(/\r?\n/);const port=Number(portText);assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
  const pages=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());const target=pages.find(p=>p.type==='page'&&p.url===pathToFileURL(resolve(root,'dist/index.html')).href);assert.ok(target,'Exact isolated application page missing');
  const debugUrl=new URL(target.webSocketDebuggerUrl);assert.ok(['127.0.0.1','localhost'].includes(debugUrl.hostname));assert.equal(Number(debugUrl.port),port);
  cdp=new Cdp(debugUrl.href);await cdp.open();const status=await cdp.evaluate(()=>window.codexPane.getRemoteAccessStatus());assert.equal(status.relayUrl,origin);assert.equal(status.phase,'connected');
  const bootstrap=await cdp.evaluate(()=>window.codexPane.bootstrap());assert.equal(bootstrap.connection.phase,'ready');
  const publicIdentity=JSON.parse(await readFile(resolve(testData,'remote/credentials.json'),'utf8'));const pairing=(await cdp.evaluate(()=>window.codexPane.beginRemotePairing())).pairing;
  const url=new URL(pairing.url);assert.equal(url.origin,origin);const binding=JSON.parse(Buffer.from(new URLSearchParams(url.hash.slice(1)).get('pair'),'base64url').toString());assert.equal(binding.channelId,publicIdentity.channelId);
  const identity={deviceId:randomUUID(),signing:generateP256KeyPair(),agreement:generateP256KeyPair()};await writeFile(resolve(output,'identity.private.json'),JSON.stringify({identity,binding:{relayOrigin:origin,channelId:binding.channelId,desktopSigningPublicKey:binding.desktopSigningPublicKey,desktopAgreementPublicKey:binding.desktopAgreementPublicKey}}),{flag:'wx',mode:0o600});
  pair=new NativeClient(binding,identity,true);const confirmation=await pair.wait(e=>e.type==='pairing.awaiting-confirmation');const shown=(await cdp.evaluate(()=>window.codexPane.getRemoteAccessStatus())).pairing;assert.ok(shown.readyToConfirm);assert.equal(confirmation.code,shown.code);await cdp.evaluate(id=>window.codexPane.confirmRemotePairing(id),shown.pairingId);await pair.wait(e=>e.type==='pairing.completed');await pair.close();pair=null;await step('native-pairing-confirmed');
  client=new NativeClient(binding,identity);await client.authenticated();await step('native-authenticated');
  const thread=await cdp.evaluate(params=>window.codexPane.request({method:'thread/start',params}),{cwd:resolve(output,'workspace'),model:'gpt-6.1-sol',ephemeral:false});const threadId=thread.thread.id;report.threadId=threadId;
  await cdp.evaluate(threadId=>window.codexPane.request({method:'thread/settings/update',params:{threadId,permissions:':read-only',approvalPolicy:'on-request',approvalsReviewer:'user'}}),threadId);
  await cdp.evaluate(threadId=>window.codexPane.request({method:'thread/name/set',params:{threadId,name:'0.8 Node native media acceptance'}}),threadId);
  await client.request({type:'thread.open',threadId});await step('isolated-thread-open');
  const content=Buffer.alloc(70000,120);Buffer.from('PANEFLOW_08_ATTACHMENT_TEST\n').copy(content);const uploadId=randomUUID();const begin={type:'attachment.begin',threadId,uploadId,name:'paneflow-08-test.txt',mime:'text/plain',size:content.length,sha256:hash(content)};
  assert.equal((await client.request(begin,'attachment.status')).offset,0);const chunk={type:'attachment.chunk',threadId,uploadId,offset:0,data:content.subarray(0,49152).toString('base64')};assert.equal((await client.request(chunk,'attachment.status')).offset,49152);
  await client.close();client=null;await step('first-chunk-and-disconnect');
  client=new NativeClient(binding,identity);await client.authenticated();await client.request({type:'thread.open',threadId});assert.equal((await client.request(begin,'attachment.status')).offset,49152);assert.equal((await client.request(chunk,'attachment.status')).offset,49152);await step('reconnect-offset-and-idempotent-chunk');
  await client.request({type:'attachment.chunk',threadId,uploadId,offset:49152,data:content.subarray(49152).toString('base64')},'attachment.status');const file=(await client.request({type:'attachment.finish',threadId,uploadId},'attachment.status')).attachment;
  const png=redPng(),imageUpload=randomUUID();await client.request({type:'attachment.begin',threadId,uploadId:imageUpload,name:'red-square.png',mime:'image/png',size:png.length,sha256:hash(png)},'attachment.status');await client.request({type:'attachment.chunk',threadId,uploadId:imageUpload,offset:0,data:png.toString('base64')},'attachment.status');const image=(await client.request({type:'attachment.finish',threadId,uploadId:imageUpload},'attachment.status')).attachment;
  const sendId=randomUUID();report.sendRequestId=sendId;await save();await client.request({type:'turn.send',requestId:sendId,threadId,text:'这是附件传输验收。不要调用工具，不要修改文件。仅回复 PANEFLOW_08_ATTACHMENT_ACCEPTED。',attachmentIds:[file.id,image.id]});await step('single-real-turn-submitted');
  let found=false,answered=false;
  for(let attempt=0;attempt<90;attempt++){const page=await client.request({type:'history.list',threadId,limit:20},'history.page');for(const item of page.items){if(item.attachments?.some(a=>a.id===file.id)){assert.equal(item.attachments.length,2);assert.ok(item.attachments.some(a=>a.id===image.id));found=true;}if(item.kind==='agent'&&item.markdown?.includes('PANEFLOW_08_ATTACHMENT_ACCEPTED'))answered=true;}if(found&&answered)break;await delay(1000);}
  assert.ok(found,'Real history attachment association missing');assert.ok(answered,'Real assistant reply missing');await step('history-two-attachments-and-real-reply');
  for(const [meta,expected]of [[file,content],[image,png]]){const blocks=[];let offset=0,eof=false;while(!eof){const block=await client.request({type:'attachment.read',threadId,attachmentId:meta.id,offset},'attachment.chunk');assert.equal(block.offset,offset);const bytes=Buffer.from(block.data,'base64');blocks.push(bytes);offset+=bytes.length;eof=block.eof;assert.ok(bytes.length||eof);}assert.equal(hash(Buffer.concat(blocks)),hash(expected));}
  const actual=await cdp.evaluate(threadId=>window.codexPane.request({method:'thread/turns/list',params:{threadId,cursor:null,limit:20,sortDirection:'desc',itemsView:'full'}}),threadId);
  const toolItems=actual.data.flatMap(turn=>turn.items??[]).filter(item=>['commandExecution','fileChange','mcpToolCall','webSearch','computerToolCall'].includes(item.type));assert.equal(toolItems.length,0,'Unexpected tool activity');report.toolActivityCount=0;report.success=true;await step('download-sha256-matches',{textBytes:content.length,imageBytes:png.length});
}catch(error){report.success=false;report.failure=error instanceof assert.AssertionError?'Acceptance assertion failed':error.message;await save();console.error(JSON.stringify({failed:report.failure,report:resolve(output,'report.json')}));process.exitCode=1;}
finally{await client?.close();await pair?.close();cdp?.close();report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({report:resolve(output,'report.json'),physicalPhone:false,success:report.success}));}
