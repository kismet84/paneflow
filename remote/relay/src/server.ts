import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import {
  MAX_RELAY_BUFFERED_BYTES,
  MAX_RELAY_FRAME_BYTES,
  RELAY_CHALLENGE_TTL_MS,
  channelDataSchema,
  channelPolicySchema,
  desktopAttachProof,
  desktopAttachSchema,
  mobileAttachProof,
  mobileAttachSchema
} from "@codex-pane/remote-protocol";
import { channelIdForPublicKey, proofFresh, secretMatches, verifyP256Signature } from "./authorization.js";
import { loadConfig } from "./config.js";

type HeartbeatSocket = WebSocket & { isAlive?: boolean };
type Challenge = { connectionId: string; nonce: string; expiresAt: number };
type Connection = {
  socket: HeartbeatSocket;
  challenge: Challenge;
  attachTimer?: NodeJS.Timeout;
  role: "pending" | "desktop" | "mobile";
  channelId?: string;
  peerId?: string;
  deviceId?: string;
  mode?: "device" | "pairing";
  rate: { startedAt: number; count: number };
};
type MobileConnection = Connection & { role: "mobile"; channelId: string; peerId: string; mode: "device" | "pairing" };
type DesktopConnection = Connection & { role: "desktop"; channelId: string; peerId: string };
type Channel = {
  desktop: DesktopConnection;
  revision: number;
  devices: Map<string, JsonWebKey>;
  pairing: { pairingId: string; secretHash: string; expiresAt: number } | null;
  mobiles: Map<string, MobileConnection>;
};

const config = loadConfig();
const routePath = (path: string): string => config.BASE_PATH === "/" ? path : `${config.BASE_PATH}${path}`;
const app = Fastify({ logger: true, bodyLimit: MAX_RELAY_FRAME_BYTES });
await app.register(rateLimit, { global: true, max: 120, timeWindow: "1 minute" });
await app.register(websocket, { options: { maxPayload: MAX_RELAY_FRAME_BYTES } });

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const publicRoot = [resolve(currentDirectory, "../public"), resolve(currentDirectory, "../../public")].find(existsSync) ?? resolve(currentDirectory, "../public");
await app.register(fastifyStatic, { root: publicRoot, prefix: routePath("/") });

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss: ws:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  return payload;
});

if (config.BASE_PATH !== "/") app.get(config.BASE_PATH, async (_request, reply) => reply.redirect(`${config.BASE_PATH}/`));
app.get(routePath("/health"), async () => {
  // Public, non-secret launch nonce proves the domain reaches the same locally owned relay.
  const instance = process.env.PANEFLOW_RELAY_INSTANCE;
  return { ok: true, protocolVersion: 1, ...(instance && /^[a-f0-9-]{36}$/i.test(instance) ? { instanceId: instance } : {}) };
});

const channels = new Map<string, Channel>();
const connections = new Set<Connection>();

const sendJson = (socket: WebSocket, value: unknown): void => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_RELAY_BUFFERED_BYTES) {
    socket.close(1008, "Client too slow");
    return;
  }
  socket.send(JSON.stringify(value));
};

const messageAllowed = (connection: Connection): boolean => {
  const now = Date.now();
  if (now - connection.rate.startedAt >= 60_000) {
    connection.rate.startedAt = now;
    connection.rate.count = 0;
  }
  connection.rate.count += 1;
  return connection.rate.count <= 240;
};

const clearAttachTimer = (connection: Connection): void => {
  if (!connection.attachTimer) return;
  clearTimeout(connection.attachTimer);
  connection.attachTimer = undefined;
};

const disconnectMobile = (channel: Channel, mobile: MobileConnection, code = 1008, reason = "Access removed"): void => {
  channel.mobiles.delete(mobile.peerId);
  mobile.socket.close(code, reason);
  sendJson(channel.desktop.socket, { type: "channel.peer-offline", peerId: mobile.peerId });
};

