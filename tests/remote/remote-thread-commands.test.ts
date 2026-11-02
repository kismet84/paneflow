import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteCredentialState } from "../../electron/main/remote-credential-store";
import type { DesktopEvent, MobileCommand } from "../../packages/remote-protocol/src/index";

const hooks = vi.hoisted(() => ({ relays: [] as any[] }));
vi.mock("electron", () => ({ app: { getAppPath: () => ".", getVersion: () => "test" }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));
vi.mock("../../electron/main/relay-connection", () => ({ RelayConnection: class extends EventEmitter {
  sent: Array<{ peerId: string; payload: any }> = [];
  constructor() { super(); hooks.relays.push(this); }
  start() {} stop() {} sendPolicy() {}
  send(peerId: string, payload: any) { this.sent.push({ peerId, payload }); }
} }));
vi.mock("../../electron/main/remote-crypto", () => ({
  deriveSessionKey: () => Buffer.alloc(32), generateP256KeyPair: () => ({ publicKey: {}, privateKey: {} }),
  signP256: () => "signature", verifyP256: () => true,
  SecureSession: class { decrypt(envelope: any) { return JSON.parse(envelope.ciphertext); } encrypt(payload: any) { return payload; } }
}));
import { RemoteQueueStore } from "../../electron/main/remote-queue-store";
import { RemoteRequestStore } from "../../electron/main/remote-request-store";
import { RemoteBridge } from "../../electron/main/remote-bridge";

const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const safeSettings = { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace" };
const bridges: RemoteBridge[] = [];
const receiptDirectories: string[] = [];
const harness = async (receiptPath?: string, queueStore?: RemoteQueueStore) => {
  const threads: Array<Record<string, any>> = [];
  const failures = new Map<string, string>();
  const state: RemoteCredentialState = { version: 2, enabled: true, relayUrl: "http://localhost:48321", channelId: "a".repeat(64), signingPublicKey: jwk, protectedSigningPrivateKey: "key", agreementPublicKey: jwk, protectedAgreementPrivateKey: "key", devices: [{ id: deviceId, name: "native", signingPublicKey: jwk, agreementPublicKey: jwk, authentication: "native", createdAt: 1, revokedAt: null }] };
  const supervisor = {
    state: { phase: "ready", generation: 1, message: "ready" }, respondToServer: vi.fn(),
    call: vi.fn(async (method: string, params: any = {}): Promise<unknown> => {
      if (failures.has(method)) throw new Error(failures.get(method));
      if (method === "model/list") return { data: [{ model: "model-a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "low" }] }, { model: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }, { model: "hidden-model", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] };
      if (method === "thread/list") { const offset=Number(params.cursor || 0),limit=params.limit ?? 100;return { data: structuredClone(threads.slice(offset,offset+limit)),nextCursor:offset+limit<threads.length?String(offset+limit):null }; }
      if (method === "thread/start" || method === "thread/fork") {
        const source = threads.find((thread) => thread.id === params.threadId);
        const thread = { ...source, id: `new-${threads.length + 1}`, cwd: params.cwd ?? "D:/project", name: source?.name ?? null, turns: source?.turns ?? [], status: { type: "idle" } };
        threads.push(thread);
        return { thread: structuredClone(thread), model: params.model ?? "model-a", reasoningEffort: "low" };
      }
      if (method === "thread/resume") return { thread: structuredClone(threads.find((thread) => thread.id === params.threadId)), model: "model-a", reasoningEffort: "low" };
      if (method === "thread/turns/list") return { data: threads.find((thread) => thread.id === params.threadId)?.turns ?? [], nextCursor: null };
      if (method === "thread/items/list") return { data: [], nextCursor: null };
      if (method === "thread/read") return { thread: structuredClone(threads.find((thread) => thread.id === params.threadId)) };
      if (method === "thread/name/set") {
        threads.find((thread) => thread.id === params.threadId)!.name = params.name;
        return {};
      }
      if (method === "turn/start") return { turn: { id: "initial-turn" } };
      return {};
    })
  };
  const bridge = new RemoteBridge(supervisor as any, { load: async () => state, save: async () => {}, revealSigningPrivateKey: () => ({}), revealAgreementPrivateKey: () => ({}) } as any, { write: async () => {} } as any, new RemoteRequestStore(receiptPath), queueStore);
  bridges.push(bridge);
  await bridge.initialize();
  const relay = hooks.relays.at(-1);
  const connect = async (connectedDeviceId = deviceId) => {
  const peerId = crypto.randomUUID();
  const send = (payload: unknown) => relay.emit("event", { type: "data", peerId, payload: JSON.stringify(payload) });
  const secure = (payload: unknown) => send({ type: "secure", sessionId: crypto.randomUUID(), sequence: 0, iv: "iv", ciphertext: JSON.stringify(payload) });
  relay.emit("event", { type: "peerOnline", peerId, mode: "device", deviceId: connectedDeviceId });
  send({ type: "session.hello", sessionId: crypto.randomUUID(), deviceId: connectedDeviceId, mobileEphemeralPublicKey: jwk, timestamp: Date.now(), signature: "sig" });
  await vi.waitFor(() => expect(relay.sent.some((item: any) => item.peerId === peerId && item.payload.type === "native.authentication.challenge")).toBe(true), { interval: 5 });
  const challenge = relay.sent.find((item: any) => item.peerId === peerId && item.payload.type === "native.authentication.challenge").payload.challenge;
  secure({ type: "native.authentication.response", challenge });
  await vi.waitFor(() => expect(relay.sent.some((item: any) => item.peerId === peerId && item.payload.event?.type === "snapshot")).toBe(true), { interval: 5 });
  supervisor.call.mockClear();
  const events = (): DesktopEvent[] => relay.sent.flatMap((item: any) => item.peerId === peerId && item.payload.type === "desktop.event" ? [item.payload.event] : []);
  const command = async (value: { type: MobileCommand["type"]; [key: string]: unknown }, requestId = crypto.randomUUID()) => {
    const previousCount = events().filter((event) => event.type === "command.result" && event.requestId === requestId).length;
    secure({ type: "mobile.command", command: { ...value, requestId } });
    await vi.waitFor(() => expect(events().filter((event) => event.type === "command.result" && event.requestId === requestId).length).toBeGreaterThan(previousCount), { interval: 5 });
    return events().filter((event) => event.type === "command.result" && event.requestId === requestId).at(-1) as Extract<DesktopEvent, { type: "command.result" }>;
  };
  const snapshot = () => (events().filter((event) => event.type === "snapshot").at(-1) as Extract<DesktopEvent, { type: "snapshot" }>).snapshot;
  return { command, snapshot, events, dispatch: (command: unknown) => secure({ type: "mobile.command", command }) };
  };
  const first = await connect();
  const addDevice = async () => {
    const id = crypto.randomUUID();
    state.devices.push({ ...state.devices[0]!, id });
    return connect(id);
  };
  return { bridge, supervisor, threads, failures, ...first, relay, addDevice, reconnect: () => connect() };
};

afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.stop())); hooks.relays.length = 0; await Promise.all(receiptDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("authenticated remote thread commands", () => {
  it("serves usage to the authenticated device without writing or resuming", async () => {
    const h = await harness();
    expect((await h.command({type:"usage.get"})).ok).toBe(true);
    expect(h.events().some(e=>e.type==="usage.snapshot" && !e.usage.tokensAvailable)).toBe(true);
    expect(h.supervisor.call.mock.calls.map(c=>c[0])).toContain("account/usage/read");
    expect(h.supervisor.call.mock.calls.map(c=>c[0])).not.toContain("thread/resume");
    expect((await h.command({type:"usage.get",threadId:"wrong-target"})).ok).toBe(false);
  });
  it("opens an externally owned thread read-only, blocks mutations and polls new content without resuming", async () => {
    const h = await harness();
    h.threads.push({id:"external",name:"External",status:{type:"active"},turns:[{id:"t",status:"inProgress",items:[{id:"m",type:"agentMessage",text:"first"}]}]});
    h.failures.set("thread/resume", "thread external already has an active writer");
    expect((await h.command({type:"thread.open",threadId:"external"})).ok).toBe(true);
    expect(h.snapshot()).toMatchObject({activeThreadId:"external",readOnly:true});
    expect(h.snapshot().items[0]).toMatchObject({id:"m",markdown:"first"});
    for (const value of [
      {type:"turn.send",text:"do not send"}, {type:"turn.interrupt",turnId:"t"},
      {type:"thread.configure",model:"model-a",effort:"high"},
      {type:"approval.resolve",approvalId:"a",version:1,decision:"accept"},
      {type:"approval.decide",approvalId:"a",version:1,decision:"accept"},
      {type:"attachment.delete",attachmentId:crypto.randomUUID()}
    ]) expect((await h.command({...value,type:value.type as MobileCommand["type"],threadId:"external"})).ok).toBe(false);
    expect((await h.command({type:"history.list",threadId:"external",limit:5})).ok).toBe(true);
    expect(h.supervisor.call.mock.calls.some(([m])=>["turn/start","turn/interrupt","thread/settings/update"].includes(m))).toBe(false);
    const resumes=h.supervisor.call.mock.calls.filter(([m])=>m==="thread/resume").length;
    h.threads[0]!.turns[0].items[0].text="streamed update";
    await vi.waitFor(()=>expect(h.snapshot().items[0]).toMatchObject({markdown:"streamed update"}),{timeout:6000,interval:50});
    expect(h.supervisor.call.mock.calls.filter(([m])=>m==="thread/resume")).toHaveLength(resumes);
    expect(h.snapshot().readOnlyUpdatedAt).toBeGreaterThan(0);
    h.threads[0]!.turns=[{id:"t2",status:"inProgress",items:[{id:"m2",type:"agentMessage",text:"next turn"}]}];
    await vi.waitFor(()=>expect(h.snapshot().items.map(i=>i.id)).toEqual(["m","m2"]),{timeout:6000,interval:50});

    await h.bridge.setMaintenance(true);
    const reads=h.supervisor.call.mock.calls.filter(([m])=>m==="thread/read").length;
    await new Promise(resolve=>setTimeout(resolve,2200));
    expect(h.supervisor.call.mock.calls.filter(([m])=>m==="thread/read")).toHaveLength(reads);
    await h.bridge.setMaintenance(false);
    h.failures.delete("thread/resume");
    expect((await h.command({type:"thread.open",threadId:"external"})).ok).toBe(true);
    expect(h.snapshot().readOnly).toBe(false);
  }, 15000);

  it("does not downgrade unrelated resume failures or replace selection when read-only read fails", async () => {
    const h=await harness();
    h.threads.push({id:"external",turns:[],status:{type:"idle"}});
    h.failures.set("thread/resume","permission denied");
    expect((await h.command({type:"thread.open",threadId:"external"})).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.some(([m])=>m==="thread/read")).toBe(false);
    h.failures.set("thread/resume","already has an active writer");h.failures.set("thread/read","not available");
    expect((await h.command({type:"thread.open",threadId:"external"})).ok).toBe(false);
    expect(h.snapshot().activeThreadId).toBeNull();
  });

  it("uploads scoped attachments through encrypted commands and sends once with durable receipts", async () => {
    const directory=await mkdtemp(join(tmpdir(),"paneflow-media-bridge-"));receiptDirectories.push(directory);
    const h=await harness(join(directory,"requests.enc"));
    h.threads.push({id:"media-thread",cwd:"D:/fixture",turns:[],status:{type:"idle"}});
    await h.command({type:"thread.open",threadId:"media-thread"});
    expect(h.snapshot().capabilities).toContain("attachmentsV1");
    const bytes=Buffer.from("attachment fixture"),uploadId=crypto.randomUUID();
    const begin={type:"attachment.begin" as const,threadId:"media-thread",uploadId,name:"fixture.txt",mime:"text/plain",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    expect((await h.command(begin)).ok).toBe(true);
    expect((await h.command({type:"attachment.chunk",threadId:"media-thread",uploadId,offset:0,data:bytes.toString("base64")})).ok).toBe(true);
    expect((await h.command({type:"attachment.finish",threadId:"media-thread",uploadId})).ok).toBe(true);
    const event=h.events().filter(e=>e.type==="attachment.status"&&e.complete).at(-1) as Extract<DesktopEvent,{type:"attachment.status"}>;
    const id=event.attachment!.id;
    const second=await h.addDevice();await second.command({type:"thread.open",threadId:"media-thread"});
    expect((await second.command({type:"attachment.read",threadId:"media-thread",attachmentId:id,offset:0})).ok).toBe(false);
    const requestId=crypto.randomUUID(),send={type:"turn.send" as const,threadId:"media-thread",text:"",attachmentIds:[id]};
    expect((await h.command(send,requestId)).ok).toBe(true);expect((await h.command(send,requestId)).ok).toBe(true);
    const calls=h.supervisor.call.mock.calls.filter(([method])=>method==="turn/start");expect(calls).toHaveLength(1);
    const input=(calls[0]![1] as any).input;expect(input[0]).toMatchObject({type:"mention",name:"fixture.txt"});
    h.threads[0]!.turns=[{id:"completed-turn",status:"completed",items:[{id:"message",type:"userMessage",content:input}]}];
    h.failures.set("thread/items/list","thread/items/list unsupported");
    await second.command({type:"thread.open",threadId:"media-thread"});
    expect(second.snapshot().items[0]).toMatchObject({attachments:[{id,name:"fixture.txt"}]});
    expect((await second.command({type:"attachment.read",threadId:"media-thread",attachmentId:id,offset:0})).ok).toBe(true);
    const downloaded=second.events().filter(e=>e.type==="attachment.chunk").at(-1) as Extract<DesktopEvent,{type:"attachment.chunk"}>;
    expect(downloaded.data).toBe(bytes.toString("base64"));
    h.failures.set("thread/resume","already has an active writer");
    expect((await second.command({type:"thread.open",threadId:"media-thread"})).ok).toBe(true);
    expect(second.snapshot().readOnly).toBe(true);
    expect((await second.command({type:"attachment.read",threadId:"media-thread",attachmentId:id,offset:0})).ok).toBe(true);
    expect((await second.command({type:"attachment.delete",threadId:"media-thread",attachmentId:id})).ok).toBe(false);

    expect((await h.command({type:"attachment.cancel",threadId:"media-thread",uploadId})).ok).toBe(false);
    expect((await second.command({type:"turn.send",threadId:"media-thread",text:"",attachmentIds:[]})).ok).toBe(false);
  });
  it("blocks new mobile effects during update maintenance and refuses maintenance with pending work", async () => {
    const h = await harness();
    await h.bridge.setMaintenance(true);
    expect((await h.command({ type: "queue.enqueue", cwd: "D:/fixture", text: "must not run" })).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "thread/start")).toBe(false);
    await h.bridge.setMaintenance(false);
    await h.command({ type: "queue.pause", paused: true });
    expect((await h.command({ type: "queue.enqueue", cwd: "D:/fixture", text: "pending" })).ok).toBe(true);
    await expect(h.bridge.setMaintenance(true)).rejects.toThrow("任务");
  });
  it("replaces the waiting-for-stop message when Codex confirms interruption", async () => {
    const h = await harness();
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "stop me" });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("running"), { interval: 5 });
    const task = h.snapshot().queue!.tasks[0]!;
    h.threads[0]!.turns = [{ id: task.turnId, status: "inProgress", items: [] }];
    expect((await h.command({ type: "queue.stop", taskId: task.id, threadId: task.threadId, turnId: task.turnId })).ok).toBe(true);
    expect(h.snapshot().queue!.tasks[0]!.lastError).toContain("等待 Codex");
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/completed", params: { threadId: task.threadId, turn: { id: task.turnId, status: "interrupted" } } } });
    await vi.waitFor(() => expect(h.snapshot().queue!.tasks[0]).toMatchObject({ queueState: "failed", lastError: "任务已停止。" }), { interval: 5 });
  });

  it.each(["revoke", "disable"])("does not interrupt when %s happens while the stop target read is pending", async action => {
    const h = await harness(); const other = await h.addDevice();
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "running" });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("running"), { interval: 5 });
    const task = h.snapshot().queue!.tasks[0]!;
    let resolveRead!: (value: unknown) => void;
    let reading = false;
    const original = h.supervisor.call.getMockImplementation()!;
    h.supervisor.call.mockImplementation(async (method, params) => {
      if (method === "thread/read") { reading = true; return new Promise(resolve => { resolveRead = resolve; }); }
      return original(method, params);
    });
    h.dispatch({ type: "queue.stop", requestId: crypto.randomUUID(), taskId: task.id, threadId: task.threadId, turnId: task.turnId });
    await vi.waitFor(() => expect(reading).toBe(true), { interval: 5 });
    if (action === "revoke") await h.bridge.revokePasskey(deviceId);
    else await h.bridge.updateSettings({ enabled: false, relayUrl: "http://localhost:48321" });
    resolveRead({ thread: { id: task.threadId, turns: [{ id: task.turnId, status: "inProgress" }] } });
    await vi.waitFor(() => expect(h.bridge.getPendingWork()).toContainEqual(expect.objectContaining({ kind: "queue", id: task.id, state: "unknown" })), { interval: 5 });
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    if (action === "revoke") expect(other.snapshot().queue?.paused).toBe(true);
  });

  it("catches asynchronous completion persistence failures, visibly pauses, and retains the execution slot", async () => {
    let saved: any = null; let fail = false;
    const store = { load: async () => structuredClone(saved), save: async (value: any) => { if (fail) throw new Error("disk unavailable"); saved = structuredClone(value); } };
    const h = await harness(undefined, store as any);
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "first" });
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "second" });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("running"), { interval: 5 });
    const task = h.snapshot().queue!.tasks[0]!; fail = true;
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/completed", params: { threadId: task.threadId, turn: { id: task.turnId, status: "completed" } } } });
    await vi.waitFor(() => expect(h.snapshot().queue?.pauseReason).toContain("存储"), { interval: 5 });
    expect(h.snapshot().queue).toMatchObject({ paused: true, activeTaskId: task.id });
    expect(h.bridge.hasActiveWork()).toBe(true);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
  });

  it("clears only the manually reconciled unknown queue target from old-generation ownership", async () => {
    const h = await harness();
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "first" });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("running"), { interval: 5 });
    const task = h.snapshot().queue!.tasks[0]!;
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "manual-other", turn: { id: "other-turn" } } } });
    h.supervisor.state.generation = 2; h.bridge.handleConnectionState(h.supervisor.state as any);
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("unknown"), { interval: 5 });
    expect((await h.command({ type: "queue.reconcile", taskId: task.id, resolution: "failed" })).ok).toBe(true);
    expect(h.bridge.getPendingWork().some(work => work.kind === "turn" && work.id === task.turnId)).toBe(false);
    expect(h.bridge.getPendingWork()).toContainEqual({ kind: "turn", id: "other-turn", threadId: "manual-other", state: "unknown" });
  });

  it("runs queue FIFO with approval occupying the slot and a cross-chat explicit center decision", async () => {
    const h = await harness();
    const other = await h.addDevice();
    await h.command({ type: "queue.pause", paused: true });
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "first", model: "model-a", effort: "high" });
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "second" });
    expect(h.snapshot().queue?.tasks.map(task => task.queueState)).toEqual(["pending", "pending"]);
    expect(h.bridge.hasActiveWork()).toBe(true);
    await h.command({ type: "queue.pause", paused: false });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("running"), { interval: 5 });
    const first = h.snapshot().queue!.tasks[0]!;
    expect(first).toMatchObject({ threadId: "new-1", turnId: "initial-turn", cwd: "D:/queue" });
    expect(h.snapshot().activeThreadId).toBeNull();
    expect(other.snapshot().activeThreadId).toBeNull();
    h.bridge.handleProtocolEvent({ generation: 1, kind: "server-request", payload: { id: "queued-approval", method: "item/commandExecution/requestApproval", params: { threadId: "new-1", cwd: "D:/queue", command: ["echo", "review"], availableDecisions: ["accept", "decline"] } } });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("waiting"), { interval: 5 });
    expect(other.snapshot().approvals?.[0]).toMatchObject({ threadId: "new-1", cwd: "D:/queue" });
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    const approval = other.snapshot().approvals![0]!.approval;
    const decision = { type: "approval.decide" as const, approvalId: approval.id, threadId: "new-1", version: approval.version, decision: "accept" };
    expect((await other.command({ ...decision, threadId: "unrelated" })).ok).toBe(false);
    expect(h.supervisor.respondToServer).not.toHaveBeenCalled();
    const results = await Promise.all([other.command(decision), h.command(decision)]);
    expect(results.map(result => result.ok).sort()).toEqual([false, true]);
    expect(h.supervisor.respondToServer).toHaveBeenCalledTimes(1);
    expect(other.snapshot().approvals).toHaveLength(0);
    expect(h.snapshot().approvals).toHaveLength(0);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/completed", params: { threadId: "new-1", turn: { id: "initial-turn", status: "completed" } } } });
    await vi.waitFor(() => expect(h.snapshot().queue?.tasks[1]?.queueState).toBe("running"), { interval: 5 });
    expect(h.snapshot().queue?.tasks[0]?.queueState).toBe("completed");
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(2);
  });

  it("labels external metadata read-only and refuses interrupt without app-server ownership evidence", async () => {
    const h = await harness();
    h.threads.push({ id: "external", cwd: "D:/external", status: { type: "active" }, turns: [{ id: "external-turn", status: "inProgress", items: [] }] });
    await h.command({ type: "thread.open", threadId: "external" });
    expect((await h.command({ type: "turn.interrupt", threadId: "external", turnId: "external-turn" })).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    await h.command({ type: "task.detail", threadId: "external" });
    const detail = h.events().filter(event => event.type === "task.detail").at(-1)!.detail;
    expect(detail).toMatchObject({ threadId: "external", cwd: "D:/external", turnStatus: "running", controllable: false, readOnly: true, goalStatus: null });
    expect(detail.queueState).toBeUndefined();
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "external", turn: { id: "external-turn", status: "inProgress" } } } });
    expect(h.bridge.getPendingWork()).toContainEqual({ kind: "turn", id: "external-turn", threadId: "external", state: "running" });
    expect((await h.command({ type: "turn.interrupt", threadId: "external", turnId: "external-turn" })).ok).toBe(true);
  });

  it("does not send task.detail events to an old passive client and guards upgrade while queued or manually running", async () => {
    const h = await harness(); const other = await h.addDevice();
    expect(h.bridge.hasActiveWork()).toBe(false);
    await h.command({ type: "queue.pause", paused: true });
    await h.command({ type: "queue.enqueue", cwd: "D:/project", text: "pending" });
    const task = h.snapshot().queue!.tasks[0]!;
    await h.command({ type: "task.detail", taskId: task.id });
    expect(h.events().filter(event => event.type === "task.detail").at(-1)!.detail).toMatchObject({ taskId: task.id, queueState: "pending", turnStatus: "idle", controllable: true });
    expect(other.events().some(event => event.type === "task.detail")).toBe(false);
    expect(h.bridge.hasActiveWork()).toBe(true);
    await h.command({ type: "queue.cancel", taskId: task.id });
    expect(h.bridge.hasActiveWork()).toBe(false);
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "desktop-manual", turn: { id: "manual-turn" } } } });
    expect(h.bridge.hasActiveWork()).toBe(true);
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/completed", params: { threadId: "desktop-manual", turn: { id: "manual-turn", status: "completed" } } } });
    expect(h.bridge.hasActiveWork()).toBe(false);
  });

  it("does not associate an enqueue receipt with an unrelated selected chat and rejects old-generation control", async () => {
    const h = await harness(); await h.command({ type: "thread.new" });
    await h.command({ type: "queue.pause", paused: true });
    const requestId = crypto.randomUUID();
    await h.command({ type: "queue.enqueue", cwd: "D:/queue", text: "later" }, requestId);
    await h.command({ type: "request.status", requestIds: [requestId] });
    const receipt = h.events().filter(event => event.type === "request.status").at(-1)!.records[0]!;
    expect(receipt.status).toBe("completed");
    expect(receipt.threadId).toBeUndefined();
    h.threads[0]!.turns = [{ id: "old-generation", status: "inProgress", items: [] }];
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "new-1", turn: { id: "old-generation" } } } });
    h.supervisor.state.generation = 2;
    h.bridge.handleConnectionState(h.supervisor.state as any);
    expect(h.bridge.getPendingWork()).toContainEqual({ kind: "turn", id: "old-generation", threadId: "new-1", state: "unknown" });
    expect((await h.command({ type: "turn.interrupt", threadId: "new-1", turnId: "old-generation" })).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
  });

  it.each(["thread/settings/update", "thread/list", "turn/start", "thread/name/set"])("persists the actual partial-created target across restart when %s fails", async (stage) => {
    const directory = await mkdtemp(join(tmpdir(), "paneflow-partial-result-"));
    receiptDirectories.push(directory);
    const path = join(directory, "requests.enc");
    const h = await harness(path);
    const requestId = crypto.randomUUID();
    const isFork = stage === "thread/name/set";
    if (isFork) await h.command({ type: "thread.new" });
    h.failures.set(stage, "failure after target creation");
    const command = isFork ? { type: "thread.fork" as const, threadId: "new-1", name: "fork" } : { type: "thread.new" as const, model: "model-a", effort: "high", text: "initial prompt" };
    expect((await h.command(command, requestId)).ok).toBe(false);
    await h.bridge.stop();
    const restarted = await harness(path);
    await restarted.command({ type: "request.status", requestIds: [requestId] });
    const receipt = restarted.events().filter(event => event.type === "request.status").at(-1)!.records[0];
    expect(receipt).toMatchObject({ requestId, status: "unknown", threadId: isFork ? "new-2" : "new-1" });
    expect((await restarted.command(command, requestId)).ok).toBe(false);
    expect(restarted.supervisor.call.mock.calls.some(([method]) => ["thread/start", "thread/fork", "turn/start"].includes(method))).toBe(false);
  });

  it("isolates approvals by selected chat and rejects a forged cross-chat decision", async () => {
    const h = await harness();
    const other = await h.addDevice();
    await h.command({ type: "thread.new" });
    await other.command({ type: "thread.new" });
    h.bridge.handleProtocolEvent({ generation: 1, kind: "server-request", payload: { id: "approval-a", method: "item/commandExecution/requestApproval", params: { threadId: "new-1", command: ["echo", "review"], availableDecisions: ["accept", "decline"] } } });
    const approval = h.events().filter(e => e.type === "approval.request").at(-1)!;
    expect(approval.threadId).toBe("new-1");
    expect(other.events().some(e => e.type === "approval.request")).toBe(false);
    const decision = { type: "approval.resolve" as const, approvalId: "approval-a", threadId: "new-1", version: approval.approval.version, decision: "accept" };
    expect((await other.command(decision)).ok).toBe(false);
    expect(h.supervisor.respondToServer).not.toHaveBeenCalled();
    await other.command({ type: "snapshot.get" });
    expect(other.snapshot().items.some(item => item.kind === "approval")).toBe(false);
    expect((await h.command(decision)).ok).toBe(true);
    expect(h.supervisor.respondToServer).toHaveBeenCalledTimes(1);
    expect((await h.command(decision)).ok).toBe(false);
    expect(h.supervisor.respondToServer).toHaveBeenCalledTimes(1);
  });

  it("keeps completed durable status when the acknowledgement cannot be delivered", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    const requestId = crypto.randomUUID();
    const send = h.relay.send.bind(h.relay);
    h.relay.send = (peerId: string, payload: any) => {
      if (payload.event?.type === "command.result" && payload.event.requestId === requestId) throw new Error("network unavailable");
      send(peerId, payload);
    };
    h.dispatch({ type: "turn.send", requestId, threadId: "new-1", text: "accepted message" });
    await vi.waitFor(() => expect(h.supervisor.call).toHaveBeenCalledWith("turn/start", expect.objectContaining({ clientUserMessageId: requestId })), { interval: 5 });
    await h.command({ type: "request.status", requestIds: [requestId] });
    expect(h.events().filter(e => e.type === "request.status").at(-1)!.records[0]?.status).toBe("completed");
    h.relay.send = send;
    expect((await h.command({ type: "turn.send", threadId: "new-1", text: "accepted message" }, requestId)).ok).toBe(true);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("retains the same device selection after reconnect and targets snapshot requests", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    const other = await h.addDevice();
    await other.command({ type: "thread.new" });
    const reconnected = await h.reconnect();
    expect(reconnected.snapshot().activeThreadId).toBe("new-1");
    const count = other.events().filter(event => event.type === "snapshot").length;
    await reconnected.command({ type: "snapshot.get" });
    expect(reconnected.snapshot().activeThreadId).toBe("new-1");
    expect(other.events().filter(event => event.type === "snapshot")).toHaveLength(count);
  });

  it("routes streaming items to the selected device and preserves desktop subscriptions", async () => {
    const h = await harness();
    const other = await h.addDevice();
    await h.command({ type: "thread.new" });
    await other.command({ type: "thread.new" });
    h.bridge.acquireDesktopThread("new-1");
    h.bridge.handleProtocolEvent({ generation: 1, kind: "notification", payload: { method: "item/agentMessage/delta", params: { threadId: "new-1", itemId: "stream", delta: "only phone one" } } });
    await vi.waitFor(() => expect(h.events().some(e => e.type === "item.upsert" && e.item.id === "stream")).toBe(true), { interval: 10 });
    expect(other.events().some(e => e.type === "item.upsert" && e.item.id === "stream")).toBe(false);
    h.supervisor.call.mockClear();
    await h.command({ type: "thread.new" });
    expect(h.supervisor.call.mock.calls.some(([method, params]) => method === "thread/unsubscribe" && params.threadId === "new-1")).toBe(false);
    expect(await h.bridge.releaseDesktopThread("new-1")).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "new-1" });
    expect(other.snapshot().activeThreadId).toBe("new-2");
  });

  it("isolates selection and receipts between two authenticated devices", async () => {
    const h = await harness();
    const other = await h.addDevice();
    const sharedRequestId = crypto.randomUUID();
    expect((await h.command({ type: "thread.new" }, sharedRequestId)).ok).toBe(true);
    expect(h.snapshot().activeThreadId).toBe("new-1");
    expect(other.snapshot().activeThreadId).toBeNull();
    expect((await other.command({ type: "thread.new" }, sharedRequestId)).ok).toBe(true);
    expect(other.snapshot().activeThreadId).toBe("new-2");
    expect(h.snapshot().activeThreadId).toBe("new-1");
    await h.command({ type: "turn.send", threadId: "new-1", text: "one" });
    expect(h.supervisor.call).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "new-1" }));
    expect((await other.command({ type: "turn.send", threadId: "new-1", text: "wrong target" })).ok).toBe(false);
    await other.command({ type: "request.status", requestIds: [sharedRequestId] });
    const status = other.events().filter(e => e.type === "request.status").at(-1)!;
    expect(status.records).toEqual([expect.objectContaining({ requestId: sharedRequestId, status: "completed", threadId: "new-2" })]);
  });

  it("keeps uncertain dispatch unknown and never repeats it on duplicate delivery", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    h.failures.set("turn/start", "transport connection lost after dispatch");
    const requestId = crypto.randomUUID();
    const command = { type: "turn.send" as const, threadId: "new-1", text: "side effect" };
    expect((await h.command(command, requestId)).ok).toBe(false);
    h.failures.delete("turn/start");
    expect((await h.command(command, requestId)).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    await h.command({ type: "request.status", requestIds: [requestId] });
    expect(h.events().filter(e => e.type === "request.status").at(-1)!.records[0]?.status).toBe("unknown");
  });

  it("rejects reused request ids with changed payload without overwriting the original receipt", async () => {
    const h = await harness();
    const requestId = crypto.randomUUID();
    await h.command({ type: "thread.new" }, requestId);
    expect((await h.command({ type: "thread.new", text: "different" }, requestId)).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    await h.command({ type: "request.status", requestIds: [requestId] });
    expect(h.events().filter(e => e.type === "request.status").at(-1)!.records[0]?.status).toBe("completed");
  });

  it("loads full history in chronological order only for the selected device", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    const other = await h.addDevice();
    const original = h.supervisor.call.getMockImplementation()!;
    h.supervisor.call.mockImplementation(async (method, params) => method === "thread/turns/list" ? {
      data: [{ id: "turn-b", status: "completed", items: [{ id: "item-b", type: "agentMessage", text: "newer" }] }, { id: "turn-a", status: "completed", items: [{ id: "item-a", type: "agentMessage", text: "older" }] }], nextCursor: "older-cursor"
    } : original(method, params));
    expect((await h.command({ type: "history.list", threadId: "new-1", limit: 20 })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/turns/list", { threadId: "new-1", cursor: null, limit: 20, sortDirection: "desc", itemsView: "full" });
    const page = h.events().filter(e => e.type === "history.page").at(-1)!;
    expect(page.items.map(item => item.id)).toEqual(["item-a", "item-b"]);
    expect(page.nextCursor).toBeTruthy();
    expect(page.nextCursor).not.toBe("older-cursor");
    expect(other.events().some(e => e.type === "history.page")).toBe(false);
    await other.command({ type: "thread.open", threadId: "new-1" });
    expect((await other.command({ type: "history.list", threadId: "new-1", cursor: page.nextCursor })).message).toContain("不属于");
    expect((await h.command({ type: "history.list", threadId: "new-1", cursor: page.nextCursor })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ cursor: "older-cursor" }));
    h.failures.set("thread/turns/list", "unsupported");
    h.supervisor.call.mockImplementation(original);
    expect((await h.command({ type: "history.list", threadId: "new-1" })).message).toContain("升级");
  });

  it("returns the latest five then ten distinct sessions using the cursor without changing the active chat", async () => {
    const h=await harness();
    for(let i=0;i<16;i++)h.threads.push({id:"page-"+i,name:"Session "+i,status:{type:"idle"}});
    expect((await h.command({type:"thread.list",limit:5})).ok).toBe(true);
    const first=h.events().filter(e=>e.type==="thread.page").at(-1) as Extract<DesktopEvent,{type:"thread.page"}>;
    expect(first.threads.map(t=>t.id)).toEqual(["page-0","page-1","page-2","page-3","page-4"]);
    expect(first.nextCursor).toBe("5");
    expect((await h.command({type:"thread.list",limit:10,cursor:first.nextCursor})).ok).toBe(true);
    const next=h.events().filter(e=>e.type==="thread.page").at(-1) as Extract<DesktopEvent,{type:"thread.page"}>;
    expect(next.threads).toHaveLength(10);expect(next.threads[0]?.id).toBe("page-5");expect(next.nextCursor).toBe("15");
    expect(h.supervisor.call.mock.calls.some(([method])=>method==="thread/resume")).toBe(false);
  });
  it("creates, configures, then sends the initial message to the returned id using fixed permissions", async () => {
    const h = await harness();
    const requestId = crypto.randomUUID();
    const result = await h.command({ type: "thread.new", cwd: " D:/chosen ", model: "model-b", effort: "medium", text: " first message " }, requestId);
    expect(result.ok).toBe(true);
    expect(h.supervisor.call.mock.calls.map(([method]) => method)).toEqual(["model/list", "thread/start", "thread/settings/update", "thread/list", "thread/goal/get", "turn/start"]);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/start", { cwd: "D:/chosen", model: "model-b", ephemeral: false, ...safeSettings });
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/settings/update", { threadId: "new-1", effort: "medium" });
    expect(h.supervisor.call).toHaveBeenCalledWith("turn/start", { threadId: "new-1", clientUserMessageId: requestId, input: [{ type: "text", text: "first message", text_elements: [] }] });
    expect(h.snapshot()).toMatchObject({ activeThreadId: "new-1", activeTurnId: "initial-turn", selectedModel: "model-b", selectedEffort: "medium", turnStatus: "running" });
    await h.command({ type: "thread.new", cwd: "D:/chosen", model: "model-b", effort: "medium", text: "first message" }, requestId);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("keeps old new-thread commands and resolves effort-only requests against the catalog default", async () => {
    const h = await harness();
    h.bridge.updateSessionDefaults({ cwd: "D:/default", model: "model-a" });
    expect((await h.command({ type: "thread.new" })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/start", { cwd: "D:/default", model: "model-a", ephemeral: false, ...safeSettings });
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "turn/start" || method === "thread/settings/update")).toBe(false);
    h.bridge.updateSessionDefaults({ cwd: null, model: null });
    expect((await h.command({ type: "thread.new", effort: "high" })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/list", expect.anything());
    expect(h.supervisor.call).toHaveBeenLastCalledWith("thread/goal/get", expect.anything(), 2_000);
    expect(h.snapshot()).toMatchObject({ selectedModel: "model-a", selectedEffort: "high" });
  });

  it("targets the newly returned thread when another thread was selected", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    h.supervisor.call.mockClear();
    expect((await h.command({ type: "thread.new", text: "new draft" })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("turn/start", expect.objectContaining({ threadId: "new-2" }));
    expect(h.supervisor.call.mock.calls.filter(([method, params]) => method === "turn/start" && params.threadId === "new-1")).toEqual([]);
    expect(h.snapshot().activeThreadId).toBe("new-2");
  });

  it.each([{ model: "unknown" }, { model: "hidden-model" }, { model: "model-a", effort: "ultra" }, { model: "model-b", effort: "high" }])("rejects unsupported model selection before creating a thread: %j", async (selection) => {
    const h = await harness();
    expect((await h.command({ type: "thread.new", ...selection })).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.map(([method]) => method)).toEqual(["model/list"]);
  });

  it("passes cwd to the supervisor boundary and never sends if native cwd validation rejects it", async () => {
    const h = await harness();
    h.failures.set("thread/start", "Codex 工作目录不存在或不是目录，请重新选择项目目录。");
    const result = await h.command({ type: "thread.new", cwd: "D:/missing", text: "draft" });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("工作目录") });
    expect(h.supervisor.call.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/start", expect.objectContaining({ cwd: "D:/missing" }));
  });

  it.each(["thread/settings/update", "thread/list", "turn/start"])("reports partial creation and caches failure when %s fails", async (stage) => {
    const h = await harness();
    h.failures.set(stage, "test failure");
    const requestId = crypto.randomUUID();
    const value = { type: "thread.new" as const, model: "model-a", effort: "high", text: "draft" };
    const result = await h.command(value, requestId);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("会话 new-1 已创建") });
    expect(result.message).toContain(stage === "turn/start" ? "发送结果未确认" : "尚未发送");
    expect(h.snapshot().activeThreadId).toBe("new-1");
    await h.command(value, requestId);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(1);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(stage === "turn/start" ? 1 : 0);
  });

  it("names only the returned fork and preserves history and source name", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    h.threads[0]!.name = "source";
    h.threads[0]!.turns = [{ id: "old-turn", status: "completed", items: [] }];
    h.supervisor.call.mockClear();
    expect((await h.command({ type: "thread.fork", threadId: "new-1", name: " named branch " })).ok).toBe(true);
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/fork", { threadId: "new-1", excludeTurns: false, deferGoalContinuation: true });
    expect(h.supervisor.call).toHaveBeenCalledWith("thread/name/set", { threadId: "new-2", name: "named branch" });
    expect(h.threads[0]!.name).toBe("source");
    expect(h.threads[1]!.turns).toEqual(h.threads[0]!.turns);
    expect(h.snapshot()).toMatchObject({ activeThreadId: "new-2", activeThreadTitle: "named branch" });
    expect(h.snapshot().threads.find((thread) => thread.id === "new-2")?.title).toBe("named branch");
  });

  it("returns an inspectable fork after rename failure without retrying the fork", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    h.supervisor.call.mockClear();
    h.failures.set("thread/name/set", "rename failed");
    const requestId = crypto.randomUUID();
    const value = { type: "thread.fork" as const, threadId: "new-1", name: "branch" };
    expect(await h.command(value, requestId)).toMatchObject({ ok: false, message: expect.stringContaining("分叉会话 new-2 已创建") });
    expect(h.snapshot().activeThreadId).toBe("new-2");
    await h.command(value, requestId);
    expect(h.supervisor.call.mock.calls.filter(([method]) => method === "thread/fork")).toHaveLength(1);
  });

  it("preserves unnamed fork command compatibility without changing any name", async () => {
    const h = await harness();
    await h.command({ type: "thread.new" });
    h.supervisor.call.mockClear();
    expect((await h.command({ type: "thread.fork", threadId: "new-1" })).ok).toBe(true);
    expect(h.supervisor.call.mock.calls.some(([method]) => method === "thread/name/set")).toBe(false);
    expect(h.snapshot().activeThreadId).toBe("new-2");
  });

  it("rejects named forks while the source is running", async () => {
    const h = await harness();
    await h.command({ type: "thread.new", text: "run" });
    h.supervisor.call.mockClear();
    expect((await h.command({ type: "thread.fork", threadId: "new-1", name: "branch" })).ok).toBe(false);
    expect(h.supervisor.call.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
  });
});
