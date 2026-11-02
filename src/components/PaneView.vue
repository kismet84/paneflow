<script setup lang="ts">
import { computed, h, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { NAlert, NButton, NDropdown, NIcon, NInput, NSelect, NTag, NText, NTooltip } from "naive-ui";
import { AddOutline, ArrowDownOutline, AttachOutline, DocumentTextOutline, FolderOpenOutline, LinkOutline, PauseOutline, SendOutline } from "@vicons/ionicons5";
import type { ItemAction, PaneState, PendingServerRequest, UiItem } from "../types";
import { readComposerHistory, writeComposerHistory } from "../composer-history";
import ApprovalCenter from "./ApprovalCenter.vue";
import ItemCard from "./ItemCard.vue";
import VirtualList from "./VirtualList.vue";

const props = withDefaults(defineProps<{
  pane: PaneState;
  defaultCwd: string;
  models: Array<{ label: string; value: string; efforts: string[]; inputModalities: string[]; defaultEffort: string | null }>;
  focused: boolean;
  pendingRequests: PendingServerRequest[];
  approvalResolving: boolean;
  connectionReady?: boolean;
  rateLimitLabels: string[];
  paneNumber?: number;
  showTitle?: boolean;
  approvalReviewer?: string | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  commandShellPath?: string;
  unwrapPowerShellCommands?: boolean;
  mcpGatewayAdaptation?: boolean;
  searchFiles?: (query: string) => Promise<Array<{ name: string; path: string; relativePath: string }>>;
}>(), { showTitle: true, connectionReady: true });
const emit = defineEmits<{
  send: [];
  interrupt: [];
  newThread: [];
  openSessions: [];
  chooseAttachments: [];
  chooseDirectory: [];
  openSkills: [];
  pasteAttachments: [paths: string[]];
  slashCommand: [command: string];
  removeAttachment: [id: string];
  removeReference: [id: string];
  resolve: [request: PendingServerRequest, result?: unknown, error?: { code: number; message: string }];
  scrollState: [top: number, followTail: boolean];
  loadOlder: [];
  activate: [];
  itemAction: [action: ItemAction];
}>();

type ConversationScroller = { $el: HTMLElement; scrollToBottom: (force?: boolean) => void; scrollToPosition: (position: number) => void };
type ComposerInput = { focus: () => void; $el?: HTMLElement };
type ComposerToken = { start: number; end: number; query: string };

const output = ref<ConversationScroller | null>(null);
const composer = ref<ComposerInput | null>(null);
const composerCaret = ref(0);
const restoredThreadId = ref<string | null>(null);
const slashIndex = ref(-1);
const fileSuggestions = ref<Array<{ name: string; path: string; relativePath: string }>>([]);
const fileSearchState = ref<"idle" | "needsQuery" | "noRoot" | "searching" | "ready" | "error">("idle");
const composerMenuDismissed = ref(false);
const composerHint = ref("");
const promptHistory = ref<string[]>(readComposerHistory(props.pane.id));
const promptHistoryIndex = ref(-1);
const promptHistoryDraft = ref("");
let fileSearchSequence = 0;
let fileSearchTimer: ReturnType<typeof setTimeout> | null = null;
const effortLabels: Record<string, string> = { minimal: "最低", low: "低", medium: "中等", high: "高", xhigh: "极高" };
const effortOptions = computed(() => props.models.find((model) => model.value === props.pane.model)?.efforts.map((effort) => ({ label: effortLabels[effort] ?? effort, value: effort })) ?? []);
const modelSupportsImage = computed(() => {
  const model = props.models.find((candidate) => candidate.value === props.pane.model);
  return !model || model.inputModalities.length === 0 || model.inputModalities.includes("image");
});
const slashOptions = [
  { label: "/agents", description: "查看并切换子代理", usage: "/agents", key: "agents" },
  { label: "/cd", description: "切换工作目录", usage: "/cd", key: "cd" },
  { label: "/compact", description: "压缩上下文", usage: "/compact", key: "compact" },
  { label: "/fast", description: "切换快速服务层级", usage: "/fast", key: "fast" },
  { label: "/goal", description: "查看或设置当前目标", usage: "/goal <目标内容> | pause | resume | clear", key: "goal" },
  { label: "/mcp", description: "查看 MCP 状态", usage: "/mcp", key: "mcp" },
  { label: "/new", description: "新建会话", usage: "/new", key: "new" },
  { label: "/permissions", description: "切换权限模式", usage: "/permissions", key: "permissions" },
  { label: "/plan", description: "进入计划模式", usage: "/plan [任务内容]", key: "plan" },
  { label: "/ps", description: "查看后台进程", usage: "/ps", key: "ps" },
  { label: "/rename", description: "重命名当前会话", usage: "/rename <新名称>", key: "rename" },
  { label: "/resume", description: "恢复历史会话", usage: "/resume", key: "resume" },
  { label: "/review", description: "审查未提交更改", usage: "/review", key: "review" },
  { label: "/skills", description: "查看可用技能", usage: "/skills", key: "skills" },
  { label: "/status", description: "查看当前状态", usage: "/status", key: "status" },
  { label: "/stop", description: "关闭所有后台进程", usage: "/stop", key: "stop" }
];
const slashQuery = computed(() => props.pane.draft.match(/^\/([a-z]*)$/i)?.[1]?.toLowerCase() ?? null);
const filteredSlashOptions = computed(() => slashQuery.value === null ? [] : slashOptions.filter((option) => option.key.startsWith(slashQuery.value!)));
const activeToken = (marker: "@" | "$"): ComposerToken | null => {
  const beforeCaret = props.pane.draft.slice(0, composerCaret.value);
  const match = marker === "@"
    ? beforeCaret.match(/@([^\s@]*)$/)
    : beforeCaret.match(/\$"([^"]*)$/) ?? beforeCaret.match(/\$([^\s$"]*)$/);
  if (!match || match.index === undefined) return null;
  return { start: match.index, end: composerCaret.value, query: match[1] ?? "" };
};
const skillToken = computed(() => activeToken("@"));
const skillQuery = computed(() => skillToken.value?.query.toLocaleLowerCase() ?? null);
const filteredSkills = computed(() => skillQuery.value === null ? [] : props.pane.skills.filter((skill) =>
  `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase().includes(skillQuery.value!)
));
const fileToken = computed(() => activeToken("$"));
const fileQuery = computed(() => fileToken.value?.query ?? null);
const composerMenuMode = computed<"slash" | "skill" | "file" | null>(() => slashQuery.value !== null ? "slash" : skillQuery.value !== null ? "skill" : fileQuery.value !== null ? "file" : null);
const composerMenuVisible = computed(() => props.focused && composerMenuMode.value !== null && !composerMenuDismissed.value);
const effectiveCwd = computed(() => props.pane.cwd || props.defaultCwd || "未设置工作目录");
const contextUsedPercent = computed(() => {
  const remaining = props.pane.contextRemainingPercent;
  return typeof remaining === "number" ? 100 - Math.min(100, Math.max(0, remaining)) : null;
});
const contextLabel = computed(() => contextUsedPercent.value === null ? "" : `上下文已用 ${contextUsedPercent.value}%`);
const permissionModeLabel = computed(() => {
  const reviewer = props.pane.approvalsReviewer ?? props.approvalReviewer ?? "";
  const policy = props.pane.approvalPolicy ?? props.approvalPolicy;
  if (["auto_review", "guardian_subagent"].includes(reviewer)) return "权限：自动审批";
  if (policy === "never") return "权限：完全访问";
  if (props.pane.activePermissionProfile === ":read-only" || !props.pane.activePermissionProfile && props.sandboxMode === "read-only") return "权限：只读";
  if (props.pane.activePermissionProfile === ":danger-full-access") return "权限：完全访问";
  if (props.pane.activePermissionProfile === ":workspace" || policy === "on-request") return "权限：请求审批";
  return "";
});
const goalStatusLabel = computed(() => {
  const goal = props.pane.goal;
  if (!goal || goal.status === "complete") return "";
  const status = String(goal.status ?? "active");
  const elapsedSeconds = typeof goal.timeUsedSeconds === "number" ? Math.max(0, Math.floor(goal.timeUsedSeconds)) : 0;
  const elapsed = elapsedSeconds < 60 ? "不足 1 分钟" : elapsedSeconds < 3600 ? `${Math.floor(elapsedSeconds / 60)} 分钟` : `${Math.floor(elapsedSeconds / 3600)} 小时 ${Math.floor(elapsedSeconds % 3600 / 60)} 分钟`;
  return `目标：${({ active: "进行中", paused: "已暂停", blocked: "受阻", usageLimited: "用量受限", budgetLimited: "预算受限" } as Record<string, string>)[status] ?? status} · ${elapsed}`;
});
const activeSubAgentCount = computed(() => Object.values(props.pane.subAgents ?? {}).filter((agent) => ["pendingInit", "running", "unknown"].includes(agent.status)).length);
const backgroundTaskCount = computed(() => props.pane.backgroundTerminals?.length ?? 0);
const attachmentCount = computed(() => props.pane.attachments.length + props.pane.references.length);
const attachmentLimitReached = computed(() => attachmentCount.value >= 20);
const threadSettingsLocked = computed(() => Boolean(props.pane.activeTurnId || props.pane.status === "starting" || props.pane.status === "interrupting" || props.pendingRequests.length));
const formatBytes = (value: number): string => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const composerUnavailable = computed(() => (!props.pane.draft.trim() && props.pane.attachments.length === 0 && props.pane.references.length === 0)
  || !props.connectionReady
  || !modelSupportsImage.value && props.pane.attachments.length > 0
  || props.pane.status === "starting"
  || props.pane.status === "interrupting");
const composerDisabledReason = computed(() => {
  if (!props.connectionReady) return "Codex 尚未连接；连接恢复后即可发送。";
  if (!modelSupportsImage.value && props.pane.attachments.length > 0) return "当前模型不支持图片，请移除图片或切换模型。";
  if (props.pane.status === "starting") return "会话正在启动，请稍候。";
  if (props.pane.status === "interrupting") return "正在停止当前任务，请稍候。";
  return "";
});
const noSpellcheckInputProps = { spellcheck: false, autocorrect: "off", autocapitalize: "off" } as const;
const modelSelectLabels = computed(() => ["模型", ...props.models.map((model) => model.label)]);
const effortSelectLabels = computed(() => ["推理", ...effortOptions.value.map((option) => option.label)]);
const composerDropdownOptions = computed(() => {
  if (composerMenuMode.value === "slash") {
    if (!filteredSlashOptions.value.length) return [{ key: "empty:slash", disabled: true, label: "没有匹配的命令" }];
    return filteredSlashOptions.value.map((option, index) => ({
      key: `slash:${option.key}`,
      label: () => h("div", { class: "composer-command-option", onMouseenter: () => { slashIndex.value = index; } }, [
        h("strong", { class: "composer-option-title" }, option.label),
        h("span", { class: "composer-option-hint" }, [
          h("span", { class: "composer-option-description" }, option.description),
          option.usage !== option.label ? h("code", { class: "composer-option-usage" }, option.usage) : null
        ])
      ]),
      props: { class: index === slashIndex.value ? "slash-option-active" : "", onMouseenter: () => { slashIndex.value = index; } }
    }));
  }
  if (composerMenuMode.value === "skill" && !filteredSkills.value.length) {
    return [{ key: "empty:skill", disabled: true, label: props.pane.skills.length ? "没有匹配的 Skill" : "暂无可用 Skill" }];
  }
  if (composerMenuMode.value === "file" && !fileSuggestions.value.length) {
    const label = fileSearchState.value === "needsQuery" ? "继续输入文件名以开始搜索" : fileSearchState.value === "noRoot" ? "请先选择工作目录" : fileSearchState.value === "searching" ? "正在搜索工作区文件…" : fileSearchState.value === "error" ? "文件搜索失败；继续输入以重试" : "没有匹配的文件";
    return [{ key: "empty:file", disabled: true, label }];
  }
  const options = composerMenuMode.value === "skill"
    ? filteredSkills.value.map((skill) => ({ key: `skill:${skill.name}`, label: () => h("div", { class: "composer-rich-option" }, [h("strong", skill.name), skill.description ? h("span", skill.description) : null]) }))
    : fileSuggestions.value.map((file) => ({ key: `file:${file.path}`, label: () => h("div", { class: "composer-rich-option" }, [h("strong", file.name), h("span", file.relativePath)]) }));
  return options.map((option, index) => ({ ...option, props: { class: index === slashIndex.value ? "slash-option-active" : "", onMouseenter: () => { slashIndex.value = index; } } }));
});
const composerMenuProps = () => ({ class: "composer-options-menu", style: "max-height: min(320px, calc(100vh - 180px));" });
const activeComposerOptions = computed(() => composerMenuMode.value === "slash" ? filteredSlashOptions.value : composerMenuMode.value === "skill" ? filteredSkills.value : fileSuggestions.value);
const itemKey = (item: UiItem): string => `${item.turnId}:${item.id}`;
const estimateItemSize = (item: UiItem): number => {
  if (item.type === "userMessage") return 72;
  if (item.type === "agentMessage" || item.type === "reasoning" || item.type === "plan") {
    const text = typeof item.data.text === "string" ? item.data.text : item.streamText;
    return Math.min(560, 72 + Math.ceil(text.length / 44) * 20);
  }
  if (item.type === "fileChange") return 180;
  return 124;
};
const outputElement = (): HTMLElement | null => output.value?.$el ?? null;

const focusComposer = async (): Promise<void> => {
  await nextTick();
  composer.value?.focus();
};
const composerTextarea = (): HTMLTextAreaElement | null => composer.value?.$el?.querySelector("textarea") ?? null;
const placeComposerCaret = async (position: number): Promise<void> => {
  await focusComposer();
  const textarea = composerTextarea();
  textarea?.setSelectionRange(position, position);
  composerCaret.value = position;
};
const replaceComposerToken = (token: ComposerToken, replacement: string): void => {
  props.pane.draft = `${props.pane.draft.slice(0, token.start)}${replacement}${props.pane.draft.slice(token.end)}`;
  void placeComposerCaret(token.start + replacement.length);
};
const syncComposerCaret = (event: Event): void => {
  if (event.target instanceof HTMLTextAreaElement) composerCaret.value = event.target.selectionStart;
};
const scrollToBottom = async (): Promise<void> => {
  if (!props.pane.followTail) return;
  await nextTick();
  output.value?.scrollToBottom(false);
};
const forceScrollToBottom = async (): Promise<void> => {
  await nextTick();
  output.value?.scrollToBottom(true);
  const element = outputElement();
  if (element) emit("scrollState", element.scrollTop, true);
};
const handleOutputScroll = (event: Event): void => {
  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : outputElement();
  if (!element) return;
  const followTail = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  emit("scrollState", element.scrollTop, followTail);
  if (element.scrollTop < 240) emit("loadOlder");
};
const selectSlashCommand = (command: string): void => {
  props.pane.draft = `/${command} `;
  slashIndex.value = 0;
  void focusComposer();
};
const selectSkill = (name: string): void => {
  const token = skillToken.value;
  if (!token) return;
  replaceComposerToken(token, `@${name} `);
  slashIndex.value = 0;
};
const selectFile = (path: string): void => {
  const file = fileSuggestions.value.find((candidate) => candidate.path === path);
  if (!file) return;
  if (!props.pane.references.some((reference) => reference.path === file.path)) {
    if (props.pane.attachments.length + props.pane.references.length >= 20) {
      props.pane.error = "每个窗格最多添加 20 个附件，请先移除部分附件。";
      return;
    }
    props.pane.references.push({ id: crypto.randomUUID(), name: file.name, path: file.path });
  }
  const mention = file.relativePath.includes(" ") ? `$"${file.relativePath}" ` : `$${file.relativePath} `;
  const token = fileToken.value;
  if (!token) return;
  replaceComposerToken(token, mention);
  fileSuggestions.value = [];
  slashIndex.value = 0;
};
const selectComposerOption = (key: string): void => {
  if (key.startsWith("slash:")) selectSlashCommand(key.slice(6));
  else if (key.startsWith("skill:")) selectSkill(key.slice(6));
  else if (key.startsWith("file:")) selectFile(key.slice(5));
};
const completeSlash = (): void => {
  const option = filteredSlashOptions.value[slashIndex.value] ?? filteredSlashOptions.value[0];
  if (option) props.pane.draft = option.label;
};
const scrollComposerSelectionIntoView = async (): Promise<void> => {
  await nextTick();
  document.querySelector<HTMLElement>(".composer-options-menu .slash-option-active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
};
const submitComposer = (): void => {
  if (composerUnavailable.value) {
    if (composerDisabledReason.value) composerHint.value = composerDisabledReason.value;
    return;
  }
  const submittedDraft = props.pane.draft.trim();
  if (submittedDraft && promptHistory.value.at(-1) !== submittedDraft) {
    promptHistory.value = [...promptHistory.value.slice(-49), submittedDraft];
    writeComposerHistory(props.pane.id, promptHistory.value);
  }
  promptHistoryIndex.value = -1;
  promptHistoryDraft.value = "";
  const match = props.pane.draft.trim().match(/^\/(new|resume|cd|cwd|status|compact|review|mcp|skills|agents|permission|permissions|ps|processes|stop|kill-processes|fast|goal|plan|rename)(?:\s+([\s\S]*))?$/i);
  const command = match?.[1]?.toLowerCase();
  if (!command) {
    if (props.pane.draft.trimStart().startsWith("/")) {
      composerHint.value = "未识别这个斜杠命令；请从命令菜单选择，或删除开头的 / 后作为普通消息发送。";
      return;
    }
    void forceScrollToBottom();
    emit("send");
    return;
  }
  props.pane.draft = "";
  if (command === "new") emit("newThread");
  else if (command === "resume") emit("openSessions");
  else emit("slashCommand", `${command} ${match?.[2] ?? ""}`.trim());
};
const recallPrompt = (direction: -1 | 1): void => {
  if (!promptHistory.value.length) return;
  if (promptHistoryIndex.value === -1) {
    if (direction > 0) return;
    promptHistoryDraft.value = props.pane.draft;
    promptHistoryIndex.value = promptHistory.value.length - 1;
  } else {
    const next = promptHistoryIndex.value + direction;
    if (next >= promptHistory.value.length) {
      promptHistoryIndex.value = -1;
      props.pane.draft = promptHistoryDraft.value;
      void placeComposerCaret(props.pane.draft.length);
      return;
    }
    promptHistoryIndex.value = Math.max(0, next);
  }
  props.pane.draft = promptHistory.value[promptHistoryIndex.value] ?? "";
  void placeComposerCaret(props.pane.draft.length);
};
const handleKeydown = (event: KeyboardEvent): void => {
  if (composerMenuVisible.value && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.ctrlKey && !event.altKey && !event.metaKey && ["n", "p"].includes(event.key.toLowerCase()) || event.key === "Tab")) {
    if (!activeComposerOptions.value.length) return;
    event.preventDefault();
    const moveNext = event.key === "ArrowDown" || event.ctrlKey && event.key.toLowerCase() === "n";
    const movePrevious = event.key === "ArrowUp" || event.ctrlKey && event.key.toLowerCase() === "p" || event.key === "Tab" && event.shiftKey;
    if (moveNext) slashIndex.value = (slashIndex.value + 1) % activeComposerOptions.value.length;
    else if (movePrevious) slashIndex.value = slashIndex.value < 0 ? activeComposerOptions.value.length - 1 : (slashIndex.value - 1 + activeComposerOptions.value.length) % activeComposerOptions.value.length;
    if (moveNext || movePrevious) void scrollComposerSelectionIntoView();
    else if (composerMenuMode.value === "slash") completeSlash();
    else if (composerMenuMode.value === "skill") {
      const skill = filteredSkills.value[slashIndex.value] ?? filteredSkills.value[0];
      if (skill) selectSkill(skill.name);
    } else {
      const file = fileSuggestions.value[slashIndex.value] ?? fileSuggestions.value[0];
      if (file) selectFile(file.path);
    }
    return;
  }
  const textarea = event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget : composerTextarea();
  if (!composerMenuVisible.value && !event.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey
    && (event.key === "ArrowUp" && (textarea?.selectionStart ?? 0) === 0
      || event.key === "ArrowDown" && promptHistoryIndex.value >= 0 && (textarea?.selectionEnd ?? 0) === props.pane.draft.length)) {
    event.preventDefault();
    recallPrompt(event.key === "ArrowUp" ? -1 : 1);
    return;
  }
  if (event.key === "ArrowDown" && props.pane.draft.length === 0 && !event.isComposing) {
    event.preventDefault();
    void forceScrollToBottom();
    return;
  }
  if (composerMenuVisible.value && activeComposerOptions.value.length > 0 && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    const option = activeComposerOptions.value[slashIndex.value] ?? activeComposerOptions.value[0];
    if (composerMenuMode.value === "slash" && option && "key" in option) {
      if (props.pane.draft.endsWith(" ") && props.pane.draft.trim().toLowerCase() === option.label.toLowerCase()) submitComposer();
      else selectSlashCommand(option.key);
    }
    else if (composerMenuMode.value === "skill" && option && "name" in option) selectSkill(option.name);
    else if (composerMenuMode.value === "file" && option && "path" in option) selectFile(option.path);
    return;
  }
  if (event.key === "Escape" && composerMenuVisible.value) {
    event.preventDefault();
    composerMenuDismissed.value = true;
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitComposer();
  }
};
const handlePaste = (event: ClipboardEvent): void => {
  const clipboardData = event.clipboardData;
  const files = [...(clipboardData?.files ?? [])];
  const hasBinaryItem = files.length > 0 || [...(clipboardData?.items ?? [])].some((item) => item.kind === "file");
  if (hasBinaryItem) {
    event.preventDefault();
    const directPaths = [
      ...files.map((file) => (file as File & { path?: string }).path ?? ""),
      ...(window.codexPane?.resolveFilePaths?.(files) ?? [])
    ].filter(Boolean);
    const uriPaths = (clipboardData?.getData("text/uri-list") ?? "").split(/\r?\n/).filter((line) => line.startsWith("file://")).map((line) => {
      try {
        return decodeURIComponent(new URL(line).pathname).replace(/^\/([a-z]:)/i, "$1").replaceAll("/", "\\");
      } catch {
        return "";
      }
    }).filter(Boolean);
    emit("pasteAttachments", [...new Set([...directPaths, ...uriPaths])]);
  }
};
const openSlashMenu = (): void => {
  if (props.pane.draft.trim()) {
    composerHint.value = "斜杠命令只能从空输入框开始；当前草稿已为你保留。";
    void focusComposer();
    return;
  }
  props.pane.draft = "/";
  slashIndex.value = -1;
  composerMenuDismissed.value = false;
  void focusComposer();
};
const openSkillMenu = (): void => {
  if (!skillToken.value) replaceComposerToken({ start: composerCaret.value, end: composerCaret.value, query: "" }, "@");
  slashIndex.value = -1;
  composerMenuDismissed.value = false;
};
const openFileMenu = (): void => {
  if (!fileToken.value) replaceComposerToken({ start: composerCaret.value, end: composerCaret.value, query: "" }, "$");
  slashIndex.value = -1;
  composerMenuDismissed.value = false;
};
const activatePane = (event: MouseEvent): void => {
  emit("activate");
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".inline-approval, .n-select, .n-base-selection, button, input, textarea, select, [contenteditable], [role='button'], [role='option'], [role='combobox']")) return;
  if (window.getSelection()?.toString()) return;
  void focusComposer();
};
const hasFocusedInteractiveControl = (): boolean => document.activeElement instanceof Element
  && !!document.activeElement.closest(".inline-approval, .n-select, .n-base-selection, button, input:not(textarea), select, [contenteditable], [role='button'], [role='option'], [role='combobox']");

watch(() => {
  const last = props.pane.items.at(-1);
  return [props.pane.items.length, last?.id, last?.streamText.length, last?.status] as const;
}, scrollToBottom);
watch(() => props.pendingRequests.length, (count, previous) => {
  if (previous > count) void focusComposer();
});
watch(() => props.pane.draft, async () => {
  composerMenuDismissed.value = false;
  composerHint.value = "";
  await nextTick();
  const textarea = composerTextarea();
  composerCaret.value = textarea?.selectionStart ?? props.pane.draft.length;
});
watch(() => props.pane, (pane) => {
  promptHistory.value = readComposerHistory(pane.id);
  promptHistoryIndex.value = -1;
  promptHistoryDraft.value = "";
});
watch(() => props.focused, (focused) => {
  if (focused && props.pendingRequests.length === 0 && !hasFocusedInteractiveControl() && !window.getSelection()?.toString()) void focusComposer();
});
watch(slashQuery, () => { slashIndex.value = -1; });
watch(skillQuery, (query, previous) => {
  if (query !== null && previous === null) emit("openSkills");
  slashIndex.value = -1;
});
watch([fileQuery, () => props.focused], ([query, focused]) => {
  slashIndex.value = -1;
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  const sequence = ++fileSearchSequence;
  if (!focused || query === null || !props.searchFiles) {
    fileSuggestions.value = [];
    fileSearchState.value = "idle";
    return;
  }
  if (!props.pane.cwd && !props.defaultCwd) {
    fileSuggestions.value = [];
    fileSearchState.value = "noRoot";
    return;
  }
  if (!query.trim()) {
    fileSuggestions.value = [];
    fileSearchState.value = "needsQuery";
    return;
  }
  fileSearchState.value = "searching";
  fileSearchTimer = setTimeout(async () => {
    try {
      const files = await props.searchFiles!(query);
      if (sequence === fileSearchSequence) {
        fileSuggestions.value = files;
        fileSearchState.value = "ready";
      }
    } catch {
      if (sequence === fileSearchSequence) {
        fileSuggestions.value = [];
        fileSearchState.value = "error";
      }
    }
  }, 120);
});
watch(
  () => [props.pane.threadId, props.pane.items.length > 0, props.pane.followTail] as const,
  async ([threadId, hasItems, followTail]) => {
    if (followTail || !hasItems || restoredThreadId.value === threadId) return;
    await nextTick();
    const element = outputElement();
    if (!element) return;
    output.value?.scrollToPosition(Math.min(props.pane.scrollTop, Math.max(0, element.scrollHeight - element.clientHeight)));
    restoredThreadId.value = threadId;
  },
  { immediate: true }
);
watch(() => props.pane.model, (model) => {
  const option = props.models.find((candidate) => candidate.value === model);
  if (!option || props.pane.effort && option.efforts.includes(props.pane.effort)) return;
  props.pane.effort = option.defaultEffort ?? option.efforts[0] ?? null;
});
onMounted(async () => {
  await nextTick();
  if (props.pane.followTail) output.value?.scrollToBottom(true);
});
onUnmounted(() => {
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  fileSearchSequence += 1;
});
defineExpose({ focusComposer });
</script>

<template>
  <section class="pane" :class="{ 'pane-focused': focused, 'pane-without-header': showTitle === false && pane.status !== 'interrupting' && pane.status !== 'error' }" :data-pane-id="pane.id" :aria-label="pane.title" @focusin="emit('activate')" @click="activatePane">
    <header v-if="showTitle !== false || pane.status === 'interrupting' || pane.status === 'error'" class="pane-header">
      <div v-if="showTitle !== false" class="pane-title-wrap">
        <span v-if="pane.unread" class="unread-dot" aria-label="有新内容" />
        <span v-if="paneNumber" class="pane-number" :title="`按 Alt+${paneNumber} 聚焦此窗格`">{{ paneNumber }}</span>
        <strong class="pane-title">{{ pane.title || "新会话" }}</strong>
      </div>
      <NTag v-if="pane.status === 'interrupting' || pane.status === 'error'" size="small" :type="pane.status === 'error' ? 'error' : 'warning'">
        {{ pane.status === "interrupting" ? "正在停止" : "需要处理" }}
      </NTag>
    </header>

    <VirtualList ref="output" class="pane-output" :items="pane.items" :item-key="itemKey" :estimate-size="estimateItemSize" :min-item-size="56" :buffer="240" :follow-tail="pane.followTail" role="log" aria-live="polite" aria-relevant="additions" @scroll="handleOutputScroll">
      <template #before><div v-if="pane.historyLoading" class="history-loading">正在加载更早内容…</div></template>
      <template #default="{ item }"><div class="conversation-item"><ItemCard :item="item" :unwrap-power-shell="unwrapPowerShellCommands" :command-shell-path="commandShellPath" :mcp-gateway-adaptation="mcpGatewayAdaptation" @action="emit('itemAction', $event)" /></div></template>
      <template #empty>
        <div class="empty-conversation">
          <div class="empty-conversation-content">
            <strong>{{ showTitle === false ? "开始一段新会话" : "此窗格已就绪" }}</strong>
            <NText depth="3">在下方描述任务；输入 <kbd>/</kbd> 执行命令、<kbd>@</kbd> 使用 Skill、<kbd>$</kbd> 引用工作区文件。</NText>
          </div>
        </div>
      </template>
    </VirtualList>
    <NButton v-if="!pane.followTail && pane.items.length" class="scroll-to-bottom" size="small" secondary round aria-label="回到最新消息" @click="forceScrollToBottom">
      <template #icon><NIcon :component="ArrowDownOutline" /></template>
      回到最新
    </NButton>

    <NAlert v-if="pane.error" type="error" closable class="pane-error" @close="pane.error = null">{{ pane.error }}</NAlert>

    <div class="composer">
      <ApprovalCenter
        :requests="pendingRequests"
        :show="pendingRequests.length > 0"
        :pane-id="null"
        :resolving="approvalResolving"
        @update:show="undefined"
        @resolve="(request, result, error) => emit('resolve', request, result, error)"
      />

      <div v-if="pane.attachments.length || pane.references.length" class="attachment-list">
        <div class="attachment-summary" role="status"><span>已添加 {{ attachmentCount }} / 20 个附件</span><span v-if="attachmentLimitReached">已达到上限</span></div>
        <div v-for="attachment in pane.attachments" :key="attachment.id" class="attachment-chip">
          <img v-if="attachment.kind === 'local'" :src="attachment.url" alt="" />
          <NIcon v-else :component="LinkOutline" size="20" aria-label="远程图片地址" />
          <span :title="attachment.kind === 'remote' ? (attachment.sourceUrl ?? attachment.url) : (attachment.sourcePath ?? attachment.name)">{{ attachment.kind === 'remote' ? (attachment.sourceUrl ?? attachment.url) : attachment.name }}<small v-if="attachment.size"> · {{ formatBytes(attachment.size) }}</small></span>
          <NButton quaternary circle size="tiny" :aria-label="`移除 ${attachment.name}`" @click="emit('removeAttachment', attachment.id)">×</NButton>
        </div>
        <div v-for="reference in pane.references" :key="reference.id" class="attachment-chip">
          <NIcon :component="DocumentTextOutline" size="20" aria-label="文件" />
          <span :title="reference.path">{{ reference.path }}</span>
          <NButton quaternary circle size="tiny" :aria-label="`移除 ${reference.name}`" @click="emit('removeReference', reference.id)">×</NButton>
        </div>
      </div>

      <NDropdown trigger="manual" placement="top-start" scrollable :show="composerMenuVisible" :options="composerDropdownOptions" :menu-props="composerMenuProps" @select="selectComposerOption">
        <NInput ref="composer" v-model:value="pane.draft" type="textarea" :maxlength="200000" :autosize="{ minRows: 2, maxRows: 8 }" :input-props="{ ...noSpellcheckInputProps, 'aria-label': '消息输入框', 'aria-keyshortcuts': 'Enter Shift+Enter ArrowUp ArrowDown' }" placeholder="描述任务，或输入 /、@、$ 快速开始…" @click="syncComposerCaret" @keyup="syncComposerCaret" @select="syncComposerCaret" @keydown="handleKeydown" @paste="handlePaste" />
      </NDropdown>

      <div v-if="composerMenuVisible" class="composer-menu-help" role="status">
        <span><kbd>↑</kbd><kbd>↓</kbd> 或 <kbd>Ctrl+P</kbd><kbd>Ctrl+N</kbd> 选择</span>
        <span><kbd>Tab</kbd> 补全 · <kbd>Shift+Tab</kbd> 上一项 · <kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 关闭</span>
      </div>

      <div v-if="composerDisabledReason || composerHint || pane.draft.length >= 180000" class="composer-notice" role="status">
        <span v-if="composerDisabledReason" class="composer-warning">{{ composerDisabledReason }}</span>
        <span v-else-if="composerHint">{{ composerHint }}</span>
        <span v-if="pane.draft.length >= 180000">还可输入 {{ (200000 - pane.draft.length).toLocaleString() }} 个字符</span>
      </div>

      <div class="composer-actions">
        <div class="composer-tools">
          <NTooltip><template #trigger><NButton quaternary circle size="small" aria-label="斜杠命令" @click="openSlashMenu">/</NButton></template>斜杠命令</NTooltip>
          <NTooltip><template #trigger><NButton quaternary circle size="small" aria-label="选择 Skill" @click="openSkillMenu">@</NButton></template>选择 Skill</NTooltip>
          <NTooltip><template #trigger><NButton quaternary circle size="small" aria-label="引用工作区文件" @click="openFileMenu">$</NButton></template>引用工作区文件</NTooltip>
          <NTooltip><template #trigger><span><NButton quaternary circle size="small" aria-label="添加附件" :disabled="attachmentLimitReached" @click="emit('chooseAttachments')"><template #icon><NIcon :component="AttachOutline" /></template></NButton></span></template>{{ attachmentLimitReached ? "已达到 20 个附件上限" : "添加文件或图片" }}</NTooltip>
          <NTooltip><template #trigger><span><NButton text class="cwd-button" aria-label="切换当前工作目录" :disabled="threadSettingsLocked" @click="emit('chooseDirectory')"><template #icon><NIcon :component="FolderOpenOutline" /></template><span class="cwd-text">{{ effectiveCwd }}</span></NButton></span></template>{{ threadSettingsLocked ? "任务或确认进行中，完成后再切换目录" : `${effectiveCwd} · 点击切换目录` }}</NTooltip>
        </div>
        <div class="composer-selects">
          <div class="content-fit-select model-select-fit">
            <span class="select-width-sizer" aria-hidden="true"><span v-for="label in modelSelectLabels" :key="label">{{ label }}</span></span>
            <NSelect v-model:value="pane.model" class="compact-select model-select" size="tiny" :options="models" placeholder="模型" aria-label="选择模型" :disabled="threadSettingsLocked" :consistent-menu-width="false" :menu-props="{ class: 'content-fit-select-menu' }" @mousedown.stop @click.stop />
          </div>
          <div class="content-fit-select effort-select-fit">
            <span class="select-width-sizer" aria-hidden="true"><span v-for="label in effortSelectLabels" :key="label">{{ label }}</span></span>
            <NSelect v-model:value="pane.effort" class="compact-select effort-select" size="tiny" :options="effortOptions" placeholder="推理" aria-label="选择推理强度" :disabled="threadSettingsLocked" :consistent-menu-width="false" :menu-props="{ class: 'content-fit-select-menu' }" @mousedown.stop @click.stop />
          </div>
        </div>
        <div class="composer-submit">
          <NButton v-if="pane.activeTurnId" size="small" secondary :disabled="composerUnavailable" @click="submitComposer"><template #icon><NIcon :component="AddOutline" /></template>追加</NButton>
          <NButton v-if="pane.activeTurnId" size="small" type="error" secondary @click="emit('interrupt')"><template #icon><NIcon :component="PauseOutline" /></template>停止</NButton>
          <NButton v-else size="small" type="primary" :disabled="composerUnavailable" @click="submitComposer"><template #icon><NIcon :component="SendOutline" /></template>发送</NButton>
        </div>
      </div>

      <footer class="status-line">
        <span v-if="pane.status === 'running' || pane.status === 'starting'" class="working-indicator" role="status">处理中<span class="working-dots">...</span></span>
        <button v-if="permissionModeLabel" class="status-action auto-review-indicator" type="button" title="查看或切换权限模式（/permissions）" @click="emit('slashCommand', 'permissions')">{{ permissionModeLabel }}</button>
        <span v-if="pane.collaborationMode === 'plan'">计划模式</span>
        <span v-if="goalStatusLabel">{{ goalStatusLabel }}</span>
        <span v-if="pane.activeFlags?.includes('waitingOnApproval')">等待操作确认</span>
        <span v-else-if="pane.activeFlags?.includes('waitingOnUserInput')">等待你的选择</span>
        <button v-if="activeSubAgentCount" class="status-action" type="button" title="查看子代理（/agents）" @click="emit('slashCommand', 'agents')">子代理 {{ activeSubAgentCount }}</button>
        <button v-if="backgroundTaskCount" class="status-action" type="button" title="查看后台任务（/ps）" @click="emit('slashCommand', 'ps')">后台任务 {{ backgroundTaskCount }}</button>
        <span v-if="contextLabel" class="context-usage" :class="{ 'context-usage-warning': (contextUsedPercent ?? 0) >= 80, 'context-usage-critical': (contextUsedPercent ?? 0) >= 95 }" :title="`剩余 ${100 - (contextUsedPercent ?? 0)}%`">{{ contextLabel }}</span>
        <span v-for="label in rateLimitLabels" :key="label">{{ label }}</span>
      </footer>
    </div>
  </section>
</template>
