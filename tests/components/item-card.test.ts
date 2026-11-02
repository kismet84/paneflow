// @vitest-environment jsdom

import { config, mount } from "@vue/test-utils";
import { messageApiInjectionKey } from "naive-ui/es/message/src/context";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ItemCard from "../../src/components/ItemCard.vue";
import type { UiItem } from "../../src/types";

const item = (type: string, data: Record<string, unknown>, streamText = "", status: UiItem["status"] = "completed"): UiItem => ({ id: "item-1", turnId: "turn-1", type, data, streamText, status });
const messageApi = { success: vi.fn(), error: vi.fn() };

config.global.stubs = {
  MarkdownContent: { props: ["source"], template: "<div>{{ source }}</div>" },
  NCode: { props: ["code"], template: "<code>{{ code }}</code>" },
  Code: { props: ["code"], template: "<code>{{ code }}</code>" },
  NTooltip: { template: "<span><slot name='trigger' /><slot /></span>" }
};
config.global.provide = { [messageApiInjectionKey as symbol]: messageApi };

const expandFirst = async (wrapper: ReturnType<typeof mount>): Promise<void> => {
  await wrapper.get(".n-collapse-item__header-main").trigger("click");
  await nextTick();
};

beforeEach(() => {
  vi.clearAllMocks();
  window.codexPane = { copyText: vi.fn().mockResolvedValue(undefined) } as unknown as Window["codexPane"];
});

