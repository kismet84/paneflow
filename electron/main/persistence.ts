import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_WORKSPACE_BYTES = 8 * 1024 * 1024;

const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(200),
  url: z.string().startsWith("codex-media://"),
  size: z.number().nonnegative(),
  kind: z.enum(["local", "remote"]).default("local"),
  sourcePath: z.string().min(1).max(32_768).optional(),
  sourceUrl: z.string().url().startsWith("https://").optional(),
  protectedSourceUrl: z.string().max(16_384).optional()
}).superRefine((attachment, context) => {
  if (attachment.kind === "remote" && !attachment.sourceUrl && !attachment.protectedSourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "远程图片缺少受保护的地址" });
  }
});

const paneSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  threadId: z.string().min(1).max(512).nullable(),
  cwd: z.string().max(32_768),
  draft: z.string().max(200_000),
  attachments: z.array(attachmentSchema).max(20),
  references: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1).max(512), path: z.string().min(1).max(32_768), managed: z.boolean().optional() })).max(20).default([]),
  model: z.string().max(200).nullable(),
  effort: z.string().max(50).nullable(),
  activePermissionProfile: z.string().max(512).nullable().optional(),
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).nullable().optional(),
  approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]).nullable().optional(),
  serviceTier: z.string().max(100).nullable().optional(),
  collaborationMode: z.enum(["default", "plan"]).nullable().optional(),
  scrollTop: z.number().nonnegative().default(0),
  followTail: z.boolean().default(true)
});

export const workspaceStateSchema = z.object({
  version: z.literal(1),
  workspaceMode: z.enum(["panes", "sessionSidebar"]).default("panes"),
  layout: z.enum(["single", "vertical", "horizontal", "quad", "fourColumns", "fourRows", "six"]),
  splitSizes: z.record(z.array(z.number().min(10).max(90)).min(2).max(4)).refine((sizes) => Object.keys(sizes).length <= 20, { message: "窗格尺寸配置过多" }).default({}),
  defaultCwd: z.string().max(32_768).default(""),
  appearance: z.object({
    theme: z.enum(["system", "dark", "light"]).default("system"),
    fontFamily: z.string().max(200).default('"Segoe UI", "Microsoft YaHei UI", sans-serif'),
    fontSize: z.number().int().min(12).max(22).default(14),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/i).default("#10a37f"),
    commandShellPath: z.string().max(32_768).default("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
    unwrapPowerShellCommands: z.boolean().default(true),
    mcpGatewayAdaptation: z.boolean().default(false)
  }).default({ theme: "system", fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif', fontSize: 14, accentColor: "#10a37f", commandShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", unwrapPowerShellCommands: true, mcpGatewayAdaptation: false }),
  focusedPaneId: z.string().nullable(),
  panes: z.array(paneSchema).min(1).max(6),
  window: z.object({
    width: z.number().int().min(800),
    height: z.number().int().min(600),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    maximized: z.boolean()
  })
}).superRefine((state, context) => {
  const paneIds = state.panes.map((pane) => pane.id);
  if (new Set(paneIds).size !== paneIds.length) context.addIssue({ code: "custom", path: ["panes"], message: "窗格标识不能重复" });
  if (state.focusedPaneId && !paneIds.includes(state.focusedPaneId)) context.addIssue({ code: "custom", path: ["focusedPaneId"], message: "聚焦窗格必须存在" });
});

export type WorkspaceState = z.infer<typeof workspaceStateSchema>;

export class StateStore {
  readonly #path: string;
  #saveQueue: Promise<void> = Promise.resolve();
  #loadWarning: string | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  get loadWarning(): string | null {
    return this.#loadWarning;
  }

  async load(): Promise<WorkspaceState | null> {
    try {
      const metadata = await stat(this.#path);
      if (metadata.size > MAX_WORKSPACE_BYTES) throw new Error("工作台状态文件超过安全大小限制");
      const content = await readFile(this.#path, "utf8");
      const state = workspaceStateSchema.parse(JSON.parse(content));
      this.#loadWarning = null;
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.#loadWarning = "上次保存的工作台状态无法读取，已使用安全默认布局。原文件仍保留在应用数据目录中。";
      }
      return null;
    }
  }

  save(value: unknown): Promise<void> {
    const state = workspaceStateSchema.parse(value);
    return this.#enqueueWrite(state);
  }

  updateWindow(window: WorkspaceState["window"]): Promise<void> {
    const operation = this.#saveQueue.then(async () => {
      const current = await this.load();
      if (!current) return;
      await this.#write({ ...current, window });
    });
    this.#saveQueue = operation.catch(() => undefined);
    return operation;
  }

  #enqueueWrite(state: WorkspaceState): Promise<void> {
    const operation = this.#saveQueue.then(() => this.#write(state));
    this.#saveQueue = operation.catch(() => undefined);
    return operation;
  }

  async #write(state: WorkspaceState): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(state, null, 2), "utf8");
      await rename(temporaryPath, this.#path);
    } catch (error) {
      try { await unlink(temporaryPath); } catch { /* Temporary file may not exist. */ }
      throw error;
    }
  }
}
