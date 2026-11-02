import type { ConnectionState, FileReference, MediaAttachment } from "../electron/shared/contracts";

export type LayoutKind = "single" | "vertical" | "horizontal" | "quad" | "fourColumns" | "fourRows" | "six";
export type WorkspaceMode = "panes" | "sessionSidebar";
export type ThemeMode = "system" | "dark" | "light";

export type AppearanceSettings = {
  theme: ThemeMode;
  fontFamily: string;
  fontSize: number;
  accentColor: string;
  commandShellPath: string;
  unwrapPowerShellCommands: boolean;
  mcpGatewayAdaptation: boolean;
};

export type UiItemStatus = "running" | "completed" | "failed" | "declined";

export type ApprovalReviewState = {
  reviewId: string;
  turnId: string;
  targetItemId: string | null;
  startedAtMs: number;
  completedAtMs: number | null;
  status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
  riskLevel: string | null;
  userAuthorization: string | null;
  rationale: string | null;
  decisionSource: string | null;
  action: Record<string, unknown>;
};

export type BackgroundTerminalState = {
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
};

export type SubAgentRuntimeState = {
  threadId: string;
  path: string | null;
  status: string;
  message: string | null;
};

export type McpServerState = {
  name: string;
  pluginId: string | null;
  authStatus: "unknown" | "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  startupStatus: "starting" | "ready" | "failed" | "cancelled" | null;
  error: string | null;
  failureReason: string | null;
  tools: string[];
  resourceCount: number;
  resourceTemplateCount: number;
};

export type UiItem = {
  id: string;
  turnId: string;
  type: string;
  data: Record<string, unknown>;
  streamText: string;
  status: UiItemStatus;
};

export type PaneState = {
  id: string;
  title: string;
  threadId: string | null;
  cwd: string;
  draft: string;
  attachments: MediaAttachment[];
  references: FileReference[];
  skills: SkillOption[];
  activePermissionProfile: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never" | null;
  approvalsReviewer?: "user" | "auto_review" | "guardian_subagent" | null;
  serviceTier?: string | null;
  collaborationMode?: "default" | "plan" | null;
  goal?: Record<string, unknown> | null;
  model: string | null;
  effort: string | null;
  activeTurnId: string | null;
  status: "idle" | "starting" | "running" | "interrupting" | "error";
  items: UiItem[];
  tokenUsage: Record<string, unknown> | null;
  contextRemainingPercent?: number | null;
  turnDiff?: string;
  activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput">;
  approvalReviews?: ApprovalReviewState[];
  strictReviewRequired?: boolean;
  backgroundTerminals?: BackgroundTerminalState[];
  subAgents?: Record<string, SubAgentRuntimeState>;
  error: string | null;
  unread: boolean;
  scrollTop: number;
  followTail: boolean;
  historyCursor?: string | null;
  historyLoading?: boolean;
};

export type ItemAction =
  | { type: "switchAgent"; threadId: string }
  | { type: "stopBackgroundProcess"; processId: string }
  | { type: "stopAllBackgroundProcesses" }
  | { type: "switchPermissionMode"; profileId: string; approvalPolicy: "untrusted" | "on-request" | "never"; approvalsReviewer: "user" | "auto_review" | "guardian_subagent" }
  | { type: "dismissItem"; itemId: string };

export type PendingServerRequest = {
  generation: number;
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  paneId: string | null;
  createdAt: number;
};

export type ModelOption = {
  label: string;
  value: string;
  efforts: string[];
  inputModalities: string[];
  defaultEffort: string | null;
  serviceTiers: Array<{ id: string; name: string; description: string }>;
  isDefault: boolean;
};

export type SkillOption = {
  name: string;
  description: string;
  path: string;
};

export type ThreadSummary = {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  updatedAt: number;
  status: string;
};

export type AppState = {
  appVersion: string;
  connection: ConnectionState;
  workspaceMode: WorkspaceMode;
  layout: LayoutKind;
  splitSizes: Record<string, number[]>;
  defaultCwd: string;
  focusedPaneId: string | null;
  panes: PaneState[];
  pendingRequests: PendingServerRequest[];
  models: ModelOption[];
  accountLabel: string;
  rateLimits: Record<string, unknown> | null;
  rateLimitLabels: string[];
  accountUsage: Record<string, unknown> | null;
  mcpServers: McpServerState[];
  appearance: AppearanceSettings;
  effectiveConfig: {
    model: string | null;
    modelProvider: string | null;
    sandboxMode: string | null;
    approvalPolicy: string | null;
    approvalReviewer: string | null;
    reasoningEffort: string | null;
    webSearch: string | null;
    serviceTier: string | null;
  } | null;
  permissionProfiles: Array<{ id: string; description: string | null; allowed: boolean }>;
  threads: ThreadSummary[];
  sidebarUnreadThreadIds: string[];
  notices: string[];
  initialized: boolean;
};
