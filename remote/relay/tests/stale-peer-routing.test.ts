import { EventEmitter } from "node:events";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { desktopAttachProof, mobileAttachProof } from "@codex-pane/remote-protocol";
import { channelIdForPublicKey } from "../src/authorization.js";

const harness=vi.hoisted(()=>({wsHandler:null as null|((socket:any,request:any)=>void),listen:vi.fn(),close:vi.fn()}));
vi.mock("fastify",()=>({default:()=>({register:async()=>{},addHook:()=>{},get:(path:string,...args:any[])=>{if(path==="/ws")harness.wsHandler=args.at(-1);},setNotFoundHandler:()=>{},listen:harness.listen,close:harness.close})}));
class Socket extends EventEmitter {
  readyState=1;bufferedAmount=0;sent:any[]=[];closes:Array<{code:number;reason:string}>=[];deferClose=false;
  send(data:string){this.sent.push(JSON.parse(data));}
  close(code:number,reason:string){this.closes.push({code,reason});this.readyState=2;if(!this.deferClose){this.readyState=3;this.emit("close");}}
  ping(){}terminate(){this.close(1006,"terminated");}
  receive(frame:unknown){this.emit("message",JSON.stringify(frame));}
}
const keys=()=>generateKeyPairSync("ec",{namedCurve:"P-256",publicKeyEncoding:{format:"jwk"},privateKeyEncoding:{format:"jwk"}});
const signature=(key:JsonWebKey,proof:string)=>sign("sha256",Buffer.from(proof),{key,format:"jwk",dsaEncoding:"ieee-p1363"}).toString("base64url");
function connect(){const socket=new Socket();harness.wsHandler!(socket,{headers:{origin:"http://localhost:49999"}});return socket;}
function attachDesktop(identity=keys()){
  const socket=connect(),challenge=socket.sent[0],channelId=channelIdForPublicKey(identity.publicKey),timestamp=Date.now();
  socket.receive({type:"desktop.attach",protocolVersion:1,channelId,publicKey:identity.publicKey,timestamp,signature:signature(identity.privateKey,desktopAttachProof(challenge.connectionId,challenge.nonce,channelId,timestamp))});
  return {socket,channelId,identity};
}
function attachMobile(desktop:ReturnType<typeof attachDesktop>,identity:ReturnType<typeof keys>,deviceId:string){
  const socket=connect(),challenge=socket.sent[0],timestamp=Date.now();
  socket.receive({type:"mobile.attach",protocolVersion:1,mode:"device",channelId:desktop.channelId,deviceId,timestamp,signature:signature(identity.privateKey,mobileAttachProof(challenge.connectionId,challenge.nonce,desktop.channelId,deviceId,timestamp))});
  return {socket,peerId:socket.sent.find(frame=>frame.type==="relay.attached")?.peerId as string};
}
function policy(desktop:ReturnType<typeof attachDesktop>,devices:Array<{deviceId:string;publicKey:JsonWebKey}>,revision=1){desktop.socket.receive({type:"channel.policy",revision,devices,pairing:null});}
let priorTerm:Function[],priorInt:Function[];
beforeAll(async()=>{vi.useFakeTimers();vi.stubEnv("PUBLIC_ORIGIN","http://localhost:49999");vi.stubEnv("BASE_PATH","/");priorTerm=process.listeners("SIGTERM");priorInt=process.listeners("SIGINT");if(process.send)vi.spyOn(process,"send").mockImplementation(()=>true);await import("../src/server.js");});
afterAll(()=>{for(const fn of process.listeners("SIGTERM"))if(!priorTerm.includes(fn))process.removeListener("SIGTERM",fn);for(const fn of process.listeners("SIGINT"))if(!priorInt.includes(fn))process.removeListener("SIGINT",fn);vi.clearAllTimers();vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});
describe("stale mobile response routing",()=>{
  it("drops a closed peer destination without disconnecting the desktop or another mobile",()=>{
    const desktop=attachDesktop(),firstKey=keys(),secondKey=keys(),firstId=randomUUID(),secondId=randomUUID();
    policy(desktop,[{deviceId:firstId,publicKey:firstKey.publicKey},{deviceId:secondId,publicKey:secondKey.publicKey}]);
    const first=attachMobile(desktop,firstKey,firstId),second=attachMobile(desktop,secondKey,secondId);
    first.socket.close(1000,"test disconnect");
    expect(desktop.socket.sent.some(frame=>frame.type==="channel.peer-offline"&&frame.peerId===first.peerId)).toBe(true);
    desktop.socket.receive({type:"channel.data",peerId:first.peerId,payload:"late command.result"});
    desktop.socket.receive({type:"channel.data",peerId:second.peerId,payload:"still delivered"});
    second.socket.receive({type:"channel.data",payload:"still connected"});
    expect(desktop.socket.closes).toEqual([]);expect(second.socket.closes).toEqual([]);
    expect(second.socket.sent.at(-1)).toMatchObject({type:"channel.data",payload:"still delivered"});
    expect(desktop.socket.sent.at(-1)).toMatchObject({type:"channel.data",peerId:second.peerId,payload:"still connected"});
  });
  it("does not route across channels and rejects unauthenticated frames",()=>{
    const a=attachDesktop(),b=attachDesktop(),key=keys(),id=randomUUID();policy(a,[]);policy(b,[{deviceId:id,publicKey:key.publicKey}]);const mobile=attachMobile(b,key,id),count=mobile.socket.sent.length;
    a.socket.receive({type:"channel.data",peerId:mobile.peerId,payload:"cross channel"});
    expect(mobile.socket.sent).toHaveLength(count);expect(a.socket.closes).toEqual([]);
    const pending=connect();pending.receive({type:"channel.data",peerId:mobile.peerId,payload:"unauthorized"});expect(pending.closes.at(-1)?.code).toBe(1008);expect(mobile.socket.sent).toHaveLength(count);
    const unauthorized=attachMobile(b,keys(),randomUUID());expect(unauthorized.socket.closes.at(-1)).toMatchObject({code:1008,reason:"Access denied"});expect(mobile.socket.sent).toHaveLength(count);
  });
  it("rejects revoked mobiles and replaced desktop connections even before their close event",()=>{
    const desktop=attachDesktop(),key=keys(),id=randomUUID();policy(desktop,[{deviceId:id,publicKey:key.publicKey}]);const mobile=attachMobile(desktop,key,id);mobile.socket.deferClose=true;
    policy(desktop,[],2);const received=desktop.socket.sent.length;mobile.socket.receive({type:"channel.data",payload:"revoked"});expect(desktop.socket.sent).toHaveLength(received);expect(mobile.socket.closes.at(-1)).toMatchObject({code:1008,reason:"Invalid request"});
    desktop.socket.deferClose=true;const replacement=attachDesktop(desktop.identity);policy(replacement,[]);desktop.socket.receive({type:"channel.data",peerId:randomUUID(),payload:"old desktop"});expect(desktop.socket.closes.at(-1)).toMatchObject({code:1008,reason:"Invalid request"});expect(replacement.socket.closes).toEqual([]);
  });
});
