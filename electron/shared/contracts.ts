import { z } from "zod";

const shortId = z.string().min(1).max(512);
const nullableString = z.string().max(32_768).nullable();
const textInput = z.object({ type: z.literal("text"), text: z.string().max(200_000), text_elements: z.array(z.unknown()).max(100).default([]) });
const localImageInput = z.object({ type: z.literal("managedImage"), id: z.string().uuid(), detail: z.enum(["low", "high", "auto"]).optional() });
const remoteImageInput = z.object({ type: z.literal("managedRemoteImage"), url: z.string().url().max(8_192), detail: z.enum(["low", "high", "auto"]).optional() });
const managedFileInput = z.object({ type: z.literal("managedFile"), id: z.string().uuid(), name: z.string().min(1).max(512) });
const skillInput = z.object({ type: z.literal("skill"), name: z.string().min(1).max(512), path: z.string().min(1).max(32_768) });
const mentionInput = z.object({ type: z.literal("mention"), name: z.string().min(1).max(512), path: z.string().min(1).max(32_768) });
const userInput = z.union([textInput, localImageInput, remoteImageInput, managedFileInput, skillInput, mentionInput]);
const collaborationMode = z.object({
  mode: z.enum(["default", "plan"]),
  settings: z.object({ model: z.string().max(200), reasoning_effort: z.string().max(50).nullable(), developer_instructions: z.string().max(200_000).nullable() })
});

export const safeRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("model/list"), params: z.object({ limit: z.number().int().min(1).max(200) }) }),
  z.object({ method: z.literal("account/read"), params: z.object({ refreshToken: z.boolean() }) }),
  z.object({ method: z.literal("account/rateLimits/read"), params: z.undefined().optional() }),
  z.object({ method: z.literal("account/usage/read"), params: z.object({ threadId: shortId.nullable().optional() }) }),
  z.object({ method: z.literal("config/read"), params: z.object({ includeLayers: z.boolean(), cwd: nullableString }) }),
  z.object({ method: z.literal("permissionProfile/list"), params: z.object({ cursor: nullableString, limit: z.number().int().min(1).max(100), cwd: nullableString }) }),
  z.object({ method: z.literal("thread/list"), params: z.object({
    limit: z.number().int().min(1).max(100),
    sortKey: z.enum(["created_at", "updated_at"]),
    sortDirection: z.enum(["asc", "desc"]),
    searchTerm: nullableString,
    cwd: nullableString.optional(),
    ancestorThreadId: shortId.nullable().optional(),
    sourceKinds: z.array(z.enum(["subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther"])).max(5).nullable().optional()
  }) }),
  z.object({ method: z.literal("thread/resume"), params: z.object({
    threadId: shortId,
    excludeTurns: z.boolean(),
    initialTurnsPage: z.object({
      limit: z.number().int().min(1).max(100),
      sortDirection: z.literal("desc"),
      itemsView: z.literal("full")
    }).optional()
  }) }),
  z.object({ method: z.literal("thread/unsubscribe"), params: z.object({ threadId: shortId }) }),
  z.object({ method: z.literal("thread/name/set"), params: z.object({ threadId: shortId, name: z.string().trim().min(1).max(200) }) }),
  z.object({ method: z.literal("thread/goal/get"), params: z.object({ threadId: shortId }) }),
  z.object({ method: z.literal("thread/goal/set"), params: z.object({ threadId: shortId, objective: z.string().trim().min(1).max(4_000).optional(), status: z.enum(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]).optional(), tokenBudget: z.number().int().positive().nullable().optional() }).refine((params) => params.objective !== undefined || params.status !== undefined || params.tokenBudget !== undefined, { message: "至少需要更新一项目标设置" }) }),
  z.object({ method: z.literal("thread/goal/clear"), params: z.object({ threadId: shortId }) }),
  z.object({ method: z.literal("collaborationMode/list"), params: z.object({}) }),
  z.object({ method: z.literal("thread/turns/list"), params: z.object({
    threadId: shortId,
    cursor: nullableString,
    limit: z.number().int().min(1).max(100),
    sortDirection: z.literal("desc"),
    itemsView: z.literal("full")
  }) }),
  z.object({ method: z.literal("thread/start"), params: z.object({ cwd: nullableString, model: z.string().max(200).nullable(), ephemeral: z.boolean() }) }),
  z.object({ method: z.literal("thread/settings/update"), params: z.object({
    threadId: shortId,
    cwd: z.string().max(32_768).optional(),
    permissions: z.string().min(1).max(512).optional(),
    approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
    approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]).optional(),
    serviceTier: z.string().max(100).nullable().optional(),
    collaborationMode: collaborationMode.optional()
  }).refine((params) => Object.keys(params).some((key) => key !== "threadId"), { message: "至少需要一项会话设置" }) }),
  z.object({ method: z.literal("turn/start"), params: z.object({ threadId: shortId, clientUserMessageId: shortId.nullable().optional(), input: z.array(userInput).min(1).max(100), model: z.string().max(200).nullable(), effort: z.string().max(50).nullable() }) }),
  z.object({ method: z.literal("turn/steer"), params: z.object({ threadId: shortId, clientUserMessageId: shortId.nullable().optional(), expectedTurnId: shortId, input: z.array(userInput).min(1).max(100) }) }),
  z.object({ method: z.literal("turn/interrupt"), params: z.object({ threadId: shortId, turnId: shortId }) }),
  z.object({ method: z.literal("thread/compact/start"), params: z.object({ threadId: shortId }) }),
  z.object({ method: z.literal("fuzzyFileSearch"), params: z.object({ query: z.string().max(2_000), roots: z.array(z.string().min(1).max(32_768)).min(1).max(1), cancellationToken: nullableString }) }),
  z.object({ method: z.literal("review/start"), params: z.object({ threadId: shortId, target: z.object({ type: z.literal("uncommittedChanges") }), delivery: z.literal("inline") }) }),
  z.object({ method: z.literal("mcpServerStatus/list"), params: z.object({ threadId: shortId.nullable().optional(), limit: z.number().int().min(1).max(100), detail: z.literal("full") }) }),
  z.object({ method: z.literal("mcpServer/oauth/login"), params: z.object({ name: z.string().min(1).max(200), threadId: shortId.nullable().optional(), clientRegistration: z.enum(["auto", "cimd", "dcr"]).nullable().optional(), scopes: z.array(z.string().min(1).max(500)).max(100).nullable().optional() }) }),
  z.object({ method: z.literal("thread/backgroundTerminals/list"), params: z.object({ threadId: shortId, cursor: nullableString.optional(), limit: z.number().int().min(1).max(100).nullable().optional() }) }),
  z.object({ method: z.literal("thread/backgroundTerminals/terminate"), params: z.object({ threadId: shortId, processId: shortId }) }),
  z.object({ method: z.literal("thread/backgroundTerminals/clean"), params: z.object({ threadId: shortId }) }),
  z.object({ method: z.literal("skills/list"), params: z.object({ cwds: z.array(z.string().max(32_768)).max(1), forceReload: z.boolean() }) })
]);

