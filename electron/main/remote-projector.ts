import type { Attachment, MobileItem, MobileSnapshot, ThreadSummary } from "../../packages/remote-protocol/src/index.js";
import type { ConnectionState, ProtocolEvent } from "../shared/contracts.js";
import { redactSensitiveText } from "./sensitive-data.js";
import { win32 } from "node:path";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const TRUNCATION_SUFFIX = "\n…内容已截断";
const truncate = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_SUFFIX.length) return value.slice(0, limit);
  return `${value.slice(0, limit - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`;
};
const safeText = (value: unknown, limit = 20_000): string => truncate(redactSensitiveText(text(value), true), limit);
const safePath = (path: string, cwd: string): string => {
  if (cwd) {
    const relativePath = win32.relative(cwd, path);
    if (relativePath && !relativePath.startsWith("..") && !win32.isAbsolute(relativePath)) return relativePath;
  }
  return win32.basename(path) || "工作区外路径";
};
export const sanitizeRemoteActivityText = (value: string, cwd = "", limit = 4_000): string => {
  const redacted = redactSensitiveText(value, true)
    .replace(/(["'])([A-Za-z]:[\\/][^"'\r\n]+)\1/g, (_match, quote: string, path: string) => `${quote}${safePath(path, cwd)}${quote}`)
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>|]+/g, (path) => safePath(path, cwd));
  return truncate(redacted, limit);
};
const itemStatus = (value: unknown): "running" | "completed" | "failed" => {
  const status = text(value).toLocaleLowerCase();
  if (status.includes("fail") || status.includes("error") || status.includes("declin")) return "failed";
  if (status.includes("progress") || status.includes("running") || status.includes("start")) return "running";
  return "completed";
};
const MAX_MOBILE_ITEMS = 300;

const inputText = (item: Record<string, unknown>): string => {
  if (typeof item.text === "string") return safeText(item.text);
  const content = Array.isArray(item.content) ? item.content : Array.isArray(item.input) ? item.input : [];
  return content.map((part) => {
    const value = record(part);
    return text(value.text) || (text(value.type).toLocaleLowerCase().includes("image") ? "[含附件]" : "");
  }).filter(Boolean).join("\n");
};

export type AttachmentResolver = (raw: unknown, threadId: string) => Attachment[];
export const projectItem = (raw: unknown, cwd = "", resolveAttachments?: AttachmentResolver, threadId = ""): MobileItem | null => {
  const item = record(raw);
  const id = text(item.id) || text(item.itemId);
  if (!id) return null;
  const type = text(item.type);
  const status = itemStatus(item.status);
  const attachments = resolveAttachments?.(raw, threadId) ?? [];
  if (type === "userMessage" || type === "user_message") {
    return { id, kind: "user", text: inputText(item), ...(attachments.length ? { attachments } : {}), status };
  }
  if (type === "agentMessage" || type === "agent_message") {
    return { id, kind: "agent", markdown: safeText(item.text || item.content, 200_000), ...(attachments.length ? { attachments } : {}), status };
  }
  if (type === "plan" && typeof item.text === "string") return { id, kind: "agent", markdown: safeText(item.text, 200_000), presentation: "plan", status };
  if (type === "reasoning") return { id, kind: "activity", title: "思考过程", summary: "Agent 正在分析任务", status };
  if (type === "commandExecution" || type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : text(item.command);
    return { id, kind: "activity", title: "命令执行", summary: sanitizeRemoteActivityText(command || "执行了一条命令", cwd, 1_000), detail: sanitizeRemoteActivityText(text(item.aggregatedOutput || item.output), cwd, 4_000) || undefined, status };
  }
  if (type === "fileChange" || type === "file_change") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return { id, kind: "activity", title: "文件变化", summary: changes.length ? `修改了 ${changes.length} 个文件，请在桌面端查看详情` : "文件已发生变化，请在桌面端查看详情", status };
  }
  if (type.includes("mcp") || type.includes("webSearch") || type.includes("plan") || type.includes("collab")) {
    return { id, kind: "activity", title: type.includes("mcp") ? "MCP 操作" : "任务活动", summary: sanitizeRemoteActivityText(text(item.name || item.query || item.server) || "已执行一项操作", cwd, 1_000), status };
  }
  return { id, kind: "activity", title: "任务活动", summary: "详细内容请在桌面端查看", status };
};

