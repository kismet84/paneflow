import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => encryption.available,
  encryptString: (value: string) => Buffer.from("protected:" + Buffer.from(value).toString("base64")),
  decryptString: (value: Buffer) => {
    if (!value.toString().startsWith("protected:")) throw new Error("decryption failed");
    return Buffer.from(value.toString().slice(10), "base64").toString();
  }
} }));
import { RemoteRequestStore } from "../../electron/main/remote-request-store";

const directories: string[] = [];
const makePath = async () => { const dir = await mkdtemp(join(tmpdir(), "paneflow-receipts-")); directories.push(dir); return join(dir, "requests.enc"); };
afterEach(async () => { encryption.available = true; await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("durable remote request receipts", () => {
  it("recovers accepted as unknown, preserves final results, and scopes ids by device", async () => {
    const path = await makePath();
    const store = new RemoteRequestStore(path);
    const requestId = randomUUID();
    await store.load();
    await store.put({ deviceId: "phone-a", requestId, digest: "digest-a", status: "accepted", updatedAt: 1 });
    await store.put({ deviceId: "phone-b", requestId, digest: "digest-b", status: "completed", threadId: "thread-b", updatedAt: 2 });
    const restarted = new RemoteRequestStore(path);
    await restarted.load();
    expect(restarted.get("phone-a", requestId)?.status).toBe("unknown");
    expect(restarted.get("phone-b", requestId)).toMatchObject({ status: "completed", threadId: "thread-b" });
    expect(restarted.get("phone-c", requestId)).toBeUndefined();
    expect((await readFile(path, "utf8")).includes("phone-a")).toBe(false);
  });

  it("fails closed without overwriting corrupt receipt storage", async () => {
    const path = await makePath();
    await writeFile(path, "corrupted");
    await expect(new RemoteRequestStore(path).load()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("corrupted");
  });

  it("does not accept a request when OS encryption is unavailable", async () => {
    const store = new RemoteRequestStore(await makePath());
    encryption.available = false;
    const requestId = randomUUID();
    await expect(store.put({ deviceId: "phone-a", requestId, digest: "digest", status: "accepted", updatedAt: 1 })).rejects.toThrow("安全存储");
    expect(store.get("phone-a", requestId)).toBeUndefined();
  });

  it("serializes writes and excludes unrecognized payload fields", async () => {
    const path = await makePath();
    const store = new RemoteRequestStore(path);
    const requests = Array.from({ length: 12 }, () => randomUUID());
    await Promise.all(requests.map(requestId => store.put({ deviceId: "phone", requestId, digest: "hash-only", status: "completed", updatedAt: 1, text: "private prompt" } as any)));
    const restarted = new RemoteRequestStore(path);
    await restarted.load();
    expect(requests.every(id => restarted.get("phone", id)?.status === "completed")).toBe(true);
    const encrypted = await readFile(path, "utf8");
    expect(Buffer.from(encrypted.slice(10), "base64").toString()).not.toContain("private prompt");
  });
});
