import { EventEmitter } from "node:events";
import { z } from "zod";
import { queueTaskSchema, type QueueSnapshot, type QueueTask } from "../../packages/remote-protocol/src/index.js";
import { SerialTaskQueue } from "./serial-task-queue.js";

export const storedTaskSchema = queueTaskSchema.extend({ deviceId: z.string(), text: z.string().min(1).max(20_000), model: z.string().optional(), effort: z.string().optional() });
export type StoredQueueTask = z.infer<typeof storedTaskSchema>;
export const storedQueueSchema = z.object({ version: z.literal(1), paused: z.boolean(), pauseReason: z.string().optional(), tasks: z.array(storedTaskSchema).max(500) });
export type StoredQueue = z.infer<typeof storedQueueSchema>;
export interface QueuePersistence { load(): Promise<StoredQueue | null>; save(state: StoredQueue): Promise<void> }
export interface QueueExecutor {
  ready(): boolean;
  dispatch(task: StoredQueueTask, checkpoint: (target: { threadId: string; turnId?: string }) => Promise<void>): Promise<{ threadId: string; turnId: string }>;
  inspect(task: StoredQueueTask): Promise<"completed" | "failed" | "unknown">;
  stop(task: StoredQueueTask, authorize: () => void): Promise<void>;
}
const activeStates = new Set<QueueTask["queueState"]>(["dispatching", "running", "waiting", "unknown"]);
const terminalStates = new Set<QueueTask["queueState"]>(["completed", "failed", "cancelled"]);

/** A single durable execution slot. Unknown results block dispatch until explicitly reconciled. */
export class RemoteTaskQueue extends EventEmitter {
  #state: StoredQueue = { version: 1, paused: false, tasks: [] };
  readonly #serial = new SerialTaskQueue();
  #available = false;
  #recoveryRequired = false;
  #pumpScheduled = false;
  #fault: string | undefined;
  constructor(readonly persistence: QueuePersistence, readonly executor: QueueExecutor, readonly now = Date.now) { super(); }

