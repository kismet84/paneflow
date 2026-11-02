import { EventEmitter } from "node:events";
import type { ChannelPolicy, RelayServerFrame } from "../../packages/remote-protocol/src/index.js";
import { desktopAttachProof, relayServerFrameSchema } from "../../packages/remote-protocol/src/index.js";
import type { RemoteCredentialState } from "./remote-credential-store.js";
import { signP256 } from "./remote-crypto.js";

export type RelayConnectionEvent =
  | { type: "state"; phase: "disabled" | "connecting" | "connected" | "error"; message: string }
  | { type: "attached" }
  | { type: "peerOnline"; peerId: string; mode: "device" | "pairing"; deviceId?: string }
  | { type: "peerOffline"; peerId: string }
  | { type: "data"; peerId: string; payload: string };

export const toWebSocketUrl = (relayUrl: string): string => {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/ws`;
  url.search = "";
  url.hash = "";
  return url.toString();
};

export class RelayConnection extends EventEmitter {
  readonly #signingPrivateKey: () => JsonWebKey;
  #credentials: RemoteCredentialState;
  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #reconnectAttempt = 0;
  #stopped = true;
  #attached = false;

  constructor(credentials: RemoteCredentialState, signingPrivateKey: () => JsonWebKey) {
    super();
    this.#credentials = credentials;
    this.#signingPrivateKey = signingPrivateKey;
  }

  updateCredentials(credentials: RemoteCredentialState): void {
    this.#credentials = credentials;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#attached = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.close(1000, "Remote access disabled");
    this.#socket = null;
    this.emit("event", { type: "state", phase: "disabled", message: "远程访问已关闭" } satisfies RelayConnectionEvent);
  }

  reconnect(): void {
    if (this.#stopped) return;
    this.#attached = false;
    this.#socket?.close(1000, "Desktop session restarted");
  }

  sendPolicy(policy: Omit<ChannelPolicy, "type">): void {
    this.#send({ type: "channel.policy", ...policy });
  }

  send(peerId: string, payload: unknown): void {
    this.#send({ type: "channel.data", peerId, payload: JSON.stringify(payload) });
  }

  #send(value: unknown): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN || !this.#attached) throw new Error("中转服务未连接。");
    this.#socket.send(JSON.stringify(value));
  }

  #connect(): void {
    if (this.#stopped || this.#socket) return;
    this.emit("event", { type: "state", phase: "connecting", message: "正在连接中转服务…" } satisfies RelayConnectionEvent);
    try {
      const socket = new WebSocket(toWebSocketUrl(this.#credentials.relayUrl));
      this.#socket = socket;
      const timeout = setTimeout(() => {
        if (this.#socket === socket && !this.#attached) socket.close(1000, "Relay attach timeout");
      }, 30_000);
      timeout.unref?.();
      socket.addEventListener("message", (event) => { if (this.#socket === socket) this.#handleMessage(String(event.data)); });
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (this.#socket !== socket) return;
        this.#socket = null;
        this.#attached = false;
        if (!this.#stopped) this.#scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        this.emit("event", { type: "state", phase: "error", message: "无法连接中转服务，正在重试…" } satisfies RelayConnectionEvent);
      });
    } catch (error) {
      this.#socket = null;
      this.emit("event", { type: "state", phase: "error", message: error instanceof Error ? error.message : String(error) } satisfies RelayConnectionEvent);
      this.#scheduleReconnect();
    }
  }

  #handleMessage(raw: string): void {
    let message: RelayServerFrame;
    try {
      message = relayServerFrameSchema.parse(JSON.parse(raw));
    } catch {
      this.#socket?.close(1003, "Invalid relay frame");
      return;
    }
    if (message.type === "relay.challenge") {
      if (message.expiresAt < Date.now()) return this.#socket?.close(1008, "Challenge expired");
      const timestamp = Date.now();
      const proof = desktopAttachProof(message.connectionId, message.nonce, this.#credentials.channelId, timestamp);
      this.#socket?.send(JSON.stringify({
        type: "desktop.attach",
        protocolVersion: 1,
        channelId: this.#credentials.channelId,
        publicKey: this.#credentials.signingPublicKey,
        timestamp,
        signature: signP256(this.#signingPrivateKey(), proof)
      }));
      return;
    }
    if (message.type === "relay.attached" && message.role === "desktop") {
      this.#attached = true;
      this.#reconnectAttempt = 0;
      this.emit("event", { type: "state", phase: "connected", message: "已连接中转服务" } satisfies RelayConnectionEvent);
      this.emit("event", { type: "attached" } satisfies RelayConnectionEvent);
      return;
    }
    if (message.type === "channel.peer-online") {
      this.emit("event", { type: "peerOnline", peerId: message.peerId, mode: message.mode, ...(message.deviceId ? { deviceId: message.deviceId } : {}) } satisfies RelayConnectionEvent);
      return;
    }
    if (message.type === "channel.peer-offline") {
      this.emit("event", { type: "peerOffline", peerId: message.peerId } satisfies RelayConnectionEvent);
      return;
    }
    if (message.type === "channel.data") {
      this.emit("event", { type: "data", peerId: message.peerId, payload: message.payload } satisfies RelayConnectionEvent);
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt) + Math.floor(Math.random() * 500);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }
}
