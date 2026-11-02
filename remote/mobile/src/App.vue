<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { darkTheme, NAlert, NButton, NConfigProvider, NInput, NPopconfirm, NSpin } from "naive-ui";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { DesktopEvent, MobileCommand, MobileItem, MobileSnapshot } from "@codex-pane/remote-protocol";
import { RemoteClient } from "./remote-client";
import { isNearConversationBottom } from "./scroll";

const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
const prefersDark = ref(darkMedia.matches);
const emptySnapshot = (): MobileSnapshot => ({ deviceOnline: false, codexState: "stopped", codexMessage: "桌面未连接", appearance: { theme: "system", accentColor: "#10a37f" }, activeThreadId: null, activeThreadTitle: "Codex Pane", activeTurnId: null, models: [], selectedModel: null, selectedEffort: null, turnStatus: "idle", threads: [], items: [] });
const snapshot = ref(emptySnapshot());
const resolvedTheme = computed<"dark" | "light">(() => snapshot.value.appearance.theme === "system" ? prefersDark.value ? "dark" : "light" : snapshot.value.appearance.theme);
const activeTheme = computed(() => resolvedTheme.value === "dark" ? darkTheme : null);
const themeOverrides = computed(() => ({ common: {
  primaryColor: snapshot.value.appearance.accentColor,
  primaryColorHover: snapshot.value.appearance.accentColor,
  primaryColorPressed: snapshot.value.appearance.accentColor,
  primaryColorSuppl: snapshot.value.appearance.accentColor
} }));
const appearanceStyle = computed(() => ({ "--accent": snapshot.value.appearance.accentColor }));
const error = ref("");
const connectionState = ref<"connecting" | "connected" | "disconnected">("disconnected");
const sessionMenuOpen = ref(false);
const consoleOpen = ref(false);
const modelDraft = ref("");
const effortDraft = ref("");
const taskFilter = ref("all");
const stopTarget = ref<{ threadId: string; turnId: string } | null>(null);
const captureStopTarget = (show: boolean): void => {
  if (show) stopTarget.value = snapshot.value.activeThreadId && snapshot.value.activeTurnId ? { threadId: snapshot.value.activeThreadId, turnId: snapshot.value.activeTurnId } : null;
};
const draft = ref("");
const pendingCommands = reactive(new Map<string, MobileCommand["type"]>());
const resolvingApprovals = reactive(new Set<string>());
const sentDrafts = new Map<string, string>();
const scrollContainer = ref<HTMLElement | null>(null);
const followTail = ref(true);
const unread = ref(0);
const sessionButton = ref<HTMLButtonElement | null>(null);
const drawerCloseButton = ref<HTMLButtonElement | null>(null);
let client: RemoteClient | null = null;
const approvalResolutions = new Map<string, { item: Extract<MobileItem, { kind: "approval" }>; threadId: string }>();
const markdownCache = new Map<string, { source: string; html: string }>();

const sending = computed(() => [...pendingCommands.values()].includes("turn.send"));
const threadBusy = computed(() => [...pendingCommands.values()].some((type) => ["thread.new", "thread.open", "thread.fork", "thread.configure"].includes(type)));
const stopping = computed(() => [...pendingCommands.values()].includes("turn.interrupt"));
const taskActive = computed(() => snapshot.value.turnStatus === "running" || snapshot.value.turnStatus === "waiting");
const effortOptions = computed(() => snapshot.value.models.find((model) => model.id === modelDraft.value)?.efforts ?? []);
const visibleTasks = computed(() => snapshot.value.threads.filter((thread) => taskFilter.value === "all" || thread.status === taskFilter.value).sort((a, b) => b.updatedAt - a.updatedAt));
const statusText = (status: string): string => ({ idle: "空闲", running: "运行中", waiting: "待审批", failed: "失败", unknown: "状态待确认" }[status] ?? status);
const effortText = (effort: string): string => ({ none: "无", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "极高" }[effort] ?? effort);
watch(() => [snapshot.value.activeThreadId, snapshot.value.selectedModel, snapshot.value.selectedEffort], () => {
  modelDraft.value = snapshot.value.selectedModel ?? "";
  effortDraft.value = snapshot.value.selectedEffort ?? "";
});
const changeModel = (): void => { if (!effortOptions.value.includes(effortDraft.value)) effortDraft.value = effortOptions.value[0] ?? ""; };
const disablingRemote = computed(() => [...pendingCommands.values()].includes("remote.disable"));
const desktopReady = computed(() => connectionState.value === "connected" && snapshot.value.deviceOnline && snapshot.value.codexState === "ready");
const canSend = computed(() => desktopReady.value && Boolean(snapshot.value.activeThreadId) && draft.value.trim().length > 0 && !sending.value);
const statusClass = computed(() => desktopReady.value ? "online" : "offline");
const statusLabel = computed(() => {
  if (connectionState.value === "disconnected") return "未连接";
  if (snapshot.value.codexState === "starting") return "启动中";
  if (snapshot.value.codexState === "error") return "异常";
  return desktopReady.value ? "已连接" : "待机";
});

