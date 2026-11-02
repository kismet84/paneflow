import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type JsonWebKey as NodeJsonWebKey
} from "node:crypto";
import { secureEnvelopeSchema, type SecureEnvelope } from "../../packages/remote-protocol/src/index.js";

const asNodeJwk = (key: JsonWebKey): NodeJsonWebKey => key as NodeJsonWebKey;

export const generateP256KeyPair = (): { publicKey: JsonWebKey; privateKey: JsonWebKey } => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey: pair.publicKey.export({ format: "jwk" }) as JsonWebKey,
    privateKey: pair.privateKey.export({ format: "jwk" }) as JsonWebKey
  };
};

export const signP256 = (privateKey: JsonWebKey, message: string): string =>
  sign("sha256", Buffer.from(message), { key: asNodeJwk(privateKey), format: "jwk", dsaEncoding: "ieee-p1363" }).toString("base64url");

export const verifyP256 = (publicKey: JsonWebKey, message: string, signature: string): boolean => {
  try {
    return verify("sha256", Buffer.from(message), { key: asNodeJwk(publicKey), format: "jwk", dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};

export const deriveSessionKey = (privateKey: JsonWebKey, publicKey: JsonWebKey, context: string): Buffer => {
  const secret = diffieHellman({
    privateKey: createPrivateKey({ key: asNodeJwk(privateKey), format: "jwk" }),
    publicKey: createPublicKey({ key: asNodeJwk(publicKey), format: "jwk" })
  });
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(context), Buffer.from("codex-pane-remote-v1"), 32));
};

const aad = (sessionId: string, sequence: number): Buffer => Buffer.from(`codex-pane-secure-v1\n${sessionId}\n${sequence}`);

export class SecureSession {
  readonly #sessionId: string;
  readonly #key: Buffer;
  #sendSequence = 0;
  #receiveSequence = 0;

  constructor(sessionId: string, key: Buffer) {
    this.#sessionId = sessionId;
    this.#key = Buffer.from(key);
  }

  encrypt(payload: unknown): SecureEnvelope {
    const sequence = this.#sendSequence++;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(aad(this.#sessionId, sequence));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { type: "secure", sessionId: this.#sessionId, sequence, iv: iv.toString("base64url"), ciphertext: encrypted.toString("base64url") };
  }

  decrypt(raw: unknown): unknown {
    const envelope = secureEnvelopeSchema.parse(raw);
    if (envelope.sessionId !== this.#sessionId || envelope.sequence !== this.#receiveSequence) throw new Error("加密消息顺序无效。");
    const iv = Buffer.from(envelope.iv, "base64url");
    const encrypted = Buffer.from(envelope.ciphertext, "base64url");
    if (iv.length !== 12 || encrypted.length < 17) throw new Error("加密消息格式无效。");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
    decipher.setAAD(aad(this.#sessionId, envelope.sequence));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    this.#receiveSequence += 1;
    return JSON.parse(plaintext.toString("utf8"));
  }
}
