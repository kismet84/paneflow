import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteCredentialState } from "../../electron/main/remote-credential-store";
import type { DesktopEvent, MobileCommand } from "../../packages/remote-protocol/src/index";

const hooks = vi.hoisted(() => ({ relays: [] as any[] }));
vi.mock("electron", () => ({ app: { getAppPath: () => ".", getVersion: () => "test" }, safeStorage: {} }));
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
import { RemoteBridge } from "../../electron/main/remote-bridge";

const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const safeSettings = { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace" };
const bridges: RemoteBridge[] = [];
const harness = async () => {
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
      if (method === "thread/read") return { thread: structuredClone(threads.find((thread) => thread.id === params.threadId)) };
      if (method === "thread/name/set") {
        threads.find((thread) => thread.id === params.threadId)!.name = params.name;
        return {};
      }
      if (method === "turn/start") return { turn: { id: "initial-turn" } };
      return {};
    })
  };
  const bridge = new RemoteBridge(supervisor as any, { load: async () => state, revealSigningPrivateKey: () => ({}), revealAgreementPrivateKey: () => ({}) } as any, { write: async () => {} } as any);
  bridges.push(bridge);
  await bridge.initialize();
  const relay = hooks.relays.at(-1);
  const peerId = crypto.randomUUID();
  const send = (payload: unknown) => relay.emit("event", { type: "data", peerId, payload: JSON.stringify(payload) });
  const secure = (payload: unknown) => send({ type: "secure", sessionId: crypto.randomUUID(), sequence: 0, iv: "iv", ciphertext: JSON.stringify(payload) });
  relay.emit("event", { type: "peerOnline", peerId, mode: "device", deviceId });
  send({ type: "session.hello", sessionId: crypto.randomUUID(), deviceId, mobileEphemeralPublicKey: jwk, timestamp: Date.now(), signature: "sig" });
  await vi.waitFor(() => expect(relay.sent.some((item: any) => item.payload.type === "native.authentication.challenge")).toBe(true), { interval: 5 });
  const challenge = relay.sent.find((item: any) => item.payload.type === "native.authentication.challenge").payload.challenge;
  secure({ type: "native.authentication.response", challenge });
  await vi.waitFor(() => expect(relay.sent.some((item: any) => item.payload.event?.type === "snapshot")).toBe(true), { interval: 5 });
  supervisor.call.mockClear();
  const events = (): DesktopEvent[] => relay.sent.flatMap((item: any) => item.payload.type === "desktop.event" ? [item.payload.event] : []);
  const command = async (value: Omit<Extract<MobileCommand, { type: "thread.new" }>, "requestId"> | Omit<Extract<MobileCommand, { type: "thread.fork" }>, "requestId"> | Omit<Extract<MobileCommand, { type: "thread.list" }>, "requestId">, requestId = crypto.randomUUID()) => {
    const previousCount = events().filter((event) => event.type === "command.result" && event.requestId === requestId).length;
    secure({ type: "mobile.command", command: { ...value, requestId } });
    await vi.waitFor(() => expect(events().filter((event) => event.type === "command.result" && event.requestId === requestId).length).toBeGreaterThan(previousCount), { interval: 5 });
    return events().filter((event) => event.type === "command.result" && event.requestId === requestId).at(-1) as Extract<DesktopEvent, { type: "command.result" }>;
  };
  const snapshot = () => (events().filter((event) => event.type === "snapshot").at(-1) as Extract<DesktopEvent, { type: "snapshot" }>).snapshot;
  return { bridge, supervisor, threads, failures, command, snapshot, events };
};

afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.stop())); hooks.relays.length = 0; });

describe("authenticated remote thread commands", () => {
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