const markdown = (id: string, value: string): string => {
  const cached = markdownCache.get(id);
  if (cached?.source === value) return cached.html;
  const container = document.createElement("div");
  container.innerHTML = DOMPurify.sanitize(marked.parse(value, { async: false }) as string);
  for (const anchor of container.querySelectorAll("a")) {
    try {
      const url = new URL(anchor.href, location.origin);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported link");
      anchor.href = url.toString();
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } catch { anchor.replaceWith(document.createTextNode(anchor.textContent ?? "")); }
  }
  const html = container.innerHTML;
  markdownCache.set(id, { source: value, html });
  while (markdownCache.size > 300) markdownCache.delete(markdownCache.keys().next().value!);
  return html;
};
const nearBottom = (): boolean => {
  const element = scrollContainer.value;
  return !element || isNearConversationBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
};
const scrollLatest = async (): Promise<void> => {
  followTail.value = true;
  unread.value = 0;
  await nextTick();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (scrollContainer.value) scrollContainer.value.scrollTop = Math.max(0, scrollContainer.value.scrollHeight - scrollContainer.value.clientHeight);
  }));
};
const updateItems = async (operation: () => void): Promise<void> => {
  const shouldFollow = followTail.value && nearBottom();
  operation();
  if (shouldFollow) await scrollLatest();
  else unread.value += 1;
};
const handleScroll = (): void => {
  followTail.value = nearBottom();
  if (followTail.value) unread.value = 0;
};

const handleEvent = (event: DesktopEvent): void => {
  if (event.type === "snapshot") {
    void updateItems(() => { snapshot.value = event.snapshot; });
    return;
  }
  if (event.type === "device.status") {
    snapshot.value.deviceOnline = event.online;
    snapshot.value.codexState = event.codexState;
    snapshot.value.codexMessage = event.message;
    return;
  }
  if (event.type === "thread.summary") {
    const index = snapshot.value.threads.findIndex((thread) => thread.id === event.thread.id);
    if (index >= 0) snapshot.value.threads[index] = event.thread;
    else snapshot.value.threads.push(event.thread);
    return;
  }
  if (event.type === "item.upsert") {
    if (event.threadId !== snapshot.value.activeThreadId) return;
    void updateItems(() => {
      const index = snapshot.value.items.findIndex((item) => item.id === event.item.id);
      if (index >= 0) snapshot.value.items[index] = event.item;
      else snapshot.value.items.push(event.item);
    });
    return;
  }
  if (event.type === "approval.request" && event.threadId === snapshot.value.activeThreadId) void updateItems(() => {
    const index = snapshot.value.items.findIndex((item) => item.id === event.approval.id);
    if (index >= 0) snapshot.value.items[index] = event.approval;
    else snapshot.value.items.push(event.approval);
  });
  if (event.type === "turn.status" && event.threadId === snapshot.value.activeThreadId) snapshot.value.turnStatus = event.status;
  if (event.type === "desktop.required" || event.type === "notice") error.value = event.message;
  if (event.type === "command.result") {
    const commandType = pendingCommands.get(event.requestId);
    pendingCommands.delete(event.requestId);
    const approval = approvalResolutions.get(event.requestId);
    approvalResolutions.delete(event.requestId);
    if (!event.ok) {
      const sentDraft = sentDrafts.get(event.requestId);
      if (commandType === "turn.send" && sentDraft && !draft.value.trim()) draft.value = sentDraft;
      if (approval && approval.threadId === snapshot.value.activeThreadId && !snapshot.value.items.some((item) => item.id === approval.item.id)) snapshot.value.items.push(approval.item);
      error.value = event.message;
    }
    if (approval) resolvingApprovals.delete(approval.item.id);
    sentDrafts.delete(event.requestId);
  }
};

