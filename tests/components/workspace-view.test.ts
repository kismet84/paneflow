// @vitest-environment jsdom

import { defineComponent, h } from "vue";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import WorkspaceView from "../../src/components/WorkspaceView.vue";
import { useWorkspaceStore } from "../../src/stores/workspace";

const passthrough = defineComponent({ setup: (_props, { slots }) => () => h("div", slots.default?.()) });
const paneHost = defineComponent({
  props: { index: { type: Number, required: true }, includeGlobalRequests: { type: Boolean, default: false } },
  setup(props, { expose }) {
    expose({ focusComposer: vi.fn() });
    return () => h("section", { "data-test-pane": props.index, "data-global-requests": String(props.includeGlobalRequests) });
  }
});

describe("WorkspaceView focus navigation", () => {
  it("moves the highlighted pane with Alt+Arrow without collapsing the layout", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.layout = "quad";
    store.state.focusedPaneId = store.state.panes[0]!.id;
    vi.spyOn(store, "scheduleSave").mockImplementation(() => undefined);
    const wrapper = mount(WorkspaceView, {
      global: { plugins: [pinia], stubs: { Splitpanes: passthrough, Pane: passthrough, PaneHost: paneHost } }
    });
    expect(wrapper.findAll("[data-test-pane]")).toHaveLength(4);
    expect(wrapper.get("main").classes()).toContain("workspace-layout-quad");
    await wrapper.get("main").trigger("keydown", { key: "ArrowRight", altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[1]!.id);
    await wrapper.get("main").trigger("keydown", { key: "ArrowDown", altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[3]!.id);
    expect(wrapper.findAll("[data-test-pane]")).toHaveLength(4);
    await wrapper.get("main").trigger("keydown", { key: "4", altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[3]!.id);
    await wrapper.get("main").trigger("keydown", { key: "6", altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[3]!.id);
  });

  it.each([
    { layout: "fourColumns" as const, direction: "ArrowRight", blockedDirection: "ArrowDown" },
    { layout: "fourRows" as const, direction: "ArrowDown", blockedDirection: "ArrowRight" }
  ])("renders and navigates $layout as a one-dimensional four-pane layout", async ({ layout, direction, blockedDirection }) => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.layout = layout;
    store.state.focusedPaneId = store.state.panes[0]!.id;
    vi.spyOn(store, "scheduleSave").mockImplementation(() => undefined);
    const wrapper = mount(WorkspaceView, {
      global: { plugins: [pinia], stubs: { Splitpanes: passthrough, Pane: passthrough, PaneHost: paneHost } }
    });

    expect(wrapper.findAll("[data-test-pane]")).toHaveLength(4);
    expect(wrapper.get("main").classes()).toContain(`workspace-layout-${layout}`);
    await wrapper.get("main").trigger("keydown", { key: direction, altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[1]!.id);
    await wrapper.get("main").trigger("keydown", { key: blockedDirection, altKey: true });
    expect(store.state.focusedPaneId).toBe(store.state.panes[1]!.id);
  });

  it("shows a collapsible session list beside one active pane in session-sidebar mode", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.workspaceMode = "sessionSidebar";
    store.state.layout = "quad";
    store.state.focusedPaneId = store.state.panes[1]!.id;
    const wrapper = mount(WorkspaceView, {
      global: {
        plugins: [pinia],
        stubs: {
          Splitpanes: passthrough,
          Pane: passthrough,
          PaneHost: paneHost,
          SessionSidebar: { props: ["pane"], template: "<aside data-test-sidebar />" }
        }
      }
    });

    expect(wrapper.find("[data-test-sidebar]").exists()).toBe(true);
    expect(wrapper.findAll("[data-test-pane]")).toHaveLength(1);
    expect(wrapper.get("[data-test-pane]").attributes("data-test-pane")).toBe("1");
    expect(wrapper.get("[data-test-pane]").attributes("data-global-requests")).toBe("true");
    expect(wrapper.get("main").classes()).toContain("workspace-mode-sessionSidebar");
    await wrapper.get("main").trigger("keydown", { key: "b", ctrlKey: true, shiftKey: true });
    expect(wrapper.get(".session-workspace").classes()).toContain("session-workspace-sidebar-collapsed");
    expect(wrapper.find("[data-test-sidebar]").exists()).toBe(false);
    await wrapper.get("main").trigger("keydown", { key: "b", ctrlKey: true, shiftKey: true });
    expect(wrapper.find("[data-test-sidebar]").exists()).toBe(true);
  });
});
