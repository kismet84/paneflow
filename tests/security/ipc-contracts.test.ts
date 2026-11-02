import { describe, expect, it } from "vitest";
import { remoteSettingsSchema, safeRequestSchema, serverResponseSchema } from "../../electron/shared/contracts";

describe("renderer IPC contracts", () => {
  it("strips renderer-provided sandbox and approval policy fields", () => {
    const request = safeRequestSchema.parse({
      method: "thread/start",
      params: { cwd: null, model: null, ephemeral: false, sandbox: "danger-full-access", approvalPolicy: "never" }
    });
    expect(request.params).toEqual({ cwd: null, model: null, ephemeral: false });
  });

  it("rejects methods outside the UI allowlist and ambiguous responses", () => {
    expect(() => safeRequestSchema.parse({ method: "config/write", params: {} })).toThrow();
    expect(() => serverResponseSchema.parse({ generation: 1, id: 1, result: {}, error: { code: -1, message: "x" } })).toThrow();
    expect(() => serverResponseSchema.parse({ generation: 1, id: 1 })).toThrow();
  });

  it("requires HTTPS for remote relays except explicit loopback development", () => {
    expect(remoteSettingsSchema.parse({ enabled: true, relayUrl: "https://pane.example.com" }).relayUrl).toBe("https://pane.example.com");
    expect(remoteSettingsSchema.parse({ enabled: true, relayUrl: "https://pane.example.com/codex-pane-relay/" }).relayUrl).toBe("https://pane.example.com/codex-pane-relay");
    expect(remoteSettingsSchema.parse({ enabled: true, relayUrl: "http://127.0.0.1:3000" }).relayUrl).toBe("http://127.0.0.1:3000");
    expect(() => remoteSettingsSchema.parse({ enabled: true, relayUrl: "http://pane.example.com" })).toThrow("HTTPS");
    expect(() => remoteSettingsSchema.parse({ enabled: true, relayUrl: "https://user:secret@pane.example.com" })).toThrow("不含账号或参数");
    expect(() => remoteSettingsSchema.parse({ enabled: true, relayUrl: "https://pane.example.com/relay?token=secret" })).toThrow("不含账号或参数");
  });

  it("allows only the supported thread cwd update and optimistic message identity", () => {
    expect(safeRequestSchema.parse({ method: "thread/settings/update", params: { threadId: "thread-1", cwd: "E:\\Work" } })).toEqual({ method: "thread/settings/update", params: { threadId: "thread-1", cwd: "E:\\Work" } });
    const request = safeRequestSchema.parse({ method: "turn/steer", params: { threadId: "thread-1", expectedTurnId: "turn-1", clientUserMessageId: "client-1", input: [{ type: "text", text: "hello", text_elements: [] }] } });
    expect(request.params).toMatchObject({ clientUserMessageId: "client-1" });
    expect(safeRequestSchema.parse({ method: "thread/settings/update", params: { threadId: "thread-1", permissions: ":workspace" } })).toMatchObject({ params: { permissions: ":workspace" } });
    expect(safeRequestSchema.parse({ method: "thread/settings/update", params: { threadId: "thread-1", permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } })).toMatchObject({ params: { approvalsReviewer: "auto_review" } });
    expect(safeRequestSchema.parse({ method: "thread/settings/update", params: { threadId: "thread-1", serviceTier: "priority", collaborationMode: { mode: "plan", settings: { model: "gpt-5", reasoning_effort: "high", developer_instructions: null } } } })).toMatchObject({ params: { serviceTier: "priority", collaborationMode: { mode: "plan" } } });
    expect(() => safeRequestSchema.parse({ method: "thread/settings/update", params: { threadId: "thread-1", approvalsReviewer: "renderer" } })).toThrow();
    expect(safeRequestSchema.parse({ method: "thread/name/set", params: { threadId: "thread-1", name: "新名称" } })).toMatchObject({ method: "thread/name/set" });
    expect(safeRequestSchema.parse({ method: "thread/goal/set", params: { threadId: "thread-1", objective: "完成适配", status: "active" } })).toMatchObject({ method: "thread/goal/set" });
    expect(safeRequestSchema.parse({ method: "fuzzyFileSearch", params: { query: "readme", roots: ["E:\\Work"], cancellationToken: null } })).toMatchObject({ method: "fuzzyFileSearch" });
    expect(safeRequestSchema.parse({ method: "turn/start", params: { threadId: "thread-1", clientUserMessageId: null, model: null, effort: null, input: [{ type: "skill", name: "project-verify", path: "E:\\Skills\\project-verify\\SKILL.md" }, { type: "mention", name: "README.md", path: "E:\\Work\\README.md" }, { type: "managedFile", id: "11111111-1111-4111-8111-111111111111", name: "notes.txt" }] } })).toMatchObject({ method: "turn/start" });
  });

  it("allows scoped MCP auth, usage, agent discovery, and background-terminal controls", () => {
    expect(safeRequestSchema.parse({ method: "account/usage/read", params: { threadId: "thread-1" } })).toMatchObject({ method: "account/usage/read" });
    expect(safeRequestSchema.parse({ method: "mcpServer/oauth/login", params: { name: "docs", threadId: "thread-1", clientRegistration: "auto" } })).toMatchObject({ method: "mcpServer/oauth/login" });
    expect(safeRequestSchema.parse({ method: "thread/backgroundTerminals/list", params: { threadId: "thread-1", cursor: null, limit: 100 } })).toMatchObject({ method: "thread/backgroundTerminals/list" });
    expect(safeRequestSchema.parse({ method: "thread/backgroundTerminals/terminate", params: { threadId: "thread-1", processId: "42" } })).toMatchObject({ method: "thread/backgroundTerminals/terminate" });
    expect(safeRequestSchema.parse({ method: "thread/backgroundTerminals/clean", params: { threadId: "thread-1" } })).toMatchObject({ method: "thread/backgroundTerminals/clean" });
    expect(safeRequestSchema.parse({ method: "thread/list", params: { limit: 100, sortKey: "updated_at", sortDirection: "desc", searchTerm: null, cwd: "E:\\AI-Workspace", ancestorThreadId: "thread-1", sourceKinds: ["subAgent", "subAgentReview"] } })).toMatchObject({ method: "thread/list" });
    expect(() => safeRequestSchema.parse({ method: "thread/list", params: { limit: 100, sortKey: "updated_at", sortDirection: "desc", searchTerm: null, ancestorThreadId: "thread-1", sourceKinds: ["cli"] } })).toThrow();
  });
});
