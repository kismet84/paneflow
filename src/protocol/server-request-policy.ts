import { SERVER_REQUEST_METHODS, type ServerRequestMethod } from "../../packages/protocol/src/method-manifest";

export type ServerRequestHandling = "interactive" | "automatic" | "safe-reject";

const INTERACTIVE_METHODS = new Set<ServerRequestMethod>([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval"
]);

const AUTOMATIC_METHODS = new Set<ServerRequestMethod>(["currentTime/read"]);

export const getServerRequestHandling = (method: string): ServerRequestHandling => {
  if (INTERACTIVE_METHODS.has(method as ServerRequestMethod)) return "interactive";
  if (AUTOMATIC_METHODS.has(method as ServerRequestMethod)) return "automatic";
  return "safe-reject";
};

export const buildApprovalDecision = (method: string, decision: unknown): { decision: unknown } => {
  if (method !== "applyPatchApproval" && method !== "execCommandApproval") {
    return { decision };
  }
  if (decision === "accept") return { decision: "approved" };
  if (decision === "acceptForSession") return { decision: "approved_for_session" };
  if (decision === "cancel") return { decision: "abort" };
  if (decision === "decline") return { decision: { denied: { rejection: "用户拒绝了此操作" } } };
  return { decision };
};

export const hasExhaustiveServerRequestPolicy = (): boolean =>
  SERVER_REQUEST_METHODS.every((method) => getServerRequestHandling(method) !== undefined);
