<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { NAlert, NButton } from "naive-ui";
import { CloseOutline } from "@vicons/ionicons5";
import type { PaneState, ThreadSummary } from "../types";
import SessionListPanel from "./SessionListPanel.vue";

const props = withDefaults(defineProps<{ show: boolean; pane: PaneState | null; threads: ThreadSummary[]; showAll: boolean; currentCwd: string; loading?: boolean; error?: string }>(), { loading: false, error: "" });
const emit = defineEmits<{
  "update:show": [value: boolean];
  search: [value: string];
  scope: [showAll: boolean, search: string];
  resume: [threadId: string];
}>();
const panel = ref<InstanceType<typeof SessionListPanel> | null>(null);
const changeScope = (showAll: boolean, search: string): void => emit("scope", showAll, search);
watch(() => props.show, (show) => {
  if (show) void nextTick(() => panel.value?.focusSearch());
});
</script>

<template>
  <Teleport v-if="show && pane" :to="`[data-pane-id='${pane.id}']`">
    <section class="session-pane-page" role="region" aria-label="恢复会话" @keydown.esc.stop="emit('update:show', false)">
      <header class="session-pane-header"><strong>恢复会话</strong><NButton quaternary circle size="small" aria-label="关闭恢复会话" @click="emit('update:show', false)"><template #icon><CloseOutline /></template></NButton></header>
      <SessionListPanel
        ref="panel"
        :threads="threads"
        :active-thread-id="pane.threadId"
        :show-all="showAll"
        :current-cwd="currentCwd"
        :loading="loading"
        show-resume-button
        search-placeholder="按标题或内容搜索历史会话"
        show-all-label="显示全部"
        current-only-label="仅当前目录"
        @search="emit('search', $event)"
        @scope="changeScope"
        @resume="emit('resume', $event)"
      />
      <NAlert v-if="error" type="error" class="session-drawer-error">{{ error }}</NAlert>
    </section>
  </Teleport>
</template>
