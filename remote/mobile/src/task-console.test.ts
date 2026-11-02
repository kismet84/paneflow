// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import type { DesktopEvent, MobileCommand, MobileSnapshot } from "@codex-pane/remote-protocol";

const transport = vi.hoisted(() => ({ event: (_event: DesktopEvent) => {}, send: vi.fn() }));
vi.mock("./remote-client", () => ({ RemoteClient: class {
  constructor(event: typeof transport.event, private state: (state: string, message: string) => void) { transport.event = event; }
  start() { this.state("connected", ""); }
  stop() {}
  send(command: MobileCommand) { transport.send(command); }
} }));
beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 0; };
});
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); transport.send.mockClear(); });
const base = (): MobileSnapshot => ({ deviceOnline: true, codexState: "ready", codexMessage: "", appearance: { theme: "light", accentColor: "#10a37f" }, activeThreadId: "test-a", activeThreadTitle: "测试会话", activeTurnId: null, selectedModel: "model-a", selectedEffort: "high", models: [{ id: "model-a", displayName: "Model A", efforts: ["low", "high"] }, { id: "model-b", displayName: "Model B", efforts: ["medium"] }], turnStatus: "idle", threads: [{ id: "test-a", title: "测试会话", preview: "", updatedAt: 2, status: "idle", unread: false }, { id: "test-b", title: "等待确认的任务", preview: "审批命令", updatedAt: 3, status: "waiting", unread: true }], items: [] });
const setup = async (snapshot = base()) => {
  const { default: App } = await import("./App.vue");
  wrapper = mount(App);
  transport.event({ type: "snapshot", seq: 1, snapshot });
  await flushPromises();
  return wrapper;
};
const clickText = async (text: string) => {
  const button = wrapper!.findAll("button").find(button => button.text() === text);
  expect(button, text).toBeDefined();
  await button!.trigger("click"); await flushPromises();
};
describe("task console boundaries", () => {
  it("shows task states and opens the selected waiting task", async () => {
    await setup();
    const tabs = wrapper!.findAll(".console-tabs button"); await tabs[1]!.trigger("click");
    await wrapper!.get('[aria-label="筛选任务状态"]').setValue("waiting");
    expect(wrapper!.findAll(".task-card")).toHaveLength(1);
    await wrapper!.get(".task-card").trigger("click");
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.open", threadId: "test-b" }));
  });
  it("changes the model and constrains effort, bound to the selected thread", async () => {
    await setup();
    await wrapper!.get('[aria-label="模型"]').setValue("model-b");
    expect(wrapper!.get('[aria-label="推理强度"]').element).toHaveProperty("value", "medium");
    await clickText("应用设置");
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.configure", threadId: "test-a", model: "model-b", effort: "medium" }));
  });
  it("forks only an idle task and locks settings while running", async () => {
    const snapshot = base(); await setup(snapshot); await clickText("分叉会话");
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.fork", threadId: "test-a" }));
    transport.event({ type: "snapshot", seq: 2, snapshot: { ...snapshot, turnStatus: "running", activeTurnId: "turn-a" } });
    await flushPromises();
    expect(wrapper!.get('[aria-label="模型"]').attributes("disabled")).toBeDefined();
  });
  it("ignores content and approvals from a different thread", async () => {
    await setup();
    transport.event({ type: "item.upsert", seq: 2, threadId: "test-b", item: { id: "foreign", kind: "agent", markdown: "不可混入", status: "completed" } });
    transport.event({ type: "approval.request", seq: 3, threadId: "test-b", approval: { id: "foreign-approval", kind: "approval", title: "不可审批", summary: "", version: 1, decisions: ["accept", "decline"] } });
    await flushPromises(); expect(wrapper!.text()).not.toContain("不可混入"); expect(wrapper!.text()).not.toContain("不可审批");
  });
  it("binds approvals to the current thread and request version", async () => {
    const snapshot = base(); snapshot.items = [{ id: "approval-a", kind: "approval", title: "测试审批", summary: "只读命令", version: 4, decisions: ["accept", "decline"] }];
    await setup(snapshot); await clickText("仅本次同意");
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ type: "approval.resolve", threadId: "test-a", approvalId: "approval-a", version: 4, decision: "accept" }));
  });
  it("does not stop a new turn when the target changes during confirmation", async () => {
    const snapshot = { ...base(), activeTurnId: "turn-old", turnStatus: "running" as const };
    await setup(snapshot);
    const confirm = wrapper!.findAllComponents({ name: "Popconfirm" }).find(component => component.props("positiveText") === "停止任务")!;
    expect(confirm).toBeDefined();
    confirm.vm.$emit("update:show", true);
    transport.event({ type: "snapshot", seq: 2, snapshot: { ...snapshot, activeTurnId: "turn-new" } });
    await flushPromises();
    const confirmAction = confirm.props("onPositiveClick") as () => void;
    confirmAction(); await flushPromises();
    expect(transport.send).not.toHaveBeenCalled();
    expect(wrapper!.text()).toContain("确认期间任务已变化");
  });
});
