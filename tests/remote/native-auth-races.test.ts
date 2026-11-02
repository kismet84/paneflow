import { mkdtemp, readdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteCredentialStore } from "../../electron/main/remote-credential-store";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteCredentialState, RemoteMobileDevice } from "../../electron/main/remote-credential-store";

const hooks = vi.hoisted(() => ({ relays: [] as any[], verifyAuthentication: vi.fn(), verifyRegistration: vi.fn() }));
vi.mock("electron", () => ({ app: { getAppPath: () => ".", getVersion: () => "test" }, safeStorage: {} }));
vi.mock("../../electron/main/relay-connection", () => ({ RelayConnection: class extends EventEmitter {
  sent: Array<{ peerId: string; payload: any }> = [];
  constructor() { super(); hooks.relays.push(this); }
  start() {} stop() {} reconnect() {} sendPolicy() {}
  send(peerId: string, payload: any) { this.sent.push({ peerId, payload }); }
} }));
vi.mock("../../electron/main/remote-crypto", () => ({
  deriveSessionKey: () => Buffer.alloc(32), generateP256KeyPair: () => ({ publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, privateKey: {} }),
  signP256: () => "signature", verifyP256: () => true,
  SecureSession: class { decrypt(envelope: any) { return JSON.parse(envelope.ciphertext); } encrypt(payload: any) { return payload; } }
}));
vi.mock("../../electron/main/remote-passkey", () => ({ RemotePasskeyService: class {
  registrationOptions() { return Promise.resolve({ challenge: "registration" }); }
  authenticationOptions() { return Promise.resolve({ challenge: "authentication" }); }
  verifyAuthentication(...args: any[]) { return hooks.verifyAuthentication(...args); }
  verifyRegistration(...args: any[]) { return hooks.verifyRegistration(...args); }
} }));
import { RemoteBridge } from "../../electron/main/remote-bridge";

const jwk = { kty: "EC", crv: "P-256", x: "x", y: "y" };
const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const browserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const passkey = { id: "passkey", publicKey: "key", counter: 0, transports: [], name: "browser", createdAt: 1, lastUsedAt: null };
const devices: RemoteMobileDevice[] = [
  { id: nativeId, name: "native", signingPublicKey: jwk, agreementPublicKey: jwk, authentication: "native", createdAt: 1, revokedAt: null },
  { id: browserId, name: "browser", signingPublicKey: jwk, agreementPublicKey: jwk, authentication: "passkey", passkey, createdAt: 1, revokedAt: null }
];
const initial = (): RemoteCredentialState => ({ version: 2, enabled: true, relayUrl: "http://localhost:48321", channelId: "a".repeat(64), signingPublicKey: jwk, protectedSigningPrivateKey: "key", agreementPublicKey: jwk, protectedAgreementPrivateKey: "key", devices: structuredClone(devices) });
it("preserves a damaged credential file instead of silently creating a new identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pane-credential-corrupt-"));
  const path = join(root, "credentials.json");
  try {
    const store = new RemoteCredentialStore(path);
    expect(await store.load()).toBeNull();
    for (const raw of ['{broken', '{"version":2,"devices":[]}']) {
      await writeFile(path, raw);
      await expect(store.load()).rejects.toThrow("保留绑定");
      expect(await readFile(path, "utf8")).toBe(raw);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const bridges: RemoteBridge[] = [];
const harness = async () => {
  let stored = initial();
  const save = vi.fn(async (state: RemoteCredentialState) => { stored = structuredClone(state); });
  const store = { load: async () => structuredClone(stored), save, revealSigningPrivateKey: () => ({}), revealAgreementPrivateKey: () => ({}) };
  const supervisor = { state: { phase: "ready", generation: 1, message: "ready" }, call: vi.fn(async () => ({ data: [] })), respondToServer: vi.fn() };
  const bridge = new RemoteBridge(supervisor as any, store as any, { write: vi.fn(async () => {}) } as any);
  bridges.push(bridge);
  await bridge.initialize();
  const relay = hooks.relays.at(-1);
  const send = (peerId: string, payload: any) => relay.emit("event", { type: "data", peerId, payload: JSON.stringify(payload) });
  const secure = (peerId: string, payload: any) => send(peerId, { type: "secure", sessionId: crypto.randomUUID(), sequence: 0, iv: "iv", ciphertext: JSON.stringify(payload) });
  const connect = async (deviceId: string) => {
    const peerId = crypto.randomUUID();
    relay.emit("event", { type: "peerOnline", peerId, mode: "device", deviceId });
    send(peerId, { type: "session.hello", sessionId: crypto.randomUUID(), deviceId, mobileEphemeralPublicKey: jwk, timestamp: Date.now(), signature: "sig" });
    await vi.waitFor(() => expect(relay.sent.some((x: any) => x.peerId === peerId && x.payload.type.endsWith("options") || x.peerId === peerId && x.payload.type === "native.authentication.challenge")).toBe(true));
    return peerId;
  };
  const pair = async (authentication: "native" | "passkey" = "passkey") => {
    const status = await bridge.beginPairing();
    const pairing = status.pairing!;
    const payload = JSON.parse(Buffer.from(new URLSearchParams(new URL(pairing.url).hash.slice(1)).get("pair")!, "base64url").toString());
    const peerId = crypto.randomUUID();
    relay.emit("event", { type: "peerOnline", peerId, mode: "pairing" });
    const hello = { type: "pairing.hello", sessionId: crypto.randomUUID(), pairingId: pairing.pairingId, mobileAgreementPublicKey: jwk, envelope: { type: "secure", sessionId: crypto.randomUUID(), sequence: 0, iv: "iv", ciphertext: JSON.stringify({ type: "pairing.start", pairingSecret: payload.pairingSecret, deviceId: crypto.randomUUID(), deviceName: "new", signingPublicKey: jwk, agreementPublicKey: jwk, authentication }) } };
    send(peerId, hello);
    await vi.waitFor(() => expect(relay.sent.some((x: any) => x.peerId === peerId && ["passkey.registration.options", "pairing.awaiting-confirmation"].includes(x.payload.type))).toBe(true));
    return { peerId, pairing, hello };
  };
  return { bridge, relay, save, stored: () => stored, connect, pair, send, secure };
};
beforeEach(() => { vi.restoreAllMocks(); hooks.relays.length = 0; hooks.verifyAuthentication.mockReset(); hooks.verifyRegistration.mockReset(); });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(bridges.splice(0).map((bridge) => bridge.stop())); });

