import { z } from "zod";

export * from "./relay.js";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const MAX_REMOTE_MESSAGE_BYTES = 256 * 1024;
export const MAX_REMOTE_TEXT_LENGTH = 20_000;

const idSchema = z.string().min(1).max(200);
const requestIdSchema = z.string().uuid();
const approvalChoiceValueSchema = z.union([z.string().max(2_000), z.number().finite(), z.boolean()]);
export const attachmentSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(180), mime: z.string().min(1).max(100), size: z.number().int().min(1).max(20 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(["image", "file"]), available: z.boolean().optional() });
export type Attachment = z.infer<typeof attachmentSchema>;

export const mobileCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attachment.begin"), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema, name: z.string().min(1).max(180), mime: z.string().min(1).max(100), size: z.number().int().min(1).max(20 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ type: z.literal("attachment.chunk"), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema, offset: z.number().int().nonnegative(), data: z.string().min(4).max(65536) }),
  z.object({ type: z.literal("attachment.finish"), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema }),
  z.object({ type: z.literal("attachment.status"), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema }),
  z.object({ type: z.literal("attachment.cancel"), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema }),
  z.object({ type: z.literal("attachment.read"), requestId: requestIdSchema, threadId: idSchema, attachmentId: requestIdSchema, offset: z.number().int().nonnegative() }),
  z.object({ type: z.literal("attachment.delete"), requestId: requestIdSchema, threadId: idSchema, attachmentId: requestIdSchema }),
  z.object({ type: z.literal("queue.enqueue"), requestId: requestIdSchema, cwd: z.string().trim().min(1).max(4096), text: z.string().trim().min(1).max(MAX_REMOTE_TEXT_LENGTH), model: idSchema.optional(), effort: z.string().min(1).max(50).optional() }),
  z.object({ type: z.literal("queue.cancel"), requestId: requestIdSchema, taskId: idSchema }),
  z.object({ type: z.literal("queue.pause"), requestId: requestIdSchema, paused: z.boolean() }),
  z.object({ type: z.literal("queue.stop"), requestId: requestIdSchema, taskId: idSchema, threadId: idSchema, turnId: idSchema }),
  z.object({ type: z.literal("queue.reconcile"), requestId: requestIdSchema, taskId: idSchema, resolution: z.enum(["completed", "failed", "cancelled"]) }),
  z.object({ type: z.literal("task.detail"), requestId: requestIdSchema, taskId: idSchema.optional(), threadId: idSchema.optional() }),
  z.object({ type: z.literal("approval.decide"), requestId: requestIdSchema, approvalId: idSchema, threadId: idSchema, version: z.number().int().positive(), decision: z.enum(["accept", "decline"]), selection: approvalChoiceValueSchema.optional() }),
  z.object({ type: z.literal("request.status"), requestId: requestIdSchema, requestIds: z.array(requestIdSchema).min(1).max(100) }),
  z.object({ type: z.literal("history.list"), requestId: requestIdSchema, threadId: idSchema, cursor: z.string().max(8192).nullable().optional(), limit: z.number().int().min(1).max(20).default(20) }),
  z.object({ type: z.literal("usage.get"), requestId: requestIdSchema, threadId: idSchema.optional() }),
  z.object({ type: z.literal("snapshot.get"), requestId: requestIdSchema }),
  z.object({ type: z.literal("thread.list"), requestId: requestIdSchema, cursor: z.string().max(8192).nullable().optional(), limit: z.number().int().min(1).max(100).optional(), searchTerm: z.string().trim().max(1000).optional() }),
  z.object({ type: z.literal("thread.open"), requestId: requestIdSchema, threadId: idSchema }),
  z.object({ type: z.literal("thread.new"), requestId: requestIdSchema, cwd: z.string().trim().min(1).max(4_096).optional(), model: idSchema.optional(), effort: z.string().min(1).max(50).optional(), text: z.string().trim().min(1).max(MAX_REMOTE_TEXT_LENGTH).optional() }),
  z.object({ type: z.literal("turn.send"), requestId: requestIdSchema, threadId: idSchema, text: z.string().trim().max(MAX_REMOTE_TEXT_LENGTH), attachmentIds: z.array(requestIdSchema).max(8).optional() }),
  z.object({ type: z.literal("turn.interrupt"), requestId: requestIdSchema, threadId: idSchema, turnId: idSchema }),
  z.object({ type: z.literal("thread.fork"), requestId: requestIdSchema, threadId: idSchema, name: z.string().trim().min(1).max(200).optional() }),
  z.object({ type: z.literal("thread.configure"), requestId: requestIdSchema, threadId: idSchema, model: idSchema, effort: z.string().min(1).max(50) }),
  z.object({ type: z.literal("remote.disable"), requestId: requestIdSchema }),
  z.object({
    type: z.literal("approval.resolve"),
    requestId: requestIdSchema,
    approvalId: idSchema,
    threadId: idSchema,
    version: z.number().int().positive(),
    decision: z.enum(["accept", "decline"]),
    selection: approvalChoiceValueSchema.optional()
  })
]);

