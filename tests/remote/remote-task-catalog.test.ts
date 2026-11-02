import { describe, expect, it, vi } from "vitest";
import { RemoteTaskCatalog } from "../../electron/main/remote-task-catalog";
import { RemoteProjector } from "../../electron/main/remote-projector";
import { mobileCommandSchema, desktopEventSchema } from "../../packages/remote-protocol/src";

describe("cross-window goal catalog", () => {
  it("keeps active and paused goals distinct from idle execution and refreshes completion", async () => {
    let now=0, completed=false;
    const call=vi.fn(async (_method: string, params: any) => ({goal: params.threadId==="ordinary"?null:{status:params.threadId==="paused"?"paused":completed?"complete":"active"}}));
    const catalog=new RemoteTaskCatalog(call,()=>now);
    const rows=["active","paused","ordinary"].map(id=>({id,status:{type:"notLoaded"},updatedAt:10}));
    const projector=new RemoteProjector();
    const first=projector.setThreads(await catalog.enrich(rows));
    expect(first.map(t=>[t.status,t.goalStatus,t.goalStateKnown])).toEqual([["unknown","active",true],["unknown","paused",true],["unknown",null,true]]);
    await catalog.enrich(rows);expect(call).toHaveBeenCalledTimes(3);
    now=16000;completed=true;
    expect((await catalog.enrich(rows))[0]?.goalStatus).toBe("complete");
  });
  it("marks unavailable goal state unknown instead of calling it completed", async () => {
    const catalog=new RemoteTaskCatalog(async()=>{throw new Error("offline");});
    expect(await catalog.enrich([{id:"a"}])).toMatchObject([{goalStatus:null,goalStateKnown:false}]);
  });
  it("returns a snapshot promptly when goal lookups are slow, with only four in flight", async () => {
    const resolvers: Array<(v: unknown)=>void>=[];
    const call=vi.fn(()=>new Promise(resolve=>resolvers.push(resolve)));
    const catalog=new RemoteTaskCatalog(call);
    const started=Date.now();
    const rows=await catalog.enrich(Array.from({length:100},(_,id)=>({id:String(id)})));
    expect(Date.now()-started).toBeLessThan(600);
    expect(call).toHaveBeenCalledTimes(4);
    expect(rows.every(row=>row.goalStateKnown===false&&row.goalStatus===null)).toBe(true);
    for(let i=0;i<100;i++){resolvers[i]?.({goal:null});await Promise.resolve();await Promise.resolve();await Promise.resolve();}
  });
  it("validates bounded page sizes and opaque cursors", () => {
    const requestId=crypto.randomUUID();
    expect(mobileCommandSchema.parse({type:"thread.list",requestId,limit:5,cursor:null})).toMatchObject({limit:5});
    expect(mobileCommandSchema.safeParse({type:"thread.list",requestId,limit:101}).success).toBe(false);
    expect(desktopEventSchema.safeParse({type:"thread.page",seq:1,requestId,threads:[],nextCursor:"next-page"}).success).toBe(true);
  });
});
