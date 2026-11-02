import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeProtocolValidator } from "../../packages/protocol/src/runtime-validator";

const validator = new RuntimeProtocolValidator(resolve("packages/protocol/schema/generated"));

describe("runtime protocol schema", () => {
  it("accepts known server requests and notifications", () => {
    expect(validator.validateServerRequest({ method: "currentTime/read", id: 1, params: { threadId: "thread-1" } }).valid).toBe(true);
    expect(validator.validateServerNotification({ method: "warning", params: { threadId: null, message: "test" } }).valid).toBe(true);
  });

  it("rejects malformed known messages", () => {
    expect(validator.validateServerRequest({ method: "currentTime/read", id: 1, params: {} }).valid).toBe(false);
    expect(validator.validateServerNotification({ method: "warning", params: { message: 42 } }).valid).toBe(false);
  });

  it("validates method-specific server response payloads", () => {
    expect(validator.validateServerResponse("item/commandExecution/requestApproval", { decision: "accept" }).valid).toBe(true);
    expect(validator.validateServerResponse("item/commandExecution/requestApproval", { decision: "invented" }).valid).toBe(false);
    expect(validator.validateServerResponse("currentTime/read", { currentTimeAt: 1_700_000_000 }).valid).toBe(true);
    expect(validator.validateServerResponse("currentTime/read", {}).valid).toBe(false);
    expect(validator.validateServerResponse("item/fileChange/requestApproval", { decision: "acceptForSession" }).valid).toBe(true);
    expect(validator.validateServerResponse("item/tool/requestUserInput", { answers: { question: { answers: ["yes"] } } }).valid).toBe(true);
    expect(validator.validateServerResponse("mcpServer/elicitation/request", { action: "accept", content: null, _meta: null }).valid).toBe(true);
    expect(validator.validateServerResponse("item/permissions/requestApproval", { permissions: {}, scope: "turn" }).valid).toBe(true);
    expect(validator.validateServerResponse("execCommandApproval", { decision: "approved" }).valid).toBe(true);
  });

  it("validates outgoing client requests and notifications", () => {
    expect(validator.validateClientRequest({ id: 1, method: "account/read", params: { refreshToken: false } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 2, method: "account/rateLimits/read" }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 3, method: "account/rateLimits/read", params: {} }).valid).toBe(false);
    expect(validator.validateClientRequest({ id: 4, method: "config/read", params: { includeLayers: false, cwd: null } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 5, method: "permissionProfile/list", params: { cursor: null, limit: 100, cwd: null } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 6, method: "account/usage/read", params: { threadId: "0198c000-0000-7000-8000-000000000001" } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 7, method: "mcpServer/oauth/login", params: { name: "docs", threadId: null } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 8, method: "thread/backgroundTerminals/list", params: { threadId: "thread-1", cursor: null, limit: 100 } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 9, method: "thread/backgroundTerminals/terminate", params: { threadId: "thread-1", processId: "42" } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 10, method: "thread/list", params: { limit: 100, sortKey: "updated_at", sortDirection: "desc", searchTerm: null, ancestorThreadId: "thread-1", sourceKinds: ["subAgent", "subAgentReview"] } }).valid).toBe(true);
    expect(validator.validateClientRequest({ id: 1, method: "turn/start", params: {} }).valid).toBe(false);
    expect(validator.validateClientNotification({ method: "initialized" }).valid).toBe(true);
    expect(validator.validateClientNotification({ method: "unknown/client-notification" }).valid).toBe(false);
  });
});
