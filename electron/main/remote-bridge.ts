import { EventEmitter } from "node:events";
import { createHash, randomInt } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppServerSupervisor } from "./app-server-supervisor.js";
import { normalizeRelayUrl, type ConnectionState, type ProtocolEvent, type RemoteAccessStatus, type RemotePairingInfo, type RemoteSettings } from "../shared/contracts.js";
import {
  mobileCommandSchema,
  pairingHelloSchema,
  peerPayloadSchema,
  sessionHelloProof,
  sessionWelcomeProof,
  uiDocumentProof,
  type DesktopEvent,
  type MobileCommand,
  type MobileItem
} from "../../packages/remote-protocol/src/index.js";
import { RemoteCredentialStore, type RemoteCredentialState, type RemoteMobileDevice } from "./remote-credential-store.js";
import { deriveSessionKey, generateP256KeyPair, SecureSession, signP256, verifyP256 } from "./remote-crypto.js";
import { RemotePasskeyService } from "./remote-passkey.js";
import { RelayConnection, type RelayConnectionEvent } from "./relay-connection.js";
import { RemoteAuditLog } from "./remote-audit-log.js";
import { RemoteProjector, sanitizeRemoteActivityText } from "./remote-projector.js";
import { ServerRequestCoordinator } from "./server-request-coordinator.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { ThreadSubscriptionRegistry } from "./thread-subscription-registry.js";
import { assertRemoteCommandAuthorized } from "./remote-command-authorization.js";
import { RemoteTaskCatalog } from "./remote-task-catalog.js";
import { loadRemoteThread } from "./remote-history.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const MAX_MOBILE_DOCUMENT_BYTES = 2 * 1024 * 1024;
const REMOTE_SAFE_SETTINGS = { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace" } as const;

type PairingState = {
  pairingId: string;
  secret: string;
  hash: string;
  code: string;
  expiresAt: number;
  readyToConfirm: boolean;
  peerId?: string;
};

type PeerState = {
  peerId: string;
  mode: "device" | "pairing";
  deviceId?: string;
  dataQueue: SerialTaskQueue;
  secure?: SecureSession;
  authenticated: boolean;
  registrationChallenge?: string;
  pairing?: PairingState;
  authenticationChallenge?: string;
  pendingDevice?: RemoteMobileDevice;
};

const pairingStartSchema = z.object({
  type: z.literal("pairing.start"),
  pairingSecret: z.string().min(32).max(512),
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1).max(200),
  authentication: z.enum(["passkey", "native"]).default("passkey"),
  signingPublicKey: z.object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() }).passthrough(),
  agreementPublicKey: z.object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() }).passthrough()
});

export class RemoteBridge extends EventEmitter {
  readonly #supervisor: AppServerSupervisor;
  readonly #taskCatalog: RemoteTaskCatalog;
  readonly #credentialStore: RemoteCredentialStore;
  readonly #auditLog: RemoteAuditLog;
  readonly #projector = new RemoteProjector();
  readonly #coordinator: ServerRequestCoordinator;
  readonly #subscriptions: ThreadSubscriptionRegistry;
  readonly #requestResults = new Map<string, { at: number; event: DesktopEvent }>();
  readonly #pendingProjected = new Map<string, { threadId: string; item: MobileItem }>();
  readonly #commandQueue = new SerialTaskQueue();
  readonly #credentialQueue = new SerialTaskQueue();
  readonly #pendingRevokedDeviceIds = new Set<string>();
  #refreshTimer: NodeJS.Timeout | null = null;
  #refreshPending = false;
  readonly #remoteTurnIds = new Set<string>();
  readonly #peers = new Map<string, PeerState>();
  #projectTimer: NodeJS.Timeout | null = null;
  #credentials: RemoteCredentialState | null = null;
  #connection: RelayConnection | null = null;
  #passkeys: RemotePasskeyService | null = null;
  #pairing: PairingState | null = null;
  #policyRevision = 0;
  #seq = 0;
  #mobileDocument: string | null = null;
  #ownsRemoteAccess = true;
  #sessionDefaults: { cwd: string | null; model: string | null } = { cwd: null, model: null };
  #status: RemoteAccessStatus = { enabled: false, phase: "disabled", message: "远程访问已关闭", relayUrl: "", paired: false, pairing: null, passkeys: [] };

  constructor(supervisor: AppServerSupervisor, credentialStore: RemoteCredentialStore, auditLog: RemoteAuditLog) {
    super();
    this.#supervisor = supervisor;
    this.#taskCatalog = new RemoteTaskCatalog((method, params) => supervisor.call(method, params, 2_000));
    this.#credentialStore = credentialStore;
    this.#auditLog = auditLog;
    this.#coordinator = new ServerRequestCoordinator(supervisor);
    this.#subscriptions = new ThreadSubscriptionRegistry(supervisor);
  }

