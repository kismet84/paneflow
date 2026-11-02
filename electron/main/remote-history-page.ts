import { createHash } from "node:crypto";
import { z } from "zod";
import { projectTurnItems, type AttachmentResolver } from "./remote-projector.js";
import type { MobileItem } from "../../packages/remote-protocol/src/index.js";

const continuationSchema = z.object({ cursor: z.string().nullable(), limit: z.number().int().min(1).max(20), remaining: z.number().int().nonnegative(), fingerprint: z.string() });
const prefix = "paneflow-history-v1:";
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Split oversized turn pages without losing items; never continue against a changed page. */
export async function loadRemoteHistoryPage(call: (method: string, params: unknown) => Promise<unknown>, threadId: string, cursor: string | null, limit: number, resolveAttachments?: AttachmentResolver, registerAttachments?: (raw: unknown) => Promise<void>): Promise<{ items: MobileItem[]; nextCursor: string | null }> {
  const continuation = cursor?.startsWith(prefix) ? continuationSchema.parse(JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString("utf8"))) : null;
  const sourceCursor = continuation ? continuation.cursor : cursor;
  const sourceLimit = continuation?.limit ?? limit;
  let response: Record<string, unknown>;
  try { response = record(await call("thread/turns/list", { threadId, cursor: sourceCursor, limit: sourceLimit, sortDirection: "desc", itemsView: "full" })); }
  catch (error) {
    if (/unsupported|not supported|not found|-32601|不支持/i.test(String(error))) throw new Error("当前 Codex 不支持完整历史分页，请升级电脑端 Codex。");
    throw error;
  }
  if (!Array.isArray(response.data)) throw new Error("当前 Codex 未返回完整历史分页，请升级电脑端 Codex。");
  if (response.data.some(turn => record(turn).itemsView && record(turn).itemsView !== "full")) throw new Error("当前 Codex 未返回完整消息正文，请升级电脑端 Codex。");
  // Older servers may omit itemsView, but an explicit items array is always required.
  // Missing/non-array items means unloaded or malformed content, not an empty history.
  if (response.data.some(turn => !Array.isArray(record(turn).items))) throw new Error("当前 Codex 未返回完整消息正文，请升级电脑端 Codex。");
  const rawThread={ id: threadId, turns: [...response.data].reverse() };
  await registerAttachments?.(rawThread);
  const all = projectTurnItems(rawThread, resolveAttachments);
  const fingerprint = createHash("sha256").update(JSON.stringify(all)).digest("hex");
  if (continuation && continuation.fingerprint !== fingerprint) throw new Error("历史分页内容已变化，请刷新会话后重新加载；未跳过历史消息。");
  const end = continuation?.remaining ?? all.length;
  let start = end;
  let bytes = 0;
  while (start > 0) {
    const itemBytes = Buffer.byteLength(JSON.stringify(all[start - 1])) + 1;
    if (bytes + itemBytes > MAX_PAGE_BYTES) break;
    bytes += itemBytes;
    start--;
  }
  if (start === end && end > 0) throw new Error("单条历史消息超过传输上限，请在电脑端查看。");
  return { items: all.slice(start, end), nextCursor: start > 0 ? prefix + Buffer.from(JSON.stringify({ cursor: sourceCursor, limit: sourceLimit, remaining: start, fingerprint })).toString("base64url") : typeof response.nextCursor === "string" ? response.nextCursor : null };
}