export const serverResponseSchema = z.object({
  generation: z.number().int().positive(),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional()
}).refine((value) => (value.result !== undefined) !== (value.error !== undefined), {
  message: "处理结果和错误必须且只能提供一个"
});

export type SafeRequest = z.infer<typeof safeRequestSchema>;
export type ServerResponse = z.infer<typeof serverResponseSchema>;

export type ConnectionState = {
  phase: "stopped" | "starting" | "ready" | "error" | "restarting";
  generation: number;
  codexVersion: string | null;
  compatible: boolean | null;
  message: string;
};

export type ProtocolEvent = {
  generation: number;
  kind: "notification" | "notification-batch" | "server-request" | "diagnostic";
  payload: unknown;
};

const relayPathPattern = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/;

export const normalizeRelayUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const url = new URL(trimmed);
  const secureProtocol = url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  if (!secureProtocol || url.username || url.password || url.search || url.hash || !relayPathPattern.test(url.pathname)) throw new Error("Invalid relay URL");
  const basePath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${basePath}`;
};

export const remoteSettingsSchema = z.object({
  enabled: z.boolean(),
  relayUrl: z.string().trim().max(2_048).refine((value) => {
    try { normalizeRelayUrl(value); return true; } catch { return false; }
  }, "请填写不含账号或参数的 HTTPS 中转服务地址；可以包含路径前缀，本机调试可使用 HTTP").transform(normalizeRelayUrl)
}).superRefine((value, context) => {
  if (value.enabled && !value.relayUrl) context.addIssue({ code: "custom", path: ["relayUrl"], message: "启用远程访问前请填写中转服务地址" });
});

export const remoteCredentialIdSchema = z.string().min(1).max(2_048);

export type RemoteSettings = z.infer<typeof remoteSettingsSchema>;
export type RemotePairingInfo = { pairingId: string; url: string; code: string; expiresAt: number; readyToConfirm: boolean };
export type RemoteAccessStatus = {
  enabled: boolean;
  phase: "disabled" | "standby" | "connecting" | "pairing" | "connected" | "error";
  message: string;
  relayUrl: string;
  paired: boolean;
  pairing: RemotePairingInfo | null;
  passkeys: Array<{ id: string; name: string; createdAt: number; lastUsedAt: number | null }>;
};

export type MediaAttachment = {
  id: string;
  name: string;
  url: string;
  size: number;
  kind: "local" | "remote";
  sourcePath?: string;
  sourceUrl?: string;
};

export type FileReference = {
  id: string;
  name: string;
  path: string;
  managed?: boolean;
};

export type AttachmentBatch = {
  images: MediaAttachment[];
  files: FileReference[];
  errors: string[];
};
