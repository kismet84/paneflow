import { SerialTaskQueue } from "../../electron/main/serial-task-queue";
import { assertRemoteCommandAuthorized } from "../../electron/main/remote-command-authorization";
import { describe, expect, it, vi } from "vitest";
import { RemoteProjector, projectThreadStatus } from "../../electron/main/remote-projector";
import { ServerRequestCoordinator } from "../../electron/main/server-request-coordinator";
import type { AppServerSupervisor } from "../../electron/main/app-server-supervisor";
import { mobileCommandSchema, mobileSnapshotSchema } from "../../packages/remote-protocol/src/index";

describe("remote task console", () => {
  it("maps a refusal to cancel when the live command approval only offers cancel", () => {
    const respondToServer = vi.fn();
    const coordinator = new ServerRequestCoordinator({ respondToServer } as unknown as AppServerSupervisor);
    const options = { threadId: "a", availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["Write-Output"] } }, "cancel"] };
    const pending = coordinator.observe(1, 0, "item/commandExecution/requestApproval", options)!;
    coordinator.resolve("0", pending.version, "decline", undefined, "a");
    expect(respondToServer).toHaveBeenCalledWith(1, 0, { decision: "cancel" });
    const next = coordinator.observe(1, 1, "item/commandExecution/requestApproval", options)!;
    coordinator.resolve("1", next.version, "accept", undefined, "a");
    expect(respondToServer).toHaveBeenLastCalledWith(1, 1, { decision: "accept" });
  });
  it("rejects queued controls after peer replacement, logout, disable, ownership loss or revocation", () => {
    const valid = { currentPeer: true, authenticated: true, enabled: true, ownsRemoteAccess: true, deviceAuthorized: true };
    expect(() => assertRemoteCommandAuthorized(valid)).not.toThrow();
    for (const key of Object.keys(valid)) expect(() => assertRemoteCommandAuthorized({ ...valid, [key]: false })).toThrow();
  });
  it("uses status flags, errors and observed updates instead of inventing running or unread state", () => {
    expect(projectThreadStatus({ type: "active", activeFlags: ["waitingOnUserInput"] })).toBe("waiting");
    expect(projectThreadStatus({ type: "active", activeFlags: [] })).toBe("running");
    expect(projectThreadStatus({ type: "systemError" })).toBe("failed");
    expect(projectThreadStatus({ type: "notLoaded" })).toBe("unknown");
    const projector = new RemoteProjector();
    projector.setThreads([{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 1 }]);
    projector.setActiveThread({ id: "a", turns: [] });
    projector.setThreads([{ id: "a", updatedAt: 2 }, { id: "b", updatedAt: 2 }]);
    expect(projector.snapshot().threads.map((thread) => thread.unread)).toEqual([false, true]);
    projector.setActiveThread({ id: "b", turns: [] });
    expect(projector.snapshot().threads[1]?.unread).toBe(false);
  });

  it("preserves thread-bound approvals for reconnect and removes completed approvals", () => {
    const projector = new RemoteProjector();
    projector.setActiveThread({ id: "a", turns: [{ id: "turn", status: "inProgress" }] });
    projector.addApproval("a", { id: "approval", kind: "approval", title: "Command", summary: "test", version: 1, decisions: ["accept", "decline"] });
    expect(projector.snapshot()).toMatchObject({ activeTurnId: "turn", turnStatus: "waiting" });
    expect(projector.snapshot().items[0]?.kind).toBe("approval");
    projector.setActiveThread({ id: "b", turns: [] });
    expect(projector.snapshot().items).toEqual([]);
    projector.setActiveThread({ id: "a", turns: [{ id: "turn", status: "inProgress" }] });
    expect(projector.snapshot().items).toHaveLength(1);
    projector.removeApproval("approval");
    expect(projector.snapshot().items).toEqual([]);
    expect(projector.snapshot().turnStatus).toBe("running");
  });

  it("does not assign another thread's completed state to the selected turn", () => {
    const projector = new RemoteProjector();
    projector.setThreads([{ id: "a" }, { id: "b" }]);
    projector.setActiveThread({ id: "a", turns: [{ id: "turn", status: "inProgress" }] });
    projector.applyProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/completed", params: { threadId: "b", turn: { id: "other", status: "failed" } } } });
    expect(projector.snapshot()).toMatchObject({ turnStatus: "running", activeTurnId: "turn" });
    expect(projector.snapshot().threads[1]).toMatchObject({ status: "failed", unread: true });
    projector.setThreads([{ id: "a", status: { type: "active", activeFlags: [] } }, { id: "b", status: { type: "idle" } }]);
    expect(projector.snapshot().threads[1]?.status).toBe("failed");
    projector.applyProtocolEvent({ generation: 1, kind: "notification", payload: { method: "turn/started", params: { threadId: "b", turn: { id: "new" } } } });
    projector.setThreads([{ id: "b", status: { type: "active", activeFlags: [] } }]);
    expect(projector.snapshot().threads[0]?.status).toBe("running");
  });

  it("rejects cross-thread, stale and unsupported approval decisions without responding", () => {
    const respondToServer = vi.fn();
    const coordinator = new ServerRequestCoordinator({ respondToServer } as unknown as AppServerSupervisor);
    const pending = coordinator.observe(1, 42, "item/commandExecution/requestApproval", { threadId: "a" })!;
    expect(() => coordinator.resolve("42", pending.version, "accept", undefined, "b")).toThrow();
    expect(respondToServer).not.toHaveBeenCalled();
    coordinator.removeThread("a");
    expect(() => coordinator.resolve("42", pending.version, "accept", undefined, "a")).toThrow();
    expect(coordinator.observe(1, 43, "item/commandExecution/requestApproval", { threadId: "a", availableDecisions: ["acceptForSession", "decline"] })).toBeNull();
    expect(coordinator.observe(1, 44, "item/commandExecution/requestApproval", {})).toBeNull();
  });

  it("checks authorization when a queued command actually starts", async () => {
    const queue = new SerialTaskQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocking = queue.enqueue(() => gate);
    const state = { currentPeer: true, authenticated: true, enabled: true, ownsRemoteAccess: true, deviceAuthorized: true };
    const mutate = vi.fn();
    const command = queue.enqueue(async () => { assertRemoteCommandAuthorized(state); mutate(); });
    state.deviceAuthorized = false;
    release();
    await blocking;
    await expect(command).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("requires precise control targets and preserves old snapshot compatibility", () => {
    const requestId = crypto.randomUUID();
    expect(mobileCommandSchema.safeParse({ type: "turn.interrupt", requestId, threadId: "a", turnId: "turn" }).success).toBe(true);
    expect(mobileCommandSchema.safeParse({ type: "turn.interrupt", requestId, threadId: "a" }).success).toBe(false);
    expect(mobileCommandSchema.safeParse({ type: "approval.resolve", requestId, approvalId: "a", version: 1, decision: "accept" }).success).toBe(false);
    const { activeTurnId, models, selectedModel, selectedEffort, ...oldSnapshot } = new RemoteProjector().snapshot();
    expect(mobileSnapshotSchema.parse(oldSnapshot)).toMatchObject({ activeTurnId: null, models: [], selectedModel: null, selectedEffort: null });
  });
});
