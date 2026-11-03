import { resolve } from "node:path";
import { RuntimeProtocolValidator } from "../../packages/protocol/src/runtime-validator";
import { latestLifecycle, latestCompletion } from "../../electron/main/remote-local-runtime";
import { describe, it, expect, vi } from "vitest";
import { RemoteRuntimeCatalog } from "../../electron/main/remote-runtime-catalog";
import { RemoteProjector, projectThreadStatus } from "../../electron/main/remote-projector";
import { readRemoteUsage } from "../../electron/main/remote-usage";
import { usageSummarySchema } from "../../packages/remote-protocol/src";
describe("external runtime and usage", () => {
  it("requires a final task marker, excluding tool steps, cancellation and partial writes",()=>{
    const line=(payload:unknown)=>JSON.stringify({type:"event_msg",timestamp:"2026-11-03T04:12:12Z",payload})+"\n";
    const final=line({type:"task_complete",turn_id:"child",root_turn_id:"root",last_agent_message:"Final result"});
    expect(latestCompletion(final)).toEqual({id:"root",completedAt:Date.parse("2026-11-03T04:12:12Z")});
    expect(latestCompletion(line({type:"exec_command_end",turn_id:"t"}))).toBeNull();
    expect(latestCompletion(line({type:"agent_message",message:"Progress"}))).toBeNull();
    expect(latestCompletion(line({type:"task_complete",turn_id:"t",last_agent_message:""}))).toBeNull();
    expect(latestCompletion(final+line({type:"turn_aborted",turn_id:"next"}))).toBeNull();
    expect(latestCompletion(final+line({type:"task_started",turn_id:"next"}))).toBeNull();
    expect(latestCompletion(final.slice(0,-1))).toBeNull();
  });
  it("projects final completion evidence for loaded and external threads without exposing text",async()=>{
    const c=new RemoteRuntimeCatalog(async()=>({data:[]}),Date.now,async()=>"idle",async()=>({id:"root",completedAt:123}));
    const rows=new RemoteProjector().setThreads(await c.enrich([{id:"a",status:{type:"notLoaded"}},{id:"b",status:{type:"idle"}}]));
    expect(rows.map(r=>r.completion)).toEqual([{id:"root",completedAt:123},{id:"root",completedAt:123}]);
  });
  it("rechecks goals after final evidence instead of trusting cached absence",async()=>{
    const c=new RemoteRuntimeCatalog(async method=>method==="thread/goal/get"?{goal:{status:"active"}}:{data:[]},Date.now,async()=>"idle",async()=>({id:"root",completedAt:123}));
    const [row]=await c.enrich([{id:"a",status:{type:"idle"},goalStateKnown:true,goalStatus:null}]);
    expect(row).toMatchObject({goalStateKnown:true,goalStatus:"active"});
    const offline=new RemoteRuntimeCatalog(async()=>{throw Error("offline")},Date.now,async()=>"idle",async()=>({id:"root",completedAt:123}));
    expect((await offline.enrich([{id:"a",goalStateKnown:true,goalStatus:null}]))[0]).toMatchObject({goalStateKnown:false});
  });
  it("sends the quota request through the real protocol validator without object params",async()=>{
    const validator=new RuntimeProtocolValidator(resolve("packages/protocol/schema/generated"));
    const result=await readRemoteUsage(async(method,params)=>{
      expect(validator.validateClientRequest({id:1,method,params}).valid).toBe(true);
      if(method==="account/rateLimits/read"){expect(params).toBeUndefined();return {rateLimits:{primary:{usedPercent:24,windowDurationMins:300,resetsAt:1793628000}}};}
      return {summary:{}};
    });
    expect(result.limitsAvailable).toBe(true);expect(result.windows[0]).toMatchObject({usedPercent:24,windowMinutes:300,resetsAt:1793628000});
  });
  it("reads complete lifecycle lines and ignores partial appends",()=>{
    const start=JSON.stringify({type:"event_msg",payload:{type:"task_started",turn_id:"t"}})+"\n";
    const end=JSON.stringify({type:"event_msg",payload:{type:"task_complete",turn_id:"t"}})+"\n";
    expect(latestLifecycle(start+end.slice(0,-1))).toBeNull();
    expect(latestLifecycle(end+start.slice(0,-1))).toBeNull();
    expect(latestLifecycle(start+end)?.type).toBe("ended");
  });
  it("prefers live local writer evidence over interrupted history reconstruction",async()=>{
    const c=new RemoteRuntimeCatalog(async()=>({data:[{status:"interrupted"}]}),Date.now,async()=>"active");
    expect(new RemoteProjector().setThreads(await c.enrich([{id:"external",status:{type:"notLoaded"}}]))[0]?.status).toBe("running");
  });
  it("keeps unavailable local evidence unknown despite a synthetic interrupted turn",async()=>{
    const c=new RemoteRuntimeCatalog(async()=>({data:[{status:"interrupted"}]}),Date.now,async()=>null);
    expect(new RemoteProjector().setThreads(await c.enrich([{id:"external",status:{type:"notLoaded"}}]))[0]?.status).toBe("unknown");
  });
  it("never maps unloaded or missing runtime to idle", () => {
    expect(projectThreadStatus({type:"notLoaded"})).toBe("unknown");
    expect(projectThreadStatus(undefined)).toBe("unknown");
  });
  it("reads latest metadata without resuming and refreshes completed turns", async () => {
    let now=0,status="inProgress";
    const call=vi.fn(async()=>({data:[{id:"turn",status}]}));
    const catalog=new RemoteRuntimeCatalog(call,()=>now,async()=>status==="completed"?"idle":null), projector=new RemoteProjector();
    const rows=[{id:"external",status:{type:"notLoaded"}}];
    expect(projector.setThreads(await catalog.enrich(rows))[0]?.status).toBe("running");
    expect(call).toHaveBeenCalledWith("thread/turns/list",{threadId:"external",cursor:null,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
    await catalog.enrich(rows);expect(call).toHaveBeenCalledTimes(1);
    now=6000;status="completed";
    expect(projector.setThreads(await catalog.enrich(rows))[0]?.status).toBe("idle");
  });
  it("keeps failed lookups unknown and leaves native active flags intact", async()=>{
    const catalog=new RemoteRuntimeCatalog(async()=>{throw new Error("offline");});
    const result=new RemoteProjector().setThreads(await catalog.enrich([{id:"a",status:{type:"notLoaded"}},{id:"b",status:{type:"active",activeFlags:["waitingOnApproval"]}}]));
    expect(result.map(r=>r.status)).toEqual(["unknown","waiting"]);
  });
  it("clears a previous failure when a later completed turn was observed",()=>{
    const p=new RemoteProjector();p.setThreads([{id:"x",status:{type:"notLoaded"}}]);
    p.setActiveThread({id:"x",turns:[{status:"failed"}]},true);
    p.setActiveThread({id:"x",turns:[{status:"completed"}]},true);
    expect(p.snapshot().turnStatus).toBe("idle");
    expect(p.setThreads([{id:"x",status:{type:"notLoaded"},runtimeStatus:{type:"idle"}}])[0]?.status).toBe("idle");
  });
  it("whitelists windows and tokens without account data and checks thread identity",async()=>{
    const result=await readRemoteUsage(async method=>method.includes("rateLimits")?{secret:"hidden",rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:42}}}:{summary:{lifetimeTokens:123,peakDailyTokens:null,currentStreakDays:0},threadUsage:{threadId:"other",estimatedUsageUsdMicros:80}},"target");
    expect(result).toMatchObject({limitsAvailable:true,tokensAvailable:true,lifetimeTokens:123,currentStreakDays:0,windows:[{usedPercent:25,windowMinutes:300,resetsAt:42}]});
    expect(result).not.toHaveProperty("peakDailyTokens");expect(result).not.toHaveProperty("estimatedUsdMicros");expect(JSON.stringify(result)).not.toContain("hidden");expect(usageSummarySchema.safeParse(result).success).toBe(true);
  });
  it("does not turn unavailable, malformed or unsafe counters into zero",async()=>{
    const unavailable=await readRemoteUsage(async()=>{throw new Error("private upstream failure");});
    expect(unavailable).toMatchObject({limitsAvailable:false,tokensAvailable:false,windows:[]});expect(JSON.stringify(unavailable)).not.toContain("private");expect(unavailable).not.toHaveProperty("lifetimeTokens");
    const invalid=await readRemoteUsage(async()=>({summary:{lifetimeTokens:Number.MAX_SAFE_INTEGER+1},rateLimits:{primary:{usedPercent:Infinity}}}));
    expect(invalid.tokensAvailable).toBe(false);expect(invalid.limitsAvailable).toBe(false);
  });
});
