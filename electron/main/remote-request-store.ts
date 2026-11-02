import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { z } from "zod";
import { SerialTaskQueue } from "./serial-task-queue.js";

const receiptSchema = z.object({
  deviceId: z.string(), requestId: z.string().uuid(), digest: z.string(),
  status: z.enum(["accepted", "completed", "failed", "unknown"]),
  threadId: z.string().optional(), turnId: z.string().optional(), updatedAt: z.number()
});
export type RemoteRequestReceipt = z.infer<typeof receiptSchema>;

/** No prompt, command payload, or raw exception is persisted. Missing/corrupt stores fail closed. */
export class RemoteRequestStore {
  readonly #receipts = new Map<string, RemoteRequestReceipt>();
  readonly #writes = new SerialTaskQueue();
  constructor(readonly path?: string) {}

  async load(): Promise<void> {
    if (!this.path) return;
    let encrypted: Buffer;
    try { encrypted = await readFile(this.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，已停止远程请求处理。");
    const data = z.object({ version: z.literal(1), receipts: z.array(receiptSchema) }).parse(JSON.parse(safeStorage.decryptString(encrypted)));
    for (const receipt of data.receipts) this.#receipts.set(this.#key(receipt.deviceId, receipt.requestId), { ...receipt, status: receipt.status === "accepted" ? "unknown" : receipt.status });
  }

  get(deviceId: string, requestId: string): RemoteRequestReceipt | undefined {
    const value = this.#receipts.get(this.#key(deviceId, requestId));
    return value ? { ...value } : undefined;
  }

  async put(receipt: RemoteRequestReceipt): Promise<void> {
    await this.#writes.enqueue(async () => {
      const value = receiptSchema.parse(receipt);
      const next = new Map(this.#receipts);
      next.set(this.#key(value.deviceId, value.requestId), value);
      // Keep durable tombstones indefinitely: evicting a side-effect request permits duplicate execution.
      if (this.path) {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未执行请求。");
        await mkdir(dirname(this.path), { recursive: true });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        await writeFile(temporary, safeStorage.encryptString(JSON.stringify({ version: 1, receipts: [...next.values()] })), { mode: 0o600, flush: true });
        await rename(temporary, this.path);
      }
      this.#receipts.clear();
      for (const [key, entry] of next) this.#receipts.set(key, entry);
    });
  }

  #key(deviceId: string, requestId: string): string { return `${deviceId}:${requestId}`; }
}
