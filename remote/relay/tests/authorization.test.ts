import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { channelIdForPublicKey, hashValue, proofFresh, secretMatches, verifyP256Signature } from "../src/authorization.js";

describe("relay authorization", () => {
  it("derives a stable channel and verifies proof of possession", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { format: "jwk" },
      privateKeyEncoding: { format: "jwk" }
    });
    const message = "relay challenge";
    const signature = sign("sha256", Buffer.from(message), { key: privateKey, format: "jwk", dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect(channelIdForPublicKey(publicKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyP256Signature(publicKey, message, signature)).toBe(true);
    expect(verifyP256Signature(publicKey, `${message}!`, signature)).toBe(false);
  });

  it("uses bounded timestamps and constant-time pairing-secret comparison", () => {
    const now = Date.now();
    expect(proofFresh(now, now)).toBe(true);
    expect(proofFresh(now - 30_001, now)).toBe(false);
    const hash = hashValue("correct horse");
    expect(secretMatches("correct horse", hash)).toBe(true);
    expect(secretMatches("wrong", hash)).toBe(false);
  });
});
