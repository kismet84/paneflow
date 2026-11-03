import { readLocalRuntime, readLocalCompletion, type LocalCompletion } from "./remote-local-runtime.js";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
type Entry = { expires: number; type: string; completion: LocalCompletion | null; completionGoal?: { goalStateKnown: boolean; goalStatus: unknown } };
/** notLoaded describes this app-server, not the runtime of another Codex window. */
export class RemoteRuntimeCatalog {
  #cache = new Map<string, Entry>();
  #pending = new Map<string, Promise<void>>();
  #queue: Array<() => Promise<void>> = [];
  #active = 0;
  constructor(private readonly call: (method: string, params: unknown) => Promise<unknown>, private readonly now = Date.now, private readonly local = readLocalRuntime, private readonly completion = readLocalCompletion) {}
  #schedule(id: string, row: Record<string, unknown>): Promise<void> {
    const existing = this.#pending.get(id); if (existing) return existing;
    let done!: () => void;
    const promise = new Promise<void>(resolve => { done = resolve; });
    this.#pending.set(id, promise);
    this.#queue.push(async () => {
      let type = "unknown";
      let completion: LocalCompletion | null = null;
      let completionGoal: Entry["completionGoal"];
      try {
        completion = await this.completion(row);
        if (completion) {
          // The independent goal catalog can be older than this final marker.
          // Never interpret its cached null as permission to notify a newly goal-backed task.
          completionGoal = { goalStateKnown: false, goalStatus: null };
          try {
            const result = record(await this.call("thread/goal/get", { threadId: id }));
            if (Object.hasOwn(result, "goal")) completionGoal = { goalStateKnown: true, goalStatus: record(result.goal).status ?? null };
          } catch { /* No ordinary completion notification without fresh goal evidence. */ }
        }
        if (record(row.status).type !== "notLoaded") return;
        const page = record(await this.call("thread/turns/list", { threadId: id, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }));
        const local = await this.local(row);
        const turn = record(Array.isArray(page.data) ? page.data[0] : undefined);
        if (local === "active" || local === "unknown") type = local;
        else if (local === "idle") type = turn.status === "failed" ? "failed" : "idle";
        else if (turn.status === "inProgress") type = "active";
        else if (turn.status === "failed") type = "failed";
        // Unloaded history may synthesize completed/interrupted for an active external writer.
        // Without local end evidence these are unknown.
      } catch { /* Unknown is deliberately not idle. */ }
      finally { this.#cache.set(id, { expires: this.now() + 5_000, type, completion, completionGoal }); this.#pending.delete(id); done(); }
    });
    this.#pump(); return promise;
  }
  #pump(): void {
    while (this.#active < 4 && this.#queue.length) {
      this.#active++; void this.#queue.shift()!().finally(() => { this.#active--; this.#pump(); });
    }
  }
  async enrich(rows: unknown[]): Promise<Record<string, unknown>[]> {
    const values = rows.map(record);
    const work = values.flatMap(row => typeof row.id === "string" && (!this.#cache.has(row.id) || this.#cache.get(row.id)!.expires <= this.now()) ? [this.#schedule(row.id, row)] : []);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(work), new Promise<void>(resolve => { timer = setTimeout(resolve, 150); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    const result = values.map(row => {
      const entry = this.#cache.get(String(row.id));
      const fresh = entry && entry.expires > this.now();
      return { ...row, completion: fresh ? entry.completion : null,
        ...(fresh ? entry.completionGoal : {}),
        ...(record(row.status).type === "notLoaded" ? { runtimeStatus: { type: fresh ? entry.type : "unknown" } } : {}) };
    });
    if (this.#cache.size > 2_000) for (const [id, entry] of this.#cache) if (entry.expires <= this.now()) this.#cache.delete(id);
    return result;
  }
}
