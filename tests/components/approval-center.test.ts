// @vitest-environment jsdom

import { mount } from "@vue/test-utils";
import { NInputNumber } from "naive-ui";
import { describe, expect, it, vi } from "vitest";
import ApprovalCenter from "../../src/components/ApprovalCenter.vue";
import type { PendingServerRequest } from "../../src/types";

const request = (id: string | number, method: string, paneId: string, params: Record<string, unknown>): PendingServerRequest => ({
  generation: 2,
  id,
  method,
  paneId,
  params,
  createdAt: 1
});

const drawerStubs = {
  teleport: true,
  Code: { props: ["code"], template: "<code>{{ code }}</code>" },
  NDrawer: { template: "<div><slot /></div>" },
  NDrawerContent: { props: ["title"], template: "<section><h2>{{ title }}</h2><slot /></section>" },
  NSpin: { template: "<div><slot /></div>" }
};

const mountCenter = (requests: PendingServerRequest[], paneId: string | null = null) => mount(ApprovalCenter, {
  props: { requests, paneId, show: true, resolving: false },
  global: { stubs: drawerStubs }
});

const clickButton = async (wrapper: ReturnType<typeof mountCenter>, label: string): Promise<void> => {
  const button = wrapper.findAll("button").find((candidate) => candidate.text().includes(label));
  expect(button, `button ${label}`).toBeDefined();
  await button!.trigger("click");
};