const attachDesktop = (connection: Connection, raw: unknown): void => {
  const body = desktopAttachSchema.parse(raw);
  if (connection.role !== "pending" || connection.challenge.expiresAt < Date.now() || !proofFresh(body.timestamp)) throw new Error("stale desktop proof");
  if (channelIdForPublicKey(body.publicKey) !== body.channelId) throw new Error("invalid channel id");
  const proof = desktopAttachProof(connection.challenge.connectionId, connection.challenge.nonce, body.channelId, body.timestamp);
  if (!verifyP256Signature(body.publicKey, proof, body.signature)) throw new Error("invalid desktop signature");
  if (!channels.has(body.channelId) && channels.size >= config.MAX_CHANNELS) throw new Error("channel limit reached");
  const existing = channels.get(body.channelId);
  if (existing) {
    existing.desktop.socket.close(1000, "Desktop reconnected");
    for (const mobile of existing.mobiles.values()) mobile.socket.close(1012, "Desktop reconnected");
  }
  const desktop = Object.assign(connection, { role: "desktop" as const, channelId: body.channelId, peerId: randomUUID() });
  clearAttachTimer(connection);
  channels.set(body.channelId, { desktop, revision: -1, devices: new Map(), pairing: null, mobiles: new Map() });
  sendJson(connection.socket, { type: "relay.attached", role: "desktop", peerId: desktop.peerId });
};

const attachMobile = (connection: Connection, raw: unknown): void => {
  const body = mobileAttachSchema.parse(raw);
  if (connection.role !== "pending" || connection.challenge.expiresAt < Date.now()) throw new Error("stale mobile proof");
  const channel = channels.get(body.channelId);
  if (!channel || channel.desktop.socket.readyState !== WebSocket.OPEN) {
    sendJson(connection.socket, { type: "relay.notice", code: "desktop-offline", message: "桌面端未连接" });
    connection.socket.close(1008, "Desktop offline");
    return;
  }
  if (channel.revision < 0) {
    connection.socket.close(1013, "Policy pending");
    return;
  }
  if (channel.mobiles.size >= config.MAX_MOBILES_PER_CHANNEL) throw new Error("mobile limit reached");
  if (body.mode === "device") {
    const publicKey = channel.devices.get(body.deviceId);
    const proof = mobileAttachProof(connection.challenge.connectionId, connection.challenge.nonce, body.channelId, body.deviceId, body.timestamp);
    if (!publicKey || !proofFresh(body.timestamp) || !verifyP256Signature(publicKey, proof, body.signature)) {
      connection.socket.close(1008, "Access denied");
      return;
    }
  } else {
    const pairing = channel.pairing;
    if (!pairing || pairing.pairingId !== body.pairingId || pairing.expiresAt < Date.now() || !secretMatches(body.pairingSecret, pairing.secretHash)) {
      connection.socket.close(1008, "Pairing rejected");
      return;
    }
    const existingPair = [...channel.mobiles.values()].find((mobile) => mobile.mode === "pairing");
    if (existingPair) disconnectMobile(channel, existingPair, 1008, "Pairing replaced");
  }
  const mobile = Object.assign(connection, {
    role: "mobile" as const,
    channelId: body.channelId,
    peerId: randomUUID(),
    mode: body.mode,
    deviceId: body.mode === "device" ? body.deviceId : undefined
  });
  clearAttachTimer(connection);
  channel.mobiles.set(mobile.peerId, mobile);
  sendJson(connection.socket, { type: "relay.attached", role: "mobile", peerId: mobile.peerId, mode: mobile.mode });
  sendJson(channel.desktop.socket, { type: "channel.peer-online", peerId: mobile.peerId, mode: mobile.mode, ...(mobile.deviceId ? { deviceId: mobile.deviceId } : {}) });
};

const updatePolicy = (connection: Connection, raw: unknown): void => {
  if (connection.role !== "desktop" || !connection.channelId) throw new Error("desktop required");
  const body = channelPolicySchema.parse(raw);
  const channel = channels.get(connection.channelId);
  if (!channel || channel.desktop !== connection || body.revision <= channel.revision) throw new Error("stale policy");
  channel.revision = body.revision;
  channel.devices = new Map(body.devices.map((device) => [device.deviceId, device.publicKey]));
  channel.pairing = body.pairing && body.pairing.expiresAt > Date.now() ? body.pairing : null;
  for (const mobile of [...channel.mobiles.values()]) {
    if (mobile.mode === "device" && (!mobile.deviceId || !channel.devices.has(mobile.deviceId))) disconnectMobile(channel, mobile);
    if (mobile.mode === "pairing" && !channel.pairing) disconnectMobile(channel, mobile);
  }
  sendJson(connection.socket, { type: "relay.notice", code: "policy-updated", message: "访问设备已更新" });
};

