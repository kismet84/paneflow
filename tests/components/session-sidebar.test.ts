// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { NModal } from "naive-ui";
import { describe, expect, it, vi } from "vitest";
import SessionSidebar from "../../src/components/SessionSidebar.vue";
import SessionListPanel from "../../src/components/SessionListPanel.vue";
import { useWorkspaceStore } from "../../src/stores/workspace";

describe("SessionSidebar", () => {
  it("switches to an already bound session and creates a new session from the top action", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection.phase = "ready";
    store.state.workspaceMode = "sessionSidebar";
    store.state.panes[0]!.threadId = "thread-a";
    store.state.panes[1]!.threadId = "thread-b";
    store.state.panes[1]!.unread = true;
    store.state.panes[1]!.status = "running";
    store.state.threads = [
      { id: "thread-a", name: "会话 A", preview: "", cwd: "E:\\Work", updatedAt: 1, status: "idle" },
      { id: "thread-b", name: "会话 B", preview: "", cwd: "E:\\Work", updatedAt: 2, status: "idle" }
    ];
    vi.spyOn(store, "loadThreads").mockResolvedValue(undefined);
    vi.spyOn(store, "scheduleSave").mockImplementation(() => undefined);
    const newSidebarThread = vi.spyOn(store, "newSidebarThread");
    const wrapper = mount(SessionSidebar, { props: { pane: store.state.panes[0]! }, global: { plugins: [pinia] } });
    document.body.appendChild(wrapper.element);

    expect(wrapper.find(".session-sidebar-header").exists()).toBe(false);
    expect(wrapper.get(".session-new-button").classes()).not.toContain("n-button--block-type");
    expect(wrapper.find(".session-working-icon").attributes("aria-label")).toBe("正在工作");
    expect(wrapper.find(".session-unread-dot").exists()).toBe(false);
    store.state.panes[1]!.status = "idle";
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".session-working-icon").exists()).toBe(false);
    expect(wrapper.find(".session-unread-dot").attributes("aria-label")).toBe("有未读内容");
    const sessionButton = wrapper.findAll(".session-item-button").find((button) => button.attributes("aria-label")?.startsWith("会话 B"));
    expect(sessionButton?.attributes("aria-current")).toBeUndefined();
    await sessionButton!.trigger("keydown", { key: "Enter" });
    await sessionButton!.trigger("click");
    await vi.waitFor(() => expect(wrapper.emitted("activatePane")?.at(-1)).toEqual(["pane-2"]));
    await wrapper.setProps({ pane: store.state.panes[1]! });
    expect(store.state.focusedPaneId).toBe("pane-2");
    expect(store.state.panes[1]!.unread).toBe(false);
    expect(wrapper.find(".session-unread-dot").exists()).toBe(false);

    const sessionButtons = wrapper.findAll(".session-item-button");
    (sessionButtons[0]!.element as HTMLButtonElement).focus();
    await sessionButtons[0]!.trigger("keydown", { key: "ArrowDown" });
    expect(document.activeElement).toBe(sessionButtons[1]!.element);
    await sessionButtons[1]!.trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("focusConversation")).toHaveLength(1);

    wrapper.getComponent(SessionListPanel).vm.$emit("newSession");
    await vi.waitFor(() => expect(newSidebarThread).toHaveBeenCalledWith(store.state.panes[1]));
  });

  it("resumes an unbound session in the active pane", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection.phase = "ready";
    store.state.workspaceMode = "sessionSidebar";
    vi.spyOn(store, "loadThreads").mockResolvedValue(undefined);
    const switchSidebarThread = vi.spyOn(store, "switchSidebarThread").mockImplementation(async (pane, threadId) => { pane.threadId = threadId; return pane; });
    const wrapper = mount(SessionSidebar, { props: { pane: store.state.panes[0]! }, global: { plugins: [pinia] } });

    wrapper.getComponent(SessionListPanel).vm.$emit("resume", "thread-new");
    await vi.waitFor(() => expect(switchSidebarThread).toHaveBeenCalledWith(store.state.panes[0], "thread-new"));
    expect(wrapper.emitted("activatePane")?.at(-1)).toEqual(["pane-1"]);
  });

  it("keeps the current session while a global confirmation is pending", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection.phase = "ready";
    store.state.workspaceMode = "sessionSidebar";
    store.state.panes[0]!.threadId = "thread-current";
    store.state.pendingRequests = [{ generation: 1, id: "request-1", method: "test", params: {}, paneId: null, createdAt: 1 }];
    vi.spyOn(store, "loadThreads").mockResolvedValue(undefined);
    const switchSidebarThread = vi.spyOn(store, "switchSidebarThread");
    const wrapper = mount(SessionSidebar, { props: { pane: store.state.panes[0]! }, global: { plugins: [pinia] } });

    wrapper.getComponent(SessionListPanel).vm.$emit("resume", "thread-other");
    await wrapper.vm.$nextTick();
    expect(switchSidebarThread).not.toHaveBeenCalled();
    expect(store.state.panes[0]!.threadId).toBe("thread-current");
    expect(store.state.panes[0]!.error).toBeNull();
    expect(wrapper.getComponent(NModal).props()).toMatchObject({ show: true, title: "无法切换会话", content: "当前确认请求尚未处理，请完成后再切换会话。" });
  });

  it("shows session switch failures in a dialog instead of the current pane", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection.phase = "ready";
    store.state.workspaceMode = "sessionSidebar";
    store.state.panes[0]!.threadId = "thread-current";
    vi.spyOn(store, "loadThreads").mockResolvedValue(undefined);
    vi.spyOn(store, "switchSidebarThread").mockRejectedValue(new Error("无法恢复会话：会话已在其他客户端中打开"));
    const wrapper = mount(SessionSidebar, { props: { pane: store.state.panes[0]! }, global: { plugins: [pinia] } });

    wrapper.getComponent(SessionListPanel).vm.$emit("resume", "thread-external");
    await vi.waitFor(() => expect(wrapper.getComponent(NModal).props("show")).toBe(true));
    expect(wrapper.getComponent(NModal).props()).toMatchObject({ title: "无法切换会话", content: "无法恢复会话：会话已在其他客户端中打开" });
    expect(store.state.panes[0]!.error).toBeNull();
  });

  it("keeps history loading failures in the sidebar and offers an in-place retry", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useWorkspaceStore();
    store.state.connection.phase = "ready";
    store.state.workspaceMode = "sessionSidebar";
    const loadThreads = vi.spyOn(store, "loadThreads").mockRejectedValueOnce(new Error("app-server 暂时不可用")).mockResolvedValue(undefined);
    const wrapper = mount(SessionSidebar, { props: { pane: store.state.panes[0]! }, global: { plugins: [pinia] } });
    await vi.waitFor(() => expect(wrapper.find(".session-sidebar-error").exists()).toBe(true));
    expect(wrapper.text()).toContain("app-server 暂时不可用");
    expect(store.state.panes[0]!.error).toBeNull();
    await wrapper.findAll("button").find((button) => button.text() === "重试")!.trigger("click");
    await vi.waitFor(() => expect(loadThreads).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(wrapper.find(".session-sidebar-error").exists()).toBe(false));
  });
});
