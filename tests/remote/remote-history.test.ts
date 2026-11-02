import { describe, expect, it, vi } from "vitest";
import { loadRemoteThread } from "../../electron/main/remote-history";

describe("loadRemoteThread", () => {
  it("hydrates bounded turn and item pages after metadata-only resume", async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: "thread-1", name: "会话", turns: [{ id: "legacy-turn" }] }, cwd: "E:\\Work" };
      if (method === "thread/turns/list") {
        if (params.cursor === null) return { data: [{ id: "turn-2", status: "inProgress" }], nextCursor: "older-turns" };
        return { data: [{ id: "turn-1", status: "completed" }], nextCursor: null };
      }
      if (params.cursor === null) return { data: [{ turnId: "turn-2", item: { id: "item-2", type: "agentMessage", text: "two" } }], nextCursor: "older-items" };
      return { data: [{ turnId: "turn-1", item: { id: "item-1", type: "userMessage", text: "one" } }], nextCursor: null };
    });

    const result = await loadRemoteThread(call, "thread-1");

    expect(call).toHaveBeenNthCalledWith(1, "thread/resume", { threadId: "thread-1", excludeTurns: true });
    expect(call).toHaveBeenCalledWith("thread/turns/list", { threadId: "thread-1", cursor: null, limit: 100, sortDirection: "desc", itemsView: "notLoaded" });
    expect(call).toHaveBeenCalledWith("thread/items/list", { threadId: "thread-1", cursor: null, limit: 100, sortDirection: "desc" });
    expect(result.thread.turns).toEqual([
      { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "userMessage", text: "one" }] },
      { id: "turn-2", status: "inProgress", items: [{ id: "item-2", type: "agentMessage", text: "two" }] }
    ]);
  });

  it("stops at 300 recent entries even when another page exists", async () => {
    const page = Array.from({ length: 100 }, (_, index) => ({ id: `turn-${index}`, status: "completed" }));
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: "thread-1" } };
      if (method === "thread/items/list") return { data: [], nextCursor: null };
      return { data: page, nextCursor: `cursor-${params.cursor ?? "first"}` };
    });

    const result = await loadRemoteThread(call, "thread-1");

    expect(result.thread.turns).toHaveLength(300);
    expect(call.mock.calls.filter(([method]) => method === "thread/turns/list")).toHaveLength(3);
  });

  it("falls back to full turn pages when item pages are not supported yet", async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "thread/resume") return { thread: { id: "thread-1" } };
      if (method === "thread/items/list") throw new Error("thread/items/list is not supported yet");
      if (params.itemsView === "notLoaded") return { data: [{ id: "turn-metadata", status: "completed" }], nextCursor: null };
      return {
        data: [{ id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "fallback" }] }],
        nextCursor: null
      };
    });

    const result = await loadRemoteThread(call, "thread-1");

    expect(call).toHaveBeenCalledWith("thread/resume", { threadId: "thread-1", excludeTurns: true });
    expect(call).toHaveBeenCalledWith("thread/turns/list", { threadId: "thread-1", cursor: null, limit: 100, sortDirection: "desc", itemsView: "full" });
    expect(result.thread.turns).toEqual([
      { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "fallback" }] }
    ]);
  });

  it("does not hide unrelated item pagination failures", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "thread/resume") return { thread: { id: "thread-1" } };
      if (method === "thread/items/list") throw new Error("network unavailable");
      return { data: [], nextCursor: null };
    });

    await expect(loadRemoteThread(call, "thread-1")).rejects.toThrow("network unavailable");
  });
});
