<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watchEffect } from "vue";
import { darkTheme, dateZhCN, NAlert, NButton, NButtonGroup, NCheckbox, NConfigProvider, NDialogProvider, NDropdown, NIcon, NLayout, NLayoutHeader, NMessageProvider, NModal, NSpace, NSpin, NText, NTooltip, zhCN } from "naive-ui";
import { ChevronBackOutline, ChevronForwardOutline, CloseOutline, GridOutline, ListOutline, ReloadOutline, ScanOutline, SettingsOutline } from "@vicons/ionicons5";
import hljs from "highlight.js/lib/core";
import powershell from "highlight.js/lib/languages/powershell";
import { useWorkspaceStore } from "./stores/workspace";
import type { LayoutKind, PaneState, WorkspaceMode } from "./types";
import { appearanceCssVars, appearanceThemeOverrides, resolvedTheme } from "./theme";
import WorkspaceView from "./components/WorkspaceView.vue";
import SessionDrawer from "./components/SessionDrawer.vue";
import SettingsModal from "./components/SettingsModal.vue";
import { summarizeNotice } from "./notice-summary";

const store = useWorkspaceStore();
const latestNotice = computed(() => store.state.notices.at(-1) ?? "");
const latestNoticeSummary = computed(() => summarizeNotice(latestNotice.value));
hljs.registerLanguage("powershell", powershell);
const appIconUrl = new URL("../assets/icon.svg", import.meta.url).href;
const fullScreen = ref(false);
const maximized = ref(false);
const sessionSidebarCollapsed = ref(false);
const sessionsOpen = ref(false);
const sessionsShowAll = ref(false);
const sessionsLoading = ref(false);
const sessionsError = ref("");
let sessionLoadSequence = 0;
const settingsOpen = ref(false);
const sessionPaneId = ref<string | null>(null);
const sessionPane = computed(() => store.state.panes.find((pane) => pane.id === sessionPaneId.value) ?? null);
const sessionFilterCwd = computed(() => sessionPane.value?.cwd || store.state.defaultCwd || "");
const workspaceView = ref<InstanceType<typeof WorkspaceView> | null>(null);
const systemPrefersDark = ref(window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
const resolvedAppearanceTheme = computed(() => resolvedTheme(store.state.appearance, systemPrefersDark.value));

const layoutLabels: Record<LayoutKind, string> = {
  single: "单窗格",
  vertical: "左右双栏",
  horizontal: "上下双栏",
  quad: "四宫格",
  fourColumns: "横向四栏",
  fourRows: "纵向四栏",
  six: "六宫格"
};
const layoutOptions = Object.entries(layoutLabels).map(([key, label]) => ({ key, label }));
const activeTheme = computed(() => resolvedAppearanceTheme.value === "dark" ? darkTheme : null);
const themeOverrides = computed(() => appearanceThemeOverrides(store.state.appearance, systemPrefersDark.value));
const appearanceStyle = computed(() => appearanceCssVars(store.state.appearance, systemPrefersDark.value));
const connectionStatus = computed(() => {
  const phase = store.state.connection.phase;
  if (phase === "ready") return { label: "已连接", tone: "ready" };
  if (phase === "starting" || phase === "restarting") return { label: "连接中", tone: "working" };
  if (phase === "error") return { label: "连接异常", tone: "error" };
  return { label: "未连接", tone: "idle" };
});

const layoutPaneCounts: Record<LayoutKind, number> = { single: 1, vertical: 2, horizontal: 2, quad: 4, fourColumns: 4, fourRows: 4, six: 6 };
const pendingLayout = ref<LayoutKind | null>(null);
const selectedPaneIds = ref<string[]>([]);
const layoutSelectionError = ref("");
const visiblePanesForSelection = computed(() => store.state.panes.slice(0, layoutPaneCounts[store.state.layout]));
const protectedPaneIds = computed(() => new Set(visiblePanesForSelection.value.filter((pane) => pane.activeTurnId || pane.status === "running" || pane.status === "starting" || pane.status === "interrupting" || store.state.pendingRequests.some((request) => request.paneId === pane.id)).map((pane) => pane.id)));
const targetPaneCount = computed(() => pendingLayout.value ? layoutPaneCounts[pendingLayout.value] : 0);

const isEmptyPane = (pane: PaneState): boolean => !pane.threadId && !pane.activeTurnId && pane.items.length === 0 && !pane.draft.trim() && pane.attachments.length === 0 && pane.references.length === 0;
const applyLayout = (layout: LayoutKind, keepIds?: string[]): void => {
  const currentCount = layoutPaneCounts[store.state.layout];
  const targetCount = layoutPaneCounts[layout];
  if (targetCount < currentCount) {
    const visible = store.state.panes.slice(0, currentCount);
    const keepSet = new Set(keepIds ?? visible.slice(0, targetCount).map((pane) => pane.id));
    const kept = visible.filter((pane) => keepSet.has(pane.id));
    const removed = visible.filter((pane) => !keepSet.has(pane.id));
    removed.forEach(store.resetPane);
    store.state.panes = [...kept, ...removed, ...store.state.panes.slice(currentCount)];
    if (!store.state.focusedPaneId || !keepSet.has(store.state.focusedPaneId)) store.state.focusedPaneId = kept[0]?.id ?? null;
  }
  store.setLayout(layout);
  store.scheduleSave();
};
const selectLayout = (key: string | number): void => {
  if (!(key in layoutLabels)) return;
  const layout = key as LayoutKind;
  const currentCount = layoutPaneCounts[store.state.layout];
  const nextCount = layoutPaneCounts[layout];
  if (nextCount >= currentCount) {
    applyLayout(layout);
    return;
  }
  const visible = store.state.panes.slice(0, currentCount);
  const nonEmpty = visible.filter((pane) => !isEmptyPane(pane));
  if (nonEmpty.length <= nextCount) {
    const keep = [...nonEmpty, ...visible.filter(isEmptyPane).slice(0, nextCount - nonEmpty.length)];
    applyLayout(layout, keep.map((pane) => pane.id));
    return;
  }
  pendingLayout.value = layout;
  const required = visible.filter((pane) => protectedPaneIds.value.has(pane.id));
  selectedPaneIds.value = [...required, ...nonEmpty.filter((pane) => !protectedPaneIds.value.has(pane.id))].slice(0, nextCount).map((pane) => pane.id);
  layoutSelectionError.value = required.length > nextCount ? "运行中或等待确认的窗格数量超过目标布局，请先完成这些任务。" : "";
};
const toggleSelectedPane = (paneId: string, checked: boolean): void => {
  if (protectedPaneIds.value.has(paneId)) return;
  if (checked) {
    if (selectedPaneIds.value.length < targetPaneCount.value) selectedPaneIds.value = [...selectedPaneIds.value, paneId];
  } else {
    selectedPaneIds.value = selectedPaneIds.value.filter((id) => id !== paneId);
  }
};
const confirmLayoutReduction = (): void => {
  if (!pendingLayout.value || selectedPaneIds.value.length !== targetPaneCount.value || layoutSelectionError.value) return;
  applyLayout(pendingLayout.value, selectedPaneIds.value);
  pendingLayout.value = null;
};

const selectWorkspaceMode = (workspaceMode: WorkspaceMode): void => {
  if (workspaceMode === store.state.workspaceMode) return;
  if (workspaceMode === "panes") {
    const focusedIndex = store.state.panes.findIndex((pane) => pane.id === store.state.focusedPaneId);
    const visibleCount = layoutPaneCounts[store.state.layout];
    if (focusedIndex >= visibleCount) {
      const targetIndex = Math.max(0, visibleCount - 1);
      [store.state.panes[targetIndex], store.state.panes[focusedIndex]] = [store.state.panes[focusedIndex]!, store.state.panes[targetIndex]!];
    }
    store.setWorkspaceMode(workspaceMode);
    void nextTick(() => workspaceView.value?.focusPaneById?.(store.state.focusedPaneId));
    return;
  }
  const visiblePanes = store.state.panes.slice(0, layoutPaneCounts[store.state.layout]);
  const activePane = visiblePanes.find((pane) => pane.id === store.state.focusedPaneId) ?? visiblePanes[0]!;
  store.state.focusedPaneId = activePane.id;
  store.setWorkspaceMode(workspaceMode);
};

const toggleFullScreen = async (): Promise<void> => {
  await window.codexPane.setFullScreen(!fullScreen.value);
};
const exitFullScreen = async (): Promise<void> => window.codexPane.setFullScreen(false);

const controlWindow = async (action: "minimize" | "maximize" | "close"): Promise<void> => {
  await window.codexPane.windowControl(action);
};

const requestReconnect = async (): Promise<void> => {
  try {
    await store.reconnect();
  } catch {
    // The store turns the failure into a persistent connection error and notice.
  }
};

const openSessions = async (paneId: string): Promise<void> => {
  sessionPaneId.value = paneId;
  if (store.state.workspaceMode === "sessionSidebar") {
    await nextTick();
    workspaceView.value?.focusSessionList();
    return;
  }
  sessionsOpen.value = true;
  sessionsShowAll.value = !sessionFilterCwd.value;
  await loadSessionDrawer("", sessionsShowAll.value);
};

const loadSessionDrawer = async (search: string, showAll: boolean): Promise<void> => {
  const sequence = ++sessionLoadSequence;
  sessionsLoading.value = true;
  sessionsError.value = "";
  try {
    await store.loadThreads(search, showAll ? null : sessionFilterCwd.value);
  } catch (error) {
    if (sequence === sessionLoadSequence) sessionsError.value = `无法读取历史会话：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (sequence === sessionLoadSequence) sessionsLoading.value = false;
  }
};

const searchSessions = async (value: string): Promise<void> => {
  await loadSessionDrawer(value, sessionsShowAll.value);
};

const changeSessionScope = async (showAll: boolean, search: string): Promise<void> => {
  sessionsShowAll.value = showAll;
  await loadSessionDrawer(search, showAll);
};

const resumeSession = async (threadId: string): Promise<void> => {
  if (!sessionPane.value) return;
  try {
    await store.resumeThread(sessionPane.value, threadId);
    await closeSessions();
  } catch {
    // The pane shows a user-facing recovery error and the drawer stays open.
  }
};
const closeSessions = async (): Promise<void> => {
  sessionLoadSequence += 1;
  sessionsLoading.value = false;
  sessionsOpen.value = false;
  await nextTick();
  await workspaceView.value?.focusPaneById(sessionPaneId.value);
};

let removeFullscreenListener: (() => void) | null = null;
let removeMaximizedListener: (() => void) | null = null;
let removeCloseRequestedListener: (() => void) | null = null;
let colorSchemeQuery: MediaQueryList | null = null;
const handleColorSchemeChange = (event: MediaQueryListEvent): void => { systemPrefersDark.value = event.matches; };
const handleGlobalKeydown = (event: KeyboardEvent): void => {
  if (event.key === "F11" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    void toggleFullScreen();
    return;
  }
  if (event.key === "Escape" && fullScreen.value && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    void window.codexPane.setFullScreen(false);
    return;
  }
  if (event.key.toLowerCase() !== "m" || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  selectWorkspaceMode(store.state.workspaceMode === "panes" ? "sessionSidebar" : "panes");
};
onMounted(() => {
  colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  systemPrefersDark.value = colorSchemeQuery?.matches ?? true;
  colorSchemeQuery?.addEventListener?.("change", handleColorSchemeChange);
  removeFullscreenListener = window.codexPane.onFullScreenChange((value) => { fullScreen.value = value; });
  removeMaximizedListener = window.codexPane.onMaximizedChange((value) => { maximized.value = value; });
  removeCloseRequestedListener = window.codexPane.onCloseRequested?.(() => {
    void store.flushSave().then(
      () => window.codexPane.respondToCloseRequest(true),
      () => window.codexPane.respondToCloseRequest(false)
    );
  }) ?? null;
  void window.codexPane.isMaximized().then((value) => { maximized.value = value; });
  window.addEventListener("keydown", handleGlobalKeydown);
  void store.initialize().catch((error) => {
    store.state.initialized = true;
    store.state.connection = {
      phase: "error",
      generation: store.state.connection.generation,
      codexVersion: store.state.connection.codexVersion,
      compatible: store.state.connection.compatible,
      message: `工作台初始化失败：${error instanceof Error ? error.message : String(error)}`
    };
  });
});
watchEffect(() => {
  const variables = appearanceStyle.value as Record<string, string | number>;
  for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(name, String(value));
  document.documentElement.style.colorScheme = resolvedAppearanceTheme.value;
  document.body.style.backgroundColor = String(variables["--app-bg"]);
});
onUnmounted(() => {
  removeFullscreenListener?.();
  removeMaximizedListener?.();
  removeCloseRequestedListener?.();
  colorSchemeQuery?.removeEventListener?.("change", handleColorSchemeChange);
  window.removeEventListener("keydown", handleGlobalKeydown);
});
</script>

<template>
  <NConfigProvider :theme="activeTheme" :theme-overrides="themeOverrides" :hljs="hljs" :locale="zhCN" :date-locale="dateZhCN">
    <NDialogProvider>
      <NMessageProvider>
        <div class="app-root" :class="{ 'app-root-fullscreen': fullScreen }" :style="appearanceStyle">
          <NLayout class="app-shell">
            <NLayoutHeader v-if="!fullScreen" class="topbar custom-titlebar" bordered>
              <div class="titlebar-identity"><img :src="appIconUrl" alt="" /><span>PaneFlow Desktop</span></div>
              <div class="titlebar-drag-region" aria-hidden="true" />
              <div class="titlebar-actions">
                <NButtonGroup class="workspace-mode-switch" size="tiny" aria-label="工作台模式">
                  <NTooltip><template #trigger><NButton :type="store.state.workspaceMode === 'panes' ? 'primary' : 'default'" :secondary="store.state.workspaceMode === 'panes'" aria-label="切换到多窗格模式" @click="selectWorkspaceMode('panes')"><template #icon><NIcon :component="GridOutline" /></template><span class="workspace-mode-label">多窗格</span></NButton></template>并行查看多个任务 · Ctrl+Shift+M</NTooltip>
                  <NTooltip><template #trigger><NButton :type="store.state.workspaceMode === 'sessionSidebar' ? 'primary' : 'default'" :secondary="store.state.workspaceMode === 'sessionSidebar'" aria-label="切换到会话侧栏模式" @click="selectWorkspaceMode('sessionSidebar')"><template #icon><NIcon :component="ListOutline" /></template><span class="workspace-mode-label">会话</span></NButton></template>集中浏览历史会话 · Ctrl+Shift+M</NTooltip>
                </NButtonGroup>
                <NTooltip v-if="store.state.workspaceMode === 'sessionSidebar'">
                  <template #trigger><NButton quaternary circle size="small" aria-keyshortcuts="Control+Shift+B" :aria-label="sessionSidebarCollapsed ? '展开会话列表' : '收起会话列表'" @click="sessionSidebarCollapsed = !sessionSidebarCollapsed"><template #icon><NIcon :component="sessionSidebarCollapsed ? ChevronForwardOutline : ChevronBackOutline" /></template></NButton></template>
                  {{ sessionSidebarCollapsed ? "展开会话列表" : "收起会话列表" }} · Ctrl+Shift+B
                </NTooltip>
                <NTooltip><template #trigger><NButton quaternary circle size="small" aria-label="设置" @click="settingsOpen = true"><template #icon><NIcon :component="SettingsOutline" /></template></NButton></template>设置</NTooltip>
                <NDropdown v-if="store.state.workspaceMode === 'panes'" trigger="click" :options="layoutOptions" @select="selectLayout">
                  <NButton quaternary circle size="small" :aria-label="`切换窗格布局，当前${layoutLabels[store.state.layout]}`"><template #icon><NIcon :component="GridOutline" /></template></NButton>
                </NDropdown>
                <NTooltip><template #trigger><NButton quaternary circle size="small" aria-label="重新连接 app-server" :loading="store.state.connection.phase === 'starting' || store.state.connection.phase === 'restarting'" :disabled="store.state.connection.phase === 'starting' || store.state.connection.phase === 'restarting'" @click="requestReconnect"><template #icon><NIcon :component="ReloadOutline" /></template></NButton></template>重新连接 app-server</NTooltip>
                <NTooltip><template #trigger><NButton quaternary circle size="small" :aria-label="fullScreen ? '退出全屏' : '全屏'" @click="toggleFullScreen"><template #icon><NIcon :component="ScanOutline" /></template></NButton></template>{{ fullScreen ? "退出全屏" : "全屏" }} · F11</NTooltip>
                <NTooltip><template #trigger><span class="titlebar-status" :class="`titlebar-status-${connectionStatus.tone}`" role="status"><i />{{ connectionStatus.label }}</span></template>{{ store.state.connection.message }}<template v-if="store.state.connection.codexVersion"> · Codex {{ store.state.connection.codexVersion }}</template></NTooltip>
              </div>
              <div class="window-controls">
                <NButton quaternary class="window-control" aria-label="最小化" @click="controlWindow('minimize')"><span class="window-glyph window-glyph-minimize" /></NButton>
                <NButton quaternary class="window-control" aria-label="最大化或还原窗口" @click="controlWindow('maximize')"><span class="window-glyph" :class="maximized ? 'window-glyph-restore' : 'window-glyph-maximize'" /></NButton>
                <NButton quaternary class="window-control window-control-close" aria-label="关闭" @click="controlWindow('close')"><NIcon :component="CloseOutline" :size="18" class="window-close-icon" /></NButton>
              </div>
            </NLayoutHeader>

            <NAlert v-if="store.state.connection.phase === 'error'" type="error" class="connection-alert" :title="store.state.connection.message">
              <div class="connection-alert-content"><span>确认已安装 Codex CLI，并在 PowerShell 中运行 <code>codex --version</code>；仍失败时可复制脱敏诊断。</span><NSpace :wrap="false"><NButton size="small" secondary @click="settingsOpen = true">打开诊断</NButton><NButton size="small" type="error" secondary @click="requestReconnect">重新连接</NButton></NSpace></div>
            </NAlert>
            <NAlert v-else-if="store.state.notices.length" type="warning" class="connection-alert" closable @close="store.dismissNotice"><div class="connection-alert-content"><span>{{ latestNoticeSummary }}<small v-if="store.state.notices.length > 1"> · 另有 {{ store.state.notices.length - 1 }} 条通知</small></span><NButton v-if="store.state.notices.length > 1" size="tiny" secondary @click="store.dismissAllNotices">全部清除</NButton></div><details v-if="latestNotice !== latestNoticeSummary" class="notice-details"><summary>错误详情</summary><pre>{{ latestNotice }}</pre></details></NAlert>

            <NSpin :show="!store.state.initialized" description="正在恢复工作台…" class="workspace-spin">
              <WorkspaceView ref="workspaceView" v-model:sidebar-collapsed="sessionSidebarCollapsed" @open-sessions="openSessions" />
            </NSpin>
          </NLayout>

          <NTooltip v-if="fullScreen" placement="left"><template #trigger><NButton class="fullscreen-exit" circle secondary aria-label="退出全屏" @click="exitFullScreen"><template #icon><NIcon :component="ScanOutline" /></template></NButton></template>退出全屏 · Esc 或 F11</NTooltip>

          <SessionDrawer :show="sessionsOpen" :pane="sessionPane" :threads="store.state.threads" :show-all="sessionsShowAll" :current-cwd="sessionFilterCwd" :loading="sessionsLoading" :error="sessionsError" @update:show="value => value ? sessionsOpen = true : closeSessions()" @search="searchSessions" @scope="changeSessionScope" @resume="resumeSession" />
          <SettingsModal :command-shell-path="store.state.appearance.commandShellPath" :show="settingsOpen" @update:command-shell-path="store.updateAppearance({ commandShellPath: $event })" @update:workspace-mode="selectWorkspaceMode" @update:show="settingsOpen = $event" />
          <NModal :show="pendingLayout !== null" preset="card" title="选择要保留的窗格" class="layout-reduction-modal" :mask-closable="false" @update:show="value => { if (!value) pendingLayout = null; }">
            <NSpace vertical :size="14">
              <NText>目标布局可显示 {{ targetPaneCount }} 个窗格。请选择要保留的窗格；未保留的会话仍可从历史记录恢复。</NText>
              <NAlert v-if="layoutSelectionError" type="warning">{{ layoutSelectionError }}</NAlert>
              <div class="layout-pane-options">
                <label v-for="pane in visiblePanesForSelection" :key="pane.id" class="layout-pane-option">
                  <NCheckbox :checked="selectedPaneIds.includes(pane.id)" :disabled="protectedPaneIds.has(pane.id)" @update:checked="toggleSelectedPane(pane.id, $event)" />
                  <span class="layout-pane-copy"><strong>{{ pane.title || "新会话" }}</strong><small>{{ pane.cwd || "未设置工作目录" }}</small></span>
                  <NText v-if="protectedPaneIds.has(pane.id)" type="warning" depth="3">进行中，必须保留</NText>
                </label>
              </div>
              <NText depth="3">已选择 {{ selectedPaneIds.length }} / {{ targetPaneCount }}</NText>
              <NSpace justify="end"><NButton @click="pendingLayout = null">取消</NButton><NButton type="primary" :disabled="selectedPaneIds.length !== targetPaneCount || !!layoutSelectionError" @click="confirmLayoutReduction">应用布局</NButton></NSpace>
            </NSpace>
          </NModal>
        </div>
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>

<style>
.app-root { width: 100%; height: 100%; color: var(--app-text); background: var(--app-bg); font-family: var(--app-font-family); font-size: var(--app-font-size); }
.app-root, .app-root :where(button, input, textarea, select, code, pre) { font-family: var(--app-font-family); }
.fullscreen-exit { position: fixed; z-index: 100; top: 10px; right: 10px; border-color: var(--app-control-border) !important; background: color-mix(in srgb, var(--app-surface) 86%, transparent) !important; box-shadow: 0 5px 18px rgb(0 0 0 / 28%); opacity: .58; backdrop-filter: blur(10px); transition: opacity .15s ease; }
.fullscreen-exit:hover, .fullscreen-exit:focus-visible { opacity: 1; }
.app-shell > .n-layout-scroll-container { height: 100%; overflow: hidden; }
.app-root .app-shell, .app-root .workspace, .app-root .codex-split > .splitpanes__pane, .app-root .pane { background: var(--app-bg); }
.app-root .topbar, .app-root .pane-header, .app-root .composer { color: var(--app-text); background: var(--app-surface); border-color: var(--app-border); }
.app-root .status-line { color: var(--app-muted); background: var(--app-surface); border-color: var(--app-border); }
.app-root .tool-card { color: var(--app-text); background: var(--app-surface); border-color: var(--app-border); }
.app-root .message-user, .app-root .attachment-chip { color: var(--app-text); background: var(--app-raised); border-color: var(--app-border); }
.app-root .message-agent { color: var(--app-text); background: transparent; border-color: transparent; }
.app-root .markdown-content { color: var(--app-text); }
.app-root .markdown-content pre, .app-root .request-json { color: var(--app-text); background: var(--app-raised); border-color: var(--app-border); }
.app-root .markdown-content :not(pre) > code { color: var(--app-accent); background: var(--app-raised); }
.app-root .markdown-content a { color: var(--app-accent); }
.app-root .codex-split > .splitpanes__splitter { background: var(--app-border); }
.app-root .codex-split > .splitpanes__splitter::before { background: var(--app-accent); }
.custom-titlebar { position: relative; display: flex; box-sizing: border-box; align-items: center; justify-content: flex-end; height: 42px; padding: 0; user-select: none; -webkit-app-region: drag; }
.titlebar-identity { display: flex; min-width: 0; align-items: center; gap: 8px; padding-left: 10px; color: var(--app-text); font-size: .86em; font-weight: 600; }
.titlebar-identity img { width: 18px; height: 18px; }
.titlebar-status { display: inline-flex; height: 100%; align-items: center; gap: 5px; padding: 0 6px; color: var(--app-muted); font-size: .86em; font-weight: 500; }
.titlebar-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--app-muted); }
.titlebar-status-ready i { background: #35c98b; box-shadow: 0 0 0 3px color-mix(in srgb, #35c98b 15%, transparent); }
.titlebar-status-working i { background: #e4a853; animation: connection-pulse 1.2s ease-in-out infinite; }
.titlebar-status-error i { background: #e05b64; }
@keyframes connection-pulse { 50% { opacity: .35; } }
.connection-alert-content { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.notice-details { margin-top: 8px; }.notice-details pre { max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.titlebar-drag-region { min-width: 24px; flex: 1 1 auto; align-self: stretch; }
.titlebar-actions, .window-controls { position: relative; z-index: 1; display: flex; align-items: center; height: 100%; -webkit-app-region: no-drag; }
.titlebar-actions { gap: 2px; padding-right: 8px; }
.workspace-mode-switch { margin-right: 5px; -webkit-app-region: no-drag; }
.workspace-mode-switch .n-button { min-width: 72px; }
.window-control { width: 46px; height: 100%; border-radius: 0; }
.window-control .n-button__content { display: grid; width: 100%; height: 100%; place-items: center; }
.window-control-close:hover { color: #fff !important; background: #c42b1c !important; }
.window-glyph { position: relative; display: block; width: 11px; height: 11px; color: currentColor; }
.window-glyph-minimize::before { content: ""; position: absolute; right: 0; bottom: 2px; left: 0; height: 1px; background: currentColor; }
.window-glyph-maximize { border: 1px solid currentColor; }
.window-glyph-restore::before, .window-glyph-restore::after { content: ""; position: absolute; width: 8px; height: 8px; border: 1px solid currentColor; }
.window-glyph-restore::before { top: 0; right: 0; }
.window-glyph-restore::after { bottom: 0; left: 0; background: var(--app-surface); }
.window-close-icon { display: block; }
.app-root .workspace-spin { height: calc(100vh - 42px); }
.layout-reduction-modal { width: min(560px, calc(100vw - 32px)); }
.layout-pane-options { display: grid; gap: 8px; }
.layout-pane-option { display: flex; min-width: 0; align-items: center; gap: 10px; padding: 10px; border: 1px solid var(--app-border); border-radius: 8px; background: var(--app-raised); }
.layout-pane-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
.layout-pane-copy strong, .layout-pane-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.layout-pane-copy small { color: var(--app-muted); }
@media (max-width: 760px) {
  .titlebar-status { display: none; }
  .workspace-mode-switch .n-button { min-width: 34px; padding-inline: 8px; }
  .workspace-mode-label { display: none; }
  .titlebar-actions .n-button__content { font-size: 0; }
  .window-control { width: 40px; }
}
</style>
