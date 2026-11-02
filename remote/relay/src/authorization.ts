import { createHash, createPublicKey, timingSafeEqual, verify, type JsonWebKey as NodeJsonWebKey } from "node:crypto";
import { canonicalJwk } from "@codex-pane/remote-protocol";

export const hashValue = (value: string): string => createHash("sha256").update(value).digest("hex");

export const channelIdForPublicKey = (publicKey: JsonWebKey): string => hashValue(canonicalJwk(publicKey));

export const proofFresh = (timestamp: number, now = Date.now()): boolean => Math.abs(now - timestamp) <= 30_000;

export const verifyP256Signature = (publicKey: JsonWebKey, message: string, signature: string): boolean => {
  try {
    return verify("sha256", Buffer.from(message), { key: createPublicKey({ key: publicKey as NodeJsonWebKey, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
};

export const secretMatches = (secret: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashValue(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
