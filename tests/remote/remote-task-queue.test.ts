import { describe, expect, it, vi } from "vitest";
import { RemoteTaskQueue, type QueueExecutor, type QueuePersistence, type StoredQueue, type StoredQueueTask } from "../../electron/main/remote-task-queue";

const input = (id: string) => ({ id, requestId: crypto.randomUUID(), deviceId: "phone-a", cwd: "D:/workspace", text: `prompt-${id}`, model: "model-a", effort: "high" });
class MemoryStore implements QueuePersistence {
  value: StoredQueue | null = null;
  writes: StoredQueue[] = [];
  fail = false;
  async load() { return structuredClone(this.value); }
  async save(state: StoredQueue) { if (this.fail) throw new Error("disk unavailable"); this.value = structuredClone(state); this.writes.push(structuredClone(state)); }
}
const setup = async (store = new MemoryStore(), override: Partial<QueueExecutor> = {}) => {
  const executor: QueueExecutor = {
    ready: () => true,
    dispatch: vi.fn(async (task, checkpoint) => { await checkpoint({ threadId: `thread-${task.id}` }); await checkpoint({ threadId: `thread-${task.id}`, turnId: `turn-${task.id}` }); return { threadId: `thread-${task.id}`, turnId: `turn-${task.id}` }; }),
    inspect: vi.fn(async () => "unknown" as const), stop: vi.fn(async () => {}), ...override
  };
  const queue = new RemoteTaskQueue(store, executor);
  await queue.initialize();
  return { queue, store, executor };
};
const until = (check: () => void) => vi.waitFor(check, { interval: 5, timeout: 1000 });