const routeData = (connection: Connection, raw: unknown): void => {
  const body = channelDataSchema.parse(raw);
  if (!connection.channelId) throw new Error("attachment required");
  const channel = channels.get(connection.channelId);
  if (!channel) throw new Error("channel unavailable");
  if (connection.role === "desktop") {
    if (channel.desktop !== connection) throw new Error("desktop replaced");
    if (!body.peerId) throw new Error("peer required");
    const mobile = channel.mobiles.get(body.peerId);
    // A valid desktop may finish a response after the mobile close event. Dropping
    // that stale destination must not disconnect the desktop and every other peer.
    if (!mobile) return;
    sendJson(mobile.socket, { type: "channel.data", peerId: connection.peerId, payload: body.payload });
    return;
  }
  if (connection.role === "mobile" && connection.peerId) {
    if (channel.mobiles.get(connection.peerId) !== connection) throw new Error("mobile removed");
    sendJson(channel.desktop.socket, { type: "channel.data", peerId: connection.peerId, payload: body.payload });
    return;
  }
  throw new Error("attachment required");
};

app.get(routePath("/ws"), { websocket: true }, (socket, request) => {
  if (connections.size >= config.MAX_CONNECTIONS) return socket.close(1013, "Service busy");
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== config.PUBLIC_ORIGIN) return socket.close(1008, "Origin rejected");
  const challenge = { connectionId: randomUUID(), nonce: randomBytes(32).toString("base64url"), expiresAt: Date.now() + RELAY_CHALLENGE_TTL_MS };
  const heartbeatSocket = socket as HeartbeatSocket;
  const connection: Connection = { socket: heartbeatSocket, challenge, role: "pending", rate: { startedAt: Date.now(), count: 0 } };
  connection.attachTimer = setTimeout(() => {
    if (connection.role === "pending") socket.close(1008, "Challenge expired");
  }, RELAY_CHALLENGE_TTL_MS);
  connection.attachTimer.unref();
  connections.add(connection);
  heartbeatSocket.isAlive = true;
  heartbeatSocket.on("pong", () => { heartbeatSocket.isAlive = true; });
  sendJson(socket, { type: "relay.challenge", protocolVersion: 1, ...challenge });
  socket.on("message", (data) => {
    try {
      if (!messageAllowed(connection)) throw new Error("rate exceeded");
      const raw = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
      if (Buffer.byteLength(raw) > MAX_RELAY_FRAME_BYTES) throw new Error("frame too large");
      const body = JSON.parse(raw) as Record<string, unknown>;
      if (body.type === "desktop.attach") attachDesktop(connection, body);
      else if (body.type === "mobile.attach") attachMobile(connection, body);
      else if (body.type === "channel.policy") updatePolicy(connection, body);
      else if (body.type === "channel.data") routeData(connection, body);
      else throw new Error("unsupported frame");
    } catch {
      socket.close(1008, "Invalid request");
    }
  });
  socket.on("close", () => {
    clearAttachTimer(connection);
    connections.delete(connection);
    if (!connection.channelId) return;
    const channel = channels.get(connection.channelId);
    if (!channel) return;
    if (connection.role === "desktop" && channel.desktop === connection) {
      channels.delete(connection.channelId);
      for (const mobile of channel.mobiles.values()) mobile.socket.close(1008, "Desktop offline");
      return;
    }
    if (connection.role === "mobile" && connection.peerId && channel.mobiles.get(connection.peerId) === connection) {
      channel.mobiles.delete(connection.peerId);
      sendJson(channel.desktop.socket, { type: "channel.peer-offline", peerId: connection.peerId });
    }
  });
});

const heartbeatTimer = setInterval(() => {
  for (const connection of connections) {
    if (connection.socket.isAlive === false) {
      connection.socket.terminate();
      continue;
    }
    connection.socket.isAlive = false;
    try { connection.socket.ping(); } catch { connection.socket.close(1011, "Heartbeat failed"); }
  }
}, 20_000);
heartbeatTimer.unref();

app.setNotFoundHandler((request, reply) => {
  return reply.code(404).send({ message: "Not found" });
});

const shutdown = async (): Promise<void> => {
  clearInterval(heartbeatTimer);
  for (const connection of connections) connection.socket.close(1001, "Server shutdown");
  await app.close();
};
process.on("SIGTERM", () => { void shutdown(); });
process.on("SIGINT", () => { void shutdown(); });
await app.listen({ host: config.HOST, port: config.PORT });
// An owned local launcher must not mistake another service's /health for readiness.
process.send?.({ type: "relay.ready", port: config.PORT });