describe("ApprovalCenter request lifecycle UI", () => {
  it("filters to the selected pane and emits command approval or rejection", async () => {
    const first = request(1, "item/commandExecution/requestApproval", "pane-1", { command: "Get-ChildItem", availableDecisions: ["accept"] });
    const second = request(2, "item/commandExecution/requestApproval", "pane-2", { command: "Remove-Item sample.tmp", availableDecisions: ["accept", "decline"] });
    const wrapper = mountCenter([first, second], "pane-2");
    expect(wrapper.text()).toContain("Remove-Item sample.tmp");
    expect(wrapper.text()).not.toContain("Get-ChildItem");
    expect(wrapper.text()).toContain("1 项待处理");
    await clickButton(wrapper, "允许一次");
    await clickButton(wrapper, "拒绝");
    expect(wrapper.emitted("resolve")).toEqual([
      [second, { decision: "accept" }],
      [second, { decision: "decline" }]
    ]);
  });

  it("summarizes elevated command permissions without exposing secrets", () => {
    const command = request(9, "item/commandExecution/requestApproval", "pane-1", {
      command: "Invoke-WebRequest https://example.com",
      networkApprovalContext: { protocol: "https", host: "example.com" },
      additionalPermissions: { network: { enabled: true }, fileSystem: { read: ["E:\\Work"], write: ["E:\\Output"], entries: [] } },
      commandActions: [{ type: "read", path: "E:\\Work\\config.json", command: "Get-Content", name: "config.json" }],
      proposedExecpolicyAmendment: ["Invoke-WebRequest"],
      apiKey: "sk-this-must-never-render"
    });
    const wrapper = mountCenter([command]);
    expect(wrapper.text()).toContain("https://example.com");
    expect(wrapper.text()).toContain("读取文件：E:\\Work\\config.json");
    expect(wrapper.text()).toContain("附加写入：E:\\Output");
    expect(wrapper.text()).not.toContain("sk-this-must-never-render");
  });

  it("renders legacy argv commands and explains persistent policy decisions", () => {
    const legacy = request(10, "execCommandApproval", "pane-1", {
      command: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", "Get-ChildItem -Force", "Bearer very-secret-token", "sk-this-must-never-render"],
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["Get-ChildItem"] } },
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "example.com", action: "allow" } } }
      ]
    });
    const wrapper = mountCenter([legacy]);
    expect(wrapper.text()).toContain("'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -Command 'Get-ChildItem -Force'");
    expect(wrapper.text()).toContain("允许并记住命令规则");
    expect(wrapper.text()).toContain("允许并应用网络规则");
    expect(wrapper.get(".approval-actions").text()).toContain("允许并记住命令规则");
    expect(wrapper.text()).toContain("Bearer [已隐藏]");
    expect(wrapper.text()).toContain("sk-[已隐藏]");
    expect(wrapper.text()).not.toContain("very-secret-token");
    expect(wrapper.text()).not.toContain("sk-this-must-never-render");
  });

  it("validates and submits a user-input answer", async () => {
    const userInput = request("question-1", "item/tool/requestUserInput", "pane-1", {
      questions: [{ id: "purpose", header: "用途", question: "请输入用途", isSecret: false }]
    });
    const wrapper = mountCenter([userInput]);
    document.body.appendChild(wrapper.element);
    await clickButton(wrapper, "提交回答");
    expect(wrapper.text()).toContain("请回答用途");
    await wrapper.get("textarea").setValue("用于验收");
    const textarea = wrapper.get("textarea").element;
    textarea.focus();
    await wrapper.get("textarea").trigger("keydown", { key: "ArrowLeft" });
    expect(document.activeElement).toBe(textarea);
    await clickButton(wrapper, "提交回答");
    expect(wrapper.emitted("resolve")?.at(-1)).toEqual([userInput, { answers: { purpose: { answers: ["用于验收"] } } }]);
  });

  it("submits a user-input choice immediately without a redundant button", async () => {
    const userInput = request("question-choice", "item/tool/requestUserInput", "pane-1", {
      questions: [{ id: "mode", header: "模式", question: "请选择模式", options: [{ label: "安全", description: "只读执行" }, { label: "完整", description: "允许修改" }] }]
    });
    const wrapper = mountCenter([userInput]);
    expect(wrapper.text()).not.toContain("提交回答");
    await clickButton(wrapper, "安全");
    expect(wrapper.emitted("resolve")).toEqual([[userInput, { answers: { mode: { answers: ["安全"] } } }]]);
  });

  it("submits multiple choices when the final question is answered", async () => {
    const userInput = request("question-choices", "item/tool/requestUserInput", "pane-1", {
      questions: [
        { id: "mode", question: "请选择模式", options: [{ label: "安全" }, { label: "完整" }] },
        { id: "target", question: "请选择目标", options: [{ label: "当前" }, { label: "全部" }] }
      ]
    });
    const wrapper = mountCenter([userInput]);
    await clickButton(wrapper, "安全");
    expect(wrapper.emitted("resolve")).toBeUndefined();
    await clickButton(wrapper, "当前");
    expect(wrapper.emitted("resolve")).toEqual([[userInput, { answers: { mode: { answers: ["安全"] }, target: { answers: ["当前"] } } }]]);
  });

  it("submits MCP form data and supports decline and cancel", async () => {
    const elicitation = request(3, "mcpServer/elicitation/request", "pane-1", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { project: { type: "string", title: "项目" } },
        required: ["project"]
      },
      _meta: { source: "test" }
    });
    const wrapper = mountCenter([elicitation]);
    await clickButton(wrapper, "提交");
    expect(wrapper.text()).toContain("请填写项目");
    await wrapper.get("input").setValue("codex-pane");
    await clickButton(wrapper, "提交");
    await clickButton(wrapper, "拒绝");
    await clickButton(wrapper, "取消");
    expect(wrapper.emitted("resolve")).toEqual([
      [elicitation, { action: "accept", content: { project: "codex-pane" }, _meta: { source: "test" } }],
      [elicitation, { action: "decline", content: null, _meta: null }],
      [elicitation, { action: "cancel", content: null, _meta: null }]
    ]);
  });

  it("submits a single MCP enum option immediately", async () => {
    const elicitation = request(33, "mcpServer/elicitation/request", "pane-1", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { environment: { type: "string", title: "环境", enum: ["测试", "生产"] } },
        required: ["environment"]
      }
    });
    const wrapper = mountCenter([elicitation]);
    expect(wrapper.text()).not.toContain("提交");
    expect(wrapper.text()).toContain("拒绝");
    await clickButton(wrapper, "测试");
    expect(wrapper.emitted("resolve")).toEqual([[elicitation, { action: "accept", content: { environment: "测试" }, _meta: null }]]);
  });

  it("validates MCP form constraints before sending content", async () => {
    const elicitation = request(34, "mcpServer/elicitation/request", "pane-1", {
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { port: { type: "integer", title: "端口", minimum: 1, maximum: 65535 } },
        required: ["port"]
      }
    });
    const wrapper = mountCenter([elicitation]);
    wrapper.getComponent(NInputNumber).vm.$emit("update:value", 70000);
    await clickButton(wrapper, "提交");
    expect(wrapper.text()).toContain("端口不能大于 65535");
    expect(wrapper.emitted("resolve")).toBeUndefined();
  });

  it("opens an MCP URL only through the preload contract", async () => {
    const openExternal = vi.fn(async () => undefined);
    window.codexPane = { openExternal } as unknown as Window["codexPane"];
    const elicitation = request(4, "mcpServer/elicitation/request", "pane-1", { mode: "url", url: "https://example.com/consent" });
    const wrapper = mountCenter([elicitation]);
    expect(wrapper.text()).toContain("example.com");
    await clickButton(wrapper, "在浏览器中打开");
    expect(openExternal).toHaveBeenCalledWith("https://example.com/consent");
  });
});
