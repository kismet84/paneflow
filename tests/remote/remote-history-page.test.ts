import { describe, expect, it, vi } from "vitest";
import { loadRemoteHistoryPage } from "../../electron/main/remote-history-page";

describe("full remote history pages", () => {
  it.each([{ itemsView: "full" }, { itemsView: "full", items: null }, { itemsView: "full", items: {} }, {}, { items: "not loaded" }])("rejects missing or malformed turn items: %j", async (turn) => {
    await expect(loadRemoteHistoryPage(async () => ({ data: [turn], nextCursor: null }), "thread", null, 20)).rejects.toThrow("完整消息正文");
  });

  it("accepts an explicit empty items array from older servers without itemsView", async () => {
    const page = await loadRemoteHistoryPage(async () => ({ data: [{ items: [] }], nextCursor: null }), "thread", null, 20);
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("splits large turn pages without gaps or duplicate items", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: "x".repeat(180_000) }));
    const call = vi.fn(async () => ({ data: [{ id: "turn", status: "completed", items }], nextCursor: "next-upstream-page" }));
    let cursor: string | null = null;
    let ids: string[] = [];
    do {
      const page = await loadRemoteHistoryPage(call, "thread", cursor, 20);
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThan(2 * 1024 * 1024 + 100);
      ids = [...page.items.map(item => item.id), ...ids];
      cursor = page.nextCursor;
    } while (cursor?.startsWith("paneflow-history-v1:"));
    expect(ids).toEqual(items.map(item => item.id));
    expect(cursor).toBe("next-upstream-page");
    expect(call).toHaveBeenCalledWith("thread/turns/list", expect.objectContaining({ itemsView: "full" }));
  });

  it("refuses a changed continuation instead of skipping items", async () => {
    const data = [{ items: Array.from({ length: 20 }, (_, i) => ({ id: `item-${i}`, type: "agentMessage", text: "x".repeat(180_000) })) }];
    const call = async () => ({ data, nextCursor: null });
    const first = await loadRemoteHistoryPage(call, "thread", null, 20);
    data[0]!.items[0]!.text = "changed";
    await expect(loadRemoteHistoryPage(call, "thread", first.nextCursor, 20)).rejects.toThrow("内容已变化");
  });
});
