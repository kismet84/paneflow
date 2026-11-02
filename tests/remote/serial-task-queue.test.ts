import { describe, expect, it } from "vitest";
import { SerialTaskQueue } from "../../electron/main/serial-task-queue";

describe("SerialTaskQueue", () => {
  it("keeps async remote frames ordered", async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    let markFirstStarted = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = queue.enqueue(async () => {
      order.push("first-start");
      markFirstStarted();
      await firstGate;
      order.push("first-end");
    });
    const second = queue.enqueue(async () => { order.push("second"); });

    await firstStarted;
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after a rejected task", async () => {
    const queue = new SerialTaskQueue();
    await expect(queue.enqueue(async () => { throw new Error("invalid frame"); })).rejects.toThrow("invalid frame");
    await expect(queue.enqueue(async () => "next frame")).resolves.toBe("next frame");
  });
});
