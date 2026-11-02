import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteAuditLog } from "../../electron/main/remote-audit-log";

const testRoot = resolve("test-results", `remote-audit-${randomUUID()}`);

afterEach(() => rm(testRoot, { recursive: true, force: true }));

describe("remote security audit", () => {
  it("serializes concurrent security events without recording message content", async () => {
    const path = resolve(testRoot, "audit.jsonl");
    const audit = new RemoteAuditLog(path);
    await Promise.all([
      audit.write("device.paired", { deviceId: "device-1" }),
      audit.write("approval.resolved", { approvalId: "approval-1", decision: "decline" })
    ]);
    const entries = (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries.map((entry) => entry.event)).toEqual(["device.paired", "approval.resolved"]);
    expect(entries.every((entry) => typeof entry.at === "string")).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("prompt");
  });
});
