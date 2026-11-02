import { describe, expect, it } from "vitest";
import { workspaceStateSchema } from "../../electron/main/persistence";

const validState = {
  version: 1,
  layout: "quad",
  splitSizes: {},
  defaultCwd: "E:\\AI-Workspace",
  focusedPaneId: null,
  panes: [{ id: "pane-1", threadId: null, cwd: "E:\\Work", draft: "", attachments: [], model: null, effort: null }],
  window: { width: 1200, height: 800, maximized: false }
};

describe("workspace persistence validation", () => {
  it("accepts the supported persisted shape", () => {
    expect(workspaceStateSchema.parse(validState)).toMatchObject(validState);
    expect(workspaceStateSchema.parse({ ...validState, layout: "fourColumns", splitSizes: { fourColumns: [25, 25, 25, 25] } }).layout).toBe("fourColumns");
    expect(workspaceStateSchema.parse({ ...validState, layout: "fourRows", splitSizes: { fourRows: [25, 25, 25, 25] } }).layout).toBe("fourRows");
    expect(workspaceStateSchema.parse({ ...validState, workspaceMode: "sessionSidebar" }).workspaceMode).toBe("sessionSidebar");
    expect(() => workspaceStateSchema.parse({ ...validState, workspaceMode: "unknown" })).toThrow();
  });

  it("loads workspaces saved before the global default directory was added", () => {
    const { defaultCwd: _defaultCwd, ...legacyState } = validState;
    expect(workspaceStateSchema.parse(legacyState).defaultCwd).toBe("");
    expect(workspaceStateSchema.parse(legacyState).workspaceMode).toBe("panes");
    expect(workspaceStateSchema.parse(legacyState).appearance).toEqual({
      theme: "system",
      fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
      fontSize: 14,
      accentColor: "#10a37f",
      commandShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      unwrapPowerShellCommands: true,
      mcpGatewayAdaptation: false
    });
  });

  it("validates persisted appearance settings", () => {
    expect(workspaceStateSchema.parse({ ...validState, appearance: { theme: "light", fontFamily: "Consolas", fontSize: 18, accentColor: "#336699" } }).appearance.theme).toBe("light");
    expect(workspaceStateSchema.parse({ ...validState, appearance: { theme: "system", fontFamily: "Consolas", fontSize: 18, accentColor: "#336699" } }).appearance.theme).toBe("system");
    expect(workspaceStateSchema.parse({ ...validState, appearance: { theme: "light", fontFamily: "", fontSize: 18, accentColor: "#336699" } }).appearance.fontFamily).toBe("");
    expect(() => workspaceStateSchema.parse({ ...validState, appearance: { theme: "dark", fontFamily: "Consolas", fontSize: 40, accentColor: "red" } })).toThrow();
  });

  it("rejects oversized drafts and unsafe attachment URLs", () => {
    expect(() => workspaceStateSchema.parse({ ...validState, panes: [{ ...validState.panes[0], draft: "x".repeat(200_001) }] })).toThrow();
    expect(() => workspaceStateSchema.parse({
      ...validState,
      panes: [{ ...validState.panes[0], attachments: [{ id: crypto.randomUUID(), name: "x", url: "file:///etc/passwd", size: 1 }] }]
    })).toThrow();
  });

  it("persists managed file references without accepting an empty path", () => {
    const reference = { id: crypto.randomUUID(), name: "notes.txt", path: "codex-file://files/test", managed: true };
    expect(workspaceStateSchema.parse({ ...validState, panes: [{ ...validState.panes[0], references: [reference] }] }).panes[0]!.references).toEqual([reference]);
    expect(() => workspaceStateSchema.parse({ ...validState, panes: [{ ...validState.panes[0], references: [{ ...reference, path: "" }] }] })).toThrow();
  });

  it("persists bounded thread mode state used by the status line", () => {
    const parsed = workspaceStateSchema.parse({
      ...validState,
      panes: [{
        ...validState.panes[0],
        activePermissionProfile: ":workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        serviceTier: "priority",
        collaborationMode: "plan"
      }]
    });
    expect(parsed.panes[0]).toMatchObject({ activePermissionProfile: ":workspace", approvalsReviewer: "auto_review", collaborationMode: "plan" });
    expect(() => workspaceStateSchema.parse({ ...validState, panes: [{ ...validState.panes[0], approvalsReviewer: "renderer" }] })).toThrow();
  });

  it("rejects duplicate and missing focused pane identities", () => {
    expect(() => workspaceStateSchema.parse({ ...validState, panes: [validState.panes[0], validState.panes[0]] })).toThrow("窗格标识不能重复");
    expect(() => workspaceStateSchema.parse({ ...validState, focusedPaneId: "pane-missing" })).toThrow("聚焦窗格必须存在");
    expect(() => workspaceStateSchema.parse({ ...validState, panes: [{ ...validState.panes[0], id: "pane-1']" }] })).toThrow();
  });
});