describe("durable single-slot task queue", () => {
  it("persists the dispatch tombstone before effects and holds the slot throughout approval", async () => {
    const h = await setup();
    await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b"));
    h.queue.setAvailable(true);
    await until(() => expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running"));
    expect(h.store.writes.find(state => state.tasks[0]?.queueState === "dispatching")?.tasks[0]?.threadId).toBeUndefined();
    await h.queue.onTurn("thread-a", "turn-a", "waiting");
    h.queue.kick();
    expect(h.queue.snapshot().activeTaskId).toBe("a");
    expect(h.executor.dispatch).toHaveBeenCalledTimes(1);
    await h.queue.onTurn("thread-a", "wrong-turn", "completed");
    expect(h.executor.dispatch).toHaveBeenCalledTimes(1);
    await h.queue.onTurn("thread-a", "turn-a", "running");
    expect(h.executor.dispatch).toHaveBeenCalledTimes(1);
    await h.queue.onTurn("thread-a", "turn-a", "completed");
    await until(() => expect(h.executor.dispatch).toHaveBeenCalledTimes(2));
    expect(h.queue.snapshot().tasks.map(task => task.queueState)).toEqual(["completed", "running"]);
    expect((h.queue.snapshot().tasks[0] as unknown as Record<string, unknown>).text).toBeUndefined();
  });

  it("pauses only dispatch, cancels pending, and validates all stop targets", async () => {
    const h = await setup();
    await h.queue.pause(true); await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b"));
    h.queue.setAvailable(true);
    await h.queue.cancel("b");
    expect(h.executor.dispatch).not.toHaveBeenCalled();
    await h.queue.pause(false);
    await until(() => expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running"));
    await expect(h.queue.cancel("a")).rejects.toThrow("待执行");
    await expect(h.queue.stopCurrent("a", "thread-b", "turn-a")).rejects.toThrow("目标");
    expect(h.executor.stop).not.toHaveBeenCalled();
    await h.queue.stopCurrent("a", "thread-a", "turn-a");
    expect(h.executor.stop).toHaveBeenCalledTimes(1);
    expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running");
    await h.queue.onTurn("thread-a", "turn-a", "failed");
    expect(h.queue.snapshot().tasks.map(task => task.queueState)).toEqual(["failed", "cancelled"]);
  });

  it("persists returned targets before a partial dispatch failure and never replays after restart", async () => {
    const h = await setup(undefined, { dispatch: vi.fn(async (task, checkpoint) => { await checkpoint({ threadId: "created-target" }); throw new Error("connection lost"); }) });
    await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b")); h.queue.setAvailable(true);
    await until(() => expect(h.queue.snapshot().paused).toBe(true));
    expect(h.store.value?.tasks[0]).toMatchObject({ queueState: "unknown", threadId: "created-target" });
    h.queue.setAvailable(false);
    const restarted = await setup(h.store);
    restarted.queue.setAvailable(true);
    await expect(restarted.queue.pause(false)).rejects.toThrow("人工核对");
    expect(restarted.executor.inspect).not.toHaveBeenCalled();
    expect(restarted.executor.dispatch).not.toHaveBeenCalled();
    await expect(restarted.queue.pause(false)).rejects.toThrow("人工核对");
    await restarted.queue.reconcile("a", "failed");
    expect(restarted.queue.snapshot().paused).toBe(true);
    expect(restarted.executor.dispatch).not.toHaveBeenCalled();
    await restarted.queue.pause(false);
    await until(() => expect(restarted.executor.dispatch).toHaveBeenCalledTimes(1));
    expect((restarted.executor.dispatch as any).mock.calls[0][0].id).toBe("b");
  });

  it("checks a recovered running target before allowing the next FIFO item", async () => {
    const h = await setup();
    await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b")); h.queue.setAvailable(true);
    await until(() => expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running"));
    h.queue.setAvailable(false);
    const restarted = await setup(h.store, { inspect: vi.fn(async () => "completed" as const) });
    restarted.queue.setAvailable(true);
    await until(() => expect(restarted.executor.dispatch).toHaveBeenCalledTimes(1));
    expect(restarted.executor.inspect).toHaveBeenCalledWith(expect.objectContaining({ id: "a", threadId: "thread-a", turnId: "turn-a" }));
    expect((restarted.executor.dispatch as any).mock.calls[0][0].id).toBe("b");
  });

  it("does not dispatch when the durable tombstone cannot be saved", async () => {
    const h = await setup(); await h.queue.enqueue(input("a")); h.store.fail = true; h.queue.setAvailable(true);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.executor.dispatch).not.toHaveBeenCalled();
    expect(h.store.value?.tasks[0]?.queueState).toBe("pending");
    expect(h.queue.snapshot()).toMatchObject({ paused: true, pauseReason: expect.stringContaining("存储") });
  });

  it.each(["waiting", "completed"] as const)("fails closed and retains the slot when a %s notification cannot persist", async state => {
    const h = await setup(); await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b")); h.queue.setAvailable(true);
    await until(() => expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running"));
    h.store.fail = true;
    await expect(h.queue.onTurn("thread-a", "turn-a", state)).rejects.toThrow("disk");
    expect(h.queue.snapshot()).toMatchObject({ paused: true, activeTaskId: "a", pauseReason: expect.stringContaining("存储") });
    expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running");
    h.store.fail = false;
    await expect(h.queue.pause(false)).rejects.toThrow("重启");
    h.queue.setAvailable(true); h.queue.kick();
    expect(h.executor.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain stops occupying the slot and pauses rather than starting the next task", async () => {
    const h = await setup(undefined, { stop: async () => { throw new Error("transport lost"); } });
    await h.queue.enqueue(input("a")); await h.queue.enqueue(input("b")); h.queue.setAvailable(true);
    await until(() => expect(h.queue.snapshot().tasks[0]?.queueState).toBe("running"));
    await expect(h.queue.stopCurrent("a", "thread-a", "turn-a")).rejects.toThrow("无法确认");
    expect(h.queue.snapshot()).toMatchObject({ paused: true, activeTaskId: "a" });
    expect(h.queue.snapshot().tasks[0]?.queueState).toBe("unknown");
    expect(h.executor.dispatch).toHaveBeenCalledTimes(1);
  });
});