const connect = (): void => {
  client?.stop();
  client = new RemoteClient(handleEvent, (state, message) => {
    connectionState.value = state;
    if (message.includes("格式不兼容")) error.value = message;
  });
  client.start();
};
const sendCommand = (command: MobileCommand): void => {
  pendingCommands.set(command.requestId, command.type);
  try { client?.send(command); }
  catch (reason) {
    pendingCommands.delete(command.requestId);
    throw reason;
  }
};
const send = (): void => {
  if (!canSend.value) return;
  const value = draft.value.trim();
  const requestId = crypto.randomUUID();
  draft.value = "";
  sentDrafts.set(requestId, value);
  try { sendCommand({ type: "turn.send", requestId, threadId: snapshot.value.activeThreadId!, text: value }); }
  catch (reason) { sentDrafts.delete(requestId); draft.value = value; error.value = reason instanceof Error ? reason.message : String(reason); }
};
const newThread = (): void => { if (!desktopReady.value || threadBusy.value) return; try { sendCommand({ type: "thread.new", requestId: crypto.randomUUID() }); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } };
const openThread = (threadId: string): void => { if (!desktopReady.value || threadBusy.value) return; sessionMenuOpen.value = false; consoleOpen.value = false; try { sendCommand({ type: "thread.open", requestId: crypto.randomUUID(), threadId }); } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } };
const controlTask = (type: "turn.interrupt" | "thread.fork" | "thread.configure"): void => {
  const threadId = snapshot.value.activeThreadId;
  if (!desktopReady.value || !threadId || threadBusy.value) return;
  try {
    const requestId = crypto.randomUUID();
    if (type === "turn.interrupt") {
      const target = stopTarget.value;
      stopTarget.value = null;
      if (!target || stopping.value) return;
      if (target.threadId !== threadId || target.turnId !== snapshot.value.activeTurnId) throw new Error("确认期间任务已变化，请重新确认停止目标。");
      sendCommand({ type, requestId, ...target });
    } else if (type === "thread.configure") {
      if (taskActive.value || !modelDraft.value || !effortOptions.value.includes(effortDraft.value)) return;
      sendCommand({ type, requestId, threadId, model: modelDraft.value, effort: effortDraft.value });
    } else if (!taskActive.value) sendCommand({ type, requestId, threadId });
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
};
const openSessionMenu = async (): Promise<void> => {
  sessionMenuOpen.value = true;
  await nextTick();
  drawerCloseButton.value?.focus();
};
const closeSessionMenu = async (): Promise<void> => {
  sessionMenuOpen.value = false;
  await nextTick();
  sessionButton.value?.focus();
};
const toggleSessionMenu = (): void => { if (sessionMenuOpen.value) void closeSessionMenu(); else void openSessionMenu(); };
const handleKeydown = (event: KeyboardEvent): void => { if (event.key === "Escape" && sessionMenuOpen.value) void closeSessionMenu(); };
const handleThemeChange = (event: MediaQueryListEvent): void => { prefersDark.value = event.matches; };
const disableRemoteAccess = (): void => {
  if (disablingRemote.value) return;
  try { sendCommand({ type: "remote.disable", requestId: crypto.randomUUID() }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); }
};
const resolveApproval = (item: Extract<MobileItem, { kind: "approval" }>, decision: "accept" | "decline", selection?: string | number | boolean): void => {
  if (!desktopReady.value || !snapshot.value.activeThreadId || resolvingApprovals.has(item.id)) return;
  const requestId = crypto.randomUUID();
  resolvingApprovals.add(item.id);
  approvalResolutions.set(requestId, { item, threadId: snapshot.value.activeThreadId });
  snapshot.value.items = snapshot.value.items.filter((candidate) => candidate.id !== item.id);
  try { sendCommand({ type: "approval.resolve", requestId, threadId: snapshot.value.activeThreadId, approvalId: item.id, version: item.version, decision, ...(selection === undefined ? {} : { selection }) }); }
  catch (reason) {
    resolvingApprovals.delete(item.id);
    approvalResolutions.delete(requestId);
    snapshot.value.items.push(item);
    error.value = reason instanceof Error ? reason.message : String(reason);
  }
};
onMounted(() => { window.addEventListener("keydown", handleKeydown); darkMedia.addEventListener("change", handleThemeChange); connect(); });
onBeforeUnmount(() => { window.removeEventListener("keydown", handleKeydown); darkMedia.removeEventListener("change", handleThemeChange); client?.stop(); });
</script>

<template>
  <NConfigProvider :theme="activeTheme" :theme-overrides="themeOverrides">
  <main class="app-shell" :class="`theme-${resolvedTheme}`" :style="appearanceStyle">
    <header><div class="header-title"><h1>{{ snapshot.activeThreadTitle }}</h1><p><span class="status-dot" :class="statusClass" />{{ statusLabel }}</p></div><div class="session-menu"><button ref="sessionButton" class="session-button" aria-label="打开会话列表" :aria-expanded="sessionMenuOpen" @click="toggleSessionMenu">会话</button><button v-if="sessionMenuOpen" class="drawer-backdrop" tabindex="-1" aria-hidden="true" @click="closeSessionMenu" /><aside v-if="sessionMenuOpen" aria-label="最近会话"><div class="drawer-header"><strong>最近会话</strong><button ref="drawerCloseButton" aria-label="关闭会话列表" @click="closeSessionMenu">×</button></div><div class="drawer-body"><div v-if="!snapshot.threads.length" class="drawer-empty">暂无会话</div><button v-for="thread in snapshot.threads" :key="thread.id" class="thread-row" :class="{ active: thread.id === snapshot.activeThreadId }" :disabled="threadBusy" @click="openThread(thread.id)"><strong>{{ thread.title }}</strong><span>{{ thread.preview }}</span></button></div><div class="drawer-actions"><NButton type="primary" block :disabled="!desktopReady || threadBusy" :loading="threadBusy" @click="newThread(); sessionMenuOpen = false">新建会话</NButton><NPopconfirm positive-text="关闭" negative-text="取消" :disabled="disablingRemote" @positive-click="disableRemoteAccess"><template #trigger><NButton type="error" secondary block :loading="disablingRemote">关闭远程访问</NButton></template>关闭后，所有手机都会立即断开。可在桌面端重新启用。</NPopconfirm></div></aside></div></header>
    <NAlert v-if="error" class="connection-alert" closable type="warning" @close="error = ''">{{ error }}</NAlert>
    <section ref="scrollContainer" class="conversation" @scroll="handleScroll">
      <nav class="console-tabs" aria-label="工作区"><button :aria-pressed="!consoleOpen" @click="consoleOpen = false">当前会话</button><button :aria-pressed="consoleOpen" @click="consoleOpen = true">任务控制台 <span>{{ snapshot.threads.filter(t => t.status === 'running' || t.status === 'waiting').length }}</span></button></nav>
      <section v-if="consoleOpen" class="task-console" aria-label="任务控制台">
        <div class="console-heading"><div><h2>任务</h2><p>查看状态，进入会话后控制任务。</p></div><NButton :disabled="!desktopReady || threadBusy" @click="newThread(); consoleOpen = false">新建</NButton></div>
        <label class="task-filter">筛选状态<select v-model="taskFilter" aria-label="筛选任务状态"><option value="all">全部任务</option><option value="running">运行中</option><option value="waiting">待审批</option><option value="failed">失败</option><option value="idle">空闲</option></select></label>
        <p v-if="!visibleTasks.length" class="muted">暂无符合条件的任务</p>
        <button v-for="thread in visibleTasks" :key="thread.id" class="task-card" :disabled="!desktopReady || threadBusy" @click="openThread(thread.id)"><div><span class="task-badge" :class="thread.status">{{ statusText(thread.status) }}</span><small v-if="thread.unread">有新消息</small></div><strong>{{ thread.title }}</strong><p>{{ thread.preview || '暂无消息' }}</p><small>{{ new Date(thread.updatedAt * 1000).toLocaleString('zh-CN') }}</small></button>
      </section>
      <template v-else>
      <details v-if="snapshot.activeThreadId" class="task-controls">
        <summary><span class="task-badge" :class="snapshot.turnStatus">{{ statusText(snapshot.turnStatus) }}</span><span>任务控制 · 模型与强度</span></summary>
        <div class="control-body"><p class="muted">当前：{{ snapshot.selectedModel || '服务器默认' }} · {{ snapshot.selectedEffort ? effortText(snapshot.selectedEffort) : '默认强度' }}</p>
          <div class="model-fields"><label>模型<select v-model="modelDraft" aria-label="模型" :disabled="!desktopReady || taskActive || threadBusy" @change="changeModel"><option value="" disabled>选择模型</option><option v-for="model in snapshot.models" :key="model.id" :value="model.id">{{ model.displayName }}</option></select></label><label>推理强度<select v-model="effortDraft" aria-label="推理强度" :disabled="!desktopReady || taskActive || threadBusy"><option value="" disabled>选择强度</option><option v-for="effort in effortOptions" :key="effort" :value="effort">{{ effortText(effort) }}</option></select></label></div>
          <p class="muted control-hint">应用后用于此会话的下一轮；运行期间不能更改。</p>
          <div class="task-actions"><NButton :disabled="!desktopReady || taskActive || threadBusy || !modelDraft || !effortDraft" @click="controlTask('thread.configure')">应用设置</NButton><NButton :disabled="!desktopReady || taskActive || threadBusy" @click="controlTask('thread.fork')">分叉会话</NButton><NPopconfirm positive-text="停止任务" negative-text="取消" @update:show="captureStopTarget" @positive-click="controlTask('turn.interrupt')"><template #trigger><NButton type="error" secondary :disabled="!desktopReady || !snapshot.activeTurnId || stopping" :loading="stopping">停止任务</NButton></template>停止当前正在执行的任务。已完成的操作和历史消息仍会保留。</NPopconfirm></div>
        </div>
      </details>
      <div v-if="!snapshot.activeThreadId" class="empty-state"><h2>选择一个会话</h2><p>可以继续最近的会话，也可以新建会话。</p></div>
      <article v-for="item in snapshot.items" :key="item.id" class="message" :class="item.kind">
        <div v-if="item.kind === 'user'" class="bubble">{{ item.text }}</div>
        <div v-else-if="item.kind === 'agent'" class="markdown" v-html="markdown(item.id, item.markdown)" />
        <details v-else-if="item.kind === 'activity'" class="activity-card"><summary><span>{{ item.title }}</span><small>{{ item.status === 'running' ? '进行中' : item.status === 'failed' ? '失败' : '完成' }}</small></summary><p>{{ item.summary }}</p><pre v-if="item.detail">{{ item.detail }}</pre></details>
        <section v-else class="approval-card"><strong>{{ item.title }}</strong><p>{{ item.summary }}</p><div class="approval-actions"><NButton :disabled="resolvingApprovals.has(item.id)" @click="resolveApproval(item, 'decline')">拒绝</NButton><template v-if="item.choices"><NButton v-for="choice in item.choices" :key="`${typeof choice.value}:${String(choice.value)}`" type="primary" :loading="resolvingApprovals.has(item.id)" @click="resolveApproval(item, 'accept', choice.value)">{{ choice.label }}</NButton></template><NButton v-else type="primary" :loading="resolvingApprovals.has(item.id)" @click="resolveApproval(item, 'accept')">仅本次同意</NButton></div></section>
      </article>
      <NSpin v-if="snapshot.turnStatus === 'running'" size="small"><span class="running-label">Codex 正在处理…</span></NSpin>
      </template>
      <div class="bottom-spacer" />
    </section>
    <button v-if="!followTail" class="latest-button" @click="scrollLatest">回到最新<span v-if="unread"> · {{ unread }}</span></button>
    <footer><div class="composer"><NInput v-model:value="draft" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }" maxlength="20000" placeholder="输入消息…" @keydown="(event: KeyboardEvent) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } }" /><NButton type="primary" :disabled="!canSend" :loading="sending" @click="send">{{ snapshot.turnStatus === 'running' ? '追加' : '发送' }}</NButton></div></footer>
  </main>
  </NConfigProvider>
</template>