export const mobileApprovalSchema = z.object({
  id: idSchema,
  kind: z.literal("approval"),
  title: z.string().max(200),
  summary: z.string().max(4_000),
  version: z.number().int().positive(),
  decisions: z.array(z.enum(["accept", "decline"])).length(2),
  choices: z.array(z.object({ label: z.string().min(1).max(500), value: approvalChoiceValueSchema })).min(1).max(50).optional()
});

export const mobileItemSchema = z.discriminatedUnion("kind", [
  z.object({ id: idSchema, kind: z.literal("user"), text: z.string().max(MAX_REMOTE_TEXT_LENGTH), attachments: z.array(attachmentSchema).max(8).optional(), status: z.enum(["running", "completed", "failed"]) }),
  z.object({ id: idSchema, kind: z.literal("agent"), markdown: z.string().max(200_000), presentation: z.literal("plan").optional(), attachments: z.array(attachmentSchema).max(8).optional(), status: z.enum(["running", "completed", "failed"]) }),
  z.object({ id: idSchema, kind: z.literal("activity"), title: z.string().max(200), summary: z.string().max(4_000), detail: z.string().max(20_000).optional(), status: z.enum(["running", "completed", "failed"]) }),
  mobileApprovalSchema
]);

export const threadSummarySchema = z.object({
  id: idSchema,
  cwd: z.string().max(4096).optional(),
  title: z.string().max(200),
  preview: z.string().max(1_000),
  updatedAt: z.number().nonnegative(),
  status: z.enum(["idle", "running", "waiting", "failed", "unknown"]),
  goalStatus: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).nullable().optional(),
  goalStateKnown: z.boolean().optional(),
  completion: z.object({ id: idSchema, completedAt: z.number().nonnegative() }).nullable().optional(),
  unread: z.boolean()
});

export const queueStateSchema = z.enum(["pending", "dispatching", "running", "waiting", "unknown", "completed", "failed", "cancelled"]);
export const queueTaskSchema = z.object({ id: idSchema, requestId: requestIdSchema, title: z.string().max(200), cwd: z.string().max(4096), createdAt: z.number(), updatedAt: z.number(), queueState: queueStateSchema, threadId: idSchema.optional(), turnId: idSchema.optional(), lastError: z.string().max(2000).optional() });
export const queueSnapshotSchema = z.object({ paused: z.boolean(), pauseReason: z.string().max(2000).optional(), activeTaskId: idSchema.nullable(), tasks: z.array(queueTaskSchema).max(500) });
export const centerApprovalSchema = z.object({ threadId: idSchema, cwd: z.string().max(4096), updatedAt: z.number(), approval: mobileApprovalSchema });
export const taskDetailSchema = z.object({ taskId: idSchema.optional(), threadId: idSchema.optional(), cwd: z.string().max(4096), updatedAt: z.number(), goalStatus: z.string().nullable(), turnStatus: z.enum(["idle", "running", "waiting", "failed", "unknown"]), queueState: queueStateSchema.optional(), controllable: z.boolean(), readOnly: z.boolean(), currentStep: z.string().max(2000), activities: z.array(mobileItemSchema).max(100), lastError: z.string().max(2000).optional(), approvals: z.array(centerApprovalSchema) });
export type QueueTask = z.infer<typeof queueTaskSchema>;
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>;
export type CenterApproval = z.infer<typeof centerApprovalSchema>;
export type TaskDetail = z.infer<typeof taskDetailSchema>;

