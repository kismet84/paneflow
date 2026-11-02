// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { NDropdown, NSelect } from "naive-ui";
import { defineComponent, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PaneView from "../../src/components/PaneView.vue";
import type { PaneState, PendingServerRequest } from "../../src/types";

const pane = (): PaneState => ({
  id: "pane-1",
  title: "分析协议适配",
  threadId: "thread-secret-12345678",
  cwd: "",
  draft: "",
  attachments: [],
  references: [],
  skills: [],
  activePermissionProfile: null,
  model: "gpt-5",
  effort: "medium",
  activeTurnId: null,
  status: "idle",
  items: [],
  tokenUsage: null,
  error: null,
  unread: false,
  scrollTop: 300,
  followTail: false
});
const models = [{ label: "GPT-5", value: "gpt-5", efforts: ["low", "medium", "high"], inputModalities: ["text", "image"], defaultEffort: "medium" }];
const request = (): PendingServerRequest => ({ generation: 1, id: "approval-1", method: "item/commandExecution/requestApproval", params: {}, paneId: "pane-1", createdAt: 1 });
const mountPane = (value = reactive(pane()), pendingRequests: PendingServerRequest[] = [], searchFiles?: (query: string) => Promise<Array<{ name: string; path: string; relativePath: string }>>) => ({
  value,
  wrapper: mount(PaneView, {
    attachTo: document.body,
    props: { pane: value, defaultCwd: "E:\\Work", models, focused: true, pendingRequests, approvalResolving: false, rateLimitLabels: ["5h 80%"], searchFiles },
    global: {
      stubs: {
        ItemCard: true,
        ApprovalCenter: { template: "<div class='approval-stub' />" },
        NTooltip: { template: "<span><slot name='trigger' /><slot /></span>" }
      }
    }
  })
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("PaneView compact workbench interactions", () => {
  it("keeps the pane header focused on title and working state", async () => {
    const { value, wrapper } = mountPane();
    const header = wrapper.get(".pane-header");
    expect(header.text()).toContain("分析协议适配");
    expect(header.findAll("button")).toHaveLength(0);
    for (const removedLabel of ["选择工作目录", "新建会话", "恢复历史会话", "聚焦此窗格"]) {
      expect(wrapper.find(`button[aria-label="${removedLabel}"]`).exists()).toBe(false);
    }
    value.status = "running";
    await nextTick();
    expect(wrapper.get('.status-line [role="status"]').text()).toContain("处理中");
    expect(wrapper.find(".composer-runtime-line").exists()).toBe(false);
  });

  it("shows permission mode and only active plan and timed goal states in the status line", async () => {
    const { value, wrapper } = mountPane();
    value.activePermissionProfile = ":workspace";
    value.approvalsReviewer = "auto_review";
    value.approvalReviews = [{ reviewId: "review-1", turnId: "turn-1", targetItemId: "command-1", startedAtMs: 1, completedAtMs: 2, status: "approved", riskLevel: "low", userAuthorization: "low", rationale: "安全", decisionSource: "agent", action: {} }];
    await nextTick();
    expect(wrapper.get(".status-line").text()).toContain("权限：自动审批");
    expect(wrapper.get(".status-line").text()).not.toContain("自动审查：已允许");
    expect(wrapper.get(".status-line").text()).not.toContain("计划模式");
    expect(wrapper.get(".status-line").text()).not.toContain("目标：");

    value.subAgents = {
      "thread-running": { threadId: "thread-running", path: "/root/worker", status: "running", message: null },
      "thread-completed": { threadId: "thread-completed", path: "/root/done", status: "completed", message: "done" }
    };
    value.backgroundTerminals = [{ itemId: "command-1", processId: "42", command: "npm test", cwd: "E:\\Work", osPid: 123, cpuPercent: null, rssKb: null }];
    await nextTick();
    expect(wrapper.get(".status-line").text()).toContain("子代理 1");
    expect(wrapper.get(".status-line").text()).toContain("后台任务 1");

    value.subAgents["thread-running"]!.status = "interrupted";
    value.backgroundTerminals = [];
    await nextTick();
    expect(wrapper.get(".status-line").text()).not.toContain("子代理");
    expect(wrapper.get(".status-line").text()).not.toContain("后台任务");

    value.collaborationMode = "plan";
    value.goal = { objective: "完成适配", status: "active", timeUsedSeconds: 7_500 };
    await nextTick();
    expect(wrapper.get(".status-line").text()).toContain("计划模式");
    expect(wrapper.get(".status-line").text()).toContain("目标：进行中 · 2 小时 5 分钟");

    value.collaborationMode = "default";
    value.goal = { objective: "完成适配", status: "complete" };
    await nextTick();
    expect(wrapper.get(".status-line").text()).not.toContain("计划模式");
    expect(wrapper.get(".status-line").text()).not.toContain("目标：");
  });

  it("hides the pane title row in session-sidebar mode", async () => {
    const { value, wrapper } = mountPane();
    await wrapper.setProps({ showTitle: false });
    expect(wrapper.get(".pane").classes()).toContain("pane-without-header");
    expect(wrapper.find(".pane-header").exists()).toBe(false);
    expect(wrapper.find(".pane-title").exists()).toBe(false);

    value.status = "error";
    await nextTick();
    expect(wrapper.get(".pane").classes()).not.toContain("pane-without-header");
    expect(wrapper.get(".pane-header").text()).toContain("需要处理");
    expect(wrapper.find(".pane-title").exists()).toBe(false);
  });

  it("shows a discoverable return-to-latest action only when reading older content and omits the session id", async () => {
    const value = reactive(pane());
    value.items.push({ id: "message-1", turnId: "turn-1", type: "agentMessage", data: {}, streamText: "较早内容", status: "completed" });
    const { wrapper } = mountPane(value);
    expect(wrapper.get('button[aria-label="回到最新消息"]').text()).toContain("回到最新");
    value.followTail = true;
    await nextTick();
    expect(wrapper.find('button[aria-label="回到最新消息"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("thread-secret");
    expect(wrapper.text()).not.toContain("会话 thread");
  });

  it("uses compact model and reasoning selectors", () => {
    const { wrapper } = mountPane();
    const selects = wrapper.findAllComponents(NSelect);
    expect(selects).toHaveLength(2);
    expect(selects[0]!.classes()).toContain("compact-select");
    expect(selects[0]!.classes()).toContain("model-select");
    expect(selects[1]!.classes()).toContain("effort-select");
    expect(selects[0]!.props("size")).toBe("tiny");
    expect(selects[1]!.props("size")).toBe("tiny");
    expect(selects[0]!.props("consistentMenuWidth")).toBe(false);
    expect(selects[1]!.props("consistentMenuWidth")).toBe(false);
    expect(selects[0]!.props("menuProps")).toEqual({ class: "content-fit-select-menu" });
    expect(selects[1]!.props("menuProps")).toEqual({ class: "content-fit-select-menu" });
    expect(wrapper.get(".composer-actions").findAllComponents(NSelect)).toHaveLength(2);
    expect(wrapper.find(".status-line .model-select").exists()).toBe(false);
    expect(wrapper.get(".model-select-fit .select-width-sizer").text()).toContain("GPT-5");
    expect(wrapper.get(".effort-select-fit .select-width-sizer").text()).toContain("中等");
  });

  it("keeps composer input literal and disables empty sends and steering", async () => {
    const { value, wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    expect(textarea.attributes("spellcheck")).toBe("false");
    expect(wrapper.findAll("button").find((button) => button.text() === "发送")!.attributes("disabled")).toBeDefined();

    value.draft = "继续排查";
    await nextTick();
    expect(wrapper.findAll("button").find((button) => button.text() === "发送")!.attributes("disabled")).toBeUndefined();

    value.activeTurnId = "turn-1";
    value.draft = "";
    await nextTick();
    expect(wrapper.findAll("button").find((button) => button.text() === "追加")!.attributes("disabled")).toBeDefined();

    value.status = "starting";
    value.draft = "不能提前发送";
    await nextTick();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toBeUndefined();
    expect(value.draft).toBe("不能提前发送");
    expect(wrapper.get(".composer-notice").text()).toContain("会话正在启动");
  });

  it("does not overwrite a draft when the slash-command button is clicked", async () => {
    const { value, wrapper } = mountPane();
    value.draft = "这是一段尚未发送的草稿";
    await nextTick();
    await wrapper.get('button[aria-label="斜杠命令"]').trigger("click");
    expect(value.draft).toBe("这是一段尚未发送的草稿");
    expect(wrapper.get(".composer-notice").text()).toContain("当前草稿已为你保留");
  });

  it("does not let model or effort selectors return focus to the composer", async () => {
    const { wrapper } = mountPane();
    const textarea = wrapper.get("textarea").element;
    const selections = wrapper.findAll(".n-base-selection");
    await selections[0]!.trigger("mousedown");
    await selections[0]!.trigger("click");
    expect(document.activeElement).not.toBe(textarea);
    await selections[1]!.trigger("mousedown");
    await selections[1]!.trigger("click");
    expect(document.activeElement).not.toBe(textarea);
  });

  it("opens slash commands and completes /cd without executing it immediately", async () => {
    const { value, wrapper } = mountPane();
    await wrapper.get('button[aria-label="斜杠命令"]').trigger("click");
    await nextTick();
    expect(value.draft).toBe("/");
    const dropdown = wrapper.getComponent(NDropdown);
    expect(dropdown.props("show")).toBe(true);
    expect(dropdown.props("options")).toHaveLength(16);
    const textarea = wrapper.get("textarea");
    await textarea.setValue("/c");
    await textarea.trigger("keydown", { key: "Tab" });
    expect(value.draft).toBe("/cd");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(value.draft).toBe("/cd ");
    expect(wrapper.emitted("slashCommand")).toBeUndefined();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("slashCommand")?.at(-1)).toEqual(["cd"]);
  });

  it("puts keyboard and mouse slash selections in the composer before manual submission", async () => {
    const { value, wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    await textarea.setValue("/res");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(value.draft).toBe("/resume ");
    expect(wrapper.emitted("openSessions")).toBeUndefined();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("openSessions")).toHaveLength(1);
    expect(wrapper.emitted("send")).toBeUndefined();
    expect(value.draft).toBe("");

    await wrapper.get('button[aria-label="斜杠命令"]').trigger("click");
    await nextTick();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(value.draft).toBe("/agents ");
    expect(wrapper.emitted("slashCommand")).toBeUndefined();
    wrapper.getComponent(NDropdown).vm.$emit("select", "slash:status");
    await nextTick();
    expect(value.draft).toBe("/status ");
    expect(wrapper.emitted("slashCommand")).toBeUndefined();
    await wrapper.findAll("button").find((button) => button.text() === "发送")!.trigger("click");
    expect(wrapper.emitted("slashCommand")?.at(-1)).toEqual(["status"]);
  });

  it.each(["ps", "stop"])("submits /%s to the command store instead of the message or skill path", async (command) => {
    const { value, wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    await textarea.setValue(`/${command}`);
    await textarea.trigger("keydown", { key: "Enter" });
    expect(value.draft).toBe(`/${command} `);
    expect(wrapper.emitted("slashCommand")).toBeUndefined();
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("slashCommand")?.at(-1)).toEqual([command]);
    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("does not accidentally send an unknown slash command as a normal prompt", async () => {
    const { value, wrapper } = mountPane(reactive(pane()));
    value.draft = "/does-not-exist";
    await nextTick();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toBeUndefined();
    expect(value.draft).toBe("/does-not-exist");
    expect(wrapper.get(".composer-notice").text()).toContain("未识别这个斜杠命令");
  });

  it("sorts slash commands alphabetically and shows used context", async () => {
    const { value, wrapper } = mountPane();
    value.contextRemainingPercent = 62;
    await wrapper.get('button[aria-label="斜杠命令"]').trigger("click");
    await nextTick();
    const labels = (wrapper.getComponent(NDropdown).props("options") ?? []).map((option) => String(option.key));
    expect(labels).toEqual(["slash:agents", "slash:cd", "slash:compact", "slash:fast", "slash:goal", "slash:mcp", "slash:new", "slash:permissions", "slash:plan", "slash:ps", "slash:rename", "slash:resume", "slash:review", "slash:skills", "slash:status", "slash:stop"]);
    expect(wrapper.get(".status-line").text()).toContain("上下文已用 38%");
  });

  it("shows scannable command descriptions and non-duplicated usage hints", async () => {
    const { wrapper } = mountPane();
    await wrapper.get('button[aria-label="斜杠命令"]').trigger("click");
    await nextTick();
    const textarea = wrapper.get("textarea");
    await textarea.trigger("keydown", { key: "ArrowDown" });
    let options = wrapper.getComponent(NDropdown).props("options") ?? [];
    expect(options[0]?.props?.class).toContain("slash-option-active");
    const agentsLabel = options[0]?.label as () => ReturnType<typeof h>;
    const agentsHint = mount(defineComponent({ setup: () => () => agentsLabel() }));
    expect(agentsHint.text()).toBe("/agents查看并切换子代理");
    expect(agentsHint.text().match(/\/agents/g)).toHaveLength(1);
    const cdLabel = options[1]?.label as () => ReturnType<typeof h>;
    const commandOnly = mount(defineComponent({ setup: () => () => cdLabel() }));
    expect(commandOnly.text()).toBe("/cd切换工作目录");
    options[4]?.props?.onMouseenter?.({} as MouseEvent);
    await nextTick();
    options = wrapper.getComponent(NDropdown).props("options") ?? [];
    const goalLabel = options[4]?.label as () => ReturnType<typeof h>;
    const usage = mount(defineComponent({ setup: () => () => goalLabel() }));
    expect(usage.text()).toContain("查看或设置当前目标");
    expect(usage.text()).toContain("/goal <目标内容> | pause | resume | clear");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("slashCommand")).toBeUndefined();
  });

  it("scrolls populated slash and Skill selections into view without searching an empty file query", async () => {
    vi.useFakeTimers();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      const searchFiles = vi.fn().mockResolvedValue([{ name: "README.md", path: "E:\\Work\\README.md", relativePath: "README.md" }]);
      const value = reactive(pane());
      value.skills = [{ name: "project-verify", description: "验证项目", path: "E:\\Skills\\project-verify\\SKILL.md" }];
      const { wrapper } = mountPane(value, [], searchFiles);
      const textarea = wrapper.get("textarea");

      await textarea.setValue("/");
      await textarea.trigger("keydown", { key: "ArrowDown" });
      await nextTick();
      await textarea.setValue("@");
      await textarea.trigger("keydown", { key: "ArrowDown" });
      await nextTick();
      await textarea.setValue("$");
      await vi.advanceTimersByTimeAsync(120);
      await nextTick();
      await textarea.trigger("keydown", { key: "ArrowDown" });
      await nextTick();

      expect(searchFiles).not.toHaveBeenCalled();
      expect(wrapper.getComponent(NDropdown).props("options")?.[0]?.label).toBe("继续输入文件名以开始搜索");
      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest", inline: "nearest" });
    } finally {
      if (originalScrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: originalScrollIntoView });
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      vi.useRealTimers();
    }
  });

  it("searches and selects $ file references from the current working directory", async () => {
    vi.useFakeTimers();
    try {
      const searchFiles = vi.fn().mockResolvedValue([
        { name: "README.md", path: "E:\\Work\\README.md", relativePath: "README.md" },
        { name: "guide.md", path: "E:\\Work\\docs\\guide.md", relativePath: "docs\\guide.md" }
      ]);
      const { value, wrapper } = mountPane(reactive(pane()), [], searchFiles);
      const textarea = wrapper.get("textarea");
      await textarea.setValue("请检查 $guide");
      await vi.advanceTimersByTimeAsync(120);
      await nextTick();
      expect(searchFiles).toHaveBeenCalledWith("guide");
      const dropdown = wrapper.getComponent(NDropdown);
      expect(dropdown.props("show")).toBe(true);
      const optionLabels = (dropdown.props("options") ?? []).map((option) => {
        const label = option.label as () => ReturnType<typeof h>;
        return mount(defineComponent({ setup: () => () => label() })).text();
      });
      expect(optionLabels).toEqual(["README.mdREADME.md", "guide.mddocs\\guide.md"]);
      await textarea.trigger("keydown", { key: "ArrowDown" });
      await textarea.trigger("keydown", { key: "ArrowDown" });
      await textarea.trigger("keydown", { key: "Enter" });
      expect(value.draft).toBe("请检查 $docs\\guide.md ");
      expect(value.references).toEqual([expect.objectContaining({ name: "guide.md", path: "E:\\Work\\docs\\guide.md" })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a file query at $ and sends an unmatched reference as plain text", async () => {
    vi.useFakeTimers();
    try {
      const searchFiles = vi.fn().mockResolvedValue([]);
      const { value, wrapper } = mountPane(reactive(pane()), [], searchFiles);
      const textarea = wrapper.get("textarea");
      await textarea.setValue("请检查$");
      await vi.advanceTimersByTimeAsync(120);
      await nextTick();
      expect(searchFiles).not.toHaveBeenCalled();
      expect(wrapper.getComponent(NDropdown).props("show")).toBe(true);
      expect(wrapper.getComponent(NDropdown).props("options")?.[0]?.label).toBe("继续输入文件名以开始搜索");
      await textarea.trigger("keydown", { key: "Enter" });
      expect(wrapper.emitted("send")).toHaveLength(1);
      expect(value.draft).toBe("请检查$");
      expect(value.references).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens slash commands only at the beginning and supports @ at the caret", async () => {
    const value = reactive(pane());
    value.skills = [{ name: "project-verify", description: "验证项目", path: "E:\\Skills\\project-verify\\SKILL.md" }];
    const { wrapper } = mountPane(value);
    const textarea = wrapper.get("textarea");
    await textarea.setValue("普通文本 /");
    expect(wrapper.getComponent(NDropdown).props("show")).toBe(false);
    await textarea.setValue("请用@pro检查");
    (textarea.element as HTMLTextAreaElement).setSelectionRange(6, 6);
    await textarea.trigger("select");
    await nextTick();
    expect(wrapper.getComponent(NDropdown).props("show")).toBe(true);
    wrapper.getComponent(NDropdown).vm.$emit("select", "skill:project-verify");
    await nextTick();
    expect(value.draft).toBe("请用@project-verify 检查");
  });

  it("accepts slash command arguments and leaves rename open for input", async () => {
    const { value, wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    await textarea.setValue("/rename");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(value.draft).toBe("/rename ");
    await textarea.setValue("/rename 新标题");
    await textarea.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("slashCommand")?.at(-1)).toEqual(["rename 新标题"]);
  });

  it("opens Skills with @ and uses one attachment action for files and images", async () => {
    const { value, wrapper } = mountPane();
    value.skills = [{ name: "project-verify", description: "验证项目", path: "E:\\Skills\\project-verify\\SKILL.md" }];
    await wrapper.get('button[aria-label="选择 Skill"]').trigger("click");
    await nextTick();
    expect(wrapper.emitted("openSkills")).toHaveLength(1);
    expect(value.draft).toBe("@");
    await wrapper.get('button[aria-label="选择 Skill"]').trigger("click");
    expect(value.draft).toBe("@");
    const composerDropdown = wrapper.findAllComponents(NDropdown).find((dropdown) => dropdown.props("trigger") === "manual")!;
    expect(composerDropdown.props("options")?.[0]?.key).toBe("skill:project-verify");
    const skillLabel = composerDropdown.props("options")?.[0]?.label as () => ReturnType<typeof h>;
    expect(mount(defineComponent({ setup: () => () => skillLabel() })).text()).toBe("project-verify验证项目");
    expect(composerDropdown.props("scrollable")).toBe(true);
    expect(composerDropdown.props("menuProps")?.(undefined, [])).toMatchObject({
      class: "composer-options-menu",
      style: "max-height: min(320px, calc(100vh - 180px));"
    });
    composerDropdown.vm.$emit("select", "skill:project-verify");
    await nextTick();
    expect(value.draft).toBe("@project-verify ");
    await wrapper.get('button[aria-label="添加附件"]').trigger("click");
    expect(wrapper.emitted("chooseAttachments")).toHaveLength(1);
  });

  it("keeps typed tokens when dismissing suggestions and exposes file and directory actions", async () => {
    const searchFiles = vi.fn().mockResolvedValue([]);
    const { value, wrapper } = mountPane(reactive(pane()), [], searchFiles);
    const textarea = wrapper.get("textarea");
    await textarea.setValue("请使用 @missing");
    expect(wrapper.getComponent(NDropdown).props("show")).toBe(true);
    await textarea.trigger("keydown", { key: "Escape" });
    expect(value.draft).toBe("请使用 @missing");
    expect(wrapper.getComponent(NDropdown).props("show")).toBe(false);

    await wrapper.get('button[aria-label="引用工作区文件"]').trigger("click");
    expect(value.draft).toContain("$");
    await wrapper.get('button[aria-label="切换当前工作目录"]').trigger("click");
    expect(wrapper.emitted("chooseDirectory")).toHaveLength(1);
  });

  it("explains why an image attachment cannot be sent with the selected model", async () => {
    const value = reactive(pane());
    value.attachments = [{ id: "image-1", name: "screen.png", url: "codex-media://media/image-1", size: 12, kind: "local", sourcePath: "E:\\screen.png" }];
    const { wrapper } = mountPane(value);
    await wrapper.setProps({ models: [{ ...models[0]!, inputModalities: ["text"] }] });
    expect(wrapper.get(".composer-warning").text()).toContain("当前模型不支持图片");
    expect(wrapper.findAll("button").find((button) => button.text() === "发送")!.attributes("disabled")).toBeDefined();
  });

  it("blocks sends while disconnected and makes the attachment quota visible", async () => {
    const value = reactive(pane());
    value.draft = "稍后发送";
    value.attachments = Array.from({ length: 20 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `image-${index}.png`,
      url: `codex-media://media/${index}`,
      size: 2048,
      kind: "local" as const
    }));
    const { wrapper } = mountPane(value);
    await wrapper.setProps({ connectionReady: false });
    expect(wrapper.get(".composer-notice").text()).toContain("Codex 尚未连接");
    expect(wrapper.get(".attachment-summary").text()).toContain("20 / 20");
    expect(wrapper.get('button[aria-label="添加附件"]').attributes("disabled")).toBeDefined();
    await wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("send")).toBeUndefined();
  });

  it("leaves pasted text in the composer and routes pasted files through attachments", async () => {
    const { wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    await textarea.trigger("paste", { clipboardData: { files: [], items: [{ kind: "string", type: "text/plain" }], getData: () => "E:\\Work\\notes.txt" } });
    expect(wrapper.emitted("pasteAttachments")).toBeUndefined();
    await textarea.trigger("paste", { clipboardData: { files: [{ path: "E:\\Work\\notes.txt" }], items: [{ kind: "file", type: "text/plain" }], getData: () => "" } });
    expect(wrapper.emitted("pasteAttachments")?.at(-1)).toEqual([["E:\\Work\\notes.txt"]]);
  });

  it("scrolls the current pane to the bottom when ArrowDown is pressed on an empty composer", async () => {
    const { wrapper } = mountPane();
    const output = wrapper.get(".pane-output").element as HTMLElement;
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 1400 });
    await wrapper.get("textarea").trigger("keydown", { key: "ArrowDown" });
    await nextTick();
    expect(output.scrollTop).toBe(1400);
    expect(wrapper.emitted("scrollState")?.at(-1)).toEqual([1400, true]);
  });

  it("recalls submitted prompts from the composer with shell-style arrow history", async () => {
    const { value, wrapper } = mountPane();
    const textarea = wrapper.get("textarea");
    await textarea.setValue("第一条任务");
    await textarea.trigger("keydown", { key: "Enter" });
    value.draft = "";
    await nextTick();
    await textarea.setValue("第二条任务");
    await textarea.trigger("keydown", { key: "Enter" });
    value.draft = "尚未发送的草稿";
    await nextTick();
    (textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0);
    await textarea.trigger("keydown", { key: "ArrowUp" });
    expect(value.draft).toBe("第二条任务");
    (textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0);
    await textarea.trigger("keydown", { key: "ArrowUp" });
    expect(value.draft).toBe("第一条任务");
    (textarea.element as HTMLTextAreaElement).setSelectionRange(value.draft.length, value.draft.length);
    await textarea.trigger("keydown", { key: "ArrowDown" });
    (textarea.element as HTMLTextAreaElement).setSelectionRange(value.draft.length, value.draft.length);
    await textarea.trigger("keydown", { key: "ArrowDown" });
    expect(value.draft).toBe("尚未发送的草稿");
  });

  it("preserves prompt history when the same pane is remounted after a workspace mode switch", async () => {
    const value = reactive(pane());
    const first = mountPane(value);
    await first.wrapper.get("textarea").setValue("跨模式保留的任务");
    await first.wrapper.get("textarea").trigger("keydown", { key: "Enter" });
    expect(first.wrapper.emitted("send")).toHaveLength(1);
    first.wrapper.unmount();
    value.draft = "";

    const second = mountPane(value);
    const textarea = second.wrapper.get("textarea");
    (textarea.element as HTMLTextAreaElement).setSelectionRange(0, 0);
    await textarea.trigger("keydown", { key: "ArrowUp" });
    expect(value.draft).toBe("跨模式保留的任务");
  });

  it("searches Skill descriptions and explains keyboard menu controls", async () => {
    const value = reactive(pane());
    value.skills = [{ name: "project-verify", description: "检查发布质量", path: "E:\\Skills\\project-verify\\SKILL.md" }];
    const { wrapper } = mountPane(value);
    const textarea = wrapper.get("textarea");
    await textarea.setValue("@发布");
    await nextTick();
    expect(wrapper.getComponent(NDropdown).props("options")?.[0]?.key).toBe("skill:project-verify");
    expect(wrapper.get(".composer-menu-help").text()).toContain("Ctrl+P");
    expect(wrapper.get(".composer-menu-help").text()).toContain("Shift+Tab");
    await wrapper.setProps({ focused: false });
    expect(wrapper.getComponent(NDropdown).props("show")).toBe(false);
  });

  it("returns focus to the composer after the inline approval completes", async () => {
    const { wrapper } = mountPane(reactive(pane()), [request()]);
    const textarea = wrapper.get("textarea").element;
    await wrapper.setProps({ pendingRequests: [] });
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(textarea);
  });

  it("restores a saved reading position after asynchronous history hydration", async () => {
    const { value, wrapper } = mountPane();
    const output = wrapper.get(".pane-output").element as HTMLElement;
    Object.defineProperty(output, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(output, "clientHeight", { configurable: true, value: 400 });
    value.items.push({ id: "message-1", turnId: "turn-1", type: "agentMessage", data: { type: "agentMessage", id: "message-1", text: "history" }, streamText: "", status: "completed" });
    await nextTick();
    await nextTick();
    expect(output.scrollTop).toBe(300);
  });
});
