import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { redactSensitiveText } from "./sensitive-data.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class DiagnosticLog {
  readonly #directory: string;
  readonly #activePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = resolve(directory);
    this.#activePath = join(this.#directory, "codex-pane.log");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const cutoff = Date.now() - RETENTION_MS;
    for (const entry of entries) {
      if (!entry.isFile() || !/^codex-pane(?:\.\d+)?\.log$/.test(entry.name)) continue;
      const path = this.#safePath(entry.name);
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    }
  }

  write(payload: unknown): Promise<void> {
    const operation = this.#writeQueue.then(() => this.#write(payload));
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #write(payload: unknown): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await this.#rotateIfNeeded();
    const line = JSON.stringify({ at: new Date().toISOString(), payload: this.#redact(payload, "", 0, { nodes: 2_000 }) });
    await appendFile(this.#activePath, `${line}\n`, "utf8");
  }

  async tail(maxLines = 200): Promise<string[]> {
    try {
      const content = await readFile(this.#activePath, "utf8");
      return content.split(/\r?\n/).filter(Boolean).slice(-Math.min(maxLines, 500));
    } catch {
      return [];
    }
  }

  async #rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.#activePath)).size < MAX_LOG_BYTES) return;
      const rotated = this.#safePath("codex-pane.1.log");
      try { await unlink(rotated); } catch { /* No previous rotated log. */ }
      await rename(this.#activePath, rotated);
    } catch {
      // A missing active log does not need rotation.
    }
  }

  #safePath(name: string): string {
    if (basename(name) !== name) throw new Error("日志文件名无效。" );
    const path = resolve(this.#directory, name);
    if (dirname(path) !== this.#directory) throw new Error("日志路径无效。" );
    return path;
  }

  #redact(value: unknown, key = "", depth = 0, budget = { nodes: 2_000 }): unknown {
    if (budget.nodes-- <= 0) return "… 已省略其余内容";
    if (/(token|authorization|api.?key|password|secret)/i.test(key)) return "[已隐藏]";
    if (typeof value === "string") {
      return redactSensitiveText(value, true).slice(0, 20_000);
    }
    if (depth >= 8 && value && typeof value === "object") return "… 层级过深，已省略";
    if (Array.isArray(value)) return value.slice(0, 100).map((entry) => this.#redact(entry, "", depth + 1, budget));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([entryKey, entry]) => [entryKey, this.#redact(entry, entryKey, depth + 1, budget)]));
    return value;
  }
}
