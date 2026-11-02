import { describe, expect, it } from "vitest";
import { deriveSessionKey, generateP256KeyPair, SecureSession, signP256, verifyP256 } from "../../electron/main/remote-crypto";

describe("remote end-to-end crypto", () => {
  it("derives the same key in both directions and authenticates ordered messages", () => {
    const desktop = generateP256KeyPair();
    const mobile = generateP256KeyPair();
    const desktopKey = deriveSessionKey(desktop.privateKey, mobile.publicKey, "session-1");
    const mobileKey = deriveSessionKey(mobile.privateKey, desktop.publicKey, "session-1");
    expect(desktopKey.equals(mobileKey)).toBe(true);
    const sender = new SecureSession("2ff69979-5a94-4cc2-a774-3afca3836f34", desktopKey);
    const receiver = new SecureSession("2ff69979-5a94-4cc2-a774-3afca3836f34", mobileKey);
    const envelope = sender.encrypt({ type: "test", value: "secret" });
    expect(JSON.stringify(envelope)).not.toContain("secret");
    expect(receiver.decrypt(envelope)).toEqual({ type: "test", value: "secret" });
    expect(() => receiver.decrypt(envelope)).toThrow("顺序无效");
  });

  it("verifies P-256 identity signatures", () => {
    const identity = generateP256KeyPair();
    const signature = signP256(identity.privateKey, "proof");
    expect(verifyP256(identity.publicKey, "proof", signature)).toBe(true);
    expect(verifyP256(identity.publicKey, "changed", signature)).toBe(false);
  });

  it("rejects modified ciphertext and a different session identity", () => {
    const key = Buffer.alloc(32, 7);
    const sender = new SecureSession("a72b0ea1-1876-49a0-b91e-690d88e56a96", key);
    const envelope = sender.encrypt({ type: "test", value: "protected" });
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    expect(() => new SecureSession(envelope.sessionId, key).decrypt({ ...envelope, ciphertext: ciphertext.toString("base64url") })).toThrow();
    expect(() => new SecureSession("0fdb9f29-423c-4b20-aeac-ae9d7e20d267", key).decrypt(envelope)).toThrow("顺序无效");
  });
});
