// @vitest-environment jsdom

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, ProtocolEvent } from "../../electron/shared/contracts";
import type { WorkspaceState } from "../../electron/main/persistence";
import { useWorkspaceStore } from "../../src/stores/workspace";

const connection = (phase: ConnectionState["phase"], generation = 1): ConnectionState => ({
  phase,
  generation,
  codexVersion: "0.149.1",
  compatible: true,
  message: phase
});

const workspaceWithThread = (threadId: string): WorkspaceState => ({
  version: 1,
  workspaceMode: "panes",
  layout: "quad",
  splitSizes: {},
  defaultCwd: "",
  appearance: { theme: "dark", fontFamily: '"Segoe UI"', fontSize: 14, accentColor: "#10a37f", commandShellPath: "", unwrapPowerShellCommands: true, mcpGatewayAdaptation: false },
  focusedPaneId: null,
  panes: Array.from({ length: 6 }, (_, index) => ({
    id: `pane-${index + 1}`,
    threadId: index === 0 ? threadId : null,
    cwd: "",
    draft: "",
    attachments: [],
    references: [],
    model: null,
    effort: null,
    scrollTop: 0,
    followTail: true
  })),
  window: { width: 1200, height: 800, maximized: false }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

const installApi = (bootstrap: Promise<{ connection: ConnectionState; workspace: WorkspaceState | null }>) => {
  let stateListener: ((state: ConnectionState) => void) | null = null;
  let protocolListener: ((event: ProtocolEvent) => void) | null = null;
  const request = vi.fn(async (requestValue: { method: string }): Promise<unknown> => {
    if (requestValue.method === "model/list") return { data: [] };
    if (requestValue.method === "account/read") return { account: null };
    if (requestValue.method === "account/rateLimits/read") return {};
    if (requestValue.method === "thread/resume") return { thread: { id: "thread-old", turns: [] } };
    return {};
  });
  const respond = vi.fn(async (): Promise<void> => undefined);
  window.codexPane = {
    bootstrap: async () => ({ appVersion: "0.1.3", ...await bootstrap }),
    request,
    respond,
    reconnect: vi.fn(),
    setAppServerWorkingDirectory: vi.fn(),
    chooseDirectory: vi.fn(),
    chooseAttachments: vi.fn(),
    pasteAttachments: vi.fn(),
    importImagePath: vi.fn(),
    addRemoteImage: vi.fn(),
    saveWorkspace: vi.fn(async (): Promise<void> => undefined),
    setFullScreen: vi.fn(),
    openExternal: vi.fn(),
    readDiagnostics: vi.fn(),
    onConnectionState: (listener: (state: ConnectionState) => void) => { stateListener = listener; return () => { stateListener = null; }; },
    onProtocolEvent: (listener: (event: ProtocolEvent) => void) => { protocolListener = listener; return () => { protocolListener = null; }; },
    onFullScreenChange: () => () => undefined
  } as unknown as Window["codexPane"];
  return {
    request,
    respond,
    emitState: (state: ConnectionState) => stateListener?.(state),
    emitProtocol: (event: ProtocolEvent) => protocolListener?.(event)
  };
};

describe("workspace state machine", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("buffers ready events until persisted pane bindings are restored", async () => {
    const bootstrap = deferred<{ connection: ConnectionState; workspace: WorkspaceState | null }>();
    const api = installApi(bootstrap.promise);
    const store = useWorkspaceStore();
    const initialization = store.initialize();
    api.emitState(connection("ready"));
    bootstrap.resolve({ connection: connection("starting"), workspace: workspaceWithThread("thread-old") });
    await initialization;
    expect(store.state.appVersion).toBe("0.1.3");
    expect(store.state.connection.phase).toBe("ready");
    expect(api.request).toHaveBeenCalledWith({
      method: "thread/resume",
      params: {
        threadId: "thread-old",
        excludeTurns: true,
        initialTurnsPage: { limit: 12, sortDirection: "desc", itemsView: "full" }
      }
    });
  });

  it("loads history in bounded reverse-chronological pages and prepends it in display order", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: workspaceWithThread("thread-old") }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") return {
        thread: { id: "thread-old" },
        initialTurnsPage: {
          data: [
            { id: "turn-4", status: "completed", items: [{ id: "item-4", type: "agentMessage", text: "four" }] },
            { id: "turn-3", status: "completed", items: [{ id: "item-3", type: "agentMessage", text: "three" }] }
          ],
          nextCursor: "cursor-2"
        }
      };
      if (requestValue.method === "thread/turns/list") return {
        data: [
          { id: "turn-2", status: "completed", items: [{ id: "item-2", type: "agentMessage", text: "two" }] },
          { id: "turn-1", status: "completed", items: [{ id: "item-1", type: "agentMessage", text: "one" }] }
        ],
        nextCursor: null
      };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;

    expect(pane.items.map((item) => item.id)).toEqual(["item-3", "item-4"]);
    expect(pane.historyCursor).toBe("cursor-2");
    await store.loadOlderTurns(pane);

    expect(api.request).toHaveBeenCalledWith({
      method: "thread/turns/list",
      params: { threadId: "thread-old", cursor: "cursor-2", limit: 12, sortDirection: "desc", itemsView: "full" }
    });
    expect(pane.items.map((item) => item.id)).toEqual(["item-1", "item-2", "item-3", "item-4"]);
    expect(pane.historyCursor).toBeNull();
  });

  it("treats unavailable subscription account data as an API/custom-mode state", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read" || requestValue.method === "account/rateLimits/read") throw new Error("subscription account data unavailable");
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    expect(store.state.accountLabel).toBe("API/自定义模式");
    expect(store.state.rateLimitLabels).toEqual([]);
    expect(store.state.notices).not.toContain(expect.stringContaining("codex login"));
  });

  it("passes the active pane working directory to the server-side session filter", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    await store.loadThreads("性能", "E:\\AI-Workspace");

    expect(api.request).toHaveBeenCalledWith({
      method: "thread/list",
      params: {
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        searchTerm: "性能",
        cwd: "E:\\AI-Workspace"
      }
    });
  });

  it("keeps a newly created live session visible while the persisted thread list catches up", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/list") return { data: [] };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-new-live";
    pane.title = "刚发送的第一句话";
    pane.cwd = "E:\\Work";

    await store.loadThreads("", "E:\\Work");

    expect(store.state.threads).toEqual([expect.objectContaining({ id: "thread-new-live", name: "刚发送的第一句话" })]);
  });

  it("recognizes a successful account response that explicitly does not require OpenAI auth", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    expect(store.state.accountLabel).toBe("API/自定义模式");
    expect(store.state.rateLimitLabels).toEqual([]);
    expect(store.state.notices).not.toContain(expect.stringContaining("codex login"));
  });

  it("loads the effective app-server config and selectable permission profiles", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "config/read") return { config: { model: "gpt-test", model_provider: "openai", sandbox_mode: "workspace-write", approval_policy: "on-request", approvals_reviewer: "auto_review", model_reasoning_effort: "high", web_search: "live", service_tier: "priority" } };
      if (requestValue.method === "permissionProfile/list") return { data: [{ id: "workspace", description: "Workspace access", allowed: true }], nextCursor: null };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    expect(store.state.effectiveConfig).toEqual({ model: "gpt-test", modelProvider: "openai", sandboxMode: "workspace-write", approvalPolicy: "on-request", approvalReviewer: "auto_review", reasoningEffort: "high", webSearch: "live", serviceTier: "priority" });
    expect(store.state.permissionProfiles).toEqual([{ id: "workspace", description: "Workspace access", allowed: true }]);
  });

  it("adds selected files and images through one attachment action and enforces the combined limit", async () => {
    installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    vi.mocked(window.codexPane.chooseAttachments).mockResolvedValueOnce({
      images: [{ id: "image-1", name: "one.png", url: "codex-media://media/image-1", size: 1, kind: "local", sourcePath: "E:\\Data\\image-1.png" }],
      files: [{ id: "11111111-1111-4111-8111-111111111111", name: "notes.txt", path: "E:\\Data\\11111111-1111-4111-8111-111111111111.txt", managed: true }],
      errors: []
    });
    await store.chooseAttachments(pane);
    expect(window.codexPane.chooseAttachments).toHaveBeenCalledWith(20);
    expect(pane.attachments.map((attachment) => attachment.name)).toEqual(["one.png"]);
    expect(pane.references.map((reference) => reference.name)).toEqual(["notes.txt"]);
    pane.references = Array.from({ length: 19 }, (_, index) => ({ id: crypto.randomUUID(), name: `${index}.txt`, path: `codex-file://files/${index}`, managed: true }));
    await store.chooseAttachments(pane);
    expect(window.codexPane.chooseAttachments).toHaveBeenCalledTimes(1);
    expect(pane.error).toContain("最多添加 20 个附件");
  });

  it("keeps successful attachments when another selected file fails", async () => {
    installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    vi.mocked(window.codexPane.chooseAttachments).mockResolvedValueOnce({
      images: [],
      files: [{ id: "22222222-2222-4222-8222-222222222222", name: "ok.txt", path: "E:\\Data\\ok.txt", managed: true }],
      errors: ["bad.png：这个文件不是可识别的图片。"]
    });
    await store.chooseAttachments(pane);
    expect(pane.references.map((reference) => reference.name)).toEqual(["ok.txt"]);
    expect(pane.error).toContain("部分附件未能添加");
    expect(pane.error).toContain("bad.png");
  });

  it("surfaces reconnect failures and flushes pending workspace state on demand", async () => {
    installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    vi.mocked(window.codexPane.reconnect).mockRejectedValueOnce(new Error("codex missing"));
    await expect(store.reconnect()).rejects.toThrow("codex missing");
    expect(store.state.connection).toMatchObject({ phase: "error", message: "重新连接失败：codex missing" });
    expect(store.state.notices.at(-1)).toContain("重新连接失败");

    vi.mocked(window.codexPane.saveWorkspace).mockClear();
    store.state.panes[0]!.draft = "关闭前必须保存";
    store.scheduleSave();
    await store.flushSave();
    expect(window.codexPane.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ panes: expect.arrayContaining([expect.objectContaining({ draft: "关闭前必须保存" })]) }));
  });

  it("sends selected Skills and file references as structured app-server input", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "skills/list") return { data: [{ cwd: "E:\\Work", skills: [{ name: "project-verify", description: "验证项目", path: "E:\\Skills\\project-verify\\SKILL.md", enabled: true }] }] };
      if (requestValue.method === "thread/start") return { thread: { id: "thread-skill" }, cwd: "E:\\Work", activePermissionProfile: { id: ":workspace" } };
      if (requestValue.method === "turn/start") return { turn: { id: "turn-skill" } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    await store.refreshSkills(pane);
    pane.draft = "@project-verify 检查当前项目";
    pane.references.push({ id: "11111111-1111-4111-8111-111111111111", name: "README.md", path: "codex-file://files/11111111-1111-4111-8111-111111111111", managed: true });
    await store.send(pane);
    expect(api.request).toHaveBeenCalledWith(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({ input: expect.arrayContaining([
        { type: "skill", name: "project-verify", path: "E:\\Skills\\project-verify\\SKILL.md" },
        { type: "managedFile", id: "11111111-1111-4111-8111-111111111111", name: "README.md" }
      ]) })
    }));
    expect(pane.activePermissionProfile).toBe(":workspace");
  });

  it("searches file references relative to the pane working directory", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "fuzzyFileSearch") return { files: [{ root: "E:\\Work", path: "docs/guide.md", file_name: "guide.md", match_type: "file", score: 80, indices: [5] }] };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.cwd = "E:\\Work";

    await expect(store.searchWorkspaceFiles(pane, "guide")).resolves.toEqual([
      { name: "guide.md", path: "E:\\Work\\docs\\guide.md", relativePath: "docs\\guide.md" }
    ]);
    expect(api.request).toHaveBeenCalledWith({ method: "fuzzyFileSearch", params: { query: "guide", roots: ["E:\\Work"], cancellationToken: null } });
  });

  it("lists and switches only allowed permission profiles", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "permissionProfile/list") return { data: [
        { id: ":read-only", description: "只读", allowed: true },
        { id: ":workspace", description: "工作区", allowed: true },
        { id: ":danger-full-access", description: "完全访问", allowed: true },
        { id: ":forbidden", description: "不可用", allowed: false }
      ] };
      if (requestValue.method === "thread/start") return { thread: { id: "thread-permission" }, cwd: "E:\\Work", activePermissionProfile: { id: ":workspace" } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.approvalPolicy = "on-request";
    pane.approvalsReviewer = "user";
    await store.executeSlashCommand(pane, "permissions");
    expect(pane.items.at(-1)?.data.modes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "readOnly", profileId: ":read-only" }),
      expect.objectContaining({ id: "ask", profileId: ":workspace", approvalsReviewer: "user" }),
      expect.objectContaining({ id: "auto", profileId: ":workspace", approvalsReviewer: "auto_review" }),
      expect.objectContaining({ id: "full", profileId: ":danger-full-access" })
    ]));
    expect(pane.items.at(-1)?.data.modes).toHaveLength(4);
    expect(JSON.stringify(pane.items.at(-1)?.data)).not.toContain(":forbidden");
    await store.handleItemAction(pane, { type: "switchPermissionMode", profileId: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
    expect(api.request).toHaveBeenCalledWith({ method: "thread/settings/update", params: { threadId: "thread-permission", permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review" } });
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/settings/updated", params: { threadId: "thread-permission", threadSettings: { activePermissionProfile: { id: ":workspace" }, approvalPolicy: "on-request", approvalsReviewer: "auto_review" } } } });
    expect(pane.approvalsReviewer).toBe("auto_review");
    expect(pane.items.at(-1)).toMatchObject({ type: "threadSettingsChanged", data: { changes: [{ label: "权限模式", value: "自动审批" }] } });
  });

  it("renames sessions and maps goal, plan, and fast commands to app-server", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [{ id: "gpt-test", displayName: "GPT Test", serviceTiers: [{ id: "priority", name: "fast", description: "Fastest inference" }] }] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/start") return { thread: { id: "thread-commands" }, model: "gpt-test", cwd: "E:\\Work" };
      if (requestValue.method === "thread/goal/set") return { goal: { threadId: "thread-commands", objective: requestValue.params?.objective, status: "active" } };
      if (requestValue.method === "collaborationMode/list") return { data: [{ name: "Plan", mode: "plan", model: "gpt-test", reasoning_effort: "high" }] };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.model = "gpt-test";

    await store.executeSlashCommand(pane, "rename 新名称");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/name/set", params: { threadId: "thread-commands", name: "新名称" } });
    expect(pane.title).toBe("新名称");
    await store.executeSlashCommand(pane, "goal 完成协议适配");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/goal/set", params: { threadId: "thread-commands", objective: "完成协议适配", status: "active" } });
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/goal/updated", params: { threadId: "thread-commands", goal: { threadId: "thread-commands", objective: "完成协议适配", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } } });
    expect(pane.goal?.status).toBe("active");
    expect(pane.items.at(-1)).toMatchObject({ type: "goalStatus", data: { state: "active", objective: "完成协议适配" } });
    await store.executeSlashCommand(pane, "goal pause");
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/goal/updated", params: { threadId: "thread-commands", goal: { ...pane.goal, status: "paused", timeUsedSeconds: 90, updatedAt: 2 } } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "goalStatus", data: { state: "paused", objective: "完成协议适配" } });
    await store.executeSlashCommand(pane, "goal resume");
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/goal/updated", params: { threadId: "thread-commands", goal: { ...pane.goal, status: "active", updatedAt: 3 } } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "goalStatus", data: { state: "resumed", objective: "完成协议适配" } });
    await store.executeSlashCommand(pane, "goal clear");
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/goal/cleared", params: { threadId: "thread-commands" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "goalStatus", data: { state: "empty" } });
    await store.executeSlashCommand(pane, "plan");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/settings/update", params: { threadId: "thread-commands", collaborationMode: { mode: "plan", settings: { model: "gpt-test", reasoning_effort: "high", developer_instructions: null } } } });
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/settings/updated", params: { threadId: "thread-commands", threadSettings: { collaborationMode: { mode: "plan" } } } } });
    expect(pane.collaborationMode).toBe("plan");
    expect(pane.items.at(-1)).toMatchObject({ type: "threadSettingsChanged", data: { changes: [{ label: "协作模式", value: "计划模式" }] } });
    await store.executeSlashCommand(pane, "fast");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/settings/update", params: { threadId: "thread-commands", serviceTier: "priority" } });
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/settings/updated", params: { threadId: "thread-commands", threadSettings: { serviceTier: "priority" } } } });
    expect(pane.serviceTier).toBe("priority");
    expect(pane.items.at(-1)).toMatchObject({ type: "threadSettingsChanged", data: { changes: [{ label: "服务模式", value: "快速模式" }] } });
    await store.executeSlashCommand(pane, "fast");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/settings/update", params: { threadId: "thread-commands", serviceTier: "default" } });
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "thread/settings/updated", params: { threadId: "thread-commands", threadSettings: { serviceTier: "default" } } } });
    expect(pane.serviceTier).toBe("default");
    await store.executeSlashCommand(pane, "unknown-command");
    expect(pane.error).toBe("命令执行失败：不支持的命令：/unknown-command");
    expect(api.request.mock.calls.filter(([requestValue]) => requestValue.method === "skills/list")).toHaveLength(0);
  });

  it("maps account update notifications to readable API and subscription labels", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "account/updated", params: { authMode: "apikey" } } });
    expect(store.state.accountLabel).toBe("API 模式");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "account/updated", params: { authMode: "chatgpt" } } });
    expect(store.state.accountLabel).toBe("ChatGPT 订阅");
  });

  it("keeps server requests isolated, deduplicated, retryable, and generation-safe", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.panes[0]!.threadId = "thread-a";
    store.state.panes[1]!.threadId = "thread-b";

    const commandEvent: ProtocolEvent = { generation: 2, kind: "server-request", payload: { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-a", command: "Get-ChildItem" } } };
    api.emitProtocol(commandEvent);
    api.emitProtocol(commandEvent);
    api.emitProtocol({ generation: 2, kind: "server-request", payload: { id: "1", method: "item/tool/requestUserInput", params: { threadId: "thread-b", questions: [] } } });
    api.emitProtocol({ generation: 1, kind: "server-request", payload: { id: 99, method: "execCommandApproval", params: { threadId: "thread-a" } } });
    expect(store.state.pendingRequests).toHaveLength(2);
    expect(store.state.pendingRequests.map((request) => request.paneId)).toEqual(["pane-1", "pane-2"]);

    const response = deferred<void>();
    api.respond.mockImplementationOnce(() => response.promise);
    const commandRequest = store.state.pendingRequests[0]!;
    const first = store.resolveRequest(commandRequest, { decision: "accept" });
    const duplicate = store.resolveRequest(commandRequest, { decision: "decline" });
    expect(api.respond).toHaveBeenCalledTimes(1);
    response.resolve();
    await Promise.all([first, duplicate]);
    expect(store.state.pendingRequests).toHaveLength(1);

    const questionRequest = store.state.pendingRequests[0]!;
    api.respond.mockRejectedValueOnce(new Error("transport unavailable"));
    await expect(store.resolveRequest(questionRequest, { answers: {} })).rejects.toThrow("transport unavailable");
    expect(store.state.pendingRequests).toContain(questionRequest);
    expect(store.state.panes[1]!.error).toContain("确认结果未提交");
    api.respond.mockResolvedValueOnce(undefined);
    await store.resolveRequest(questionRequest, { answers: {} });
    expect(store.state.pendingRequests).toHaveLength(0);

    api.emitProtocol({ generation: 2, kind: "server-request", payload: { id: 3, method: "mcpServer/elicitation/request", params: { threadId: "thread-a", mode: "form" } } });
    store.state.panes[0]!.activeTurnId = "turn-a";
    store.state.panes[0]!.status = "running";
    await store.interrupt(store.state.panes[0]!);
    expect(api.request).toHaveBeenCalledWith({ method: "turn/interrupt", params: { threadId: "thread-a", turnId: "turn-a" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "serverRequest/resolved", params: { requestId: 3 } } });
    expect(store.state.pendingRequests).toHaveLength(0);
    api.emitProtocol(commandEvent);
    api.emitState(connection("restarting", 3));
    expect(store.state.pendingRequests).toHaveLength(0);
  });

  it("allows another pane to start a turn while one pane waits for approval", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/start") return { thread: { id: "thread-b" } };
      if (requestValue.method === "turn/start") return { turn: { id: "turn-b" } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.panes[0]!.threadId = "thread-a";
    api.emitProtocol({ generation: 2, kind: "server-request", payload: { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "thread-a", command: "Get-ChildItem" } } });
    store.state.panes[1]!.draft = "继续独立任务";
    await store.send(store.state.panes[1]!);
    expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ method: "turn/start", params: expect.objectContaining({ threadId: "thread-b" }) }));
    expect(store.state.pendingRequests).toHaveLength(1);
    expect(store.state.pendingRequests[0]!.paneId).toBe("pane-1");
  });

  it("uses the global default cwd unless a pane chooses its own directory", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/start") return { thread: { id: `thread-${String(requestValue.params?.cwd)}` }, cwd: requestValue.params?.cwd };
      if (requestValue.method === "turn/start") return { turn: { id: "turn-new" } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();

    vi.mocked(window.codexPane.chooseDirectory).mockResolvedValueOnce("E:\\AI-Workspace");
    await store.chooseDefaultDirectory();
    store.state.panes[0]!.draft = "default cwd";
    await store.send(store.state.panes[0]!);
    expect(api.request).toHaveBeenCalledWith({ method: "thread/start", params: { cwd: "E:\\AI-Workspace", model: null, ephemeral: false } });
    expect(store.state.panes[0]!.cwd).toBe("E:\\AI-Workspace");

    vi.mocked(window.codexPane.chooseDirectory).mockResolvedValueOnce("E:\\Work");
    await store.chooseDirectory(store.state.panes[1]!);
    store.state.panes[1]!.draft = "pane cwd";
    await store.send(store.state.panes[1]!);
    expect(api.request).toHaveBeenCalledWith({ method: "thread/start", params: { cwd: "E:\\Work", model: null, ephemeral: false } });
    expect(store.state.defaultCwd).toBe("E:\\AI-Workspace");
  });

  it("deduplicates an initial double send and restores input when turn start fails", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const threadStart = deferred<unknown>();
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/start") return threadStart.promise;
      if (requestValue.method === "turn/start") throw new Error("写入失败");
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.draft = "不要丢失";
    const first = store.send(pane);
    const second = store.send(pane);
    threadStart.resolve({ thread: { id: "thread-new" } });
    await Promise.all([first, second]);
    expect(api.request.mock.calls.filter(([value]) => value.method === "thread/start")).toHaveLength(1);
    expect(api.request.mock.calls.filter(([value]) => value.method === "turn/start")).toHaveLength(1);
    expect(pane.draft).toBe("不要丢失");
    expect(pane.error).toContain("写入失败");
  });

  it("rejects pane rebinding while a turn is active", async () => {
    installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-running";
    pane.activeTurnId = "turn-running";
    pane.status = "running";
    store.newThread(pane);
    expect(pane.threadId).toBe("thread-running");
    expect(pane.error).toContain("尚未结束");
    await expect(store.resumeThread(pane, "thread-other")).rejects.toThrow("仍在运行");
  });

  it("releases an idle sidebar session before reusing its memory", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") return { thread: { id: requestValue.params?.threadId, turns: [] } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    store.state.workspaceMode = "sessionSidebar";
    store.state.focusedPaneId = pane.id;
    pane.threadId = "thread-idle";
    pane.items = [{ id: "old-item", turnId: "old-turn", type: "agentMessage", data: {}, streamText: "old", status: "completed" }];

    const destination = await store.switchSidebarThread(pane, "thread-next");

    expect(destination).not.toBe(pane);
    expect(api.request).toHaveBeenCalledWith({ method: "thread/unsubscribe", params: { threadId: "thread-idle" } });
    expect(pane.threadId).toBeNull();
    expect(pane.items).toEqual([]);
    expect(destination.threadId).toBe("thread-next");
  });

  it("keeps the current sidebar session visible when the target resume fails", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") throw new Error("会话已在其他客户端中打开");
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    store.state.workspaceMode = "sessionSidebar";
    store.state.focusedPaneId = pane.id;
    pane.threadId = "thread-current";
    pane.title = "当前会话";
    pane.items = [{ id: "current-item", turnId: "turn-current", type: "agentMessage", data: {}, streamText: "保留内容", status: "completed" }];

    await expect(store.switchSidebarThread(pane, "thread-external")).rejects.toThrow("无法恢复会话：会话已在其他客户端中打开");

    expect(store.state.focusedPaneId).toBe(pane.id);
    expect(pane.threadId).toBe("thread-current");
    expect(pane.title).toBe("当前会话");
    expect(pane.items[0]?.streamText).toBe("保留内容");
    expect(pane.error).toBeNull();
  });

  it("derives an unnamed resumed session title after hydrating its history", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") return {
        thread: { id: "thread-unnamed", name: null },
        initialTurnsPage: {
          data: [{ id: "turn-first", status: "completed", items: [{ id: "message-first", type: "userMessage", content: [{ type: "text", text: "修复恢复后的会话标题", text_elements: [] }] }] }],
          nextCursor: null
        }
      };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();

    await store.resumeThread(store.state.panes[0]!, "thread-unnamed");

    expect(store.state.panes[0]!.title).toBe("修复恢复后的会话标题");
  });

  it("keeps unlimited working sessions behind the sidebar", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") return { thread: { id: requestValue.params?.threadId, turns: [] } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.workspaceMode = "sessionSidebar";
    store.state.panes.forEach((pane, index) => {
      pane.threadId = `thread-running-${index}`;
      pane.activeTurnId = `turn-${index}`;
      pane.status = "running";
    });
    const current = store.state.panes[0]!;
    store.state.focusedPaneId = current.id;

    const destination = await store.switchSidebarThread(current, "thread-seventh");

    expect(store.state.panes).toHaveLength(7);
    expect(destination.id).toMatch(/^sidebar-pane-/);
    expect(destination.threadId).toBe("thread-seventh");
    expect(current.threadId).toBe("thread-running-0");
    expect(current.status).toBe("running");

    vi.useFakeTimers();
    try {
      store.scheduleSave();
      await vi.advanceTimersByTimeAsync(500);
      const saved = vi.mocked(window.codexPane.saveWorkspace).mock.calls.at(-1)?.[0];
      expect(saved?.panes).toHaveLength(6);
      expect(saved?.panes.some((pane) => pane.id === saved.focusedPaneId)).toBe(true);
      expect(saved?.panes.some((pane) => pane.id.startsWith("sidebar-pane-"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a completed background session and keeps its unread marker", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.workspaceMode = "sessionSidebar";
    const foreground = store.state.panes[0]!;
    const background = store.state.panes[1]!;
    foreground.threadId = "thread-foreground";
    store.state.focusedPaneId = foreground.id;
    background.threadId = "thread-background";
    background.activeTurnId = "turn-background";
    background.status = "running";

    api.emitProtocol({
      generation: 1,
      kind: "notification",
      payload: { method: "turn/completed", params: { threadId: "thread-background", turn: { id: "turn-background", status: "completed", items: [] } } }
    });

    await vi.waitFor(() => expect(background.threadId).toBeNull());
    expect(store.state.sidebarUnreadThreadIds).toContain("thread-background");
    expect(api.request).toHaveBeenCalledWith({ method: "thread/unsubscribe", params: { threadId: "thread-background" } });
  });

  it("starts a clean session while keeping pane-level working preferences", async () => {
    installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.title = "旧会话";
    pane.threadId = "thread-old";
    pane.cwd = "E:\\Work";
    pane.model = "gpt-test";
    pane.effort = "high";
    pane.draft = "旧草稿";
    pane.attachments = [{ id: crypto.randomUUID(), name: "old.png", url: "codex-media://old", size: 1, kind: "local" }];
    pane.references = [{ id: crypto.randomUUID(), name: "old.txt", path: "E:\\Work\\old.txt" }];
    pane.skills = [{ name: "old-skill", description: "", path: "E:\\skills\\old" }];

    store.newThread(pane);

    expect(pane).toMatchObject({ title: "新会话", threadId: null, cwd: "E:\\Work", model: "gpt-test", effort: "high", draft: "" });
    expect(pane.attachments).toEqual([]);
    expect(pane.references).toEqual([]);
    expect(pane.skills).toEqual([]);
  });

  it("ignores stale-generation notifications after reconnect", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: workspaceWithThread("thread-old") }));
    const store = useWorkspaceStore();
    await store.initialize();
    api.emitProtocol({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "thread-old", turn: { id: "stale-turn" } } } });
    expect(store.state.panes[0]!.activeTurnId).toBeNull();
  });

  it("validates each nested event generation instead of dropping a mixed outer batch", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: workspaceWithThread("thread-old") }));
    const store = useWorkspaceStore();
    await store.initialize();
    api.emitProtocol({
      generation: 1,
      kind: "notification-batch",
      payload: [
        { generation: 1, kind: "notification", payload: { method: "thread/name/updated", params: { threadId: "thread-old", threadName: "旧名称" } } },
        { generation: 2, kind: "notification", payload: { method: "thread/name/updated", params: { threadId: "thread-old", threadName: "当前名称" } } }
      ]
    });
    expect(store.state.panes[0]!.title).toBe("当前名称");
  });

  it("keeps image-view tool items and their running and completed states", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: workspaceWithThread("thread-image") }));
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.panes[0]!.threadId = "thread-image";
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-image", turnId: "turn-image", item: { id: "view-image", type: "imageView", path: "E:\\Work\\image.png" } } } });
    expect(store.state.panes[0]!.items.at(-1)).toMatchObject({ type: "imageView", status: "running", data: { path: "E:\\Work\\image.png" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/completed", params: { threadId: "thread-image", turnId: "turn-image", item: { id: "view-image", type: "imageView", path: "E:\\Work\\image.png" } } } });
    expect(store.state.panes[0]!.items.at(-1)).toMatchObject({ type: "imageView", status: "completed" });
  });

  it("routes interleaved deltas with identical item ids by thread and pane", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.panes[0]!.threadId = "thread-a";
    store.state.panes[1]!.threadId = "thread-b";
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "shared-item", type: "agentMessage", text: "" } } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-b", turnId: "turn-b", item: { id: "shared-item", type: "agentMessage", text: "" } } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/agentMessage/delta", params: { threadId: "thread-b", turnId: "turn-b", itemId: "shared-item", delta: "B" } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/agentMessage/delta", params: { threadId: "thread-a", turnId: "turn-a", itemId: "shared-item", delta: "A" } } });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(store.state.panes[0]!.items[0]!.streamText).toBe("A");
    expect(store.state.panes[1]!.items[0]!.streamText).toBe("B");
  });

  it("shows submitted messages immediately and reconciles the server echo by client id", async () => {
    const turnStart = deferred<unknown>();
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "turn/start") return turnStart.promise;
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-a";
    pane.draft = "立即显示";

    const submission = store.send(pane);
    expect(pane.items).toHaveLength(1);
    expect(pane.items[0]!.type).toBe("userMessage");
    expect(pane.status).toBe("running");
    const clientId = String(pane.items[0]!.data.clientId);
    await Promise.resolve();
    expect(api.request).toHaveBeenCalledWith({
      method: "turn/start",
      params: expect.objectContaining({ threadId: "thread-a", clientUserMessageId: clientId })
    });

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "server-message", type: "userMessage", clientId, content: [{ type: "text", text: "立即显示", text_elements: [] }] } } } });
    expect(pane.items).toHaveLength(1);
    expect(pane.items[0]!.id).toBe("server-message");
    expect(pane.items[0]!.turnId).toBe("turn-a");
    turnStart.resolve({ turn: { id: "turn-a" } });
    await submission;

    pane.draft = "转向消息";
    const steering = store.send(pane);
    expect(pane.items).toHaveLength(2);
    const steerClientId = String(pane.items[1]!.data.clientId);
    await Promise.resolve();
    expect(api.request).toHaveBeenCalledWith({
      method: "turn/steer",
      params: expect.objectContaining({ threadId: "thread-a", expectedTurnId: "turn-a", clientUserMessageId: steerClientId })
    });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "server-steer", type: "userMessage", clientId: steerClientId, content: [{ type: "text", text: "转向消息", text_elements: [] }] } } } });
    await steering;
    expect(pane.items).toHaveLength(2);
    expect(pane.items[1]!.id).toBe("server-steer");
  });

  it("applies thread title, runtime status and settings notifications", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/resume") return { thread: { id: "thread-a", name: "源码审计", turns: [] } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    await store.resumeThread(pane, "thread-a");
    expect(pane.title).toBe("源码审计");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/name/updated", params: { threadId: "thread-a", threadName: "协议适配" } } });
    expect(pane.title).toBe("协议适配");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnApproval"] } } } });
    expect(pane.status).toBe("running");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/settings/updated", params: { threadId: "thread-a", threadSettings: { cwd: "E:\\Work", model: "gpt-test", effort: "high" } } } });
    expect(pane.cwd).toBe("E:\\Work");
    expect(pane.model).toBe("gpt-test");
    expect(pane.effort).toBe("high");
    expect(pane.items.at(-1)).toMatchObject({ type: "threadSettingsChanged", data: { changes: [
      { label: "工作目录", value: "E:\\Work" },
      { label: "模型", value: "gpt-test" },
      { label: "推理强度", value: "high" }
    ] } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "idle" } } } });
    expect(pane.status).toBe("idle");
  });

  it("removes empty completed reasoning items and merges sparse rate-limit updates without duplicate windows", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {
        rateLimits: { limitId: "codex", secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 123 } },
        rateLimitsByLimitId: {
          codex: { limitId: "codex", secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 123 } },
          shared: { limitId: "shared", secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 123 } }
        }
      };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    store.state.panes[0]!.threadId = "thread-a";
    expect(store.state.rateLimitLabels.filter((label) => label.includes("7天"))).toHaveLength(1);

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: 456 } } } } });
    expect((store.state.rateLimits?.rateLimitsByLimitId as Record<string, { secondary: { usedPercent: number } }>).codex?.secondary.usedPercent).toBe(25);
    expect(store.state.rateLimitLabels).toContain("codex · 7天 75%");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "reasoning-a", type: "reasoning", summary: [], content: [] } } } });
    expect(store.state.panes[0]!.items).toHaveLength(1);
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "reasoning-a", type: "reasoning", summary: [], content: [] } } } });
    expect(store.state.panes[0]!.items).toHaveLength(0);
  });

  it("updates cwd for a loaded thread, includes its id in status, and persists appearance", async () => {
    vi.useFakeTimers();
    try {
      const workspace = workspaceWithThread("thread-a");
      workspace.appearance = { theme: "light", fontFamily: "Consolas", fontSize: 16, accentColor: "#336699", commandShellPath: "", unwrapPowerShellCommands: true, mcpGatewayAdaptation: true };
      const api = installApi(Promise.resolve({ connection: connection("ready"), workspace }));
      api.request.mockImplementation(async (requestValue: { method: string }) => {
        if (requestValue.method === "model/list") return { data: [] };
        if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
        if (requestValue.method === "account/rateLimits/read") return {};
        if (requestValue.method === "thread/resume") return { thread: { id: "thread-a", turns: [] } };
        return {};
      });
      const store = useWorkspaceStore();
      await store.initialize();
      const pane = store.state.panes[0]!;
      expect(store.state.appearance.theme).toBe("light");
      vi.mocked(window.codexPane.chooseDirectory).mockResolvedValueOnce("E:\\Work");
      await store.chooseDirectory(pane);
      expect(api.request).toHaveBeenCalledWith({ method: "thread/settings/update", params: { threadId: "thread-a", cwd: "E:\\Work" } });
      await store.executeSlashCommand(pane, "status");
      expect(pane.items.at(-1)?.data.threadId).toBe("thread-a");
      expect(pane.items.at(-1)?.data).toMatchObject({ contextTokens: "0/0", backgroundProcessCount: 0, approvalState: "无需确认" });
      expect(pane.items.at(-1)?.data.quotas).toEqual(["无额度数据"]);

      store.updateAppearance({ fontSize: 18, accentColor: "#112233" });
      store.setWorkspaceMode("sessionSidebar");
      await vi.advanceTimersByTimeAsync(500);
      expect(window.codexPane.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ workspaceMode: "sessionSidebar", appearance: { theme: "light", fontFamily: "Consolas", fontSize: 18, accentColor: "#112233", commandShellPath: "", unwrapPowerShellCommands: true, mcpGatewayAdaptation: true } }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps approval review, command, diff, context, MCP progress, web search and sub-agent events", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-a";

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/status/changed", params: { threadId: "thread-a", status: { type: "active", activeFlags: ["waitingOnApproval", "waitingOnUserInput"] } } } });
    expect(pane.activeFlags).toEqual(["waitingOnApproval", "waitingOnUserInput"]);
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/autoApprovalReview/started", params: { threadId: "thread-a", turnId: "turn-a", startedAtMs: 10, reviewId: "review-a", targetItemId: "command-a", review: { status: "inProgress", riskLevel: "high", userAuthorization: "unknown", rationale: null }, action: { type: "command", command: "git status" } } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/autoApprovalReview/completed", params: { threadId: "thread-a", turnId: "turn-a", startedAtMs: 10, completedAtMs: 20, reviewId: "review-a", targetItemId: "command-a", review: { status: "denied", riskLevel: "high", userAuthorization: "unknown", rationale: "需要用户确认" }, action: { type: "command", command: "git status" }, decisionSource: "agent" } } });
    expect(pane.approvalReviews?.[0]).toMatchObject({ reviewId: "review-a", status: "denied", completedAtMs: 20, riskLevel: "high", userAuthorization: "unknown", rationale: "需要用户确认", decisionSource: "agent" });
    expect(pane.items.filter((item) => item.type === "autoApprovalReview")).toHaveLength(1);
    expect(pane.items.find((item) => item.type === "autoApprovalReview")).toMatchObject({ status: "declined", data: { rationale: "需要用户确认" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "guardianWarning", params: { threadId: "thread-a", turnId: "turn-a", message: "需要用户确认" } } });
    expect(store.state.notices).not.toContain("需要用户确认");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "autoApprovalReview/strictReviewRequired", params: { threadId: "thread-a", turnId: "turn-a", startedAtMs: 21 } } });
    expect(pane.strictReviewRequired).toBe(true);

    const itemsBeforeInitialConnection = pane.items.length;
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/environment/connected", params: { threadId: "thread-a", environmentId: "env-a" } } });
    expect(pane.items).toHaveLength(itemsBeforeInitialConnection);
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "warning", params: { threadId: "thread-a", message: "当前会话需要注意" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "Codex 警告", message: "当前会话需要注意" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "model/rerouted", params: { threadId: "thread-a", turnId: "turn-a", fromModel: "gpt-5", toModel: "safety", reason: "highRiskCyberActivity" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "模型已切换", message: "gpt-5 → safety" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/environment/disconnected", params: { threadId: "thread-a", environmentId: "env-a" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", status: "failed", data: { title: "运行环境已断开" } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/environment/connected", params: { threadId: "thread-a", environmentId: "env-a" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "运行环境已连接" } });

    const noticeCount = pane.items.filter((item) => item.type === "protocolNotice").length;
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/environment/connected", params: { threadId: "thread-a", environmentId: "env-a" } } });
    expect(pane.items.filter((item) => item.type === "protocolNotice")).toHaveLength(noticeCount);
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "model/safetyBuffering/updated", params: { threadId: "thread-a", turnId: "turn-safety", model: "gpt-5", showBufferingUi: true, reasons: ["policy"] } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "model/safetyBuffering/updated", params: { threadId: "thread-a", turnId: "turn-safety", model: "gpt-5", showBufferingUi: false } } });
    expect(pane.items.filter((item) => item.type === "protocolNotice" && item.data.title === "安全检查")).toHaveLength(1);
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "安全检查", message: "安全检查已结束，正在继续生成响应。" } });

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "configWarning", params: { summary: "配置项已失效", details: "请替换旧字段" } } });
    expect(store.state.notices.at(-1)).toBe("配置项已失效");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "deprecationNotice", params: { summary: "旧方法将移除", details: "请迁移" } } });
    expect(store.state.notices.at(-1)).toBe("旧方法将移除：请迁移");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/tokenUsage/updated", params: { threadId: "thread-a", turnId: "turn-a", tokenUsage: { total: { totalTokens: 90_000 }, last: { totalTokens: 56_000 }, modelContextWindow: 100_000 } } } });
    expect(pane.contextRemainingPercent).toBe(50);
    await store.executeSlashCommand(pane, "status");
    expect(pane.items.at(-1)?.data.contextTokens).toBe("56,000/100,000");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "turn/diff/updated", params: { threadId: "thread-a", turnId: "turn-a", diff: "diff --git a/a b/b" } } });
    expect(pane.turnDiff).toContain("diff --git");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "command-a", type: "commandExecution", processId: "42", command: "npm test", cwd: "E:\\Work", status: "inProgress", commandActions: [] } } } });
    expect(pane.items.find((item) => item.id === "command-a")?.status).toBe("running");
    expect(pane.backgroundTerminals).toEqual([expect.objectContaining({ processId: "42", command: "npm test" })]);
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "command-a", type: "commandExecution", processId: "42", command: "npm test", cwd: "E:\\Work", status: "failed", commandActions: [], exitCode: 1 } } } });
    expect(pane.items.find((item) => item.id === "command-a")?.status).toBe("failed");
    expect(pane.backgroundTerminals).toEqual([]);

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/fileChange/patchUpdated", params: { threadId: "thread-a", turnId: "turn-a", itemId: "patch-a", changes: [{ path: "old.ts", kind: { type: "update", move_path: "new.ts" }, diff: "" }] } } });
    expect(getRecordForTest(pane.items.find((item) => item.id === "patch-a")?.data.changes)[0]?.kind).toEqual({ type: "update", move_path: "new.ts" });

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "mcp-a", type: "mcpToolCall", server: "docs", tool: "search", status: "inProgress", arguments: {} } } } });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/mcpToolCall/progress", params: { threadId: "thread-a", turnId: "turn-a", itemId: "mcp-a", message: "正在检索" } } });
    expect(pane.items.find((item) => item.id === "mcp-a")?.data.progressMessage).toBe("正在检索");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "web-a", type: "webSearch", query: "Codex", action: { type: "openPage", url: "https://example.com" }, results: [] } } } });
    expect(pane.items.find((item) => item.id === "web-a")?.status).toBe("completed");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/started", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "sub-a", type: "subAgentActivity", kind: "started", agentThreadId: "thread-sub", agentPath: "/root/sub" } } } });
    expect(pane.subAgents?.["thread-sub"]?.status).toBe("running");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "item/completed", params: { threadId: "thread-a", turnId: "turn-a", item: { id: "collab-a", type: "collabAgentToolCall", tool: "wait", status: "completed", senderThreadId: "thread-a", receiverThreadIds: ["thread-sub"], agentsStates: { "thread-sub": { status: "completed", message: "done" } } } } } });
    expect(pane.subAgents?.["thread-sub"]).toMatchObject({ path: "/root/sub", status: "completed", message: "done" });
  });

  it("tracks MCP inventory and authentication lifecycle", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "mcpServerStatus/list") return { data: [{ name: "docs", pluginId: null, authStatus: "notLoggedIn", tools: { search: {} }, resources: [{}], resourceTemplates: [] }], nextCursor: null };
      if (requestValue.method === "mcpServer/oauth/login") return { authorizationUrl: "https://auth.example.com/start" };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    await store.refreshMcpServers("thread-a");
    expect(store.state.mcpServers[0]).toMatchObject({ name: "docs", authStatus: "notLoggedIn", tools: ["search"], resourceCount: 1 });
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "mcpServer/startupStatus/updated", params: { threadId: null, name: "docs", status: "failed", error: null, failureReason: "reauthenticationRequired" } } });
    expect(store.state.mcpServers[0]).toMatchObject({ startupStatus: "failed", failureReason: "reauthenticationRequired" });
    expect(store.state.notices.at(-1)).toContain("重新登录");
    await store.loginMcpServer("docs");
    expect(window.codexPane.openExternal).toHaveBeenCalledWith("https://auth.example.com/start");
  });

  it("presents newer safety, plan, lifecycle, Skill and Windows sandbox notifications", async () => {
    const api = installApi(Promise.resolve({ connection: connection("ready", 2), workspace: null }));
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-a";

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "guardianWarning", params: { threadId: "thread-a", turnId: "turn-a", message: "该操作需要额外检查" } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "安全警告", message: "该操作需要额外检查" } });

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "turn/plan/updated", params: { threadId: "thread-a", turnId: "turn-a", explanation: "按顺序完成", plan: [{ step: "检查配置", status: "completed" }, { step: "运行测试", status: "inProgress" }] } } });
    expect(pane.items.find((item) => item.id === "turn-plan:turn-a")).toMatchObject({ type: "plan", status: "running" });
    expect(pane.items.find((item) => item.id === "turn-plan:turn-a")?.data.text).toContain("检查配置");

    pane.contextRemainingPercent = 12;
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/compacted", params: { threadId: "thread-a", turnId: "turn-a" } } });
    expect(pane.contextRemainingPercent).toBeNull();
    expect(pane.items.at(-1)?.data.title).toBe("上下文已压缩");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "hook/completed", params: { threadId: "thread-a", turnId: "turn-a", run: { status: "failed", eventName: "afterTurn", statusMessage: "Hook 返回失败" } } } });
    expect(pane.items.at(-1)).toMatchObject({ type: "protocolNotice", data: { title: "Hook 执行异常", message: "Hook 返回失败" } });

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/archived", params: { threadId: "thread-a" } } });
    expect(pane.items.at(-1)?.data.title).toBe("会话已归档");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/unarchived", params: { threadId: "thread-a" } } });
    expect(pane.items.at(-1)?.data.title).toBe("会话已取消归档");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/closed", params: { threadId: "thread-a" } } });
    expect(pane.items.at(-1)?.data.title).toBe("会话已关闭");

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "windowsSandbox/setupCompleted", params: { mode: "elevated", success: true, error: null } } });
    expect(store.state.notices.at(-1)).toContain("Windows 沙箱已完成配置");
    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "skills/changed", params: {} } });
    await vi.waitFor(() => expect(api.request).toHaveBeenCalledWith({ method: "skills/list", params: { cwds: [], forceReload: false } }));

    api.emitProtocol({ generation: 2, kind: "notification", payload: { method: "thread/deleted", params: { threadId: "thread-a" } } });
    expect(pane.threadId).toBeNull();
    expect(pane.error).toContain("已被删除");
  });

  it("supports agent and background-process slash commands and item actions", async () => {
    let backgroundListCalls = 0;
    const api = installApi(Promise.resolve({ connection: connection("ready"), workspace: null }));
    api.request.mockImplementation(async (requestValue: { method: string; params?: Record<string, unknown> }) => {
      if (requestValue.method === "model/list") return { data: [] };
      if (requestValue.method === "account/read") return { account: null, requiresOpenaiAuth: false };
      if (requestValue.method === "account/rateLimits/read") return {};
      if (requestValue.method === "thread/list") return { data: [{ id: "thread-sub", name: "测试代理" }], nextCursor: null };
      if (requestValue.method === "thread/backgroundTerminals/list") {
        backgroundListCalls += 1;
        return { data: backgroundListCalls % 2 === 1 ? [{ itemId: "cmd-a", processId: "42", command: "server", cwd: "E:\\Work", osPid: 123, cpuPercent: 1, rssKb: 2048 }] : [], nextCursor: null };
      }
      if (requestValue.method === "thread/backgroundTerminals/terminate") return { terminated: true };
      if (requestValue.method === "thread/resume") return { thread: { id: String(requestValue.params?.threadId), name: "测试代理", turns: [] } };
      return {};
    });
    const store = useWorkspaceStore();
    await store.initialize();
    const pane = store.state.panes[0]!;
    pane.threadId = "thread-a";

    await store.executeSlashCommand(pane, "agents");
    expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ method: "thread/list", params: expect.objectContaining({ ancestorThreadId: "thread-a", sourceKinds: expect.arrayContaining(["subAgent", "subAgentReview"]) }) }));
    expect(pane.items.at(-1)?.type).toBe("agents");
    await store.executeSlashCommand(pane, "ps");
    expect(pane.items.at(-1)?.data.processes).toHaveLength(1);
    await store.handleItemAction(pane, { type: "stopBackgroundProcess", processId: "42" });
    expect(api.request).toHaveBeenCalledWith({ method: "thread/backgroundTerminals/terminate", params: { threadId: "thread-a", processId: "42" } });
    await store.handleItemAction(pane, { type: "switchAgent", threadId: "thread-sub" });
    expect(pane.threadId).toBe("thread-sub");
    await store.executeSlashCommand(pane, "stop");
    expect(pane.items.at(-1)).toMatchObject({ type: "backgroundProcesses", data: { result: { requested: 1, terminated: 1 } } });
  });
});

const getRecordForTest = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
  ? value.map((entry) => entry && typeof entry === "object" ? entry as Record<string, unknown> : {})
  : [];
