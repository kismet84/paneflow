import { describe, expect, it } from "vitest";
import { MAX_REMOTE_MESSAGE_BYTES, createEnvelope, mobileCommandSchema, parseEnvelopeText, routeEnvelopeSchema } from "../../packages/remote-protocol/src/index";

describe("remote protocol", () => {
  it("accepts only the supported product commands", () => {
    const requestId = crypto.randomUUID();
    expect(mobileCommandSchema.parse({ type: "snapshot.get", requestId }).type).toBe("snapshot.get");
    expect(() => mobileCommandSchema.parse({ type: "turn.interrupt", requestId, threadId: "thread-1" })).toThrow();
    expect(() => mobileCommandSchema.parse({ type: "turn.send", requestId, threadId: "thread-1", text: "/model gpt" })).not.toThrow();
    expect(() => mobileCommandSchema.parse({ type: "turn.send", requestId, text: "missing target" })).toThrow();
    expect(() => mobileCommandSchema.parse({ type: "remote.disable", requestId })).not.toThrow();
    expect(() => mobileCommandSchema.parse({ type: "approval.resolve", requestId, threadId: "thread-1", approvalId: "approval-1", version: 1, decision: "accept", selection: "测试" })).not.toThrow();
    expect(() => mobileCommandSchema.parse({ type: "turn.send", requestId, threadId: "thread-1", text: "x".repeat(20_001) })).toThrow();
  });

  it("rejects invalid lifetimes and oversized messages", () => {
    const envelope = createEnvelope("device-1", { type: "snapshot.get", requestId: crypto.randomUUID() }, 1_000);
    expect(routeEnvelopeSchema.parse(envelope).version).toBe(1);
    expect(() => routeEnvelopeSchema.parse({ ...envelope, expiresAt: envelope.sentAt + 60_001 })).toThrow();
    expect(() => parseEnvelopeText(`"${"x".repeat(MAX_REMOTE_MESSAGE_BYTES)}"`)).toThrow("消息超过大小限制");
  });

  it("bounds optional new-thread fields and fork names while preserving old commands", () => {
    const requestId = crypto.randomUUID();
    const create = { type: "thread.new", requestId };
    expect(mobileCommandSchema.parse(create)).toEqual(create);
    expect(mobileCommandSchema.parse({ ...create, cwd: " D:/project ", model: "model", effort: "high", text: " first " })).toMatchObject({ cwd: "D:/project", text: "first" });
    for (const field of ["cwd", "model", "effort", "text"]) {
      expect(mobileCommandSchema.safeParse({ ...create, [field]: "" }).success).toBe(false);
      expect(mobileCommandSchema.safeParse({ ...create, [field]: null }).success).toBe(false);
      expect(mobileCommandSchema.safeParse({ ...create, [field]: 1 }).success).toBe(false);
    }
    for (const [field, length] of [["cwd", 4_096], ["model", 200], ["effort", 50], ["text", 20_000]] as const) {
      expect(mobileCommandSchema.safeParse({ ...create, [field]: "x".repeat(length) }).success).toBe(true);
      expect(mobileCommandSchema.safeParse({ ...create, [field]: "x".repeat(length + 1) }).success).toBe(false);
    }
    const fork = { type: "thread.fork", requestId, threadId: "source" };
    expect(mobileCommandSchema.parse(fork)).toEqual(fork);
    expect(mobileCommandSchema.parse({ ...fork, name: " branch " })).toMatchObject({ name: "branch" });
    expect(mobileCommandSchema.safeParse({ ...fork, name: "x".repeat(200) }).success).toBe(true);
    for (const name of [" ", "x".repeat(201), null, 1]) expect(mobileCommandSchema.safeParse({ ...fork, name }).success).toBe(false);
  });
});
