import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.149.1\n");
  process.exit(0);
}

const input = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let approvalSent = false;

const sendApproval = (threadId = "fixture-thread") => {
  approvalSent = true;
  write({
    id: "approval-fixture-1",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId,
      turnId: "fixture-turn",
      itemId: "fixture-item",
      startedAtMs: Date.now(),
      environmentId: null,
      reason: "验证完整审批链路",
      command: "Get-ChildItem",
      cwd: "E:\\AI-Workspace",
      availableDecisions: ["accept", "decline"]
    }
  });
};

const sendMcpApproval = (threadId = "fixture-thread") => {
  write({
    id: "mcp-approval-fixture-1",
    method: "mcpServer/elicitation/request",
    params: {
      threadId,
      turnId: "fixture-turn",
      serverName: "fixture-mcp",
      mode: "form",
      message: "选择部署环境",
      requestedSchema: { type: "object", properties: { environment: { type: "string", title: "部署环境", enum: ["测试", "生产"] } }, required: ["environment"] },
      _meta: { source: "fixture" }
    }
  });
};

const resultFor = (method, params = {}) => {
  if (method === "initialize") return {
    userAgent: "codex-pane-fixture/0.149.1",
    codexHome: "fixture",
    platformFamily: "windows",
    platformOs: "windows",
    ...(process.env.CODEX_PANE_REPORT_FIXTURE_CWD === "1" ? { fixtureCwd: process.cwd() } : {})
  };
  if (method === "model/list") return { data: [], nextCursor: null };
  if (method === "account/read") return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
  if (method === "account/rateLimits/read") return {};
  if (method === "config/read") return { config: { model: "fixture-model", model_provider: "fixture", sandbox_mode: "workspace-write", approval_policy: "on-request" }, origins: {}, layers: null };
  if (method === "permissionProfile/list") return { data: [], nextCursor: null };
  if (method === "thread/list") return {
    data: [
      { id: "fixture-thread-a", name: "示例会话 A", preview: "查看第一个会话", cwd: "E:\\AI-Workspace", updatedAt: 2, status: { type: "idle" } },
      { id: "fixture-thread-b", name: "示例会话 B", preview: "查看第二个会话", cwd: "E:\\AI-Workspace", updatedAt: 1, status: { type: "idle" } }
    ],
    nextCursor: null
  };
  if (method === "thread/start") return {
    thread: { id: "fixture-thread-new", name: "手机新会话", cwd: "E:\\AI-Workspace", turns: [] }
  };
  if (method === "thread/resume") return {
    thread: { id: params.threadId, name: params.threadId === "fixture-thread-b" ? "示例会话 B" : "示例会话 A", turns: [] },
    initialTurnsPage: { data: [], nextCursor: null },
    cwd: "E:\\AI-Workspace",
    model: "fixture-model",
    reasoningEffort: "medium"
  };
  if (method === "thread/turns/list") return {
    data: params.itemsView === "full" ? [{ id: "fixture-history-turn", status: "completed", items: [{ id: "fixture-history-item", type: "agentMessage", text: "已通过兼容分页加载历史" }] }] : [{ id: "fixture-history-turn", status: "completed", items: [] }],
    nextCursor: null
  };
  return {};
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.CODEX_PANE_REQUEST_LOG && message.id !== undefined && message.method) {
    appendFileSync(process.env.CODEX_PANE_REQUEST_LOG, `${JSON.stringify({ method: message.method, params: message.params })}\n`, "utf8");
  }
  if (message.method === "initialized" && !approvalSent && existsSync(resolve(".approval-fixture"))) {
    approvalSent = true;
    setTimeout(() => sendApproval(), 500);
    return;
  }
  if (message.id === "approval-fixture-1" && message.method === undefined) {
    appendFileSync(process.env.CODEX_PANE_APPROVAL_RESPONSE_LOG || resolve("test-results", "approval-response.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    write({ method: "serverRequest/resolved", params: { requestId: "approval-fixture-1" } });
    if (process.env.CODEX_PANE_MCP_APPROVAL_AFTER_COMMAND === "1") setTimeout(() => sendMcpApproval("fixture-thread-a"), 50);
    return;
  }
  if (message.id === "mcp-approval-fixture-1" && message.method === undefined) {
    appendFileSync(process.env.CODEX_PANE_APPROVAL_RESPONSE_LOG || resolve("test-results", "approval-response.jsonl"), `${JSON.stringify(message)}\n`, "utf8");
    write({ method: "serverRequest/resolved", params: { requestId: "mcp-approval-fixture-1" } });
    return;
  }
  if (message.id !== undefined && message.method) {
    if (message.method === "thread/items/list") {
      write({ id: message.id, error: { code: -32601, message: "thread/items/list is not supported yet" } });
      return;
    }
    write({ id: message.id, result: resultFor(message.method, message.params) });
    if (message.method === "thread/resume" && message.params?.threadId === "fixture-thread-b" && process.env.CODEX_PANE_DESKTOP_TURN_ON_THREAD_B === "1") {
      setTimeout(() => write({ method: "turn/started", params: { threadId: "fixture-thread-b", turn: { id: "fixture-desktop-turn", status: "inProgress" } } }), 50);
    }
    if (message.method === "turn/start" && process.env.CODEX_PANE_APPROVAL_ON_TURN_START === "1" && !approvalSent) {
      setTimeout(() => sendApproval(message.params?.threadId || "fixture-thread"), 50);
    }
  }
});
