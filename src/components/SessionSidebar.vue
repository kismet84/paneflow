<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { NAlert, NButton, NModal } from "naive-ui";
import type { PaneState } from "../types";
import { useWorkspaceStore } from "../stores/workspace";
import SessionListPanel from "./SessionListPanel.vue";

const props = defineProps<{ pane: PaneState }>();
const emit = defineEmits<{ activatePane: [paneId: string]; focusConversation: [] }>();
const store = useWorkspaceStore();
const panel = ref<InstanceType<typeof SessionListPanel> | null>(null);
const showAll = ref(false);
const search = ref("");
const loading = ref(false);
const switchError = ref<string | null>(null);
const loadError = ref<string | null>(null);
let loadSequence = 0;
const currentCwd = computed(() => props.pane.cwd || store.state.defaultCwd || "");
const unreadThreadIds = computed(() => [...new Set([
  ...store.state.sidebarUnreadThreadIds,
  ...store.state.panes.filter((pane) => pane.threadId && pane.unread).map((pane) => pane.threadId!)
])]);
const workingThreadIds = computed(() => store.state.panes
  .filter((pane) => pane.threadId && (pane.status === "starting" || pane.status === "running"))
  .map((pane) => pane.threadId!));

const load = async (): Promise<void> => {
  if (store.state.connection.phase !== "ready") return;
  const sequence = ++loadSequence;
  loading.value = true;
  loadError.value = null;
  try {
    await store.loadThreads(search.value, showAll.value ? null : currentCwd.value);
  } catch (error) {
    if (sequence === loadSequence) loadError.value = `无法读取会话：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
};
const searchSessions = (value: string): void => {
  search.value = value;
  void load();
};
const changeScope = (value: boolean, searchValue: string): void => {
  showAll.value = value;
  search.value = searchValue;
  void load();
};
const resumeSession = async (threadId: string): Promise<void> => {
  if (store.state.pendingRequests.some((request) => request.paneId === null)) {
    switchError.value = "当前确认请求尚未处理，请完成后再切换会话。";
    return;
  }
  try {
    const pane = await store.switchSidebarThread(props.pane, threadId);
    emit("activatePane", pane.id);
    await load();
  } catch (error) {
    switchError.value = error instanceof Error ? error.message : String(error);
  }
};
const newSession = async (): Promise<void> => {
  if (store.state.pendingRequests.some((request) => request.paneId === null)) {
    props.pane.error = "当前确认请求尚未处理，请完成后再新建会话。";
    return;
  }
  const pane = await store.newSidebarThread(props.pane);
  emit("activatePane", pane.id);
};
const focusSearch = (): void => { void panel.value?.focusSearch(); };

watch([() => store.state.workspaceMode, () => store.state.connection.phase, currentCwd], ([mode, phase]) => {
  if (mode === "sessionSidebar" && phase === "ready") void load();
}, { immediate: true });
watch([() => props.pane.threadId, () => props.pane.status], ([threadId, status], [previousThreadId, previousStatus]) => {
  if (store.state.workspaceMode !== "sessionSidebar" || store.state.connection.phase !== "ready") return;
  if (threadId !== previousThreadId || status === "idle" && previousStatus !== "idle") void load();
});
defineExpose({ focusSearch, refresh: load });
</script>

<template>
  <aside class="session-sidebar" aria-label="会话列表">
    <SessionListPanel
      ref="panel"
      :threads="store.state.threads"
      :active-thread-id="pane.threadId"
      :show-all="showAll"
      :current-cwd="currentCwd"
      :loading="loading"
      :unread-thread-ids="unreadThreadIds"
      :working-thread-ids="workingThreadIds"
      show-new
      @search="searchSessions"
      @scope="changeScope"
      @resume="resumeSession"
      @new-session="newSession"
      @exit="emit('focusConversation')"
    />
    <NAlert v-if="loadError" type="error" class="session-sidebar-error"><div class="session-sidebar-error-content"><span>{{ loadError }}</span><NButton size="tiny" type="error" secondary @click="load">重试</NButton></div></NAlert>
    <NModal
      :show="switchError !== null"
      preset="dialog"
      type="error"
      title="无法切换会话"
      :content="switchError ?? ''"
      positive-text="知道了"
      @positive-click="switchError = null"
      @update:show="value => { if (!value) switchError = null; }"
    />
  </aside>
</template>