describe("native and Passkey authorization races", () => {
  it("does not resurrect a native device when a delayed browser verification finishes after revocation", async () => {
    const h = await harness(); const verify = deferred<number>(); hooks.verifyAuthentication.mockReturnValue(verify.promise);
    const peer = await h.connect(browserId); h.secure(peer, { type: "passkey.authentication.response", response: {} });
    await vi.waitFor(() => expect(hooks.verifyAuthentication).toHaveBeenCalled());
    await h.bridge.revokePasskey(nativeId); verify.resolve(1);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(2));
    expect(h.stored().devices.find((d) => d.id === nativeId)?.revokedAt).not.toBeNull();
    expect(h.stored().devices.find((d) => d.id === browserId)?.passkey?.counter).toBe(1);
  });

  it("rejects browser verification if that device is revoked during the await", async () => {
    const h = await harness(); const verify = deferred<number>(); hooks.verifyAuthentication.mockReturnValue(verify.promise);
    const peer = await h.connect(browserId); h.secure(peer, { type: "passkey.authentication.response", response: {} });
    await vi.waitFor(() => expect(hooks.verifyAuthentication).toHaveBeenCalled());
    await h.bridge.revokePasskey("passkey"); verify.resolve(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(h.relay.sent.some((x: any) => x.peerId === peer && x.payload.type === "session.ready")).toBe(false);
  });

  it("serializes delayed settings persistence and revocation using the latest stored device list", async () => {
    const h = await harness(); const gate = deferred<void>();
    const realSave = h.save.getMockImplementation()!;
    h.save.mockImplementationOnce(async (state) => { await gate.promise; await realSave(state); });
    const settings = h.bridge.updateSettings({ enabled: true, relayUrl: "http://localhost:48322" });
    await vi.waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const revoke = h.bridge.revokePasskey(nativeId);
    expect(h.save).toHaveBeenCalledTimes(1);
    gate.resolve(); await Promise.all([settings, revoke]);
    expect(h.stored().relayUrl).toBe("http://localhost:48322");
    expect(h.stored().devices.find((d) => d.id === nativeId)?.revokedAt).not.toBeNull();
  });

  it("rejects an old registration response after replacement pairing and rejects repeated hello", async () => {
    const h = await harness(); const verify = deferred<typeof passkey>(); hooks.verifyRegistration.mockReturnValue(verify.promise);
    const old = await h.pair(); h.secure(old.peerId, { type: "passkey.registration.response", response: {} });
    await vi.waitFor(() => expect(hooks.verifyRegistration).toHaveBeenCalled());
    const replacement = await h.bridge.beginPairing(); verify.resolve(passkey);
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.peerId === old.peerId && x.payload.type === "error")).toBe(true));
    expect(h.bridge.status.pairing).toMatchObject({ pairingId: replacement.pairing!.pairingId, readyToConfirm: false });
    await expect(h.bridge.confirmPairing(replacement.pairing!.pairingId)).rejects.toThrow();
    const fresh = await h.pair("native"); h.send(fresh.peerId, fresh.hello);
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.peerId === fresh.peerId && x.payload.type === "error")).toBe(true));
    expect(h.bridge.status.pairing?.readyToConfirm).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });
  it("rejects native registration responses and registration verification that expires while pending", async () => {
    const h = await harness();
    const native = await h.pair("native");
    h.secure(native.peerId, { type: "passkey.registration.response", response: {} });
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.peerId === native.peerId && x.payload.type === "error")).toBe(true));
    expect(hooks.verifyRegistration).not.toHaveBeenCalled();
    const verify = deferred<typeof passkey>(); hooks.verifyRegistration.mockReturnValue(verify.promise);
    const browser = await h.pair(); h.secure(browser.peerId, { type: "passkey.registration.response", response: {} });
    await vi.waitFor(() => expect(hooks.verifyRegistration).toHaveBeenCalled());
    const time = Date.now(); vi.spyOn(Date, "now").mockReturnValue(time + 600_000); verify.resolve(passkey);
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.peerId === browser.peerId && x.payload.type === "error")).toBe(true));
    expect(h.bridge.status.pairing?.readyToConfirm).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("uses independent temporary files for concurrent store writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-auth-save-"));
    try {
      const store = new RemoteCredentialStore(join(root, "credentials.json"));
      await Promise.all(Array.from({ length: 8 }, (_, index) => store.save({ ...initial(), enabled: index % 2 === 0 })));
      expect((await store.load())?.devices).toHaveLength(2);
      expect(await readdir(root)).toEqual(["credentials.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("blocks a native device reconnect immediately while revocation persistence is delayed", async () => {
    const h = await harness(); const gate = deferred<void>(); const realSave = h.save.getMockImplementation()!;
    h.save.mockImplementationOnce(async (state) => { await gate.promise; await realSave(state); });
    const revoke = h.bridge.revokePasskey(nativeId);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
    const peerId = crypto.randomUUID();
    h.relay.emit("event", { type: "peerOnline", peerId, mode: "device", deviceId: nativeId });
    h.send(peerId, { type: "session.hello", sessionId: crypto.randomUUID(), deviceId: nativeId, mobileEphemeralPublicKey: jwk, timestamp: Date.now(), signature: "sig" });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.relay.sent.filter((x: any) => x.peerId === peerId)).toEqual([]);
    gate.resolve(); await revoke;
    expect(h.stored().devices.find((d) => d.id === nativeId)?.revokedAt).not.toBeNull();
  });

  it("keeps a newly generated pairing visible while an already confirmed pairing finishes saving", async () => {
    const h = await harness(); const old = await h.pair("native");
    const gate = deferred<void>(); const realSave = h.save.getMockImplementation()!;
    h.save.mockImplementationOnce(async (state) => { await gate.promise; await realSave(state); });
    const confirm = h.bridge.confirmPairing(old.pairing.pairingId);
    await vi.waitFor(() => expect(h.save).toHaveBeenCalled());
    const latest = await h.bridge.beginPairing();
    gate.resolve(); await confirm;
    expect(h.bridge.status.pairing).toMatchObject({ pairingId: latest.pairing!.pairingId, readyToConfirm: false });
  });

  it("acknowledges a native disable command after saving disabled state without sending more snapshots", async () => {
    const h = await harness(); const peerId = await h.connect(nativeId);
    const challenge = h.relay.sent.find((x: any) => x.peerId === peerId && x.payload.type === "native.authentication.challenge").payload.challenge;
    h.secure(peerId, { type: "native.authentication.response", challenge });
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.payload.type === "session.ready")).toBe(true));
    const requestId = crypto.randomUUID();
    h.secure(peerId, { type: "mobile.command", command: { type: "remote.disable", requestId } });
    await vi.waitFor(() => expect(h.relay.sent.some((x: any) => x.payload.event?.type === "command.result" && x.payload.event.requestId === requestId && x.payload.event.ok)).toBe(true));
    expect(h.stored().enabled).toBe(false);
  });

});
