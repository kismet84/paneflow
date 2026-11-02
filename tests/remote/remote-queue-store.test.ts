import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from("protected:" + Buffer.from(value).toString("base64")),
  decryptString: (data: Buffer) => { if (!data.toString().startsWith("protected:")) throw new Error("invalid protection"); return Buffer.from(data.toString().slice(10), "base64").toString(); }
} }));
import { RemoteQueueStore } from "../../electron/main/remote-queue-store";
import type { StoredQueue } from "../../electron/main/remote-task-queue";
const dirs: string[] = [];
const pathForTest = async () => { const dir = await mkdtemp(join(tmpdir(), "paneflow-queue-store-")); dirs.push(dir); return join(dir, "queue.enc"); };
const state = (): StoredQueue => ({ version: 1, paused: false, tasks: [{ id: "queued-a", requestId: crypto.randomUUID(), deviceId: "phone-a", title: "private prompt", text: "private prompt", cwd: "D:/private", model: "model-a", effort: "high", createdAt: 1, updatedAt: 1, queueState: "pending" }] });
afterEach(async () => { encryption.available = true; await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("OS-protected queue storage", () => {
  it("round-trips prompt/settings through safeStorage and replaces the encrypted file atomically", async () => {
    const path = await pathForTest(); const store = new RemoteQueueStore(path); const original = state();
    await store.save(original);
    expect(await readFile(path, "utf8")).not.toContain("private prompt");
    expect(await new RemoteQueueStore(path).load()).toEqual(original);
    original.paused = true; original.tasks[0]!.queueState = "dispatching";
    await store.save(original);
    expect(await new RemoteQueueStore(path).load()).toEqual(original);
  });
  it("preserves the old queue when encryption becomes unavailable", async () => {
    const path = await pathForTest(); const store = new RemoteQueueStore(path);
    await store.save(state()); const before = await readFile(path);
    encryption.available = false;
    await expect(store.save(state())).rejects.toThrow("安全存储");
    expect(await readFile(path)).toEqual(before);
  });
  it("fails closed and preserves corrupt recovery material", async () => {
    const path = await pathForTest(); await writeFile(path, "corrupt");
    await expect(new RemoteQueueStore(path).load()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corrupt");
  });
  it("does not persist injected permanent approval policy or reviewer fields", async () => {
    const path = await pathForTest(); const data = state();
    Object.assign(data.tasks[0]!, { approvalPolicy: "never", approvalsReviewer: "auto" });
    await new RemoteQueueStore(path).save(data);
    const restored = await new RemoteQueueStore(path).load();
    expect(restored?.tasks[0]).not.toHaveProperty("approvalPolicy");
    expect(restored?.tasks[0]).not.toHaveProperty("approvalsReviewer");
  });
});
