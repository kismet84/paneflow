import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.149.1\n");
  process.exit(0);
}

const TURN_COUNT = 124;
const ITEMS_PER_TURN = 64;
const PAGE_SIZE = 12;
const input = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const activeIntervals = new Set();

const makeItem = (turnIndex, itemIndex) => {
  const id = `item-${turnIndex}-${itemIndex}`;
  const typeIndex = itemIndex % 6;
  if (typeIndex === 0) return { id, type: "userMessage", content: [{ type: "text", text: `第 ${turnIndex + 1} 轮用户消息 ${itemIndex}`, text_elements: [] }] };
  if (typeIndex === 1) return { id, type: "agentMessage", text: `## 第 ${turnIndex + 1} 轮回复\n\n历史消息 ${itemIndex}，用于验证长对话 Markdown 渲染。\n\n\`\`\`ts\nconst value = ${itemIndex};\n\`\`\`` };
  if (typeIndex === 2) return { id, type: "reasoning", summary: [{ text: `思考摘要 ${turnIndex}-${itemIndex}` }], content: [] };
  if (typeIndex === 3) return { id, type: "commandExecution", command: "Get-ChildItem -Force", cwd: "E:\\AI-Workspace", exitCode: 0, aggregatedOutput: `命令输出 ${turnIndex}-${itemIndex}\n${"x".repeat(itemIndex % 31 === 0 ? 12_000 : 240)}` };
  if (typeIndex === 4) return { id, type: "fileChange", changes: [{ path: `src/file-${turnIndex}.ts`, kind: "update", diff: `@@ -1,2 +1,2 @@\n-old ${itemIndex}\n+new ${itemIndex}\n context` }] };
  return { id, type: "mcpToolCall", server: "gateway", tool: "gateway_call_tool", status: "completed", arguments: { service: "database", tool: "list_databases", marker: `${turnIndex}-${itemIndex}` }, content: [{ type: "text", text: "ok" }] };
};

const makeTurn = (turnIndex) => ({
  id: `turn-${turnIndex}`,
  status: "completed",
  itemsView: "full",
  items: Array.from({ length: ITEMS_PER_TURN }, (_, itemIndex) => makeItem(turnIndex, itemIndex))
});

const makePage = (offset) => {
  const data = [];
  for (let index = TURN_COUNT - 1 - offset; index >= 0 && data.length < PAGE_SIZE; index -= 1) data.push(makeTurn(index));
  const nextOffset = offset + data.length;
  return { data, nextCursor: nextOffset < TURN_COUNT ? `offset:${nextOffset}` : null, backwardsCursor: data.length ? `offset:${offset}` : null };
};

const startStreamingTurn = (message) => {
  const threadId = message.params.threadId;
  const turnId = `live-${threadId}`;
  const itemId = `live-item-${threadId}`;
  write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
  write({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
  write({ method: "item/started", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text: "", status: "inProgress" } } });
  let index = 0;
  const interval = setInterval(() => {
    if (index < 120) {
      write({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta: `片段${index} ` } });
      index += 1;
      return;
    }
    clearInterval(interval);
    activeIntervals.delete(interval);
    const text = Array.from({ length: 120 }, (_, part) => `片段${part} `).join("");
    write({ method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text, status: "completed" } } });
    write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  }, 16);
  activeIntervals.add(interval);
};

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  if (message.method === "initialize") return write({ id: message.id, result: { userAgent: "codex-pane-performance/0.149.1", codexHome: "fixture", platformFamily: "windows", platformOs: "windows" } });
  if (message.method === "model/list") return write({ id: message.id, result: { data: [{ id: "fixture-model", displayName: "Fixture", supportedReasoningEfforts: [], inputModalities: ["text"], isDefault: true }], nextCursor: null } });
  if (message.method === "account/read") return write({ id: message.id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
  if (message.method === "account/rateLimits/read") return write({ id: message.id, result: {} });
  if (message.method === "config/read") return write({ id: message.id, result: { config: { model: "fixture-model", model_provider: "fixture", sandbox_mode: "workspace-write", approval_policy: "never" }, origins: {}, layers: null } });
  if (message.method === "permissionProfile/list") return write({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "thread/resume") {
    const threadId = message.params.threadId;
    return write({ id: message.id, result: { thread: { id: threadId, name: "最长会话性能夹具", status: { type: "idle" }, turns: [] }, model: "fixture-model", cwd: "E:\\AI-Workspace", initialTurnsPage: makePage(0), turnsBackwardsCursor: "offset:0", itemsBackwardsCursor: null } });
  }
  if (message.method === "thread/turns/list") {
    const offset = Number(String(message.params.cursor ?? "offset:0").split(":")[1] ?? 0);
    return write({ id: message.id, result: makePage(offset) });
  }
  if (message.method === "turn/start") return startStreamingTurn(message);
  write({ id: message.id, result: {} });
});

input.on("close", () => {
  for (const interval of activeIntervals) clearInterval(interval);
});
