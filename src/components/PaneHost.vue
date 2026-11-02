<script setup lang="ts">
import { computed, ref } from "vue";
import type { PendingServerRequest } from "../types";
import { useWorkspaceStore } from "../stores/workspace";
import PaneView from "./PaneView.vue";

const props = withDefaults(defineProps<{ index: number; includeGlobalRequests?: boolean }>(), { includeGlobalRequests: false });
const emit = defineEmits<{ openSessions: [paneId: string] }>();
const store = useWorkspaceStore();
const pane = computed(() => store.state.panes[props.index]!);
const paneView = ref<InstanceType<typeof PaneView> | null>(null);
const approvalResolving = ref(false);
const paneRequests = computed(() => store.state.pendingRequests.filter((request) => request.paneId === pane.value.id || request.paneId === null && (props.index === 0 || props.includeGlobalRequests)));

const resolveRequest = async (request: PendingServerRequest, result?: unknown, error?: { code: number; message: string }): Promise<void> => {
  if (approvalResolving.value) return;
  approvalResolving.value = true;
  try {
    await store.resolveRequest(request, result, error);
  } catch {
    // The inline approval stays visible and the pane shows a recoverable error.
  } finally {
    approvalResolving.value = false;
  }
};
const activate = (): void => {
  if (store.state.focusedPaneId !== pane.value.id) {
    store.state.focusedPaneId = pane.value.id;
    store.scheduleSave();
  }
  store.clearUnread(pane.value);
};
const focusComposer = (): void => {
  activate();
  void paneView.value?.focusComposer();
};
defineExpose({ focusComposer });
</script>

<template>
  <PaneView
    ref="paneView"
    :pane="pane"
    :default-cwd="store.state.defaultCwd"
    :models="store.state.models"
    :focused="store.state.focusedPaneId === pane.id"
    :pending-requests="paneRequests"
    :approval-resolving="approvalResolving"
    :connection-ready="store.state.connection.phase === 'ready'"
    :rate-limit-labels="store.state.rateLimitLabels"
    :pane-number="index + 1"
    :show-title="store.state.workspaceMode !== 'sessionSidebar'"
    :approval-reviewer="store.state.effectiveConfig?.approvalReviewer"
    :approval-policy="store.state.effectiveConfig?.approvalPolicy"
    :sandbox-mode="store.state.effectiveConfig?.sandboxMode"
    :command-shell-path="store.state.appearance.commandShellPath"
    :unwrap-power-shell-commands="store.state.appearance.unwrapPowerShellCommands"
    :mcp-gateway-adaptation="store.state.appearance.mcpGatewayAdaptation"
    :search-files="query => store.searchWorkspaceFiles(pane, query)"
    @send="store.send(pane)"
    @interrupt="store.interrupt(pane)"
    @new-thread="store.newThread(pane)"
    @open-sessions="emit('openSessions', pane.id)"
    @choose-attachments="store.chooseAttachments(pane)"
    @choose-directory="store.chooseDirectory(pane)"
    @open-skills="store.refreshSkills(pane)"
    @paste-attachments="store.pasteAttachments(pane, $event)"
    @slash-command="store.executeSlashCommand(pane, $event)"
    @remove-attachment="store.removeAttachment(pane, $event)"
    @remove-reference="store.removeReference(pane, $event)"
    @resolve="resolveRequest"
    @item-action="store.handleItemAction(pane, $event)"
    @scroll-state="(top, follow) => { pane.scrollTop = top; pane.followTail = follow; store.scheduleSave(); }"
    @load-older="store.loadOlderTurns(pane)"
    @click="activate"
    @activate="activate"
  />
</template>
