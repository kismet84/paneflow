import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { storedQueueSchema, type QueuePersistence, type StoredQueue } from "./remote-task-queue.js";

/** Queue payloads contain prompts; the complete file is protected by the OS, never plaintext. */
export class RemoteQueueStore implements QueuePersistence {
  #memory: StoredQueue | null = null;
  constructor(readonly path?: string) {}
  async load(): Promise<StoredQueue | null> {
    if (!this.path) return structuredClone(this.#memory);
    let data: Buffer;
    try { data = await readFile(this.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，队列已停止恢复。");
    return storedQueueSchema.parse(JSON.parse(safeStorage.decryptString(data)));
  }
  async save(state: StoredQueue): Promise<void> {
    const parsed = storedQueueSchema.parse(state);
    if (this.path) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，未派发队列任务。");
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, safeStorage.encryptString(JSON.stringify(parsed)), { mode: 0o600, flush: true });
      await rename(temporary, this.path);
    }
    this.#memory = structuredClone(parsed);
  }
}
