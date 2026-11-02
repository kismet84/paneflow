export const BASELINE = {
  codexVersion: "0.149.1",
  tag: "rust-v0.149.1",
  commit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
  generation: "codex app-server generate-ts --experimental",
  counts: {
    clientRequests: 153,
    serverRequests: 11,
    serverNotifications: 77
  }
} as const;

export const SERVER_REQUEST_METHODS = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "currentTime/read",
  "applyPatchApproval",
  "execCommandApproval"
] as const;

export type ServerRequestMethod = typeof SERVER_REQUEST_METHODS[number];

export const UNREGISTERED_CAPABILITY_REQUEST_METHODS = [
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate"
] as const satisfies readonly ServerRequestMethod[];
