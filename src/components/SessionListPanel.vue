<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { NButton, NEmpty, NIcon, NInput, NList, NListItem, NSpin, NTag, NText, NTime } from "naive-ui";
import { AddOutline, SyncOutline } from "@vicons/ionicons5";
import type { ThreadSummary } from "../types";

const props = withDefaults(defineProps<{
  threads: ThreadSummary[];
  activeThreadId: string | null;
  showAll: boolean;
  currentCwd: string;
  loading?: boolean;
  showNew?: boolean;
  showResumeButton?: boolean;
  searchPlaceholder?: string;
  showAllLabel?: string;
  currentOnlyLabel?: string;
  unreadThreadIds?: string[];
  workingThreadIds?: string[];
}>(), {
  loading: false,
  showNew: false,
  showResumeButton: false,
  searchPlaceholder: "搜索会话",
  showAllLabel: "所有目录",
  currentOnlyLabel: "当前目录",
  unreadThreadIds: () => [],
  workingThreadIds: () => []
});
const emit = defineEmits<{
  search: [value: string];
  scope: [showAll: boolean, search: string];
  resume: [threadId: string];
  newSession: [];
  exit: [];
}>();
const search = ref("");
const searchInput = ref<{ focus: () => void } | null>(null);
const noSpellcheckInputProps = { spellcheck: false, autocorrect: "off", autocapitalize: "off" } as const;
let timer: ReturnType<typeof setTimeout> | null = null;
const emptyDescription = computed(() => search.value.trim()
  ? `没有找到与“${search.value.trim()}”匹配的会话`
  : props.showAll ? "还没有历史会话" : "当前工作目录还没有会话");
const unreadThreadSet = computed(() => new Set(props.unreadThreadIds));
const workingThreadSet = computed(() => new Set(props.workingThreadIds));

const focusSearch = async (): Promise<void> => {
  await nextTick();
  searchInput.value?.focus();
};
const handlePanelKeydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("exit");
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest(".session-item-button")) return;
  const buttons = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(".session-item-button:not(:disabled)")];
  if (!buttons.length) return;
  event.preventDefault();
  const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : event.key === "ArrowDown" ? Math.min(buttons.length - 1, current + 1) : Math.max(0, current - 1);
  buttons[next]?.focus();
  buttons[next]?.scrollIntoView?.({ block: "nearest" });
};

watch(search, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => emit("search", value), 250);
});
onUnmounted(() => { if (timer) clearTimeout(timer); });
defineExpose({ focusSearch });
</script>

<template>
  <div class="session-list-panel" @keydown="handlePanelKeydown">
    <NButton v-if="showNew" type="primary" secondary class="session-new-button" @click="emit('newSession')">
      <template #icon><NIcon :component="AddOutline" /></template>
      新建会话
    </NButton>
    <div class="session-search-sticky">
      <div class="session-search-row">
        <NInput ref="searchInput" v-model:value="search" clearable :input-props="noSpellcheckInputProps" :placeholder="searchPlaceholder" aria-label="搜索历史会话" />
        <NButton secondary class="session-scope-button" :disabled="showAll && !currentCwd" @click="emit('scope', !showAll, search)">{{ showAll ? currentOnlyLabel : showAllLabel }}</NButton>
      </div>
      <NText depth="3" class="session-scope-label">{{ showAll ? "正在显示所有工作目录" : `仅显示：${currentCwd || "未设置工作目录"}` }}</NText>
    </div>
    <NSpin :show="loading" class="session-list-spin">
      <div class="session-list-scroll" :aria-busy="loading">
        <NEmpty v-if="threads.length === 0" :description="emptyDescription" />
        <NList v-else hoverable clickable class="session-list">
          <NListItem
            v-for="thread in threads"
            :key="thread.id"
            class="session-item"
            :class="{ 'session-item-active': thread.id === activeThreadId }"
          >
            <button
              type="button"
              class="session-item-button"
              :aria-current="thread.id === activeThreadId ? 'true' : undefined"
              :aria-label="`${thread.name || thread.preview.slice(0, 80) || '未命名会话'}，${thread.cwd || '未设置工作目录'}`"
              @click="emit('resume', thread.id)"
            >
              <div class="session-item-body">
              <div class="session-title-row">
                <NIcon v-if="workingThreadSet.has(thread.id)" :component="SyncOutline" class="session-working-icon" aria-label="正在工作" />
                <span
                  v-if="!workingThreadSet.has(thread.id) && unreadThreadSet.has(thread.id) && thread.id !== activeThreadId"
                  class="session-unread-dot"
                  aria-label="有未读内容"
                />
                <strong class="session-title">{{ thread.name || thread.preview.slice(0, 80) || "未命名会话" }}</strong>
                <NTag v-if="workingThreadSet.has(thread.id)" size="small" type="warning">运行中</NTag>
                <NTag v-if="thread.id === activeThreadId" size="small" type="success">当前</NTag>
              </div>
              <div class="session-meta">
                <NText depth="3" class="session-cwd">{{ thread.cwd || "—" }}</NText>
                <span class="session-meta-dot">·</span>
                <NTime v-if="thread.updatedAt > 0" class="session-time" :time="thread.updatedAt * 1000" type="relative" />
                <span v-else class="session-time">时间未知</span>
              </div>
              <span v-if="thread.name && thread.preview && thread.preview !== thread.name" class="session-preview">{{ thread.preview }}</span>
              </div>
            </button>
            <template v-if="showResumeButton" #suffix><NButton size="small" secondary class="session-resume-button" @click.stop="emit('resume', thread.id)">恢复</NButton></template>
          </NListItem>
        </NList>
        <NText v-if="threads.length >= 100" depth="3" class="session-result-limit">当前显示最近 100 个结果，可缩小搜索范围继续查找。</NText>
      </div>
    </NSpin>
  </div>
</template>
