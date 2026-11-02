import { z } from "zod";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const MAX_RELAY_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_RELAY_BUFFERED_BYTES = MAX_RELAY_FRAME_BYTES * 4;
export const RELAY_CHALLENGE_TTL_MS = 30_000;

const idSchema = z.string().min(1).max(200);
const publicJwkSchema = z.object({
  kty: z.string().min(1).max(20),
  crv: z.string().min(1).max(20),
  x: z.string().min(1).max(200),
  y: z.string().min(1).max(200)
}).passthrough();

export const relayChallengeSchema = z.object({
  type: z.literal("relay.challenge"),
  protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
  connectionId: z.string().uuid(),
  nonce: z.string().min(32).max(200),
  expiresAt: z.number().int().positive()
});

export const desktopAttachSchema = z.object({
  type: z.literal("desktop.attach"),
  protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
  channelId: idSchema,
  publicKey: publicJwkSchema,
  timestamp: z.number().int().positive(),
  signature: z.string().min(1).max(2_000)
});

export const mobileAttachSchema = z.discriminatedUnion("mode", [
  z.object({
    type: z.literal("mobile.attach"),
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    mode: z.literal("device"),
    channelId: idSchema,
    deviceId: idSchema,
    timestamp: z.number().int().positive(),
    signature: z.string().min(1).max(2_000)
  }),
  z.object({
    type: z.literal("mobile.attach"),
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    mode: z.literal("pairing"),
    channelId: idSchema,
    pairingId: z.string().uuid(),
    pairingSecret: z.string().min(32).max(512)
  })
]);

export const channelPolicySchema = z.object({
  type: z.literal("channel.policy"),
  revision: z.number().int().nonnegative(),
  devices: z.array(z.object({
    deviceId: idSchema,
    publicKey: publicJwkSchema
  })).max(20),
  pairing: z.object({
    pairingId: z.string().uuid(),
    secretHash: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.number().int().positive()
  }).nullable()
});

export const channelDataSchema = z.object({
  type: z.literal("channel.data"),
  peerId: z.string().uuid().optional(),
  payload: z.string().min(1).max(MAX_RELAY_FRAME_BYTES)
});

export const relayClientFrameSchema = z.union([
  desktopAttachSchema,
  mobileAttachSchema,
  channelPolicySchema,
  channelDataSchema
]);

export const relayServerFrameSchema = z.discriminatedUnion("type", [
  relayChallengeSchema,
  z.object({ type: z.literal("relay.attached"), role: z.enum(["desktop", "mobile"]), peerId: z.string().uuid(), mode: z.enum(["device", "pairing"]).optional() }),
  z.object({ type: z.literal("channel.peer-online"), peerId: z.string().uuid(), mode: z.enum(["device", "pairing"]), deviceId: idSchema.optional() }),
  z.object({ type: z.literal("channel.peer-offline"), peerId: z.string().uuid() }),
  z.object({ type: z.literal("channel.data"), peerId: z.string().uuid(), payload: z.string().min(1).max(MAX_RELAY_FRAME_BYTES) }),
  z.object({ type: z.literal("relay.notice"), code: z.enum(["desktop-offline", "policy-updated"]), message: z.string().max(500) })
]);

export const secureEnvelopeSchema = z.object({
  type: z.literal("secure"),
  sessionId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  iv: z.string().min(1).max(100),
  ciphertext: z.string().min(1).max(MAX_RELAY_FRAME_BYTES)
});

export const pairingHelloSchema = z.object({
  type: z.literal("pairing.hello"),
  sessionId: z.string().uuid(),
  pairingId: z.string().uuid(),
  mobileAgreementPublicKey: publicJwkSchema,
  envelope: secureEnvelopeSchema
});

export const sessionHelloSchema = z.object({
  type: z.literal("session.hello"),
  sessionId: z.string().uuid(),
  deviceId: idSchema,
  mobileEphemeralPublicKey: publicJwkSchema,
  timestamp: z.number().int().positive(),
  signature: z.string().min(1).max(2_000)
});

export const sessionWelcomeSchema = z.object({
  type: z.literal("session.welcome"),
  sessionId: z.string().uuid(),
  desktopEphemeralPublicKey: publicJwkSchema,
  timestamp: z.number().int().positive(),
  signature: z.string().min(1).max(2_000)
});

export const peerPayloadSchema = z.discriminatedUnion("type", [pairingHelloSchema, sessionHelloSchema, sessionWelcomeSchema, secureEnvelopeSchema]);

export const canonicalJwk = (key: JsonWebKey): string => JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x, y: key.y });

export const desktopAttachProof = (connectionId: string, nonce: string, channelId: string, timestamp: number): string =>
  `desktop.attach\n${RELAY_PROTOCOL_VERSION}\n${connectionId}\n${nonce}\n${channelId}\n${timestamp}`;

export const mobileAttachProof = (connectionId: string, nonce: string, channelId: string, deviceId: string, timestamp: number): string =>
  `mobile.attach\n${RELAY_PROTOCOL_VERSION}\n${connectionId}\n${nonce}\n${channelId}\n${deviceId}\n${timestamp}`;

export const sessionHelloProof = (channelId: string, sessionId: string, deviceId: string, mobileEphemeralPublicKey: JsonWebKey, timestamp: number): string =>
  `session.hello\n${channelId}\n${sessionId}\n${deviceId}\n${canonicalJwk(mobileEphemeralPublicKey)}\n${timestamp}`;

export const sessionWelcomeProof = (channelId: string, sessionId: string, mobileEphemeralPublicKey: JsonWebKey, desktopEphemeralPublicKey: JsonWebKey, timestamp: number): string =>
  `session.welcome\n${channelId}\n${sessionId}\n${canonicalJwk(mobileEphemeralPublicKey)}\n${canonicalJwk(desktopEphemeralPublicKey)}\n${timestamp}`;

export const uiDocumentProof = (version: string, hash: string): string => `ui.document\n${RELAY_PROTOCOL_VERSION}\n${version}\n${hash}`;

export type RelayChallenge = z.infer<typeof relayChallengeSchema>;
export type DesktopAttach = z.infer<typeof desktopAttachSchema>;
export type MobileAttach = z.infer<typeof mobileAttachSchema>;
export type ChannelPolicy = z.infer<typeof channelPolicySchema>;
export type ChannelData = z.infer<typeof channelDataSchema>;
export type RelayClientFrame = z.infer<typeof relayClientFrameSchema>;
export type RelayServerFrame = z.infer<typeof relayServerFrameSchema>;
export type SecureEnvelope = z.infer<typeof secureEnvelopeSchema>;
export type PairingHello = z.infer<typeof pairingHelloSchema>;
export type SessionHello = z.infer<typeof sessionHelloSchema>;
export type SessionWelcome = z.infer<typeof sessionWelcomeSchema>;
export type PeerPayload = z.infer<typeof peerPayloadSchema>;