export const mobileSnapshotSchema = z.object({
  serverTime: z.number().nonnegative().optional(),
  readOnly: z.boolean().optional(),
  readOnlyReason: z.string().max(1000).optional(),
  readOnlyUpdatedAt: z.number().nonnegative().optional(),
  capabilities: z.array(z.enum(["independentSessions", "requestStatus", "historyPagination", "taskQueue", "taskDetails", "approvalCenter", "attachmentsV1", "usageSummary"])).optional(),
  queue: queueSnapshotSchema.optional(),
  approvals: z.array(centerApprovalSchema).optional(),
  deviceOnline: z.boolean(),
  codexState: z.enum(["ready", "starting", "error", "stopped"]),
  codexMessage: z.string().max(1_000),
  appearance: z.object({ theme: z.enum(["system", "dark", "light"]), accentColor: z.string().regex(/^#[0-9a-f]{6}$/i) }),
  activeThreadId: idSchema.nullable(),
  activeThreadTitle: z.string().max(200),
  activeTurnId: idSchema.nullable().default(null),
  models: z.array(z.object({ id: idSchema, displayName: z.string().max(200), efforts: z.array(z.string().max(50)) })).default([]),
  selectedModel: idSchema.nullable().default(null),
  selectedEffort: z.string().max(50).nullable().default(null),
  turnStatus: z.enum(["idle", "running", "waiting", "failed", "unknown"]),
  threads: z.array(threadSummarySchema).max(100),
  items: z.array(mobileItemSchema).max(1_000)
});

export const usageSummarySchema = z.object({
  updatedAt: z.number().nonnegative(), limitsAvailable: z.boolean(), limitsError: z.string().max(300).optional(),
  windows: z.array(z.object({ name: z.string().max(200), usedPercent: z.number().min(0).max(100), windowMinutes: z.number().positive().optional(), resetsAt: z.number().nonnegative().optional() })).max(40),
  tokensAvailable: z.boolean(), tokensError: z.string().max(300).optional(),
  lifetimeTokens: z.number().int().nonnegative().optional(), peakDailyTokens: z.number().int().nonnegative().optional(), currentStreakDays: z.number().int().nonnegative().optional(),
  threadId: idSchema.optional(), estimatedUsdMicros: z.number().int().nonnegative().optional()
});
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export const desktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("usage.snapshot"), seq: z.number().int().positive(), requestId: requestIdSchema, usage: usageSummarySchema }),
  z.object({ type: z.literal("attachment.deleted"), seq: z.number().int().positive(), requestId: requestIdSchema, threadId: idSchema, attachmentId: requestIdSchema }),
  z.object({ type: z.literal("attachment.status"), seq: z.number().int().positive(), requestId: requestIdSchema, threadId: idSchema, uploadId: requestIdSchema, offset: z.number().int().nonnegative(), complete: z.boolean(), cancelled: z.boolean().optional(), attachment: attachmentSchema.optional() }),
  z.object({ type: z.literal("attachment.chunk"), seq: z.number().int().positive(), requestId: requestIdSchema, threadId: idSchema, attachmentId: requestIdSchema, offset: z.number().int().nonnegative(), data: z.string().max(65536), eof: z.boolean() }),
  z.object({ type: z.literal("task.detail"), seq: z.number().int().positive(), requestId: requestIdSchema, detail: taskDetailSchema }),
  z.object({ type: z.literal("request.status"), seq: z.number().int().positive(), requestId: requestIdSchema, records: z.array(z.object({ requestId: requestIdSchema, status: z.enum(["accepted", "completed", "failed", "unknown"]), message: z.string().max(2000).optional(), threadId: idSchema.optional(), turnId: idSchema.optional() })).max(100) }),
  z.object({ type: z.literal("history.page"), seq: z.number().int().positive(), requestId: requestIdSchema, threadId: idSchema, items: z.array(mobileItemSchema), nextCursor: z.string().max(8192).nullable() }),
  z.object({ type: z.literal("thread.page"), seq: z.number().int().positive(), requestId: requestIdSchema, threads: z.array(threadSummarySchema).max(100), nextCursor: z.string().max(8192).nullable() }),
  z.object({ type: z.literal("snapshot"), seq: z.number().int().positive(), snapshot: mobileSnapshotSchema }),
  z.object({ type: z.literal("device.status"), seq: z.number().int().positive(), online: z.boolean(), codexState: z.enum(["ready", "starting", "error", "stopped"]), message: z.string().max(1_000) }),
  z.object({ type: z.literal("thread.summary"), seq: z.number().int().positive(), thread: threadSummarySchema }),
  z.object({ type: z.literal("item.upsert"), seq: z.number().int().positive(), threadId: idSchema, item: mobileItemSchema }),
  z.object({ type: z.literal("turn.status"), seq: z.number().int().positive(), threadId: idSchema, status: z.enum(["idle", "running", "waiting", "failed", "unknown"]) }),
  z.object({ type: z.literal("approval.request"), seq: z.number().int().positive(), threadId: idSchema, approval: mobileApprovalSchema }),
  z.object({ type: z.literal("desktop.required"), seq: z.number().int().positive(), message: z.string().max(1_000) }),
  z.object({ type: z.literal("notice"), seq: z.number().int().positive(), level: z.enum(["info", "warning", "error"]), message: z.string().max(2_000) }),
  z.object({ type: z.literal("command.result"), seq: z.number().int().positive(), requestId: requestIdSchema, ok: z.boolean(), message: z.string().max(2_000) })
]);

export const routeEnvelopeSchema = z.object({
  version: z.literal(REMOTE_PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  deviceId: idSchema,
  sentAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
  payload: z.unknown()
}).superRefine((value, context) => {
  if (value.expiresAt <= value.sentAt || value.expiresAt - value.sentAt > 60_000) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "消息有效期不正确" });
  }
});

export type MobileCommand = z.infer<typeof mobileCommandSchema>;
export type MobileItem = z.infer<typeof mobileItemSchema>;
export type ThreadSummary = z.infer<typeof threadSummarySchema>;
export type MobileSnapshot = z.infer<typeof mobileSnapshotSchema>;
export type DesktopEvent = z.infer<typeof desktopEventSchema>;
export type RouteEnvelope = z.infer<typeof routeEnvelopeSchema>;

export const createEnvelope = (deviceId: string, payload: unknown, now = Date.now()): RouteEnvelope => ({
  version: REMOTE_PROTOCOL_VERSION,
  messageId: crypto.randomUUID(),
  deviceId,
  sentAt: now,
  expiresAt: now + 30_000,
  payload
});

export const parseEnvelopeText = (text: string): RouteEnvelope => {
  if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_MESSAGE_BYTES) throw new Error("消息超过大小限制");
  return routeEnvelopeSchema.parse(JSON.parse(text));
};