export const projectTurnItems = (thread: Record<string, unknown>, resolveAttachments?: AttachmentResolver): MobileItem[] => {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return turns.flatMap((rawTurn) => {
    const turn = record(rawTurn);
    return (Array.isArray(turn.items) ? turn.items : []).flatMap((rawItem) => {
      const item = projectItem(rawItem, text(thread.cwd), resolveAttachments, text(thread.id));
      return item ? [item] : [];
    });
  });
};

export const projectThreadStatus = (raw: unknown): ThreadSummary["status"] => {
  const status = record(raw);
  const type = text(status.type) || text(raw);
  if (type === "systemError" || type === "failed") return "failed";
  if (type === "active") return Array.isArray(status.activeFlags) && status.activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running";
  return type === "idle" ? "idle" : "unknown";
};

export class RemoteProjector {
  constructor(readonly resolveAttachments?: AttachmentResolver) {}
  markAttachmentUnavailable(id:string):void {this.#items=this.#items.map(item=>(item.kind==="user"||item.kind==="agent")&&item.attachments?{...item,attachments:item.attachments.map(a=>a.id===id?{...a,available:false}:a)}:item);}
  #connection: ConnectionState = { phase: "stopped", generation: 0, codexVersion: null, compatible: null, message: "Codex 服务未启动" };
  #threads: ThreadSummary[] = [];
  #models: MobileSnapshot["models"] = [];
  #selectedModel: string | null = null;
  #selectedEffort: string | null = null;
  #approvals = new Map<string, { threadId: string; item: MobileItem }>();
  #unread = new Set<string>();
  #failedThreads = new Set<string>();

  setModels(models: MobileSnapshot["models"]): void { this.#models = models; }
  setConfiguration(model: string | null, effort: string | null): void { this.#selectedModel = model; this.#selectedEffort = effort; }
  addApproval(threadId: string, item: MobileItem): void {
    this.#approvals.set(item.id, { threadId, item });
    this.setThreadStatus(threadId, "waiting");
  }
  removeApproval(id: string | number): void {
    const approval = this.#approvals.get(String(id));
    this.#approvals.delete(String(id));
    if (approval && ![...this.#approvals.values()].some((entry) => entry.threadId === approval.threadId)) this.setThreadStatus(approval.threadId, approval.threadId === this.#activeThreadId && this.#activeTurnId ? "running" : "idle");
  }
  setThreadStatus(threadId: string, status: ThreadSummary["status"]): void {
    if (status === "failed") this.#failedThreads.add(threadId);
    if (status === "running" || status === "waiting") this.#failedThreads.delete(threadId);
    this.#threads = this.#threads.map((thread) => thread.id === threadId ? { ...thread, status, unread: this.#unread.has(threadId) } : thread);
    if (threadId === this.#activeThreadId) this.#turnStatus = status;
  }
  #items: MobileItem[] = [];
  #activeThreadId: string | null = null;
  #activeThreadTitle = "未选择会话";
  #activeCwd = "";
  #appearance: MobileSnapshot["appearance"] = { theme: "system", accentColor: "#10a37f" };
  #turnStatus: MobileSnapshot["turnStatus"] = "idle";
  #activeTurnId: string | null = null;

  get activeThreadId(): string | null { return this.#activeThreadId; }
  get activeTurnId(): string | null { return this.#activeTurnId; }

  setConnection(state: ConnectionState): void {
    this.#connection = state;
  }

  setAppearance(appearance: MobileSnapshot["appearance"]): void {
    this.#appearance = appearance;
  }

  setThreads(rawThreads: unknown[]): ThreadSummary[] {
    this.#threads = rawThreads.flatMap((rawThread) => {
      const thread = record(rawThread);
      const id = text(thread.id);
      if (!id) return [];
      const previous = this.#threads.find((entry) => entry.id === id);
      if (previous && id !== this.#activeThreadId && typeof thread.updatedAt === "number" && thread.updatedAt > previous.updatedAt) this.#unread.add(id);
      const liveStatus = projectThreadStatus(thread.runtimeStatus ?? thread.status);
      if (liveStatus === "running" || liveStatus === "waiting" || (liveStatus === "idle" && thread.runtimeStatus !== undefined)) this.#failedThreads.delete(id);
      return [{
        id,
        ...(text(thread.cwd) ? { cwd: text(thread.cwd).slice(0, 4096) } : {}),
        title: safeText(thread.name || thread.preview || "未命名会话", 200),
        preview: safeText(thread.preview || "无预览内容", 1_000),
        updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now() / 1_000,
        status: [...this.#approvals.values()].some((approval) => approval.threadId === id) ? "waiting" as const : this.#failedThreads.has(id) ? "failed" as const : liveStatus,
        goalStatus: ["active","paused","blocked","usageLimited","budgetLimited","complete"].includes(text(thread.goalStatus)) ? thread.goalStatus as ThreadSummary["goalStatus"] : null,
        goalStateKnown: thread.goalStateKnown === true,
        completion: thread.completion as ThreadSummary["completion"] ?? null,
        unread: this.#unread.has(id)
      }];
    }).slice(0, 100);
    return this.#threads;
  }

  #officialControl = false;
  get officialControl(): boolean { return this.#officialControl; }
  setOfficialControl(value: boolean): void { if(this.#officialControl&&!value)this.#readOnly=true; this.#officialControl = value; if(value)this.#readOnly=false; }
  #readOnly = false;
  #readOnlyUpdatedAt = 0;
  get readOnly(): boolean { return this.#readOnly; }

  setActiveThread(rawThread: unknown, readOnly = false): void {
    if(text(record(rawThread).id)!==this.#activeThreadId)this.#officialControl=false;
    const preserveReadOnlyWindow = (readOnly && this.#readOnly || this.#officialControl) && text(record(rawThread).id) === this.#activeThreadId;
    this.#readOnly = readOnly && !this.#officialControl;
    this.#readOnlyUpdatedAt = readOnly ? Date.now() : 0;
    const thread = record(rawThread);
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const activeTurn = [...turns].reverse().map(record).find((turn) => text(turn.status) === "inProgress");
    this.#activeThreadId = text(thread.id) || this.#activeThreadId;
    this.#unread.delete(this.#activeThreadId!);
    this.#threads = this.#threads.map((entry) => entry.id === this.#activeThreadId ? { ...entry, unread: false } : entry);
    this.#activeThreadTitle = safeText(thread.name || "未命名会话", 200);
    this.#activeCwd = text(thread.cwd);
    const latest = projectTurnItems(thread, this.resolveAttachments);
    this.#items = (preserveReadOnlyWindow ? [...new Map([...this.#items, ...latest].map(item => [item.id, item])).values()] : latest).slice(-MAX_MOBILE_ITEMS);
    this.#activeTurnId = activeTurn ? text(activeTurn.id) || null : null;
    if (text(record(turns.at(-1)).status) === "failed") this.#failedThreads.add(this.#activeThreadId!);
    else if (["completed", "interrupted", "inProgress"].includes(text(record(turns.at(-1)).status))) this.#failedThreads.delete(this.#activeThreadId!);
    this.#turnStatus = this.#activeTurnId ? projectThreadStatus(thread.status) === "waiting" ? "waiting" : "running" : text(record(turns.at(-1)).status) === "failed" ? "failed" : ["completed", "interrupted"].includes(text(record(turns.at(-1)).status)) ? "idle" : projectThreadStatus(thread.status);
    if (readOnly && thread.runtimeStatus) this.#turnStatus = projectThreadStatus(thread.runtimeStatus);
  }

  setActiveTurn(turnId: string): void {
    if (!turnId) return;
    this.#activeTurnId = turnId;
    this.#turnStatus = "running";
  }

  clearActiveThread(): void {
    this.#officialControl = false;
    this.#readOnly = false;
    this.#readOnlyUpdatedAt = 0;
    this.#selectedModel = null;
    this.#selectedEffort = null;
    this.#approvals.clear();
    this.#activeThreadId = null;
    this.#activeThreadTitle = "未选择会话";
    this.#activeCwd = "";
    this.#items = [];
    this.#turnStatus = "idle";
    this.#activeTurnId = null;
  }

  applyProtocolEvent(event: ProtocolEvent): { threadId: string; item: MobileItem } | null {
    if (event.kind !== "notification") return null;
    const envelope = record(event.payload);
    const method = text(envelope.method);
    const params = record(envelope.params);
    const threadId = text(params.threadId);
    if (method === "thread/status/changed") this.setThreadStatus(threadId, projectThreadStatus(params.status));
    if (method === "turn/started") this.setThreadStatus(threadId, "running");
    if (method === "turn/completed") {
      if (threadId !== this.#activeThreadId) this.#unread.add(threadId);
      this.setThreadStatus(threadId, text(record(params.turn).status) === "failed" ? "failed" : "idle");
      for (const [id, approval] of this.#approvals) if (approval.threadId === threadId) this.#approvals.delete(id);
    }
    if (threadId !== this.#activeThreadId) return null;
    if (method === "turn/started") {
      this.#turnStatus = "running";
      this.#activeTurnId = text(record(params.turn).id) || null;
    }
    if (method === "turn/completed") {
      this.#turnStatus = text(record(params.turn).status).includes("fail") ? "failed" : "idle";
      this.#activeTurnId = null;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = projectItem(params.item, this.#activeCwd, this.resolveAttachments, threadId);
      if (!item) return null;
      const index = this.#items.findIndex((candidate) => candidate.id === item.id);
      if (index >= 0) this.#items[index] = item;
      else this.#items.push(item);
      if (this.#items.length > MAX_MOBILE_ITEMS) this.#items.splice(0, this.#items.length - MAX_MOBILE_ITEMS);
      return { threadId, item };
    }
    if (method === "item/agentMessage/delta" || method === "item/plan/delta") {
      const itemId = text(params.itemId);
      const delta = safeText(params.delta, 50_000);
      if (!itemId || !delta) return null;
      const existing = this.#items.find((candidate) => candidate.id === itemId && candidate.kind === "agent");
      const item: MobileItem = existing && existing.kind === "agent"
        ? { ...existing, markdown: truncate(existing.markdown + delta, 200_000), status: "running" }
        : { id: itemId, kind: "agent", markdown: delta, ...(method === "item/plan/delta" ? { presentation: "plan" as const } : {}), status: "running" };
      const index = this.#items.findIndex((candidate) => candidate.id === itemId);
      if (index >= 0) this.#items[index] = item;
      else this.#items.push(item);
      if (this.#items.length > MAX_MOBILE_ITEMS) this.#items.splice(0, this.#items.length - MAX_MOBILE_ITEMS);
      return { threadId, item };
    }
    return null;
  }

  createIndependent(): RemoteProjector {
    const projector = new RemoteProjector(this.resolveAttachments);
    projector.#connection = this.#connection;
    projector.#appearance = this.#appearance;
    projector.#models = this.#models;
    projector.#threads = structuredClone(this.#threads);
    for (const [id, approval] of this.#approvals) projector.#approvals.set(id, structuredClone(approval));
    return projector;
  }

  snapshot(): MobileSnapshot {
    const phase = this.#connection.phase === "ready" ? "ready" : this.#connection.phase === "starting" || this.#connection.phase === "restarting" ? "starting" : this.#connection.phase === "error" ? "error" : "stopped";
    return {
      serverTime: Date.now(),
      controlBackend: this.#officialControl ? "official" : "paneflow",
      readOnly: this.#readOnly,
      readOnlyReason: this.#readOnly ? "只读 · 电脑正在使用" : "",
      readOnlyUpdatedAt: this.#readOnlyUpdatedAt,
      deviceOnline: true,
      capabilities: ["independentSessions", "requestStatus", "historyPagination", "taskQueue", "taskDetails", "approvalCenter", "usageSummary", ...(this.resolveAttachments ? ["attachmentsV1" as const] : [])],
      codexState: phase,
      codexMessage: safeText(this.#connection.message, 1_000),
      appearance: this.#appearance,
      activeThreadId: this.#activeThreadId,
      activeThreadTitle: this.#activeThreadTitle,
      turnStatus: [...this.#approvals.values()].some((approval) => approval.threadId === this.#activeThreadId) ? "waiting" : this.#turnStatus,
      activeTurnId: this.#activeTurnId,
      models: this.#models,
      selectedModel: this.#selectedModel,
      selectedEffort: this.#selectedEffort,
      threads: this.#threads,
      items: [...this.#items, ...[...this.#approvals.values()].filter((approval) => approval.threadId === this.#activeThreadId).map((approval) => approval.item)]
    };
  }
}
