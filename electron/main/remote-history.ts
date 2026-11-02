const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const REMOTE_HISTORY_PAGE_SIZE = 100;
const MAX_REMOTE_HISTORY_ENTRIES = 300;

type AppServerCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const loadPages = async (call: AppServerCall, method: "thread/turns/list" | "thread/items/list", threadId: string, turnItemsView: "notLoaded" | "full" = "notLoaded"): Promise<unknown[]> => {
  const data: unknown[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const response = record(await call(method, method === "thread/turns/list"
      ? { threadId, cursor, limit: REMOTE_HISTORY_PAGE_SIZE, sortDirection: "desc", itemsView: turnItemsView }
      : { threadId, cursor, limit: REMOTE_HISTORY_PAGE_SIZE, sortDirection: "desc" }));
    if (Array.isArray(response.data)) data.push(...response.data);
    const nextCursor = text(response.nextCursor) || null;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (data.length < MAX_REMOTE_HISTORY_ENTRIES);
  return data.slice(0, MAX_REMOTE_HISTORY_ENTRIES).reverse();
};

const isUnsupportedItemsList = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : String(error).toLocaleLowerCase();
  return message.includes("thread/items/list") && (message.includes("not supported") || message.includes("unsupported") || message.includes("not found") || message.includes("不支持"));
};

export const loadRemoteThread = async (call: AppServerCall, threadId: string): Promise<{ response: Record<string, unknown>; thread: Record<string, unknown> }> => {
  const response = record(await call("thread/resume", { threadId, excludeTurns: true }));
  let rawTurns: unknown[];
  let rawEntries: unknown[];
  let usesSeparateItems = true;
  try {
    [rawTurns, rawEntries] = await Promise.all([
      loadPages(call, "thread/turns/list", threadId),
      loadPages(call, "thread/items/list", threadId)
    ]);
  } catch (error) {
    if (!isUnsupportedItemsList(error)) throw error;
    rawTurns = await loadPages(call, "thread/turns/list", threadId, "full");
    rawEntries = [];
    usesSeparateItems = false;
  }
  const itemsByTurn = new Map<string, unknown[]>();
  for (const rawEntry of rawEntries) {
    const entry = record(rawEntry);
    const turnId = text(entry.turnId);
    if (!turnId || !entry.item) continue;
    const items = itemsByTurn.get(turnId) ?? [];
    items.push(entry.item);
    itemsByTurn.set(turnId, items);
  }
  const turns = rawTurns.map((rawTurn) => {
    const turn = record(rawTurn);
    return { ...turn, items: usesSeparateItems ? itemsByTurn.get(text(turn.id)) ?? [] : Array.isArray(turn.items) ? turn.items : [] };
  });
  return { response, thread: { ...record(response.thread), turns } };
};