  async initialize(): Promise<void> {
    const stored = await this.persistence.load();
    if (stored) this.#state = storedQueueSchema.parse(stored);
    if (this.#state.tasks.filter(task => activeStates.has(task.queueState)).length > 1) throw new Error("队列执行槽状态损坏，已停止加载并保留原数据。");
    this.#recoveryRequired = this.hasActiveWork() && this.#active()?.queueState !== "unknown";
    if (this.#active()?.queueState === "unknown" && !this.#state.paused) await this.#commit({ ...this.#state, paused: true, pauseReason: "存在结果待核对任务，需人工终结后继续。" });
  }

  snapshot(): QueueSnapshot {
    return { paused: this.#fault ? true : this.#state.paused, pauseReason: this.#fault ?? this.#state.pauseReason, activeTaskId: this.#active()?.id ?? null, tasks: this.#state.tasks.map(task => queueTaskSchema.parse(task)) };
  }
  getPendingWork(): QueueTask[] { return this.snapshot().tasks.filter(task => !terminalStates.has(task.queueState)); }
  hasActiveWork(): boolean { return this.#state.tasks.some(task => activeStates.has(task.queueState)); }
  getTask(id: string): QueueTask | undefined { const task = this.#state.tasks.find(item => item.id === id); return task ? queueTaskSchema.parse(task) : undefined; }

  failClosed(): void { this.#fault = "任务队列存储或恢复异常，已停止派发并保留执行槽；请检查存储后重启恢复。"; this.#available = false; this.emit("changed"); }
  #assertHealthy(): void { if (this.#fault) throw new Error(this.#fault); }

  setAvailable(available: boolean): void { this.#available = available && !this.#fault; if (available) this.kick(); }
  kick(): void {
    if (this.#pumpScheduled || !this.#available) return;
    this.#pumpScheduled = true;
    queueMicrotask(() => { void this.#serial.enqueue(() => this.#pump()).catch(() => { this.failClosed(); }).finally(() => { this.#pumpScheduled = false; }); });
  }

  async enqueue(task: Pick<StoredQueueTask, "id" | "requestId" | "deviceId" | "cwd" | "text" | "model" | "effort">): Promise<void> {
    await this.#serial.enqueue(async () => {
      this.#assertHealthy();
      if (this.#state.tasks.some(item => item.id === task.id)) return;
      const tasks = [...this.#state.tasks];
      if (tasks.length >= 500) { const index = tasks.findIndex(item => terminalStates.has(item.queueState)); if (index < 0) throw new Error("队列已满，请先完成或取消任务。"); tasks.splice(index, 1); }
      const time = this.now();
      tasks.push(storedTaskSchema.parse({ ...task, title: task.text.slice(0, 200), createdAt: time, updatedAt: time, queueState: "pending" }));
      await this.#commit({ ...this.#state, tasks });
    });
    this.kick();
  }

  async cancel(id: string): Promise<void> {
    await this.#serial.enqueue(async () => { this.#assertHealthy(); const task = this.#require(id); if (task.queueState !== "pending") throw new Error("只能取消待执行任务。"); await this.#update(id, { queueState: "cancelled" }); });
  }
  async pause(paused: boolean): Promise<void> {
    await this.#serial.enqueue(async () => {
      this.#assertHealthy();
      if (!paused && this.#state.tasks.some(task => task.queueState === "unknown")) throw new Error("存在结果待核对的任务，请先人工核对终结。");
      await this.#commit({ ...this.#state, paused, pauseReason: paused ? "用户暂停派发" : undefined });
    });
    if (!paused) this.kick();
  }
  async reconcile(id: string, resolution: "completed" | "failed" | "cancelled"): Promise<void> {
    await this.#serial.enqueue(async () => { this.#assertHealthy(); const task = this.#require(id); if (task.queueState !== "unknown") throw new Error("只有结果待核对任务可人工终结。"); await this.#update(id, { queueState: resolution, lastError: "用户已人工核对结果；队列保持暂停，需手动继续。" }); });
  }
  async stopCurrent(id: string, threadId: string, turnId: string, authorize: () => void = () => {}): Promise<void> {
    await this.#serial.enqueue(async () => {
      this.#assertHealthy(); authorize();
      const task = this.#require(id);
      if (this.#active()?.id !== id || !["running", "waiting"].includes(task.queueState) || task.threadId !== threadId || task.turnId !== turnId) throw new Error("执行目标已变化，请刷新后停止准确的任务。");
      await this.#update(id, { lastError: "已请求停止，等待 Codex 确认终止。" });
      try { authorize(); await this.executor.stop(structuredClone(task), authorize); }
      catch { await this.#unknown(id, "停止结果无法确认，请核对当前任务。"); throw new Error("停止结果无法确认，队列已暂停，请核对当前任务。"); }
    });
  }

  async onTurn(threadId: string, turnId: string, state: "running" | "waiting" | "completed" | "failed", lastError?: string): Promise<void> {
    await this.#serial.enqueue(async () => {
      this.#assertHealthy();
      const active = this.#active();
      if (!active || active.queueState === "unknown" || active.threadId !== threadId || active.turnId !== turnId) return;
      await this.#update(active.id, { queueState: state, ...(lastError ? { lastError: lastError.slice(0, 2000) } : {}) });
    });
    if (terminalStates.has(state)) this.kick();
  }
  async requireRecovery(): Promise<void> {
    await this.#serial.enqueue(async () => { this.#recoveryRequired = this.hasActiveWork() && this.#active()?.queueState !== "unknown"; });
    this.kick();
  }

  #active(): StoredQueueTask | undefined { return this.#state.tasks.find(task => activeStates.has(task.queueState)); }
  #require(id: string): StoredQueueTask { const task = this.#state.tasks.find(item => item.id === id); if (!task) throw new Error("队列任务不存在，请刷新。"); return task; }
  async #commit(state: StoredQueue): Promise<void> {
    try { await this.persistence.save(state); }
    catch (error) { this.failClosed(); throw error; }
    this.#state = structuredClone(state); this.emit("changed");
  }
  async #update(id: string, patch: Partial<StoredQueueTask>): Promise<void> {
    await this.#commit({ ...this.#state, tasks: this.#state.tasks.map(task => task.id === id ? { ...task, ...patch, updatedAt: this.now() } : task) });
  }
  async #unknown(id: string, message: string): Promise<void> {
    await this.#commit({ ...this.#state, paused: true, pauseReason: "执行结果待核对，已暂停队列。", tasks: this.#state.tasks.map(task => task.id === id ? { ...task, queueState: "unknown", lastError: message, updatedAt: this.now() } : task) });
  }
  async #pump(): Promise<void> {
    if (!this.#available) return;
    if (this.#recoveryRequired) {
      const active = this.#active();
      if (active) {
        let outcome: "completed" | "failed" | "unknown" = "unknown";
        try { outcome = await this.executor.inspect(structuredClone(active)); } catch { /* Unavailable evidence never authorizes replay. */ }
        if (outcome === "unknown") await this.#unknown(active.id, "重启或连接恢复后无法证明执行结果，请打开关联会话人工核对。禁止自动重新执行。");
        else await this.#update(active.id, { queueState: outcome });
      }
      this.#recoveryRequired = false;
    }
    if (this.#state.paused || this.#active() || !this.executor.ready()) return;
    const next = this.#state.tasks.find(task => task.queueState === "pending");
    if (!next) return;
    // Commit before entering dispatch; crash at any later boundary must not replay this payload.
    await this.#update(next.id, { queueState: "dispatching" });
    try {
      const result = await this.executor.dispatch(structuredClone(this.#require(next.id)), async target => this.#update(next.id, target));
      await this.#update(next.id, { ...result, queueState: "running" });
    } catch {
      await this.#unknown(next.id, "任务派发结果无法确认。请检查关联会话，不能自动重新执行。");
    }
  }
}