  get status(): RemoteAccessStatus { return structuredClone(this.#status); }

  updateAppearance(appearance: { theme: "system" | "dark" | "light"; accentColor: string }): void {
    this.#projector.setAppearance(appearance);
    if (this.#status.phase === "connected") this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
  }

  async initialize(ownsRemoteAccess = true): Promise<void> {
    this.#ownsRemoteAccess = ownsRemoteAccess;
    this.#credentials = await this.#credentialStore.load();
    this.#projector.setConnection(this.#supervisor.state);
    if (!ownsRemoteAccess) {
      this.#showStandbyStatus();
      return;
    }
    if (this.#credentials?.enabled) this.#startConnection();
    else if (this.#credentials) this.#syncCredentialStatus();
  }

  async updateSettings(settings: RemoteSettings): Promise<RemoteAccessStatus> {
    this.#assertOwnership();
    for (const peer of this.#peers.values()) peer.authenticated = false;
    this.#peers.clear();
    this.#pairing = null;
    return this.#credentialQueue.enqueue(async () => {
      this.#assertOwnership();
      let credentials = this.#credentials;
      if (!credentials) credentials = this.#credentialStore.createIdentity();
      credentials = { ...credentials, enabled: settings.enabled, relayUrl: normalizeRelayUrl(settings.relayUrl) };
      await this.#credentialStore.save(credentials);
      this.#credentials = credentials;
      this.#connection?.stop();
      this.#connection = null;
      this.#peers.clear();
      this.#remoteTurnIds.clear();
      this.#pairing = null;
      this.#passkeys = credentials.relayUrl ? new RemotePasskeyService(credentials.relayUrl) : null;
      if (credentials.enabled) this.#startConnection();
      else {
        await this.#subscriptions.releaseOwner("remote");
        this.#projector.clearActiveThread();
        this.#coordinator.clear();
        this.#updateStatus({ enabled: false, phase: "disabled", message: "远程访问已关闭", relayUrl: credentials.relayUrl, pairing: null });
        this.#syncCredentialStatus();
      }
      return this.status;
    });
  }

  async beginPairing(): Promise<RemoteAccessStatus> {
    this.#assertOwnership();
    const credentials = this.#credentials;
    if (!credentials?.enabled || !credentials.relayUrl || !this.#connection) throw new Error("请先填写中转服务地址并启用远程访问。");
    const material = RemoteCredentialStore.createPairingSecret();
    const pairingId = crypto.randomUUID();
    const expiresAt = Date.now() + 5 * 60_000;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#pairing = { pairingId, ...material, code, expiresAt, readyToConfirm: false };
    this.#sendPolicy();
    const pairingPayload = Buffer.from(JSON.stringify({
      version: 1,
      relayOrigin: credentials.relayUrl,
      channelId: credentials.channelId,
      pairingId,
      pairingSecret: material.secret,
      desktopSigningPublicKey: credentials.signingPublicKey,
      desktopAgreementPublicKey: credentials.agreementPublicKey,
      expiresAt
    })).toString("base64url");
    const pairingUrl = new URL(credentials.relayUrl);
    pairingUrl.pathname = `${pairingUrl.pathname.replace(/\/+$/, "")}/`;
    pairingUrl.search = "";
    pairingUrl.hash = new URLSearchParams({ pair: pairingPayload }).toString();
    this.#updatePairingStatus(pairingUrl.toString());
    return this.status;
  }

  async confirmPairing(pairingId: string): Promise<void> {
    return this.#credentialQueue.enqueue(async () => {
      this.#assertOwnership();
      const pairing = this.#pairing;
      if (!pairing || pairing.pairingId !== pairingId || pairing.expiresAt < Date.now()) throw new Error("配对请求已过期，请重新生成二维码。");
      if (!pairing.readyToConfirm || !pairing.peerId) throw new Error("请先在手机上完成配对登记。");
      const peer = this.#peers.get(pairing.peerId);
      if (!peer?.secure || !peer.pendingDevice || !this.#credentials?.enabled || peer.pairing !== pairing) throw new Error("手机配对连接已经断开，请重新生成二维码。");
      const devices = this.#credentials.devices.filter((device) => device.id !== peer.pendingDevice!.id && (!peer.pendingDevice!.passkey || device.passkey?.id !== peer.pendingDevice!.passkey.id));
      const updatedCredentials = { ...this.#credentials, devices: [...devices, peer.pendingDevice] };
      await this.#credentialStore.save(updatedCredentials);
      this.#credentials = updatedCredentials;
      if (this.#peers.get(peer.peerId) === peer && this.#pairing === pairing && pairing.expiresAt >= Date.now()) this.#sendSecure(peer, { type: "pairing.completed", deviceId: peer.pendingDevice.id });
      const completesCurrentPairing = this.#pairing === pairing;
      if (completesCurrentPairing) this.#pairing = null;
      this.#sendPolicy();
      this.#syncCredentialStatus();
      if (completesCurrentPairing) this.#updateStatus({ pairing: null, phase: "connected", message: "手机已绑定" });
      else this.#updatePairingStatus();
      await this.#auditLog.write("device.paired", { deviceId: peer.pendingDevice.id, deviceName: peer.pendingDevice.name }).catch(() => undefined);
    });
  }

  async revokePasskey(credentialId: string): Promise<void> {
    this.#assertOwnership();
    const revokedDevice = this.#credentials?.devices.find((device) => (device.passkey?.id ?? device.id) === credentialId);
    if (revokedDevice) this.#pendingRevokedDeviceIds.add(revokedDevice.id);
    this.#sendPolicy();
    for (const [peerId, peer] of this.#peers) if (peer.deviceId === revokedDevice?.id && revokedDevice) { peer.authenticated = false; this.#peers.delete(peerId); }
    return this.#credentialQueue.enqueue(async () => {
      this.#assertOwnership();
      if (!this.#credentials) return;
      const now = Date.now();
      const target = this.#credentials.devices.find((device) => (device.passkey?.id ?? device.id) === credentialId && device.revokedAt === null);
      if (!target) return;
      const updatedCredentials = { ...this.#credentials, devices: this.#credentials.devices.map((device) => device.id === target.id ? { ...device, revokedAt: now } : device) };
      await this.#credentialStore.save(updatedCredentials);
      this.#credentials = updatedCredentials;
      this.#pendingRevokedDeviceIds.delete(target.id);
      for (const [peerId, peer] of this.#peers) if (peer.deviceId === target.id) { peer.authenticated = false; this.#peers.delete(peerId); }
      this.#sendPolicy();
      this.#syncCredentialStatus();
      await this.#auditLog.write("device.revoked", { deviceId: target.id, deviceName: target.name }).catch(() => undefined);
    });
  }

  logoutAllMobiles(): void {
    this.#assertOwnership();
    this.#peers.clear();
    this.#connection?.reconnect();
    this.#updateStatus({ phase: "connecting", message: "已退出所有手机，正在重新连接…" });
  }

  acquireDesktopThread(threadId: string): void { this.#subscriptions.acquire(threadId, "desktop"); }
  releaseDesktopThread(threadId: string): Promise<boolean> { return this.#subscriptions.release(threadId, "desktop"); }
  handleDesktopResponse(id: string | number): void { this.#coordinator.remove(id); }
  updateSessionDefaults(defaults: { cwd: string | null; model: string | null }): void { this.#sessionDefaults = defaults; }

  async stop(): Promise<void> {
    if (this.#refreshTimer) clearInterval(this.#refreshTimer);
    this.#refreshTimer = null;
    if (this.#projectTimer) clearTimeout(this.#projectTimer);
    this.#projectTimer = null;
    this.#pendingProjected.clear();
    this.#peers.clear();
    this.#connection?.stop();
    this.#connection = null;
    this.#coordinator.clear();
    this.#remoteTurnIds.clear();
    this.#subscriptions.clearOwner("remote");
  }

  handleConnectionState(state: ConnectionState): void {
    this.#projector.setConnection(state);
    if (this.#status.phase === "connected") this.#sendEvent({ type: "device.status", seq: this.#nextSeq(), online: true, codexState: this.#projector.snapshot().codexState, message: state.message });
  }

  handleProtocolEvent(event: ProtocolEvent): void {
    if (!this.#ownsRemoteAccess || !this.#credentials?.enabled) return;
    if (event.kind === "server-request") {
      const envelope = record(event.payload);
      const id = envelope.id;
      if (typeof id !== "string" && typeof id !== "number") return;
      const params = record(envelope.params);
      const approval = this.#coordinator.observe(event.generation, id, text(envelope.method), params);
      if (!approval) {
        this.#sendEvent({ type: "desktop.required", seq: this.#nextSeq(), message: "有一项操作需要在桌面端处理。" });
        return;
      }
      const command = Array.isArray(params.command) ? params.command.join(" ") : text(params.command);
      const reason = text(params.reason) || text(params.message) || text(params.url) || text(params.toolName);
      const summary = [command ? `命令：${sanitizeRemoteActivityText(command, text(params.cwd), 2_800)}` : "", reason ? sanitizeRemoteActivityText(reason, text(params.cwd), 1_100) : ""].filter(Boolean).join("\n\n") || "Codex 请求执行一项操作";
      const approvalItem: Extract<MobileItem, { kind: "approval" }> = { id: String(id), kind: "approval", title: text(envelope.method).includes("mcp") ? "MCP 操作确认" : "命令执行确认", summary, version: approval.version, decisions: ["accept", "decline"], ...(approval.choice ? { choices: approval.choice.values } : {}) };
      this.#projector.addApproval(approval.threadId, approvalItem);
      this.#sendEvent({
        type: "approval.request",
        seq: this.#nextSeq(),
        threadId: approval.threadId || this.#projector.activeThreadId || "unknown",
        approval: approvalItem
      });
      return;
    }
    const projected = this.#projector.applyProtocolEvent(event);
    const envelope = record(event.payload);
    const method = text(envelope.method);
    if (projected) {
      const key = `${projected.threadId}:${projected.item.id}`;
      if (method === "item/agentMessage/delta") this.#queueProjected(key, projected);
      else {
        this.#pendingProjected.delete(key);
        this.#sendEvent({ type: "item.upsert", seq: this.#nextSeq(), ...projected });
      }
    }
    if (method === "turn/started" || method === "turn/completed") {
      const threadId = text(record(envelope.params).threadId);
      if (method === "turn/completed") { this.#remoteTurnIds.delete(text(record(record(envelope.params).turn).id)); this.#coordinator.removeThread(threadId);
        if (threadId && threadId !== this.#projector.activeThreadId) void this.#subscriptions.release(threadId, "remote").catch(() => undefined);
      }
      if (threadId) this.#sendEvent({ type: "turn.status", seq: this.#nextSeq(), threadId, status: method === "turn/started" ? "running" : text(record(record(envelope.params).turn).status) === "failed" ? "failed" : "idle" });
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
    }
    if (method === "thread/status/changed") this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
    if (method === "serverRequest/resolved") {
      const id = record(envelope.params).requestId;
      if (typeof id === "string" || typeof id === "number") { this.#coordinator.remove(id); this.#projector.removeApproval(id); }
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
    }
  }

  #startConnection(): void {
    const credentials = this.#credentials;
    if (!credentials?.enabled || !credentials.relayUrl) return;
    this.#passkeys = new RemotePasskeyService(credentials.relayUrl);
    const connection = new RelayConnection(credentials, () => this.#credentialStore.revealSigningPrivateKey(credentials));
    this.#connection = connection;
    connection.on("event", (event: RelayConnectionEvent) => { void this.#handleRelayEvent(event); });
    this.#updateStatus({ enabled: true, phase: "connecting", message: "正在连接中转服务…", relayUrl: credentials.relayUrl });
    this.#syncCredentialStatus();
    connection.start();
    if (!this.#refreshTimer) this.#refreshTimer = setInterval(() => {
      if (this.#refreshPending || !this.#credentials?.enabled || ![...this.#peers.values()].some((peer) => peer.authenticated)) return;
      this.#refreshPending = true;
      void this.#commandQueue.enqueue(async () => {
        await this.#refreshThreads();
        this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      }).catch(() => undefined).finally(() => { this.#refreshPending = false; });
    }, 5_000);
  }

  async #handleRelayEvent(event: RelayConnectionEvent): Promise<void> {
    if (event.type === "state") {
      this.#updateStatus({ phase: event.phase, message: event.message });
      return;
    }
    if (event.type === "attached") {
      this.#peers.clear();
      this.#sendPolicy();
      this.#updateStatus({ phase: this.#pairing ? "pairing" : "connected", message: this.#pairing ? "等待手机完成绑定" : "已连接中转服务" });
      return;
    }
    if (event.type === "peerOnline") {
      this.#peers.set(event.peerId, { peerId: event.peerId, mode: event.mode, deviceId: event.deviceId, dataQueue: new SerialTaskQueue(), authenticated: false });
      return;
    }
    if (event.type === "peerOffline") {
      this.#peers.delete(event.peerId);
      if (this.#pairing?.peerId === event.peerId && !this.#pairing.readyToConfirm) this.#updateStatus({ message: "手机连接已断开，请重新扫码" });
      return;
    }
    if (event.type === "data") {
      const peer = this.#peers.get(event.peerId);
      if (!peer) return;
      await peer.dataQueue.enqueue(async () => {
        if (this.#peers.get(event.peerId) !== peer) return;
        await this.#handlePeerData(event.peerId, event.payload);
      });
    }
  }

  async #handlePeerData(peerId: string, raw: string): Promise<void> {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    try {
      const payload = peerPayloadSchema.parse(JSON.parse(raw));
      if (payload.type === "pairing.hello") {
        await this.#handlePairingHello(peer, payload);
        return;
      }
      if (payload.type === "session.hello") {
        await this.#handleSessionHello(peer, payload);
        return;
      }
      if (payload.type !== "secure" || !peer.secure) throw new Error("尚未建立安全连接。");
      await this.#handleSecurePayload(peer, peer.secure.decrypt(payload));
    } catch (error) {
      await this.#auditLog.write("peer.rejected", { deviceId: peer.deviceId ?? null, reason: error instanceof Error ? error.message.slice(0, 500) : "远程消息无效" }).catch(() => undefined);
      if (peer.secure) {
        try { this.#sendSecure(peer, { type: "error", message: error instanceof Error ? error.message : "远程消息无效。" }); }
        catch { /* The peer may have disconnected while the request was being processed. */ }
      }
    }
  }

  #assertPairing(peer: PeerState, pairing: PairingState | null | undefined): asserts pairing is PairingState {
    if (!pairing || this.#pairing !== pairing || peer.pairing !== pairing || this.#peers.get(peer.peerId) !== peer || peer.mode !== "pairing" || pairing.peerId !== peer.peerId || pairing.expiresAt < Date.now() || !this.#credentials?.enabled) throw new Error("配对请求已过期，请重新生成二维码。");
  }

  #assertAuthenticatedDevice(peer: PeerState, authentication: "native" | "passkey"): RemoteMobileDevice {
    const device = this.#credentials?.devices.find((candidate) => candidate.id === peer.deviceId && candidate.revokedAt === null && !this.#pendingRevokedDeviceIds.has(candidate.id));
    if (!this.#credentials?.enabled || this.#peers.get(peer.peerId) !== peer || peer.mode !== "device" || !device || (device.authentication ?? "passkey") !== authentication) throw new Error("设备连接或登录授权已失效。");
    return device;
  }

  async #handlePairingHello(peer: PeerState, raw: unknown): Promise<void> {
    const hello = pairingHelloSchema.parse(raw);
    const pairing = this.#pairing;
    const credentials = this.#credentials;
    if (peer.pairing || this.#peers.get(peer.peerId) !== peer || peer.mode !== "pairing" || !pairing || !credentials?.enabled || pairing.peerId || hello.pairingId !== pairing.pairingId || pairing.expiresAt < Date.now()) throw new Error("配对请求已过期。");
    const context = `pairing\n${credentials.channelId}\n${pairing.pairingId}\n${hello.sessionId}`;
    const key = deriveSessionKey(this.#credentialStore.revealAgreementPrivateKey(credentials), hello.mobileAgreementPublicKey, context);
    peer.secure = new SecureSession(hello.sessionId, key);
    const start = pairingStartSchema.parse(peer.secure.decrypt(hello.envelope));
    if (start.pairingSecret !== pairing.secret) throw new Error("配对信息不正确。");
    peer.pendingDevice = {
      id: start.deviceId,
      name: start.deviceName,
      signingPublicKey: start.signingPublicKey,
      agreementPublicKey: start.agreementPublicKey,
      authentication: start.authentication,
      ...(start.authentication === "passkey" ? { passkey: { id: "pending", publicKey: "pending", counter: 0, transports: [], name: start.deviceName, createdAt: Date.now(), lastUsedAt: null } } : {}),
      createdAt: Date.now(),
      revokedAt: null
    };
    pairing.peerId = peer.peerId;
    pairing.readyToConfirm = false;
    peer.pairing = pairing;
    if (start.authentication === "native") {
      pairing.readyToConfirm = true;
      this.#sendSecure(peer, { type: "pairing.awaiting-confirmation", code: pairing.code });
      this.#updatePairingStatus();
      this.#updateStatus({ message: "原生手机已登记，请核对确认码并确认设备绑定" });
      return;
    }
    const options = await this.#passkeys!.registrationOptions(start.deviceId, credentials.devices);
    this.#assertPairing(peer, pairing);
    peer.registrationChallenge = options.challenge;
    this.#sendSecure(peer, { type: "passkey.registration.options", options, code: pairing.code });
  }

  async #handleSessionHello(peer: PeerState, raw: unknown): Promise<void> {
    const hello = z.object({
      type: z.literal("session.hello"), sessionId: z.string().uuid(), deviceId: z.string().uuid(),
      mobileEphemeralPublicKey: z.object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() }).passthrough(),
      timestamp: z.number().int().positive(), signature: z.string()
    }).parse(raw);
    const credentials = this.#credentials;
    const device = credentials?.devices.find((candidate) => candidate.id === hello.deviceId && candidate.revokedAt === null && !this.#pendingRevokedDeviceIds.has(candidate.id));
    if (this.#peers.get(peer.peerId) !== peer || peer.mode !== "device" || peer.deviceId !== hello.deviceId || !credentials?.enabled || !device || Math.abs(Date.now() - hello.timestamp) > 30_000) throw new Error("设备未获准访问。");
    const proof = sessionHelloProof(credentials.channelId, hello.sessionId, hello.deviceId, hello.mobileEphemeralPublicKey, hello.timestamp);
    if (!verifyP256(device.signingPublicKey, proof, hello.signature)) throw new Error("设备身份验证失败。");
    peer.authenticated = false;
    peer.authenticationChallenge = undefined;
    const ephemeral = generateP256KeyPair();
    const context = `session\n${credentials.channelId}\n${hello.sessionId}\n${hello.deviceId}`;
    peer.secure = new SecureSession(hello.sessionId, deriveSessionKey(ephemeral.privateKey, hello.mobileEphemeralPublicKey, context));
    const timestamp = Date.now();
    const welcomeProof = sessionWelcomeProof(credentials.channelId, hello.sessionId, hello.mobileEphemeralPublicKey, ephemeral.publicKey, timestamp);
    this.#connection?.send(peer.peerId, { type: "session.welcome", sessionId: hello.sessionId, desktopEphemeralPublicKey: ephemeral.publicKey, timestamp, signature: signP256(this.#credentialStore.revealSigningPrivateKey(credentials), welcomeProof) });
    if (device.authentication === "native") {
      // A fresh ECDH encrypted acknowledgement proves possession of this session key.
      peer.authenticationChallenge = crypto.randomUUID();
      this.#sendSecure(peer, { type: "native.authentication.challenge", challenge: peer.authenticationChallenge });
      return;
    }
    const options = await this.#passkeys!.authenticationOptions(device);
    this.#assertAuthenticatedDevice(peer, "passkey");
    peer.authenticationChallenge = options.challenge;
    this.#sendSecure(peer, { type: "passkey.authentication.options", options });
  }

  async #handleSecurePayload(peer: PeerState, raw: unknown): Promise<void> {
    const payload = record(raw);
    if (payload.type === "native.authentication.response") {
      const credentials = this.#credentials;
      const device = credentials?.devices.find((candidate) => candidate.id === peer.deviceId && candidate.revokedAt === null && !this.#pendingRevokedDeviceIds.has(candidate.id) && candidate.authentication === "native");
      if (!credentials?.enabled || this.#peers.get(peer.peerId) !== peer || !device || !peer.authenticationChallenge || payload.challenge !== peer.authenticationChallenge) throw new Error("原生设备验证请求已失效。");
      peer.authenticationChallenge = undefined;
      // Last-use is informational; do not race a credential save against device revocation.
      peer.authenticated = true;
      this.#syncCredentialStatus();
      await this.#auditLog.write("native.authenticated", { deviceId: device.id }).catch(() => undefined);
      this.#assertAuthenticatedDevice(peer, "native");
      this.#sendSecure(peer, { type: "session.ready" });
      await this.#refreshThreads();
      await this.#refreshModels();
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() }, peer.peerId);
      return;
    }
    if (payload.type === "passkey.registration.response") {
      const pairing = peer.pairing;
      this.#assertPairing(peer, pairing);
      const pendingDevice = peer.pendingDevice;
      const challenge = peer.registrationChallenge;
      if (!challenge || !pendingDevice || pendingDevice.authentication !== "passkey") throw new Error("Passkey 登记已经过期。");
      const passkey = await this.#passkeys!.verifyRegistration(challenge, payload.response as RegistrationResponseJSON, text(payload.name) || pendingDevice.name);
      this.#assertPairing(peer, pairing);
      if (peer.pendingDevice !== pendingDevice || peer.registrationChallenge !== challenge || pendingDevice.authentication !== "passkey") throw new Error("Passkey 登记已经过期。");
      peer.registrationChallenge = undefined;
      peer.pendingDevice = { ...pendingDevice, passkey };
      pairing.readyToConfirm = true;
      this.#sendSecure(peer, { type: "pairing.awaiting-confirmation", code: pairing.code });
      this.#updatePairingStatus();
      this.#updateStatus({ message: "手机已登记，请核对确认码" });
      return;
    }
    if (payload.type === "passkey.authentication.response") {
      const device = this.#assertAuthenticatedDevice(peer, "passkey");
      const challenge = peer.authenticationChallenge;
      if (!challenge || !device.passkey) throw new Error("登录请求已经过期。");
      const counter = await this.#passkeys!.verifyAuthentication(challenge, payload.response as AuthenticationResponseJSON, device);
      await this.#credentialQueue.enqueue(async () => {
        const currentDevice = this.#assertAuthenticatedDevice(peer, "passkey");
        if (peer.authenticationChallenge !== challenge || currentDevice.passkey?.id !== device.passkey!.id) throw new Error("登录请求已经过期。");
        const latest = this.#credentials!;
        const updatedCredentials = { ...latest, devices: latest.devices.map((candidate) => candidate.id === currentDevice.id ? { ...candidate, passkey: { ...candidate.passkey!, counter: Math.max(candidate.passkey!.counter, counter), lastUsedAt: Date.now() } } : candidate) };
        await this.#credentialStore.save(updatedCredentials);
        this.#credentials = updatedCredentials;
        this.#assertAuthenticatedDevice(peer, "passkey");
        if (peer.authenticationChallenge !== challenge) throw new Error("登录请求已经过期。");
        peer.authenticationChallenge = undefined;
        peer.authenticated = true;
      });
      await this.#auditLog.write("passkey.authenticated", { deviceId: device.id, deviceName: device.name }).catch(() => undefined);
      this.#assertAuthenticatedDevice(peer, "passkey");
      this.#syncCredentialStatus();
      this.#sendSecure(peer, { type: "session.ready" });
      await this.#sendMobileDocument(peer);
      await this.#refreshThreads();
      await this.#refreshModels();
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() }, peer.peerId);
      return;
    }
    if (payload.type === "mobile.command") {
      if (!peer.authenticated) throw new Error("请先使用 Passkey 登录。");
      await this.#commandQueue.enqueue(() => this.#handleCommand(peer, payload.command));
      return;
    }
    if (payload.type === "ui.ready" && peer.authenticated) {
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() }, peer.peerId);
      return;
    }
    throw new Error("手机请求不受支持。");
  }

  async #handleCommand(peer: PeerState, raw: unknown): Promise<void> {
    let command: MobileCommand;
    let requestId = "";
    const guard = () => assertRemoteCommandAuthorized({
      currentPeer: this.#peers.get(peer.peerId) === peer,
      authenticated: peer.authenticated,
      enabled: this.#credentials?.enabled === true,
      ownsRemoteAccess: this.#ownsRemoteAccess,
      deviceAuthorized: Boolean(peer.deviceId && this.#credentials?.devices.some((device) => device.id === peer.deviceId && device.revokedAt === null && !this.#pendingRevokedDeviceIds.has(device.id)))
    });
    try {
      guard();
      command = mobileCommandSchema.parse(raw);
      requestId = command.requestId;
      const cached = this.#requestResults.get(requestId);
      if (cached && Date.now() - cached.at < 10 * 60_000) {
        this.#sendEvent(cached.event, peer.peerId);
        return;
      }
      await this.#execute(command, guard, peer.peerId);
      this.#rememberResult(requestId, true, "操作已完成", peer.peerId);
      if (command.type === "remote.disable") await this.#finishRemoteDisable();
    } catch (error) {
      if (requestId) this.#rememberResult(requestId, false, error instanceof Error ? error.message : String(error), peer.peerId);
    }
  }

  async #execute(command: MobileCommand, guard: () => void, peerId: string): Promise<void> {
    guard();
    const call = async (method: string, params: unknown): Promise<unknown> => {
      guard();
      const result = await this.#supervisor.call(method, params);
      guard();
      return result;
    };
    if (command.type === "snapshot.get") {
      await this.#refreshThreads();
      guard();
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      return;
    }
    if (command.type === "thread.list" && command.limit !== undefined) {
      const response = record(await call("thread/list", { limit: command.limit, cursor: command.cursor ?? null, sortKey: "updated_at", sortDirection: "desc", searchTerm: command.searchTerm || null, cwd: null }));
      const page = new RemoteProjector().setThreads(await this.#taskCatalog.enrich(Array.isArray(response.data) ? response.data : []));
      guard();
      this.#sendEvent({ type: "thread.page", seq: this.#nextSeq(), requestId: command.requestId, threads: page, nextCursor: text(response.nextCursor) || null }, peerId);
      return;
    }
    if (command.type === "thread.list") {
      const threads = await this.#refreshThreads();
      guard();
      for (const thread of threads) this.#sendEvent({ type: "thread.summary", seq: this.#nextSeq(), thread });
      return;
    }
    if (command.type === "turn.interrupt" || command.type === "thread.configure" || command.type === "thread.fork") {
      if (command.threadId !== this.#projector.activeThreadId) throw new Error("会话已切换，请重新打开目标会话。");
      const current = record(record(await call("thread/read", { threadId: command.threadId, includeTurns: true })).thread);
      const currentTurn = (Array.isArray(current.turns) ? current.turns : []).map(record).find((turn) => turn.status === "inProgress");
      if (command.type === "turn.interrupt") {
        if (!currentTurn || text(currentTurn.id) !== command.turnId) throw new Error("任务已结束或发生变化，请刷新后重试。");
        if (command.turnId !== this.#projector.activeTurnId) throw new Error("任务已结束或发生变化，请刷新后重试。");
        await call("turn/interrupt", { threadId: command.threadId, turnId: command.turnId });
        return;
      }
      if (currentTurn || record(current.status).type === "active" || this.#projector.activeTurnId || ["running", "waiting"].includes(this.#projector.snapshot().turnStatus)) throw new Error("请等待当前任务结束后操作。");
      if (command.type === "thread.configure") {
        await this.#refreshModels();
        guard();
        const model = this.#projector.snapshot().models.find((entry) => entry.id === command.model);
        if (!model || !model.efforts.includes(command.effort)) throw new Error("模型或推理强度不受当前 Codex 支持。");
        await call("thread/settings/update", { threadId: command.threadId, model: command.model, effort: command.effort });
        this.#projector.setConfiguration(command.model, command.effort);
      } else {
        const response = record(await call("thread/fork", { threadId: command.threadId, excludeTurns: false, deferGoalContinuation: true }));
        const thread = record(response.thread);
        const threadId = text(thread.id);
        if (!threadId || threadId === command.threadId) throw new Error("Codex 未返回分叉会话标识。");
        this.#subscriptions.acquire(threadId, "remote");
        this.#projector.setActiveThread(thread);
        this.#projector.setConfiguration(text(response.model) || null, text(response.reasoningEffort) || null);
        try {
          await this.#subscriptions.release(command.threadId, "remote");
          guard();
          if (command.name) {
            await call("thread/name/set", { threadId, name: command.name });
            this.#projector.setActiveThread({ ...thread, name: command.name });
          }
          await this.#refreshThreads();
          guard();
        } catch (error) {
          this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
          throw new Error(`分叉会话 ${threadId} 已创建，但命名或刷新未完成：${error instanceof Error ? error.message : String(error)}。请先检查该会话，不要重复分叉。`);
        }
      }
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      return;
    }
    if (command.type === "thread.open") {
      const previous = this.#projector.activeThreadId;
      const { response, thread } = await loadRemoteThread((method, params) => call(method, params), command.threadId);
      if (previous && previous !== command.threadId && !this.#projector.activeTurnId) await this.#subscriptions.release(previous, "remote");
      guard();
      this.#subscriptions.acquire(command.threadId, "remote");
      this.#projector.setActiveThread({ ...thread, cwd: text(response.cwd) || text(thread.cwd) });
      this.#projector.setConfiguration(text(response.model) || null, text(response.reasoningEffort) || null);
      await this.#refreshModels();
      guard();
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      return;
    }
    if (command.type === "thread.new") {
      const previous = this.#projector.activeThreadId;
      const cwd = command.cwd ?? this.#sessionDefaults.cwd;
      let model = command.model ?? this.#sessionDefaults.model;
      if (command.model || command.effort) {
        const defaultModel = await this.#refreshModels();
        guard();
        model ??= defaultModel;
        const supported = this.#projector.snapshot().models.find((entry) => entry.id === model);
        if (!supported || (command.effort && !supported.efforts.includes(command.effort))) throw new Error("模型或推理强度不受当前 Codex 支持。");
      }
      const response = record(await call("thread/start", { cwd, model, ephemeral: false, ...REMOTE_SAFE_SETTINGS }));
      const thread = record(response.thread);
      const threadId = text(thread.id);
      if (!threadId) throw new Error("Codex 未返回新会话标识。");
      const releasePrevious = previous && previous !== threadId && !this.#projector.activeTurnId;
      this.#subscriptions.acquire(threadId, "remote");
      this.#projector.setActiveThread({ ...thread, cwd: text(thread.cwd) || cwd || "" });
      this.#projector.setConfiguration(text(response.model) || null, text(response.reasoningEffort) || null);
      let sending = false;
      try {
        if (releasePrevious) await this.#subscriptions.release(previous, "remote");
        guard();
        const actualModel = text(response.model) || model;
        if (command.effort) {
          const supported = this.#projector.snapshot().models.find((entry) => entry.id === actualModel);
          if (!supported?.efforts.includes(command.effort)) throw new Error("新会话实际使用的模型不支持所选推理强度。");
          await call("thread/settings/update", { threadId, effort: command.effort });
          this.#projector.setConfiguration(actualModel, command.effort);
        }
        if (!command.model && !command.effort) await this.#refreshModels();
        guard();
        await this.#refreshThreads();
        guard();
        if (command.text) {
          sending = true;
          const turnResponse = record(await call("turn/start", { threadId, clientUserMessageId: command.requestId, input: [{ type: "text", text: command.text, text_elements: [] }] }));
          const turnId = text(record(turnResponse.turn).id);
          if (!turnId) throw new Error("Codex 未返回初始任务标识。");
          this.#remoteTurnIds.add(turnId);
          this.#projector.setActiveTurn(turnId);
        }
      } catch (error) {
        this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
        const delivery = command.text ? sending ? "初始消息发送结果未确认" : "初始消息尚未发送" : "配置或刷新未完成";
        throw new Error(`会话 ${threadId} 已创建，${delivery}：${error instanceof Error ? error.message : String(error)}。请先检查该会话，不要重复新建或自动重发。`);
      }
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      return;
    }
    if (command.type === "turn.send") {
      const threadId = this.#projector.activeThreadId;
      if (!threadId) throw new Error("请先选择或新建会话。");
      if (command.threadId !== threadId) throw new Error("会话已切换，请重新打开目标会话后发送。");
      const input = [{ type: "text", text: command.text, text_elements: [] }];
      if (this.#projector.activeTurnId) {
        if (!this.#remoteTurnIds.has(this.#projector.activeTurnId)) throw new Error("当前任务正在桌面端运行，完成后再发送。");
        await call("turn/steer", { threadId, expectedTurnId: this.#projector.activeTurnId, clientUserMessageId: crypto.randomUUID(), input });
      }
      else {
        const response = record(await call("turn/start", { threadId, clientUserMessageId: crypto.randomUUID(), input }));
        const turnId = text(record(response.turn).id);
        if (turnId) this.#remoteTurnIds.add(turnId);
        this.#projector.setActiveTurn(turnId);
      }
      this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
      return;
    }
    if (command.type === "remote.disable") {
      await this.#credentialQueue.enqueue(async () => {
        guard();
        if (!this.#credentials) throw new Error("远程访问尚未启用。");
        const credentials = { ...this.#credentials, enabled: false };
        await this.#credentialStore.save(credentials);
        this.#credentials = credentials;
      });
      await this.#auditLog.write("remote.disabled", { source: "mobile" }).catch(() => undefined);
      return;
    }
    guard();
    this.#coordinator.resolve(command.approvalId, command.version, command.decision, command.selection, command.threadId);
    this.#projector.removeApproval(command.approvalId);
    this.#sendEvent({ type: "snapshot", seq: this.#nextSeq(), snapshot: this.#projector.snapshot() });
    await this.#auditLog.write("approval.resolved", { approvalId: command.approvalId, decision: command.decision }).catch(() => undefined);
  }

  async #finishRemoteDisable(): Promise<void> {
    const relayUrl = this.#credentials?.relayUrl ?? "";
    this.#connection?.stop();
    this.#connection = null;
    this.#peers.clear();
    this.#remoteTurnIds.clear();
    this.#pairing = null;
    await this.#subscriptions.releaseOwner("remote").catch(() => undefined);
    this.#projector.clearActiveThread();
    this.#coordinator.clear();
    this.#updateStatus({ enabled: false, phase: "disabled", message: "远程访问已关闭", relayUrl, pairing: null });
    this.#syncCredentialStatus();
  }

  async #refreshModels(): Promise<string | null> {
    const models: ReturnType<RemoteProjector["snapshot"]>["models"] = [];
    let defaultModel: string | null = null;
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const response = record(await this.#supervisor.call("model/list", { cursor, limit: 100, includeHidden: false }));
      for (const raw of Array.isArray(response.data) ? response.data : []) {
        const model = record(raw);
        const id = text(model.model) || text(model.id);
        if (!id || model.hidden === true) continue;
        if (model.isDefault === true) defaultModel = id;
        models.push({ id, displayName: (text(model.displayName) || id).slice(0, 200), efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map((option) => text(record(option).reasoningEffort)).filter(Boolean) });
      }
      cursor = text(response.nextCursor) || null;
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
    } while (cursor && models.length < 500);
    this.#projector.setModels(models);
    return defaultModel;
  }

  async #refreshThreads() {
    const response = record(await this.#supervisor.call("thread/list", { limit: 100, sortKey: "updated_at", sortDirection: "desc", searchTerm: null, cwd: null }));
    return this.#projector.setThreads(await this.#taskCatalog.enrich(Array.isArray(response.data) ? response.data : []));
  }

  #rememberResult(requestId: string, ok: boolean, message: string, peerId: string): void {
    const event: DesktopEvent = { type: "command.result", seq: this.#nextSeq(), requestId, ok, message: message.slice(0, 2_000) };
    this.#requestResults.set(requestId, { at: Date.now(), event });
    for (const [id, result] of this.#requestResults) if (Date.now() - result.at > 10 * 60_000) this.#requestResults.delete(id);
    while (this.#requestResults.size > 1_000) this.#requestResults.delete(this.#requestResults.keys().next().value!);
    this.#sendEvent(event, peerId);
  }

  #sendEvent(event: DesktopEvent, peerId?: string): void {
    const peers = peerId ? [this.#peers.get(peerId)].filter((peer): peer is PeerState => Boolean(peer)) : [...this.#peers.values()];
    const isCommandReceipt = event.type === "command.result";
    for (const peer of peers) if (peer.authenticated && peer.secure && this.#credentials && (this.#credentials.enabled || isCommandReceipt) && this.#credentials.devices.some((device) => device.id === peer.deviceId && device.revokedAt === null && !this.#pendingRevokedDeviceIds.has(device.id))) this.#sendSecure(peer, { type: "desktop.event", event }, isCommandReceipt);
  }

  #sendSecure(peer: PeerState, payload: unknown, isCommandReceipt = false): void {
    if (!peer.secure || this.#peers.get(peer.peerId) !== peer || (!this.#credentials?.enabled && !isCommandReceipt) || Boolean(peer.deviceId && this.#pendingRevokedDeviceIds.has(peer.deviceId))) throw new Error("安全连接尚未建立或已失效。");
    this.#connection?.send(peer.peerId, peer.secure.encrypt(payload));
  }

  async #sendMobileDocument(peer: PeerState): Promise<void> {
    if (this.#mobileDocument === null) {
      const path = join(app.getAppPath(), "remote", "mobile", "dist-bundle", "mobile.html");
      this.#mobileDocument = await readFile(path, "utf8");
      if (Buffer.byteLength(this.#mobileDocument) > MAX_MOBILE_DOCUMENT_BYTES) throw new Error("手机页面资源超过大小限制。");
    }
    const version = app.getVersion();
    const hash = createHash("sha256").update(this.#mobileDocument).digest("base64url");
    const signature = signP256(this.#credentialStore.revealSigningPrivateKey(this.#credentials!), uiDocumentProof(version, hash));
    this.#sendSecure(peer, { type: "ui.document", version, hash, signature, html: this.#mobileDocument });
  }

  #sendPolicy(): void {
    if (!this.#connection || !this.#credentials) return;
    const devices = this.#credentials.devices.filter((device) => device.revokedAt === null && !this.#pendingRevokedDeviceIds.has(device.id)).map((device) => ({ deviceId: device.id, publicKey: device.signingPublicKey }));
    const pairing = this.#pairing && this.#pairing.expiresAt > Date.now() ? { pairingId: this.#pairing.pairingId, secretHash: this.#pairing.hash, expiresAt: this.#pairing.expiresAt } : null;
    try { this.#connection.sendPolicy({ revision: ++this.#policyRevision, devices, pairing }); } catch { /* The policy is resent after reconnect. */ }
  }

  #updatePairingStatus(url?: string): void {
    const pairing = this.#pairing;
    if (!pairing) return;
    const previousUrl = this.#status.pairing?.url;
    const info: RemotePairingInfo = { pairingId: pairing.pairingId, url: url ?? previousUrl ?? "", code: pairing.code, expiresAt: pairing.expiresAt, readyToConfirm: pairing.readyToConfirm };
    this.#updateStatus({ pairing: info, phase: "pairing", message: pairing.readyToConfirm ? "手机已登记，请核对确认码" : "请使用手机扫描配对二维码" });
  }

  #syncCredentialStatus(): void {
    const active = this.#credentials?.devices.filter((device) => device.revokedAt === null) ?? [];
    this.#updateStatus({
      relayUrl: this.#credentials?.relayUrl ?? "",
      paired: active.length > 0,
      passkeys: active.map((device) => {
        const fingerprint = device.id.slice(0, 6).toUpperCase();
        const name = device.name.endsWith(`· ${fingerprint}`) ? device.name : `${device.name} · ${fingerprint}`;
        return { id: device.passkey?.id ?? device.id, name: device.authentication === "native" ? `${name}（原生设备密钥）` : name, createdAt: device.createdAt, lastUsedAt: device.passkey?.lastUsedAt ?? device.lastUsedAt ?? null };
      })
    });
  }

  #assertOwnership(): void {
    if (!this.#ownsRemoteAccess) throw new Error("远程访问正由另一个应用实例管理。关闭另一个实例后，请重启本窗口接管。");
  }

  #showStandbyStatus(): void {
    this.#syncCredentialStatus();
    this.#updateStatus({
      enabled: this.#credentials?.enabled ?? false,
      phase: "standby",
      message: "由另一个实例管理",
      pairing: null
    });
  }

  #queueProjected(key: string, projected: { threadId: string; item: MobileItem }): void {
    this.#pendingProjected.set(key, projected);
    if (this.#projectTimer) return;
    this.#projectTimer = setTimeout(() => {
      this.#projectTimer = null;
      const events = [...this.#pendingProjected.values()];
      this.#pendingProjected.clear();
      for (const event of events) this.#sendEvent({ type: "item.upsert", seq: this.#nextSeq(), ...event });
    }, 50);
  }

  #nextSeq(): number { return ++this.#seq; }

  #updateStatus(patch: Partial<RemoteAccessStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.emit("status", this.status);
  }
}
