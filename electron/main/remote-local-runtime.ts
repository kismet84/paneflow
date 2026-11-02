import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, isAbsolute } from "node:path";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
export function latestLifecycle(lines: string): { type: "started" | "ended"; turnId: string } | null {
  const values = lines.split("\n");
  // Ignore a partially appended final JSON line.
  if (!lines.endsWith("\n")) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    try {
      const value = record(JSON.parse(values[i]!)), payload = record(value.payload);
      if (value.type !== "event_msg" || typeof payload.turn_id !== "string") continue;
      if (payload.type === "task_started") return { type: "started", turnId: payload.turn_id };
      if (["task_complete", "turn_aborted"].includes(String(payload.type))) return { type: "ended", turnId: payload.turn_id };
    } catch { /* Partial first line or non-JSON line. */ }
  }
  return null;
}

/** Windows-only read evidence. Never acquires/removes a writer lock or resumes a thread. */
export async function readLocalRuntime(raw: Record<string, unknown>): Promise<string | null> {
  if (process.platform !== "win32" || typeof raw.path !== "string" || typeof raw.id !== "string" || !/^[a-f0-9-]{36}$/.test(raw.id)) return null;
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  let file;
  try {
    const [root, path] = await Promise.all([realpath(join(home, "sessions")), realpath(raw.path)]);
    const rel = relative(root, path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !basename(path).endsWith(`${raw.id}.jsonl`)) return null;
    file = await open(path, "r");
    const stat = await file.stat(), size = Math.min(stat.size, 512 * 1024);
    const buffer = Buffer.alloc(size); const read = await file.read(buffer, 0, size, stat.size - size);
    const lifecycle = latestLifecycle(buffer.subarray(0, read.bytesRead).toString("utf8"));
    if (!lifecycle) return "unknown";
    if (lifecycle.type === "ended") return "idle";
    // A stale task_started after a crashed owner must not be called running.
    let lock;
    try {
      lock = await open(join(home, "thread-writer-locks", `${raw.id}.lock`), "r");
      await lock.read(Buffer.alloc(1), 0, 1, 0);
      return "unknown";
    } catch (error) {
      return record(error).code === "EBUSY" ? "active" : "unknown";
    } finally { await lock?.close(); }
  } catch { return "unknown"; }
  finally { await file?.close(); }
}
