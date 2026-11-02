import { describe, expect, it } from "vitest";
import { SERVER_REQUEST_METHODS } from "../../packages/protocol/src/method-manifest";
import { buildApprovalDecision, getServerRequestHandling, hasExhaustiveServerRequestPolicy } from "../../src/protocol/server-request-policy";

describe("server request policy", () => {
  it("assigns all 11 pinned methods to a deliberate handling mode", () => {
    expect(SERVER_REQUEST_METHODS).toHaveLength(11);
    expect(hasExhaustiveServerRequestPolicy()).toBe(true);
    expect(SERVER_REQUEST_METHODS.map((method) => [method, getServerRequestHandling(method)])).toEqual([
      ["item/commandExecution/requestApproval", "interactive"],
      ["item/fileChange/requestApproval", "interactive"],
      ["item/tool/requestUserInput", "interactive"],
      ["mcpServer/elicitation/request", "interactive"],
      ["item/permissions/requestApproval", "interactive"],
      ["item/tool/call", "safe-reject"],
      ["account/chatgptAuthTokens/refresh", "safe-reject"],
      ["attestation/generate", "safe-reject"],
      ["currentTime/read", "automatic"],
      ["applyPatchApproval", "interactive"],
      ["execCommandApproval", "interactive"]
    ]);
  });

  it("encodes legacy approval decisions without changing v2 decisions", () => {
    expect(buildApprovalDecision("item/fileChange/requestApproval", "accept")).toEqual({ decision: "accept" });
    expect(buildApprovalDecision("execCommandApproval", "acceptForSession")).toEqual({ decision: "approved_for_session" });
    expect(buildApprovalDecision("applyPatchApproval", "decline")).toEqual({ decision: { denied: { rejection: "用户拒绝了此操作" } } });
    expect(buildApprovalDecision("execCommandApproval", "cancel")).toEqual({ decision: "abort" });
  });
});
