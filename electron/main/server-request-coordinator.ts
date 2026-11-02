import type { AppServerSupervisor } from "./app-server-supervisor.js";

type PendingApproval = {
  generation: number;
  id: string | number;
  method: string;
  threadId: string;
  version: number;
  declineDecision?: "decline" | "cancel";
  choice?: {
    field: string;
    values: Array<{ label: string; value: string | number | boolean }>;
    meta: unknown;
  };
};

const REMOTE_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "execCommandApproval",
  "mcpServer/elicitation/request"
]);

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const choiceValue = (value: unknown): string | number | boolean | null => typeof value === "string" && value.length <= 2_000 || typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" ? value : null;
const readMcpChoice = (params: Record<string, unknown>): PendingApproval["choice"] => {
  if (params.mode !== "form" && params.mode !== "openai/form") return undefined;
  const properties = record(record(params.requestedSchema).properties);
  const entries = Object.entries(properties);
  if (entries.length !== 1) return undefined;
  const [field, rawFieldSchema] = entries[0]!;
  const fieldSchema = record(rawFieldSchema);
  const enumValues = Array.isArray(fieldSchema.enum) ? fieldSchema.enum : null;
  const oneOfValues = Array.isArray(fieldSchema.oneOf) ? fieldSchema.oneOf.map((entry) => record(entry).const) : null;
  const rawValues = enumValues ?? oneOfValues;
  if (!rawValues?.length || rawValues.length > 50) return undefined;
  const values = rawValues.map(choiceValue);
  if (values.some((value) => value === null)) return undefined;
  const enumNames = Array.isArray(fieldSchema.enumNames) ? fieldSchema.enumNames : [];
  const oneOf = Array.isArray(fieldSchema.oneOf) ? fieldSchema.oneOf.map(record) : [];
  return {
    field,
    values: values.map((value, index) => {
      const label = String(enumNames[index] ?? oneOf[index]?.title ?? value) || "选项";
      return { label: label.slice(0, 500), value: value! };
    }),
    meta: params._meta ?? null
  };
};

export class ServerRequestCoordinator {
  readonly #supervisor: AppServerSupervisor;
  readonly #pending = new Map<string, PendingApproval>();
  #version = 0;

  constructor(supervisor: AppServerSupervisor) {
    this.#supervisor = supervisor;
  }

  observe(generation: number, id: string | number, method: string, params: Record<string, unknown>): PendingApproval | null {
    if (!REMOTE_APPROVAL_METHODS.has(method)) return null;
    const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : ["accept", "decline"];
    const declineDecision = available.includes("decline") ? "decline" as const : available.includes("cancel") ? "cancel" as const : undefined;
    if (method === "item/commandExecution/requestApproval" && (!available.includes("accept") || !declineDecision)) return null;
    const choice = method === "mcpServer/elicitation/request" ? readMcpChoice(params) : undefined;
    if (method === "mcpServer/elicitation/request" && params.mode !== "url" && !choice) return null;
    const threadId = typeof params.threadId === "string" ? params.threadId : method === "execCommandApproval" && typeof params.conversationId === "string" ? params.conversationId : "";
    if (!threadId) return null;
    const approval = { generation, id, method, threadId, version: ++this.#version, declineDecision, ...(choice ? { choice } : {}) };
    this.#pending.set(String(id), approval);
    return approval;
  }

  resolve(approvalId: string, version: number, decision: "accept" | "decline", selection?: string | number | boolean, threadId?: string): void {
    const approval = this.#pending.get(approvalId);
    if (!approval || approval.version !== version) throw new Error("该确认已处理或已经过期。");
    if (threadId !== undefined && approval.threadId !== threadId) throw new Error("确认所属会话不匹配。");
    const selected = approval.choice?.values.find((choice) => choice.value === selection);
    if (approval.choice && decision === "accept" && !selected) throw new Error("请选择 MCP 提供的选项。");
    const result = approval.method === "mcpServer/elicitation/request"
      ? { action: decision, content: decision === "accept" && approval.choice ? { [approval.choice.field]: selected!.value } : null, _meta: decision === "accept" && approval.choice ? approval.choice.meta : null }
      : approval.method === "execCommandApproval"
      ? { decision: decision === "accept" ? "approved" : { denied: { rejection: "用户从手机端拒绝了此操作" } } }
      : { decision: decision === "decline" ? approval.declineDecision ?? "decline" : "accept" };
    this.#supervisor.respondToServer(approval.generation, approval.id, result);
    this.#pending.delete(approvalId);
  }

  removeThread(threadId: string): void {
    for (const [id, approval] of this.#pending) if (approval.threadId === threadId) this.#pending.delete(id);
  }

  remove(id: string | number): void {
    this.#pending.delete(String(id));
  }

  clear(): void {
    this.#pending.clear();
  }
}
