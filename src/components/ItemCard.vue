<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NCard, NCode, NCollapse, NCollapseItem, NDescriptions, NDescriptionsItem, NIcon, NImage, NList, NListItem, NSpace, NTag, NText, NTooltip, useMessage } from "naive-ui";
import { CheckmarkCircleOutline, CopyOutline, EllipsisHorizontalCircleOutline, TerminalOutline } from "@vicons/ionicons5";
import type { ItemAction, UiItem } from "../types";
import MarkdownContent from "./MarkdownContent.vue";

type DetailField = { key: string; label: string; value: unknown };

type DiffLineKind = "add" | "delete" | "context" | "notice";
type DiffLine = { content: string; kind: DiffLineKind; oldLine: number | null; newLine: number | null };
type DiffHunk = { key: string; added: number; deleted: number; lines: DiffLine[] };
type ParsedDiff = { added: number; deleted: number; hunks: DiffHunk[] };

const props = withDefaults(defineProps<{ item: UiItem; unwrapPowerShell?: boolean; commandShellPath?: string; mcpGatewayAdaptation?: boolean }>(), { unwrapPowerShell: false, commandShellPath: "", mcpGatewayAdaptation: false });
const emit = defineEmits<{ action: [action: ItemAction] }>();
const message = useMessage();
const copied = ref(false);
const imagePreviewUrl = ref<string | null>(null);
const imagePreviewError = ref<string | null>(null);
const compactContentStyle = "padding: 8px 10px";
const compactHeaderStyle = "padding: 7px 10px";

const record = computed(() => props.item.data);
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const redactUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return value;
    return `${url.origin}${url.pathname}${url.search || url.hash ? "?[已隐藏]" : ""}`;
  } catch {
    return value;
  }
};
const redactText = (value: string): string => value
  .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => redactUrl(url))
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
  .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[已隐藏]")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT 已隐藏]")
  .replace(/(access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|password|secret)(\s*[:=]\s*)\S+/gi, "$1$2[已隐藏]");
