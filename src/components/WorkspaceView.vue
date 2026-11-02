<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { ComponentPublicInstance } from "vue";
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useWorkspaceStore } from "../stores/workspace";
import PaneHost from "./PaneHost.vue";
import SessionSidebar from "./SessionSidebar.vue";

const emit = defineEmits<{ openSessions: [paneId: string] }>();
const sidebarCollapsed = defineModel<boolean>("sidebarCollapsed", { default: false });
const store = useWorkspaceStore();
type PaneHostInstance = ComponentPublicInstance & { focusComposer: () => void };
const paneHosts = ref<Record<number, PaneHostInstance | null>>({});
const sessionSidebar = ref<InstanceType<typeof SessionSidebar> | null>(null);
const visiblePaneCount = computed(() => ({ single: 1, vertical: 2, horizontal: 2, quad: 4, fourColumns: 4, fourRows: 4, six: 6 })[store.state.layout]);
const sessionPaneIndex = computed(() => {
  const index = store.state.panes.findIndex((pane) => pane.id === store.state.focusedPaneId);
  return index >= 0 ? index : 0;
});
const sessionPane = computed(() => store.state.panes[sessionPaneIndex.value]!);

const size = (key: string, index: number, count = 2): number => store.state.splitSizes[key]?.[index] ?? 100 / count;
const captureSizes = (key: string, payload: { panes: Array<{ size: number }> }): void => store.setSplitSizes(key, payload.panes.map((pane) => pane.size));
const setPaneHost = (index: number, instance: unknown): void => {
  paneHosts.value[index] = instance as PaneHostInstance | null;
};
const focusPane = async (index: number): Promise<void> => {
  const pane = store.state.panes[index];
  if (!pane) return;
  store.state.focusedPaneId = pane.id;
  store.scheduleSave();
  await nextTick();
  paneHosts.value[index]?.focusComposer();
};
const focusPaneById = async (paneId: string | null): Promise<void> => {
  const index = store.state.panes.findIndex((pane) => pane.id === paneId);
  if (index >= 0) await focusPane(index);
};
const handleWorkspaceKeydown = (event: KeyboardEvent): void => {
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "b" && store.state.workspaceMode === "sessionSidebar") {
    event.preventDefault();
    sidebarCollapsed.value = !sidebarCollapsed.value;
    return;
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "l" && store.state.workspaceMode === "sessionSidebar") {
    event.preventDefault();
    void focusSessionList();
    return;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^[1-6]$/.test(event.key)) {
    const index = Number(event.key) - 1;
    if (store.state.workspaceMode === "panes" && index < visiblePaneCount.value && store.state.panes[index]) {
      event.preventDefault();
      void focusPane(index);
    }
    return;
  }
  if (store.state.workspaceMode === "sessionSidebar") return;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  const layout = store.state.layout;
  const dimensions = layout === "single" ? { columns: 1, rows: 1 }
    : layout === "vertical" ? { columns: 2, rows: 1 }
      : layout === "horizontal" ? { columns: 1, rows: 2 }
        : layout === "quad" ? { columns: 2, rows: 2 }
          : layout === "fourColumns" ? { columns: 4, rows: 1 }
            : layout === "fourRows" ? { columns: 1, rows: 4 }
              : { columns: 3, rows: 2 };
  const current = Math.max(0, store.state.panes.findIndex((pane) => pane.id === store.state.focusedPaneId));
  const row = Math.floor(current / dimensions.columns);
  const column = current % dimensions.columns;
  const nextRow = event.key === "ArrowUp" ? row - 1 : event.key === "ArrowDown" ? row + 1 : row;
  const nextColumn = event.key === "ArrowLeft" ? column - 1 : event.key === "ArrowRight" ? column + 1 : column;
  if (nextRow < 0 || nextRow >= dimensions.rows || nextColumn < 0 || nextColumn >= dimensions.columns) return;
  event.preventDefault();
  void focusPane(nextRow * dimensions.columns + nextColumn);
};
const focusSessionList = async (): Promise<void> => {
  sidebarCollapsed.value = false;
  await nextTick();
  sessionSidebar.value?.focusSearch();
};
defineExpose({ focusPaneById, focusSessionList });
</script>