describe("ItemCard compact structured views", () => {
  it("uses an icon-only accessible copy action for agent messages", async () => {
    const wrapper = mount(ItemCard, { props: { item: item("agentMessage", { text: "完成了" }) } });
    expect(wrapper.classes()).toContain("item-card");
    expect(wrapper.classes()).toContain("message-agent");
    const button = wrapper.get('button[aria-label="复制回复"]');
    expect(button.text()).toBe("");
    await button.trigger("click");
    expect(window.codexPane.copyText).toHaveBeenCalledWith("完成了");
    expect(messageApi.success).toHaveBeenCalledWith("复制成功");
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it("shows an error toast when copying an agent reply fails", async () => {
    vi.mocked(window.codexPane.copyText).mockRejectedValueOnce(new Error("denied"));
    const wrapper = mount(ItemCard, { props: { item: item("agentMessage", { text: "无法复制" }) } });
    await wrapper.get('button[aria-label="复制回复"]').trigger("click");
    await vi.waitFor(() => expect(messageApi.error).toHaveBeenCalledWith("复制失败"));
    expect(messageApi.success).not.toHaveBeenCalled();
  });

  it("does not render an empty reasoning item", () => {
    const wrapper = mount(ItemCard, { props: { item: item("reasoning", { summary: [], content: [] }) } });
    expect(wrapper.find(".tool-card").exists()).toBe(false);
  });

  it("identifies unknown protocol item types instead of showing an ambiguous detail card", () => {
    const wrapper = mount(ItemCard, { props: { item: item("futureToolEvent", { message: "可见详情" }) } });
    expect(wrapper.text()).toContain("协议事件 · future Tool Event");
    expect(wrapper.text()).toContain("可见详情");
    expect(wrapper.text()).not.toContain("运行详情");
  });

  it("renders protocol notices as readable alerts", () => {
    const wrapper = mount(ItemCard, { props: { item: item("protocolNotice", { title: "模型已切换", message: "gpt-5 → safety", tone: "warning", details: "安全原因 Bearer very-secret-token" }) } });
    expect(wrapper.text()).toContain("模型已切换");
    expect(wrapper.text()).toContain("gpt-5 → safety");
    expect(wrapper.text()).toContain("安全原因");
    expect(wrapper.text()).not.toContain("very-secret-token");
    expect(wrapper.find(".protocol-notice").exists()).toBe(true);
  });

  it("renders status, MCP status, and skills as compact named fields", () => {
    const status = mount(ItemCard, { props: { item: item("status", { connection: "已连接", account: "API 模式", cwd: "E:\\Work" }) } });
    expect(status.text()).toContain("当前状态");
    expect(status.text()).toContain("已连接");
    expect(status.text()).toContain("E:\\Work");
    const mcp = mount(ItemCard, { props: { item: item("mcpStatus", { data: [{ name: "gateway", authStatus: "authenticated", tools: { search: {} }, resources: [] }] }) } });
    expect(mcp.text()).toContain("MCP 状态");
    expect(mcp.text()).toContain("gateway");
    expect(mcp.text()).toContain("authenticated");
    expect(mcp.text()).toContain("1 个工具");
    const skills = mount(ItemCard, { props: { item: item("skills", { data: [{ cwd: "E:\\Personal", skills: [{ name: "project-verify", description: "验证项目", enabled: true }] }] }) } });
    expect(skills.text()).toContain("可用技能");
    expect(skills.text()).toContain("project-verify");
    expect(skills.text()).toContain("验证项目");
    const noAuth = mount(ItemCard, { props: { item: item("mcpStatus", { data: [{ name: "local", authStatus: "unsupported", tools: {}, resources: [] }] }) } });
    expect(noAuth.text()).toContain("无需认证");
    expect(noAuth.text()).not.toContain("unsupported");
  });

  it("renders protocol settings updates inside the conversation", () => {
    const wrapper = mount(ItemCard, { props: { item: item("threadSettingsChanged", { changes: [
      { label: "权限模式", value: "自动审批" },
      { label: "协作模式", value: "计划模式" }
    ] }) } });
    expect(wrapper.text()).toContain("会话设置");
    expect(wrapper.get(".inline-detail-fields").text()).toContain("权限模式：自动审批");
    expect(wrapper.get(".inline-detail-fields").text()).toContain("协作模式：计划模式");
  });

  it("renders readable goal states without exposing protocol JSON", () => {
    const active = mount(ItemCard, { props: { item: item("goalStatus", { state: "active", objective: "完成协议适配" }) } });
    expect(active.text()).toContain("目标");
    expect(active.text()).toContain("生效");
    expect(active.text()).toContain("完成协议适配");
    expect(active.text()).not.toContain("objective");
    expect(mount(ItemCard, { props: { item: item("goalStatus", { state: "empty" }) } }).text()).toContain("暂无");
    expect(mount(ItemCard, { props: { item: item("goalStatus", { state: "paused", objective: "完成协议适配" }) } }).text()).toContain("已暂停");
    expect(mount(ItemCard, { props: { item: item("goalStatus", { state: "resumed", objective: "完成协议适配" }) } }).text()).toContain("继续");
  });

  it("renders context compaction as a title-only card", () => {
    const wrapper = mount(ItemCard, { props: { item: item("contextCompaction", { encryptedContent: "internal-compaction-details", tokenCount: 42_000 }) } });
    expect(wrapper.text()).toContain("上下文压缩");
    expect(wrapper.text()).toContain("已完成");
    expect(wrapper.text()).not.toContain("internal-compaction-details");
    expect(wrapper.find(".n-card__content").exists()).toBe(false);
  });

  it("shows command lifecycle and unwraps PowerShell display shells", () => {
    const command = mount(ItemCard, { props: { item: item("commandExecution", { id: "raw-id", command: "Get-ChildItem", cwd: "E:\\Work", exitCode: 0, aggregatedOutput: "ok", internalEnvelope: "must-not-render" }) } });
    expect(command.text()).toContain("已运行命令");
    expect(command.text()).toContain("Get-ChildItem");
    expect(command.text()).not.toContain("must-not-render");
    const running = mount(ItemCard, { props: { item: item("commandExecution", { command: "pwsh.exe -NoProfile -Command \"Get-ChildItem\"", status: "inProgress" }, "", "running"), unwrapPowerShell: true } });
    expect(running.text()).toContain("正在运行命令");
    expect(running.text()).toContain("Get-ChildItem");
    expect(running.text()).not.toContain("pwsh.exe");
    const configured = mount(ItemCard, { props: { item: item("commandExecution", { command: '"D:\\Tools\\pwsh.exe" -Command "Get-Location"', status: "completed" }), unwrapPowerShell: true, commandShellPath: "D:\\Tools\\pwsh.exe" } });
    expect(configured.text()).toContain("Get-Location");
    expect(configured.text()).not.toContain("D:\\Tools\\pwsh.exe");
    const singleQuotedExecutable = mount(ItemCard, { props: { item: item("commandExecution", { command: "'C:\\Program Files\\PowerShell\\7\\pwsh.exe' '-Command' \"Get-Date\"" }), unwrapPowerShell: true } });
    expect(singleQuotedExecutable.text()).toContain("Get-Date");
    expect(singleQuotedExecutable.text()).not.toContain("PowerShell\\7");
    const legacyPowerShell = mount(ItemCard, { props: { item: item("commandExecution", { command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "& \'script.ps1\'"' }), unwrapPowerShell: true } });
    expect(legacyPowerShell.text()).toContain("& 'script.ps1'");
    expect(legacyPowerShell.text()).not.toContain("powershell.exe");
    const escapedInnerQuotes = mount(ItemCard, { props: { item: item("commandExecution", { command: `pwsh.exe -Command '\\"Get-Location\\"'` }), unwrapPowerShell: true } });
    expect(escapedInnerQuotes.text()).toContain("Get-Location");
    expect(escapedInnerQuotes.text()).not.toContain('\\"Get-Location\\"');
    const direct = mount(ItemCard, { props: { item: item("commandExecution", { command: "Get-ChildItem -Force" }) } });
    expect(direct.text()).toContain("Get-ChildItem -Force");
    const wrapped = mount(ItemCard, { props: { item: item("commandExecution", { command: "pwsh.exe -Command \"Get-Date\"" }), unwrapPowerShell: false } });
    expect(wrapped.text()).toContain("pwsh.exe -Command");
    expect(command.get(".inline-detail-fields").text()).toContain("目录：E:\\Work");
    expect(command.get(".inline-detail-fields").text()).toContain("退出码：0");
  });

  it("shows automatic approval status, risk, rationale, and action", () => {
    const wrapper = mount(ItemCard, { props: { item: item("autoApprovalReview", {
      status: "denied",
      riskLevel: "high",
      userAuthorization: "unknown",
      rationale: "目标位置没有得到授权。",
      action: { type: "command", command: "Remove-Item E:\\Work\\data", cwd: "E:\\Work" }
    }, "", "declined") } });
    expect(wrapper.text()).toContain("自动审批");
    expect(wrapper.text()).toContain("已拒绝");
    expect(wrapper.text()).toContain("风险");
    expect(wrapper.text()).toContain("高");
    expect(wrapper.text()).toContain("授权判断");
    expect(wrapper.text()).toContain("审批理由");
    expect(wrapper.text()).toContain("目标位置没有得到授权。");
    expect(wrapper.text()).toContain("Remove-Item E:\\Work\\data");
  });

  it("renders protocol-shaped file changes with semantic diff classes", async () => {
    const wrapper = mount(ItemCard, { props: { item: item("fileChange", { changes: [
      { path: "src/new.ts", kind: { type: "add" }, diff: "@@ -0,0 +1 @@\n+new" },
      { path: "src/edit.ts", kind: { type: "update", move_path: null }, diff: "--- a/src/edit.ts\n+++ b/src/edit.ts\n@@ -10,3 +10,4 @@ function run()\n keep\n-old\n+new\n+extra\n tail\n@@ -20 +21 @@\n-old2\n+new2" },
      { path: "src/old.ts", kind: { type: "delete" }, diff: "@@ -1 +0,0 @@\n-old" },
      { path: "src/from.ts", kind: { type: "update", move_path: "src/to.ts" }, diff: " move" }
    ], internalEnvelope: "hidden" }) } });
    expect(wrapper.text()).toContain("新增");
    expect(wrapper.text()).toContain("修改");
    expect(wrapper.text()).toContain("删除");
    expect(wrapper.text()).toContain("移动");
    expect(wrapper.text()).toContain("src/from.ts → src/to.ts");
    expect(wrapper.findAll(".diff-add")).toHaveLength(1);
    expect(wrapper.findAll(".diff-update")).toHaveLength(1);
    expect(wrapper.findAll(".diff-delete")).toHaveLength(1);
    expect(wrapper.findAll(".diff-move")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("[object Object]");
    expect(wrapper.text()).not.toContain("internalEnvelope");
    expect(wrapper.text()).toContain("新增 3 行，删除 2 行");
    await nextTick();
    expect(wrapper.text()).not.toContain("@@ -10,3 +10,4 @@");
    expect(wrapper.text()).not.toContain("--- a/src/edit.ts");
    expect(wrapper.text()).not.toContain("变更内容");
    const editedFile = wrapper.get(".diff-update");
    expect(editedFile.findAll(".diff-line-add")).toHaveLength(3);
    expect(editedFile.findAll(".diff-line-delete")).toHaveLength(2);
    expect(editedFile.findAll(".diff-line-context")).toHaveLength(2);
    expect(editedFile.find(".diff-line-delete .diff-line-number").text()).toBe("11");
    expect(editedFile.find(".diff-line-add .diff-line-number").text()).toBe("11");
    expect(editedFile.findAll(".diff-line-number")).toHaveLength(7);
    expect(editedFile.findAll(".diff-hunk-separator")).toHaveLength(1);
    expect(editedFile.findAll(".diff-old-line")).toHaveLength(0);
  });

  it("renders only MCP result content and pretty prints JSON text", async () => {
    const wrapper = mount(ItemCard, { props: { item: item("mcpToolCall", { server: "gateway", tool: "search", status: "completed", arguments: { query: "hello", apiKey: "sk-abcdefghijklmnop" }, result: { content: [{ type: "text", text: '{"ok":true,"nested":{"value":1}}' }], structuredContent: { hidden: "must-not-render" }, _meta: { trace: "must-not-render" } }, unrelatedEnvelope: "do-not-dump" }) } });
    expect(wrapper.text()).toContain("gateway");
    expect(wrapper.text()).toContain("search");
    await expandFirst(wrapper);
    expect(wrapper.text()).toContain("参数");
    expect(wrapper.text()).toContain("内容");
    expect(wrapper.findAll("pre").some((node) => node.text().includes('{\n  "ok": true'))).toBe(true);
    expect(wrapper.text()).not.toContain('{"ok":true');
    expect(wrapper.text()).toContain("[已隐藏]");
    expect(wrapper.text()).not.toContain("abcdefghijklmnop");
    expect(wrapper.text()).not.toContain("must-not-render");
    expect(wrapper.text()).not.toContain("structuredContent");
    expect(wrapper.text()).not.toContain("trace");
    expect(wrapper.text()).not.toContain("unrelatedEnvelope");
  });

  it("shows MCP Gateway downstream targets only when the adapter is enabled", () => {
    const gatewayCall = item("mcpToolCall", { server: "gateway", tool: "gateway_call_tool", durationMs: 120, arguments: { serviceId: "database", toolName: "list_databases", arguments: {} } });
    const disabled = mount(ItemCard, { props: { item: gatewayCall } });
    expect(disabled.text()).not.toContain("gateway → database");
    const enabled = mount(ItemCard, { props: { item: gatewayCall, mcpGatewayAdaptation: true } });
    expect(enabled.text()).toContain("gateway → database");
    expect(enabled.text()).toContain("gateway_call_tool → list_databases");
    const aliased = mount(ItemCard, { props: { item: item("mcpToolCall", { server: "company-gateway", tool: "call_tool", arguments: { service_id: "docs", tool_name: "search" } }), mcpGatewayAdaptation: true } });
    expect(aliased.text()).toContain("company-gateway → docs");
    expect(aliased.text()).toContain("call_tool → search");
    expect(enabled.text()).toContain("0.1 秒");
  });

  it("renders web, collaboration, review, and plan summaries", async () => {
    const web = mount(ItemCard, { props: { item: item("webSearch", { query: "Codex", results: [{ title: "文档", snippet: "摘要", url: "https://example.com/docs" }] }) } });
    expect(web.text()).toContain("Codex");
    expect(web.text()).toContain("https://example.com/docs");
    await expandFirst(web);
    expect(web.text()).toContain("文档");
    const collab = mount(ItemCard, { props: { item: item("collabAgentToolCall", { tool: "spawn", agentPath: "/root/test", prompt: "检查测试", result: [{ agentPath: "/root/test", status: "完成" }] }) } });
    expect(collab.text()).toContain("/root/test");
    expect(collab.text()).toContain("检查测试");
    await expandFirst(collab);
    expect(collab.text()).toContain("完成");
    const review = mount(ItemCard, { props: { item: item("exitedReviewMode", { review: "发现 1 个问题" }) } });
    expect(review.text()).toContain("审查完成");
    expect(review.text()).toContain("发现 1 个问题");
    const plan = mount(ItemCard, { props: { item: item("plan", { text: "1. 分析\n2. 验证" }) } });
    expect(plan.text()).toContain("分析");
    expect(plan.text()).toContain("验证");
  });

  it("renders concise context status and switches permission profiles", async () => {
    const status = mount(ItemCard, { props: { item: item("status", { contextTokens: "56,000/100,000" }) } });
    expect(status.text()).toContain("上下文");
    expect(status.text()).not.toContain("上下文 Token");
    const permissions = mount(ItemCard, { props: { item: item("permissions", { currentProfile: ":workspace", currentApprovalPolicy: "on-request", currentApprovalsReviewer: "user", modes: [
      { id: "ask", label: "请求审批", description: "需要确认", profileId: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user" },
      { id: "full", label: "完全访问", description: "不再询问", profileId: ":full", approvalPolicy: "never", approvalsReviewer: "user" }
    ] }) } });
    expect(permissions.text()).toContain("权限模式");
    expect(permissions.text()).toContain("当前");
    await permissions.findAll("button").find((button) => button.text() === "切换")!.trigger("click");
    expect(permissions.emitted("action")?.at(-1)).toEqual([{ type: "switchPermissionMode", profileId: ":full", approvalPolicy: "never", approvalsReviewer: "user" }]);
    await permissions.get('button[aria-label="关闭权限选择"]').trigger("click");
    expect(permissions.emitted("action")?.at(-1)).toEqual([{ type: "dismissItem", itemId: "item-1" }]);
  });

  it("shows open-page URLs even when a web item has no result list", () => {
    const wrapper = mount(ItemCard, { props: { item: item("webSearch", { action: { type: "openPage", url: "https://example.com/page" } }) } });
    expect(wrapper.text()).toContain("https://example.com/page");
  });

  it("emits local agent and background-process actions", async () => {
    const agents = mount(ItemCard, { props: { item: item("agents", { data: [{ threadId: "thread-2", title: "研究", status: "running" }] }) } });
    await agents.get("button").trigger("click");
    expect(agents.emitted("action")).toEqual([[{ type: "switchAgent", threadId: "thread-2" }]]);

    const processes = mount(ItemCard, { props: { item: item("backgroundProcesses", { processes: [
      { processId: "proc-1", command: "npm test", status: "running" },
      { processId: "proc-2", command: "npm run build", status: "running" }
    ] }) } });
    const buttons = processes.findAll("button");
    await buttons.find((button) => button.text() === "停止")!.trigger("click");
    await buttons.find((button) => button.text() === "全部停止")!.trigger("click");
    expect(processes.emitted("action")).toEqual([
      [{ type: "stopBackgroundProcess", processId: "proc-1" }],
      [{ type: "stopAllBackgroundProcesses" }]
    ]);
  });

  it("shows user attachment paths and renders generated or imported images", async () => {
    const user = mount(ItemCard, { props: { item: item("userMessage", { content: [{ type: "localImage", path: "C:\\image.png" }, { type: "image", url: "https://example.com/image.png" }, { type: "mention", name: "README.md", path: "E:\\Work\\README.md" }] }) } });
    expect(user.text()).toContain("C:\\image.png");
    expect(user.text()).toContain("https://example.com/image.png");
    expect(user.text()).toContain("E:\\Work\\README.md");
    expect(user.text()).not.toContain("[本地图片]");
    expect(user.text()).not.toContain("[文件]");
    const generated = mount(ItemCard, { props: { item: item("imageGeneration", { result: "cG5n" }) } });
    expect(generated.get("img").attributes("src")).toBe("data:image/png;base64,cG5n");
    const importImagePath = vi.fn().mockResolvedValue({ url: "codex-media://media/test" });
    Object.defineProperty(window, "codexPane", { configurable: true, value: { importImagePath } });
    const viewed = mount(ItemCard, { props: { item: item("imageView", { path: "C:\\safe.png" }) } });
    await nextTick();
    await nextTick();
    expect(importImagePath).toHaveBeenCalledWith("C:\\safe.png");
    expect(viewed.get("img").attributes("src")).toBe("codex-media://media/test");
    expect(viewed.text()).toContain("已完成");
    expect(viewed.text()).toContain("C:\\safe.png");
  });
});