const redactValue = (value: unknown, key = "", depth = 0, budget = { nodes: 2_000 }): unknown => {
  if (budget.nodes-- <= 0) return "… 已省略其余内容";
  if (/(token|authorization|api.?key|password|secret)/i.test(key)) return "[已隐藏]";
  if (typeof value === "string") return redactText(value);
  if (depth >= 8 && value && typeof value === "object") return "… 层级过深，已省略";
  if (Array.isArray(value)) {
    const visible = value.slice(0, 100).map((entry) => redactValue(entry, "", depth + 1, budget));
    if (visible.length < value.length) visible.push(`… 已省略 ${value.length - visible.length} 项`);
    return visible;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([entryKey, entry]) => [entryKey, redactValue(entry, entryKey, depth + 1, budget)]));
  return value;
};
const textValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return redactText(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return String(value);
  return JSON.stringify(redactValue(value), null, 2);
};
const shortenedText = (value: unknown, limit = 12_000): string => {
  if (typeof value === "string") {
    const truncated = value.length > limit;
    const text = redactText(truncated ? value.slice(0, limit + 512) : value).slice(0, limit);
    return truncated ? `${text}\n… 已省略其余内容` : text;
  }
  if (!value || typeof value !== "object") {
    const text = textValue(value);
    return text.length <= limit ? text : `${text.slice(0, limit)}\n… 已省略 ${text.length - limit} 个字符`;
  }
  const budget = { characters: limit, nodes: 2_000 };
  const summarize = (entry: unknown, key = "", depth = 0): unknown => {
    if (budget.characters <= 0 || budget.nodes-- <= 0) return "… 已省略其余内容";
    if (/(token|authorization|api.?key|password|secret)/i.test(key)) return "[已隐藏]";
    if (typeof entry === "string") {
      const source = entry.length > budget.characters ? entry.slice(0, budget.characters + 512) : entry;
      const redacted = redactText(source);
      const visible = redacted.slice(0, Math.max(0, budget.characters));
      budget.characters -= visible.length;
      return source.length < entry.length || visible.length < redacted.length ? `${visible}…` : visible;
    }
    if (entry === null || typeof entry !== "object") return entry;
    if (depth >= 8) return "… 层级过深，已省略";
    if (Array.isArray(entry)) {
      const values: unknown[] = [];
      for (let index = 0; index < entry.length && budget.characters > 0 && budget.nodes > 0; index += 1) values.push(summarize(entry[index], String(index), depth + 1));
      if (values.length < entry.length) values.push(`… 已省略 ${entry.length - values.length} 项`);
      return values;
    }
    const result: Record<string, unknown> = {};
    let omitted = false;
    for (const entryKey in entry as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(entry, entryKey)) continue;
      if (budget.characters <= 0 || budget.nodes <= 0) {
        omitted = true;
        break;
      }
      result[entryKey] = summarize((entry as Record<string, unknown>)[entryKey], entryKey, depth + 1);
    }
    if (omitted) result["…"] = "已省略其余字段";
    return result;
  };
  const text = JSON.stringify(summarize(value), null, 2) ?? "—";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n… 已省略 ${text.length - limit} 个字符`;
};
const prettyText = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return redactText(value);
  try {
    return JSON.stringify(redactValue(JSON.parse(trimmed)), null, 2);
  } catch {
    return redactText(value);
  }
};
const firstValue = (...keys: string[]): unknown => {
  for (const key of keys) {
    const value = record.value[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
};
const arrayRecords = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.map(asRecord).filter((entry) => Object.keys(entry).length > 0)
  : [];
const collectionRecords = (...keys: string[]): Record<string, unknown>[] => {
  for (const key of keys) {
    const direct = arrayRecords(record.value[key]);
    if (direct.length) return direct;
    const nested = asRecord(record.value[key]);
    const data = arrayRecords(nested.data ?? nested.items ?? nested.skills ?? nested.servers);
    if (data.length) return data;
  }
  return [];
};
const labelFor = (key: string): string => ({
  arguments: "参数", params: "参数", input: "输入", result: "结果", output: "输出", content: "内容", error: "错误", metadata: "附加信息",
  status: "状态", connection: "连接", threadId: "会话 ID", account: "账号模式", model: "模型", effort: "推理强度", contextTokens: "上下文", quotas: "额度", query: "搜索词", cwd: "目录", path: "路径", prompt: "任务", agentPath: "代理", receiverThreadIds: "接收会话", progress: "进度"
}[key] ?? key);
const detailFields = (keys: string[]): DetailField[] => keys.flatMap((key) => {
  const value = record.value[key];
  return value === undefined || value === null || value === "" ? [] : [{ key, label: labelFor(key), value }];
});

const displayText = computed(() => {
  const data = record.value;
  if (props.item.type === "agentMessage" || props.item.type === "plan") return typeof data.text === "string" ? data.text : props.item.streamText;
  if (props.item.type === "userMessage") {
    const content = Array.isArray(data.content) ? data.content : [];
    return content.map((entry) => {
      const value = asRecord(entry);
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "localImage") return textValue(value.path);
      if (value.type === "image") return textValue(value.url);
      if (value.type === "mention") return textValue(value.path ?? value.name);
      return "";
    }).filter(Boolean).join("\n");
  }
  return props.item.streamText;
});
const reasoningText = computed(() => {
  const parts = [record.value.summary, record.value.content, record.value.text, props.item.streamText].flatMap((value) => {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      const detail = asRecord(entry);
      return typeof detail.text === "string" ? [detail.text] : [];
    });
  });
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
});
const reviewText = computed(() => textValue(firstValue("review", "summary", "message", "target")));
const humanizeType = (value: string): string => value
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[_/-]+/g, " ")
  .trim();
const title = computed(() => ({
  reasoning: "思考摘要", commandExecution: "命令执行", fileChange: "文件变更", mcpToolCall: "MCP 工具", dynamicToolCall: "工具调用",
  collabAgentToolCall: "协作代理", subAgentActivity: "代理活动", agents: "协作代理", backgroundProcesses: "后台进程", webSearch: "网络搜索", imageView: "查看图片", imageGeneration: "生成图片",
  enteredReviewMode: "开始审查", exitedReviewMode: "审查完成", contextCompaction: "上下文压缩", plan: "计划", status: "当前状态", mcpStatus: "MCP 状态", skills: "可用技能", protocolNotice: "Codex 通知"
}[props.item.type] ?? `协议事件 · ${humanizeType(props.item.type) || "未知类型"}`));
const statusLabel = computed(() => {
  const status = String(record.value.status ?? props.item.status);
  return ({ completed: "已完成", running: "进行中", failed: "失败", error: "失败", declined: "已拒绝", inProgress: "进行中" }[status] ?? status);
});
const statusType = computed(() => record.value.error || record.value.success === false || /fail|error|declined/i.test(String(record.value.status ?? ""))
  ? "error"
  : record.value.status === "completed" || record.value.success === true || props.item.status === "completed" ? "success" : "warning");
const durationLabel = computed(() => typeof record.value.durationMs === "number" ? `${(record.value.durationMs / 1000).toFixed(1)} 秒` : null);
const stripMatchingOuterQuotes = (value: string): string => {
  let result = value.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    const quote = result[0];
    if ((quote !== '"' && quote !== "'") || result.at(-1) !== quote) break;
    result = result.slice(1, -1).trim();
  }
  return result;
};
const stripEscapedOuterQuotes = (value: string): string => {
  let result = stripMatchingOuterQuotes(value);
  for (let depth = 0; depth < 2; depth += 1) {
    const match = result.match(/^\\(["'])([\s\S]*)\\\1$/);
    if (!match) break;
    result = stripMatchingOuterQuotes(match[2] ?? "");
  }
  return result;
};
const unwrapPowerShellCommand = (value: string): string => {
  if (!props.unwrapPowerShell) return value;
  const invocation = value.trim().replace(/^&\s+/, "");
  const quote = invocation[0];
  let executable = "";
  let executableEnd = 0;
  if (quote === '"' || quote === "'") {
    executableEnd = invocation.indexOf(quote, 1);
    if (executableEnd < 0) return value;
    executable = invocation.slice(1, executableEnd);
    executableEnd += 1;
  } else {
    executableEnd = invocation.search(/\s/);
    if (executableEnd < 0) return value;
    executable = invocation.slice(0, executableEnd);
  }
  const configuredShell = stripMatchingOuterQuotes(props.commandShellPath);
  const matchesConfiguredShell = configuredShell.length > 0 && executable.localeCompare(configuredShell, undefined, { sensitivity: "accent" }) === 0;
  const isPowerShell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(executable);
  if (!matchesConfiguredShell && !isPowerShell) return value;
  const argumentsText = invocation.slice(executableEnd);
  const commandMarker = argumentsText.match(/\s+(?:(['"])-command\1|-command)\s+/i) ?? argumentsText.match(/\s+(?:(['"])-c\1|-c)\s+/i);
  if (!commandMarker || commandMarker.index === undefined) return value;
  return stripEscapedOuterQuotes(argumentsText.slice(commandMarker.index + commandMarker[0].length));
};
const commandText = computed(() => {
  const value = firstValue("command", "commandLine");
  return typeof value === "string" ? redactText(unwrapPowerShellCommand(value)) : textValue(value);
});
const commandStateLabel = computed(() => ["inProgress", "running"].includes(String(record.value.status ?? props.item.status)) ? "正在运行" : "已运行");
const commandOutput = computed(() => {
  const value = firstValue("aggregatedOutput", "output", "stdout") ?? props.item.streamText;
  return value ? redactText(String(value)) : "";
});
const autoReviewStatusLabel = computed(() => ({
  inProgress: "审查中",
  approved: "已允许",
  denied: "已拒绝",
  timedOut: "已超时",
  aborted: "已中止"
}[String(record.value.status)] ?? textValue(record.value.status)));
const autoReviewRiskLabel = computed(() => ({ low: "低", medium: "中", high: "高", critical: "严重" }[String(record.value.riskLevel)] ?? textValue(record.value.riskLevel)));
const autoReviewAuthorizationLabel = computed(() => ({ unknown: "未知", low: "低", medium: "中", high: "高" }[String(record.value.userAuthorization)] ?? textValue(record.value.userAuthorization)));
const autoReviewAction = computed(() => asRecord(record.value.action));
const autoReviewActionLabel = computed(() => ({
  command: "命令",
  execve: "程序执行",
  applyPatch: "文件修改",
  networkAccess: "网络访问",
  mcpToolCall: "MCP 工具",
  requestPermissions: "权限请求"
}[String(autoReviewAction.value.type)] ?? "操作"));
const autoReviewActionSummary = computed(() => {
  const action = autoReviewAction.value;
  if (action.type === "command") return textValue(action.command);
  if (action.type === "execve") return [action.program, ...(Array.isArray(action.argv) ? action.argv : [])].map(String).join(" ");
  if (action.type === "applyPatch") return Array.isArray(action.files) ? action.files.map(String).join("\n") : "—";
  if (action.type === "networkAccess") return [action.target ?? action.host, action.protocol, action.port].filter((value) => value !== null && value !== undefined && value !== "").join(" · ");
  if (action.type === "mcpToolCall") return [action.server, action.toolName].filter(Boolean).join(" / ");
  if (action.type === "requestPermissions") return textValue(action.reason ?? action.permissions);
  return textValue(action);
});
const changes = computed(() => arrayRecords(record.value.changes ?? record.value.fileChanges));
const changeKind = (change: Record<string, unknown>): "add" | "update" | "delete" | "move" => {
  const kind = typeof change.kind === "string" ? change.kind : String(asRecord(change.kind).type ?? "update");
  if (kind === "add" || kind === "delete") return kind;
  const detail = asRecord(change.kind);
  return detail.move_path || detail.movePath ? "move" : "update";
};
const changeLabel = (change: Record<string, unknown>): string => ({ add: "新增", update: "修改", delete: "删除", move: "移动" }[changeKind(change)]);
const changeMovePath = (change: Record<string, unknown>): string | null => {
  const kind = asRecord(change.kind);
  const value = kind.move_path ?? kind.movePath;
  return typeof value === "string" ? value : null;
};
const toolName = computed(() => textValue(firstValue("tool", "toolName", "name")));
const toolDetailFields = computed(() => detailFields(["arguments", "params", "input", "result", "output", "contentItems", "content", "error"]));
const mcpArguments = computed(() => record.value.arguments);
const gatewayTarget = computed(() => {
  if (!props.mcpGatewayAdaptation || !["gateway_call_tool", "call_tool"].includes(toolName.value)) return null;
  const argumentsRecord = asRecord(mcpArguments.value);
  const service = [argumentsRecord.serviceId, argumentsRecord.service_id, argumentsRecord.server, argumentsRecord.serverName]
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  const tool = [argumentsRecord.toolName, argumentsRecord.tool_name, argumentsRecord.tool]
    .find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
  return service && tool ? { service, tool } : null;
});
const mcpServiceLabel = computed(() => {
  const service = textValue(record.value.server ?? record.value.serverName);
  return gatewayTarget.value ? `${service} → ${gatewayTarget.value.service}` : service;
});
const mcpToolLabel = computed(() => gatewayTarget.value ? `${toolName.value} → ${gatewayTarget.value.tool}` : toolName.value);
const mcpContent = computed(() => {
  const result = asRecord(record.value.result);
  const content = Array.isArray(result.content) ? result.content : [];
  return content.flatMap((entry, index) => {
    if (typeof entry === "string") return [{ key: String(index), text: prettyText(entry) }];
    const block = asRecord(entry);
    if (typeof block.text === "string") return [{ key: String(index), text: prettyText(block.text) }];
    const resource = asRecord(block.resource);
    if (typeof resource.text === "string") return [{ key: String(index), text: prettyText(resource.text) }];
    const { type: _type, ...content } = block;
    return Object.keys(content).length ? [{ key: String(index), text: textValue(content) }] : [];
  });
});
const webResults = computed(() => collectionRecords("results"));
const webAction = computed(() => asRecord(record.value.action));
const webQuery = computed(() => {
  if (typeof record.value.query === "string" && record.value.query) return record.value.query;
  if (typeof webAction.value.query === "string" && webAction.value.query) return webAction.value.query;
  return Array.isArray(webAction.value.queries) ? webAction.value.queries.filter((value): value is string => typeof value === "string").join(" · ") : "未提供搜索词";
});
const webUrls = computed(() => {
  const urls = webResults.value.flatMap((result) => typeof result.url === "string" ? [result.url] : []);
  if (typeof webAction.value.url === "string") urls.unshift(webAction.value.url);
  return [...new Set(urls)].map(redactText);
});
const agents = computed(() => collectionRecords("agents", "statuses", "result"));
const mcpEntries = computed(() => collectionRecords("data", "servers", "mcpServers"));
const skillEntries = computed<Record<string, unknown>[]>(() => {
  const data = arrayRecords(record.value.data);
  const nested = data.flatMap((entry) => arrayRecords(entry.skills).map((skill) => ({ ...skill, cwd: entry.cwd })));
  return nested.length ? nested : collectionRecords("skills", "items");
});
const agentEntries = computed<Record<string, unknown>[]>(() => collectionRecords("agents", "data", "items").map((entry) => ({ ...entry, threadId: entry.threadId ?? entry.id })));
const backgroundProcessEntries = computed(() => collectionRecords("processes", "data", "items"));
const permissionModes = computed(() => collectionRecords("modes"));
const settingChanges = computed(() => collectionRecords("changes"));
const goalStateLabel = computed(() => ({
  active: "生效",
  paused: "已暂停",
  resumed: "继续",
  empty: "暂无",
  blocked: "受阻",
  usageLimited: "用量受限",
  budgetLimited: "预算受限",
  complete: "已完成"
} as Record<string, string>)[String(record.value.state)] ?? textValue(record.value.state));
const permissionModeIsCurrent = (mode: Record<string, unknown>): boolean => mode.profileId === record.value.currentProfile
  && mode.approvalPolicy === record.value.currentApprovalPolicy
  && mode.approvalsReviewer === record.value.currentApprovalsReviewer;
const switchPermissionMode = (mode: Record<string, unknown>): void => {
  const approvalPolicy = String(mode.approvalPolicy);
  const approvalsReviewer = String(mode.approvalsReviewer);
  if (!["untrusted", "on-request", "never"].includes(approvalPolicy) || !["user", "auto_review", "guardian_subagent"].includes(approvalsReviewer)) return;
  emit("action", {
    type: "switchPermissionMode",
    profileId: String(mode.profileId),
    approvalPolicy: approvalPolicy as "untrusted" | "on-request" | "never",
    approvalsReviewer: approvalsReviewer as "user" | "auto_review" | "guardian_subagent"
  });
};
const entryStatus = (entry: Record<string, unknown>): string | null => {
  if (entry.status !== undefined) return textValue(entry.status);
  if (entry.authStatus !== undefined) return ({ unsupported: "无需认证", notLoggedIn: "未登录", bearerToken: "令牌认证", oAuth: "OAuth 已连接", unknown: "认证状态未知" }[String(entry.authStatus)] ?? textValue(entry.authStatus));
  if (entry.enabled !== undefined) return entry.enabled ? "已启用" : "未启用";
  return null;
};
const parseDiff = (change: Record<string, unknown>): ParsedDiff => {
  const source = String(change.diff ?? change.patch ?? "");
  const sourceLines = source.split(/\r?\n/);
  if (sourceLines.at(-1) === "") sourceLines.pop();
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let deleted = 0;

  const createHunk = (): DiffHunk => {
    const hunk = { key: `hunk-${hunks.length}`, added: 0, deleted: 0, lines: [] };
    hunks.push(hunk);
    return hunk;
  };

  for (const rawLine of sourceLines) {
    const header = rawLine.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:\s*(.*))?$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      current = createHunk();
      continue;
    }
    if (/^(?:diff --git |index |--- |\+\+\+ )/.test(rawLine)) continue;
    current ??= createHunk();
    if (rawLine.startsWith("\\ No newline at end of file")) {
      current.lines.push({ content: "文件末尾没有换行符", kind: "notice", oldLine: null, newLine: null });
      continue;
    }
    if (rawLine.startsWith("+")) {
      current.lines.push({ content: rawLine.slice(1), kind: "add", oldLine: null, newLine });
      current.added += 1;
      added += 1;
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-")) {
      current.lines.push({ content: rawLine.slice(1), kind: "delete", oldLine, newLine: null });
      current.deleted += 1;
      deleted += 1;
      oldLine += 1;
      continue;
    }
    current.lines.push({ content: rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine, kind: "context", oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return { added, deleted, hunks };
};
const parsedChanges = computed(() => changes.value.map((change) => ({ change, diff: parseDiff(change) })));
const diffLineNumber = (line: DiffLine): number | string => line.kind === "delete" ? line.oldLine ?? "" : line.newLine ?? "";
const entryDescription = (entry: Record<string, unknown>, type: string): string => {
  if (type === "skills") return shortenedText(entry.description ?? entry.path ?? entry.cwd, 500);
  const toolCount = Object.keys(asRecord(entry.tools)).length;
  const resourceCount = Array.isArray(entry.resources) ? entry.resources.length : 0;
  const serverInfo = asRecord(entry.serverInfo);
  return [serverInfo.title ?? serverInfo.name, toolCount ? `${toolCount} 个工具` : null, resourceCount ? `${resourceCount} 个资源` : null].filter(Boolean).join(" · ") || "暂无能力详情";
};
const statusFields = computed(() => detailFields(["connection", "threadId", "account", "model", "effort", "cwd", "contextTokens", "quotas"]));
const genericFields = computed(() => Object.entries(record.value)
  .filter(([key, value]) => !["id", "type", "threadId", "turnId", "status"].includes(key) && value !== undefined && value !== null && value !== "")
  .slice(0, 12)
  .map(([key, value]) => ({ key, label: labelFor(key), value })));
const imagePath = computed(() => {
  if (props.item.type === "imageView" && typeof record.value.path === "string") return record.value.path;
  if (props.item.type === "imageGeneration" && typeof record.value.savedPath === "string") return record.value.savedPath;
  return null;
});
const generatedImageDataUrl = computed(() => {
  const result = record.value.result;
  return props.item.type === "imageGeneration" && typeof result === "string" && result.length > 0 ? `data:image/png;base64,${result}` : null;
});

watch(imagePath, async (path) => {
  imagePreviewUrl.value = null;
  imagePreviewError.value = null;
  if (!path) return;
  try {
    imagePreviewUrl.value = (await window.codexPane.importImagePath(path)).url;
  } catch (error) {
    imagePreviewError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true });

const copyText = async (value: string): Promise<void> => {
  try {
    await window.codexPane.copyText(value);
    copied.value = true;
    message.success("复制成功");
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    copied.value = false;
    message.error("复制失败");
  }
};
</script>

<template>
  <article v-if="item.type === 'agentMessage'" class="message message-agent item-card">
    <MarkdownContent :source="displayText" :streaming="item.status === 'running'" ctrl-click-links />
    <NTooltip>
      <template #trigger><NButton quaternary circle size="tiny" class="copy-message-button" :aria-label="copied ? '已复制回复' : '复制回复'" @click="copyText(displayText)"><template #icon><NIcon :component="copied ? CheckmarkCircleOutline : CopyOutline" /></template></NButton></template>
      {{ copied ? "已复制" : "复制回复" }}
    </NTooltip>
  </article>

  <article v-else-if="item.type === 'userMessage'" class="message message-user item-card"><NText>{{ displayText }}</NText></article>

  <template v-else-if="item.type === 'reasoning'">
    <NCard v-if="reasoningText" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="思考摘要"><MarkdownContent :source="reasoningText" :streaming="item.status === 'running'" /></NCard>
  </template>

  <NCard v-else-if="item.type === 'status'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="当前状态">
    <div class="inline-detail-fields"><span v-for="field in statusFields" :key="field.key" class="inline-detail-field"><NText depth="3">{{ field.label }}：</NText><span>{{ shortenedText(field.value, 500) }}</span></span></div>
  </NCard>

  <NAlert v-else-if="item.type === 'protocolNotice'" class="item-card protocol-notice" :type="record.tone === 'error' ? 'error' : record.tone === 'info' ? 'info' : 'warning'" :title="String(record.title ?? 'Codex 通知')" :show-icon="true">
    <div>{{ textValue(record.message) }}</div>
    <pre v-if="record.details" class="protocol-notice-details">{{ shortenedText(record.details, 2000) }}</pre>
  </NAlert>

  <NCard v-else-if="item.type === 'permissions'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="权限模式">
    <template #header-extra><NButton quaternary circle size="small" aria-label="关闭权限选择" @click="emit('action', { type: 'dismissItem', itemId: item.id })">×</NButton></template>
    <NList v-if="permissionModes.length" size="small" :show-divider="false"><NListItem v-for="mode in permissionModes" :key="String(mode.id)"><NSpace justify="space-between" align="center" :wrap="false"><span><NText strong>{{ textValue(mode.label) }}</NText><NText v-if="mode.description" depth="3"> · {{ textValue(mode.description) }}</NText></span><NButton size="small" :type="permissionModeIsCurrent(mode) ? 'primary' : 'default'" :secondary="!permissionModeIsCurrent(mode)" :disabled="permissionModeIsCurrent(mode)" @click="switchPermissionMode(mode)">{{ permissionModeIsCurrent(mode) ? "当前" : "切换" }}</NButton></NSpace></NListItem></NList>
    <NText v-else depth="3">暂无可用权限模式</NText>
  </NCard>

  <NCard v-else-if="item.type === 'threadSettingsChanged'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="会话设置">
    <div class="inline-detail-fields"><span v-for="(change, index) in settingChanges" :key="`${String(change.label)}-${index}`" class="inline-detail-field"><NText depth="3">{{ textValue(change.label) }}：</NText><span>{{ textValue(change.value) }}</span></span></div>
  </NCard>

  <NCard v-else-if="item.type === 'goalStatus'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="目标">
    <NSpace vertical size="small"><NText strong>{{ goalStateLabel }}</NText><NText v-if="record.objective && record.state === 'active'">{{ textValue(record.objective) }}</NText></NSpace>
  </NCard>

  <NCard v-else-if="item.type === 'modeStatus'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="模式切换">
    <NText>{{ textValue(record.mode) }}</NText>
  </NCard>

  <NCard v-else-if="item.type === 'contextCompaction'" size="small" class="tool-card item-card" :header-style="compactHeaderStyle" title="上下文压缩">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
  </NCard>

  <NCard v-else-if="item.type === 'mcpStatus' || item.type === 'skills'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" :title="title">
    <NList size="small" :show-divider="false"><NListItem v-for="(entry, index) in item.type === 'mcpStatus' ? mcpEntries : skillEntries" :key="String(entry.id ?? entry.name ?? index)">
      <NSpace justify="space-between" align="center" :wrap="false"><NText strong>{{ entry.name ?? entry.serverName ?? entry.id ?? "未命名" }}</NText><NTag v-if="entryStatus(entry)" size="small" :type="entry.status === 'failed' || entry.enabled === false ? 'error' : 'success'">{{ entryStatus(entry) }}</NTag></NSpace>
      <NText depth="3">{{ entryDescription(entry, item.type) }}</NText>
    </NListItem></NList>
    <NText v-if="(item.type === 'mcpStatus' ? mcpEntries : skillEntries).length === 0" depth="3">暂无可显示内容</NText>
  </NCard>

  <NCard v-else-if="item.type === 'commandExecution'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle">
    <template #header><span class="card-title"><NIcon :component="TerminalOutline" /> {{ commandStateLabel }}命令</span></template><template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <NCode v-if="commandText !== '—'" :code="commandText" language="powershell" word-wrap />
    <div class="inline-detail-fields"><span v-if="record.cwd" class="inline-detail-field"><NText depth="3">目录：</NText><span>{{ textValue(record.cwd) }}</span></span><span v-if="record.exitCode !== undefined" class="inline-detail-field"><NText depth="3">退出码：</NText><span>{{ record.exitCode }}</span></span><span v-if="durationLabel" class="inline-detail-field"><NText depth="3">耗时：</NText><span>{{ durationLabel }}</span></span></div>
    <NCollapse v-if="commandOutput"><NCollapseItem title="输出" name="output"><pre class="long-output">{{ shortenedText(commandOutput) }}</pre><NButton v-if="commandOutput.length > 12000" text type="primary" @click="copyText(commandOutput)">复制完整输出</NButton></NCollapseItem></NCollapse>
  </NCard>

  <NCard v-else-if="item.type === 'autoApprovalReview'" size="small" :class="['tool-card', 'item-card', 'auto-review-card', `auto-review-${String(record.status)}`]" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="自动审批">
    <template #header-extra><NTag size="small" :type="statusType">{{ autoReviewStatusLabel }}</NTag></template>
    <NDescriptions :column="1" size="small" label-placement="left">
      <NDescriptionsItem v-if="record.riskLevel" label="风险">{{ autoReviewRiskLabel }}</NDescriptionsItem>
      <NDescriptionsItem v-if="record.userAuthorization" label="授权判断">{{ autoReviewAuthorizationLabel }}</NDescriptionsItem>
      <NDescriptionsItem v-if="record.rationale" label="审批理由">{{ textValue(record.rationale) }}</NDescriptionsItem>
      <NDescriptionsItem :label="autoReviewActionLabel"><pre class="auto-review-action">{{ autoReviewActionSummary }}</pre></NDescriptionsItem>
      <NDescriptionsItem v-if="autoReviewAction.cwd" label="目录">{{ textValue(autoReviewAction.cwd) }}</NDescriptionsItem>
    </NDescriptions>
  </NCard>

  <NCard v-else-if="item.type === 'fileChange'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="文件变更">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <NList size="small" :show-divider="false"><NListItem v-for="({ change, diff }, index) in parsedChanges" :key="`${String(change.path)}-${index}`" :class="['diff-entry', `diff-${changeKind(change)}`]">
      <div class="diff-file-header"><span class="diff-paths"><NText code>{{ textValue(change.path) }}</NText><template v-if="changeMovePath(change)"><span aria-hidden="true"> → </span><NText code>{{ textValue(changeMovePath(change)) }}</NText></template></span><span class="diff-file-summary"><NTag size="small">{{ changeLabel(change) }}</NTag><span v-if="diff.added" class="diff-count-add">+{{ diff.added }}</span><span v-if="diff.deleted" class="diff-count-delete">−{{ diff.deleted }}</span></span></div>
      <NCollapse v-if="diff.hunks.length" :default-expanded-names="[index]"><NCollapseItem :title="`查看差异 · 新增 ${diff.added} 行，删除 ${diff.deleted} 行`" :name="index">
        <div class="diff-viewer">
          <section v-for="(hunk, hunkIndex) in diff.hunks" :key="hunk.key" class="diff-hunk">
            <div v-if="hunkIndex > 0" class="diff-hunk-separator" aria-label="下一处变更">⋮</div>
            <div class="diff-table" role="table" :aria-label="`变更区块 ${hunkIndex + 1}`">
              <div v-for="(line, lineIndex) in hunk.lines" :key="lineIndex" :class="['diff-code-line', `diff-line-${line.kind}`]" role="row">
                <span class="diff-line-number" role="cell">{{ diffLineNumber(line) }}</span><span class="diff-line-marker" aria-hidden="true">{{ line.kind === "add" ? "+" : line.kind === "delete" ? "−" : " " }}</span><code class="diff-line-content" role="cell">{{ line.content || " " }}</code>
              </div>
            </div>
          </section>
        </div>
      </NCollapseItem></NCollapse>
    </NListItem></NList>
    <NText v-if="changes.length === 0" depth="3">没有文件变更</NText>
  </NCard>

  <NCard v-else-if="item.type === 'mcpToolCall'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="MCP 工具">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <div class="inline-detail-fields"><span v-if="record.server || record.serverName" class="inline-detail-field"><NText depth="3">服务：</NText><span>{{ mcpServiceLabel }}</span></span><span class="inline-detail-field"><NText depth="3">工具：</NText><span>{{ mcpToolLabel }}</span></span><span v-if="durationLabel" class="inline-detail-field"><NText depth="3">耗时：</NText><span>{{ durationLabel }}</span></span><span v-if="record.readOnlyHint !== null && record.readOnlyHint !== undefined" class="inline-detail-field"><NText depth="3">只读：</NText><span>{{ record.readOnlyHint ? "是" : "否" }}</span></span></div>
    <NCollapse v-if="mcpArguments !== undefined || mcpContent.length || record.error"><NCollapseItem title="参数与内容" name="details"><NDescriptions :column="1" size="small" label-placement="left"><NDescriptionsItem v-if="mcpArguments !== undefined" label="参数"><pre class="long-output">{{ shortenedText(mcpArguments) }}</pre></NDescriptionsItem><NDescriptionsItem v-for="block in mcpContent" :key="block.key" label="内容"><pre class="long-output">{{ shortenedText(block.text) }}</pre></NDescriptionsItem><NDescriptionsItem v-if="record.error" label="错误"><pre class="long-output">{{ shortenedText(record.error) }}</pre></NDescriptionsItem></NDescriptions></NCollapseItem></NCollapse>
  </NCard>

  <NCard v-else-if="item.type === 'dynamicToolCall'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="工具调用">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <div class="inline-detail-fields"><span class="inline-detail-field"><NText depth="3">工具：</NText><span>{{ toolName }}</span></span><span v-if="durationLabel" class="inline-detail-field"><NText depth="3">耗时：</NText><span>{{ durationLabel }}</span></span></div>
    <NCollapse v-if="toolDetailFields.length"><NCollapseItem title="参数与结果" name="details"><NDescriptions :column="1" size="small" label-placement="left"><NDescriptionsItem v-for="field in toolDetailFields" :key="field.key" :label="field.label"><pre class="long-output">{{ shortenedText(field.value) }}</pre></NDescriptionsItem></NDescriptions></NCollapseItem></NCollapse>
  </NCard>

  <NCard v-else-if="item.type === 'webSearch'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="网络搜索">
    <NText>{{ webQuery }}</NText><NList v-if="webUrls.length" size="small" :show-divider="false"><NListItem v-for="url in webUrls" :key="url"><NText code class="web-result-url">{{ url }}</NText></NListItem></NList><NCollapse v-if="webResults.length"><NCollapseItem :title="`结果 ${webResults.length} 项`" name="results"><NList size="small" :show-divider="false"><NListItem v-for="(result, index) in webResults" :key="String(result.url ?? index)"><NText strong>{{ result.title ?? result.name ?? `结果 ${index + 1}` }}</NText><br><NText depth="3">{{ shortenedText(result.snippet ?? result.text ?? "暂无摘要", 800) }}</NText></NListItem></NList></NCollapseItem></NCollapse>
  </NCard>

  <NCard v-else-if="item.type === 'agents'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="协作代理">
    <NList v-if="agentEntries.length" size="small" :show-divider="false"><NListItem v-for="(agent, index) in agentEntries" :key="String(agent.threadId ?? index)"><NSpace justify="space-between" align="center" :wrap="false"><span><NText strong>{{ agent.agentNickname ?? agent.agentRole ?? agent.name ?? agent.agentPath ?? `代理 ${index + 1}` }}</NText><NText v-if="agent.status" depth="3"> · {{ textValue(agent.status) }}</NText></span><NButton v-if="typeof agent.threadId === 'string'" size="tiny" @click="emit('action', { type: 'switchAgent', threadId: String(agent.threadId) })">切换</NButton></NSpace></NListItem></NList>
    <NText v-else depth="3">暂无协作代理</NText>
  </NCard>

  <NCard v-else-if="item.type === 'backgroundProcesses'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="后台进程">
    <template v-if="backgroundProcessEntries.length" #header-extra><NButton size="tiny" type="warning" secondary @click="emit('action', { type: 'stopAllBackgroundProcesses' })">全部停止</NButton></template>
    <NList v-if="backgroundProcessEntries.length" size="small" :show-divider="false"><NListItem v-for="(process, index) in backgroundProcessEntries" :key="String(process.processId ?? process.id ?? index)"><NSpace justify="space-between" align="center" :wrap="false"><span><NText code>{{ process.command ?? process.name ?? process.processId ?? `进程 ${index + 1}` }}</NText><NText v-if="process.status" depth="3"> · {{ textValue(process.status) }}</NText></span><NButton v-if="typeof process.processId === 'string'" size="tiny" type="error" secondary @click="emit('action', { type: 'stopBackgroundProcess', processId: process.processId })">停止</NButton></NSpace></NListItem></NList>
    <NText v-else depth="3">暂无后台进程</NText>
  </NCard>

  <NCard v-else-if="item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="协作代理">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <NDescriptions :column="2" size="small" label-placement="left"><NDescriptionsItem v-if="record.tool" label="操作">{{ textValue(record.tool) }}</NDescriptionsItem><NDescriptionsItem v-if="record.agentPath" label="代理">{{ textValue(record.agentPath) }}</NDescriptionsItem><NDescriptionsItem v-if="record.prompt" label="任务">{{ shortenedText(record.prompt, 800) }}</NDescriptionsItem></NDescriptions>
    <NCollapse v-if="agents.length || record.result || record.error"><NCollapseItem title="执行状态" name="details"><NDescriptions :column="1" size="small" label-placement="left"><NDescriptionsItem v-for="(agent, index) in agents" :key="String(agent.agentPath ?? agent.id ?? index)" :label="String(agent.agentPath ?? agent.name ?? `代理 ${index + 1}`)">{{ shortenedText(agent.status ?? agent.message ?? agent.result, 1000) }}</NDescriptionsItem><NDescriptionsItem v-if="!agents.length && record.result" label="结果">{{ shortenedText(record.result) }}</NDescriptionsItem><NDescriptionsItem v-if="record.error" label="错误">{{ shortenedText(record.error) }}</NDescriptionsItem></NDescriptions></NCollapseItem></NCollapse>
  </NCard>

  <NCard v-else-if="item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" :title="title"><MarkdownContent v-if="reviewText !== '—'" :source="reviewText" /><NText v-else depth="3">{{ item.type === "enteredReviewMode" ? "正在审查当前更改" : "审查已结束" }}</NText></NCard>

  <NCard v-else-if="item.type === 'imageView' || item.type === 'imageGeneration'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" :title="title">
    <template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template>
    <NSpace vertical size="small"><NImage v-if="imagePreviewUrl || generatedImageDataUrl" :src="imagePreviewUrl || generatedImageDataUrl || ''" object-fit="contain" width="240" :alt="title" /><NAlert v-else-if="imagePreviewError || record.failure" type="warning" :show-icon="false">图片无法显示：{{ imagePreviewError || textValue(record.failure) }}</NAlert><NText v-else depth="3">图片尚未生成完成</NText><NText v-if="imagePath" code>{{ textValue(imagePath) }}</NText><NText v-if="record.revisedPrompt || record.prompt" depth="3">{{ shortenedText(record.revisedPrompt ?? record.prompt, 800) }}</NText></NSpace>
  </NCard>

  <NCard v-else-if="item.type === 'plan'" size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle" title="计划"><template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template><MarkdownContent v-if="displayText" :source="displayText" :streaming="item.status === 'running'" /><NDescriptions v-else :column="1" size="small" label-placement="left"><NDescriptionsItem v-for="field in genericFields" :key="field.key" :label="field.label">{{ shortenedText(field.value, 1200) }}</NDescriptionsItem></NDescriptions></NCard>

  <NCard v-else size="small" class="tool-card item-card" :content-style="compactContentStyle" :header-style="compactHeaderStyle"><template #header><span class="card-title"><NIcon :component="EllipsisHorizontalCircleOutline" /> {{ title }}</span></template><template #header-extra><NTag size="small" :type="statusType">{{ statusLabel }}</NTag></template><NDescriptions v-if="genericFields.length" :column="1" size="small" label-placement="left"><NDescriptionsItem v-for="field in genericFields" :key="field.key" :label="field.label"><pre class="long-output">{{ shortenedText(field.value) }}</pre></NDescriptionsItem></NDescriptions><NText v-else depth="3">暂无可显示内容</NText></NCard>
</template>

<style scoped>
.item-card {
  font-size: 1.04em;
}

.message-agent {
  align-self: flex-start;
  width: min(100%, 920px);
  padding: 7px 38px 9px 5px;
  border: 0;
  background: transparent;
}

.message-agent .copy-message-button {
  position: absolute;
  top: 5px;
  right: 5px;
}

.message-user {
  background: color-mix(in srgb, var(--app-accent, #10a37f) 10%, var(--app-raised, rgb(255 255 255 / 4%)));
  border-color: color-mix(in srgb, var(--app-accent, #10a37f) 28%, var(--app-border, rgb(255 255 255 / 12%)));
}
.message-agent :deep(.markdown-content a) { cursor: pointer !important; }

.auto-review-card { border-left: 3px solid var(--app-accent, #10a37f); }
.auto-review-denied, .auto-review-timedOut, .auto-review-aborted { border-left-color: #ef4444; }
.auto-review-action { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; font: inherit; }

.diff-entry {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  margin-block: 6px;
  padding: 9px 10px;
  border: 1px solid var(--app-border, #64748b);
  border-left-width: 3px;
  border-radius: 8px;
  background: var(--app-raised, rgb(127 127 127 / 5%));
}

.diff-entry :deep(.n-collapse-item__content-inner) { padding-top: 0; }
.diff-entry :deep(.n-list-item__main),
.diff-entry :deep(.n-collapse-item),
.diff-entry :deep(.n-collapse-item__content-wrapper),
.diff-entry :deep(.n-collapse-item__content-inner) { min-width: 0; max-width: 100%; }

.diff-add { border-left-color: #22c55e; background: rgb(34 197 94 / 8%); }
.diff-update { border-left-color: #3b82f6; background: rgb(59 130 246 / 8%); }
.diff-delete { border-left-color: #ef4444; background: rgb(239 68 68 / 8%); }
.diff-move { border-left-color: #a855f7; background: rgb(168 85 247 / 8%); }

.diff-paths {
  min-width: 0;
  overflow-wrap: anywhere;
}

.diff-file-header,
.diff-file-summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.diff-file-header { justify-content: space-between; }
.diff-file-summary { flex: none; font: 600 .9em/1 var(--app-font-family); }
.diff-count-add { color: #22c55e; }
.diff-count-delete { color: #ef4444; }

.diff-viewer {
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-gutter: stable;
  border: 1px solid var(--app-border, rgb(127 127 127 / 22%));
  border-radius: 7px;
  background: var(--app-raised, rgb(2 6 23 / 24%));
}

.diff-hunk-separator { padding: 1px 0 1px 1.5ch; color: var(--app-muted, #8b949e); background: var(--app-raised, transparent); font-size: .9em; line-height: 1.2; }
.diff-table { min-width: 100%; width: max-content; font: .91em/1.55 var(--app-font-family); }
.diff-code-line { display: grid; grid-template-columns: 5ch 2.5ch minmax(max-content, 1fr); min-height: 1.55em; }
.diff-line-number { padding-inline: 6px; color: var(--app-diff-gutter-text, var(--app-muted, #8b949e)); text-align: right; user-select: none; opacity: .78; }
.diff-line-marker { text-align: center; user-select: none; }
.diff-line-content { padding-inline: 7px 14px; color: inherit; white-space: pre; }
.diff-line-context { color: var(--app-text, #dbe3ef); background: transparent; }
.diff-line-add { color: var(--app-diff-add-text, #3fb950); background: var(--app-diff-add, #213a2b); }
.diff-line-add .diff-line-number { background: var(--app-diff-add-gutter, #213a2b); }
.diff-line-delete { color: var(--app-diff-delete-text, #f85149); background: var(--app-diff-delete, #4a221d); }
.diff-line-delete .diff-line-number { background: var(--app-diff-delete-gutter, #4a221d); }
.diff-line-notice { color: #fbbf24; background: rgb(245 158 11 / 10%); font-style: italic; }

.web-result-url {
  overflow-wrap: anywhere;
}

.tool-card :deep(.n-descriptions),
.tool-card :deep(.n-descriptions-table-wrapper),
.tool-card :deep(.n-descriptions-table) { width: 100%; }
.tool-card :deep(.n-descriptions-table) { table-layout: fixed; }
.tool-card :deep(.n-descriptions-table-content__label) { width: 7.5em; }
.tool-card :deep(.n-descriptions-table-content__content),
.tool-card .long-output { min-width: 0; width: 100%; }
.tool-card,
.tool-card :deep(.n-card__content) { min-width: 0; width: 100%; }
</style>