<template>
  <main class="workspace" :class="[`workspace-layout-${store.state.layout}`, `workspace-mode-${store.state.workspaceMode}`]" @keydown="handleWorkspaceKeydown">
    <div v-if="store.state.workspaceMode === 'sessionSidebar'" class="session-workspace" :class="{ 'session-workspace-sidebar-collapsed': sidebarCollapsed }">
      <div class="session-sidebar-shell">
        <SessionSidebar v-if="!sidebarCollapsed" ref="sessionSidebar" :pane="sessionPane" @activate-pane="focusPaneById" @focus-conversation="focusPane(sessionPaneIndex)" />
      </div>
      <div class="session-workspace-pane">
        <PaneHost :ref="instance => setPaneHost(sessionPaneIndex, instance)" :index="sessionPaneIndex" include-global-requests @open-sessions="emit('openSessions', $event)" />
      </div>
    </div>

    <PaneHost v-else-if="store.state.layout === 'single'" :ref="instance => setPaneHost(0, instance)" :index="0" @open-sessions="emit('openSessions', $event)" />

    <Splitpanes v-else-if="store.state.layout === 'vertical'" class="codex-split" @resized="captureSizes('vertical', $event)">
      <Pane :size="size('vertical', 0)"><PaneHost :ref="instance => setPaneHost(0, instance)" :index="0" @open-sessions="emit('openSessions', $event)" /></Pane>
      <Pane :size="size('vertical', 1)"><PaneHost :ref="instance => setPaneHost(1, instance)" :index="1" @open-sessions="emit('openSessions', $event)" /></Pane>
    </Splitpanes>

    <Splitpanes v-else-if="store.state.layout === 'horizontal'" horizontal class="codex-split" @resized="captureSizes('horizontal', $event)">
      <Pane :size="size('horizontal', 0)"><PaneHost :ref="instance => setPaneHost(0, instance)" :index="0" @open-sessions="emit('openSessions', $event)" /></Pane>
      <Pane :size="size('horizontal', 1)"><PaneHost :ref="instance => setPaneHost(1, instance)" :index="1" @open-sessions="emit('openSessions', $event)" /></Pane>
    </Splitpanes>

    <Splitpanes v-else-if="store.state.layout === 'fourColumns'" class="codex-split" @resized="captureSizes('fourColumns', $event)">
      <Pane v-for="index in 4" :key="`four-column-${index}`" :size="size('fourColumns', index - 1, 4)"><PaneHost :ref="instance => setPaneHost(index - 1, instance)" :index="index - 1" @open-sessions="emit('openSessions', $event)" /></Pane>
    </Splitpanes>

    <Splitpanes v-else-if="store.state.layout === 'fourRows'" horizontal class="codex-split" @resized="captureSizes('fourRows', $event)">
      <Pane v-for="index in 4" :key="`four-row-${index}`" :size="size('fourRows', index - 1, 4)"><PaneHost :ref="instance => setPaneHost(index - 1, instance)" :index="index - 1" @open-sessions="emit('openSessions', $event)" /></Pane>
    </Splitpanes>

    <Splitpanes v-else-if="store.state.layout === 'quad'" horizontal class="codex-split" @resized="captureSizes('quadRows', $event)">
      <Pane :size="size('quadRows', 0)">
        <Splitpanes class="codex-split" @resized="captureSizes('quadTop', $event)">
          <Pane :size="size('quadTop', 0)"><PaneHost :ref="instance => setPaneHost(0, instance)" :index="0" @open-sessions="emit('openSessions', $event)" /></Pane>
          <Pane :size="size('quadTop', 1)"><PaneHost :ref="instance => setPaneHost(1, instance)" :index="1" @open-sessions="emit('openSessions', $event)" /></Pane>
        </Splitpanes>
      </Pane>
      <Pane :size="size('quadRows', 1)">
        <Splitpanes class="codex-split" @resized="captureSizes('quadBottom', $event)">
          <Pane :size="size('quadBottom', 0)"><PaneHost :ref="instance => setPaneHost(2, instance)" :index="2" @open-sessions="emit('openSessions', $event)" /></Pane>
          <Pane :size="size('quadBottom', 1)"><PaneHost :ref="instance => setPaneHost(3, instance)" :index="3" @open-sessions="emit('openSessions', $event)" /></Pane>
        </Splitpanes>
      </Pane>
    </Splitpanes>

    <Splitpanes v-else horizontal class="codex-split" @resized="captureSizes('sixRows', $event)">
      <Pane :size="size('sixRows', 0)">
        <Splitpanes class="codex-split" @resized="captureSizes('sixTop', $event)">
          <Pane v-for="index in 3" :key="`six-top-${index}`" :size="size('sixTop', index - 1, 3)"><PaneHost :ref="instance => setPaneHost(index - 1, instance)" :index="index - 1" @open-sessions="emit('openSessions', $event)" /></Pane>
        </Splitpanes>
      </Pane>
      <Pane :size="size('sixRows', 1)">
        <Splitpanes class="codex-split" @resized="captureSizes('sixBottom', $event)">
          <Pane v-for="index in 3" :key="`six-bottom-${index}`" :size="size('sixBottom', index - 1, 3)"><PaneHost :ref="instance => setPaneHost(index + 2, instance)" :index="index + 2" @open-sessions="emit('openSessions', $event)" /></Pane>
        </Splitpanes>
      </Pane>
    </Splitpanes>
  </main>
</template>
