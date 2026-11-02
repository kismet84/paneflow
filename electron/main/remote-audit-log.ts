import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;

export class RemoteAuditLog {
  readonly #path: string;
  #pending = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  write(event: string, details: Record<string, string | number | boolean | null> = {}): Promise<void> {
    const entry = JSON.stringify({ at: new Date().toISOString(), event, ...details });
    this.#pending = this.#pending.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      try {
        if ((await stat(this.#path)).size >= MAX_AUDIT_BYTES) {
          const previous = `${this.#path}.previous`;
          try { await unlink(previous); } catch { /* The previous audit segment may not exist. */ }
          await rename(this.#path, previous);
        }
      } catch { /* The current audit file may not exist yet. */ }
      await appendFile(this.#path, `${entry}\n`, "utf8");
    });
    return this.#pending;
  }
}
