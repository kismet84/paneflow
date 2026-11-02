import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DeploymentManager, type DeploymentDependencies, type OwnedChild } from "../../electron/main/deployment-manager";
import type { DeploymentConfig } from "../../electron/shared/deployment-contracts";

const config: DeploymentConfig = { origin: "https://pane.example.com", nodePath: "C:/tools/node.exe", cloudflaredPath: "C:/tools/cloudflared.exe", tunnelConfigPath: "C:/config/tunnel.yml", tunnelId: "existing-id", cwd: "C:/work", port: 48322, enabled: true };
class FakeChild extends EventEmitter {
  alive = true;
  constructor(readonly pid: number) { super(); }
  kill = vi.fn(() => false);
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => { this.alive = false; callback?.(null); queueMicrotask(() => this.emit("exit", 0)); return true; });
}
const fixture = (useDefaultHealth = false) => {
  const files = new Map<string, string>([[config.tunnelConfigPath, "tunnel: existing-id\ningress:\n  - hostname: pane.example.com\n    service: http://127.0.0.1:48322\n  - service: http_status:404\n"]]);
  const children: FakeChild[] = [];
  const state = { pending: [] as unknown[], portFree: true, publicOk: true, localOk: true, login: false, externalAlive: false, emitReady: true, differentInstance: false, probeSideEffect: null as null | (() => void) };
  const dependencies: Partial<DeploymentDependencies> = {
    readText: async path => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path)!; },
    writeText: async (path, data) => { files.set(path, data); }, mkdir: async () => {},
    rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from); },
    copyFile: async (from, to) => { files.set(to, files.get(from)!); },
    pathKind: async path => path === config.cwd ? "directory" : "file",
    findExecutable: async () => "C:/tools/codex.exe", probeExecutable: vi.fn(async () => true),
    portAvailable: async () => state.portFree,
    probeHealth: vi.fn(async (url, expectedInstance) => { state.probeSideEffect?.(); if (expectedInstance && state.differentInstance && url.startsWith("https:")) return false; return url.startsWith("https:") ? state.publicOk : state.localOk; }),
    processAlive: pid => children.find(child => child.pid === pid)?.alive ?? state.externalAlive,
    spawn: vi.fn((_path, _args, options) => { const child = new FakeChild(1000 + children.length); children.push(child); if (Array.isArray(options.stdio) && state.emitReady) queueMicrotask(() => child.emit("message", { type: "relay.ready", port: config.port })); return child as unknown as OwnedChild; }),
    wait: async () => {}
  };
  if (useDefaultHealth) delete dependencies.probeHealth;
  const remote = vi.fn(async () => {}), cwd = vi.fn(async () => {});
  const manager = new DeploymentManager({ dataDirectory: "C:/data", childWrapper: "C:/app/deployment-child.mjs", relayEntry: "C:/app/relay/server.js", version: "0.7.0", setRemoteSettings: remote, setWorkingDirectory: cwd, loginItem: { get: () => state.login, set: value => { state.login = value; } }, pendingWork: () => state.pending, dependencies });
  return { manager, state, files, children, dependencies, remote, cwd };
};

describe("Windows deployment manager", () => {
  it.each(["waiting", "unknown"])("rechecks degraded public connectivity during %s tasks without replay or configuration changes", async queueState => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture();
    try {
      await h.manager.save(config); await h.manager.start();
      h.state.pending = [{ kind: "queue", state: queueState }]; h.state.publicOk = false;
      h.children[1]!.alive = false; h.children[1]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.manager.status().phase).toBe("degraded"); expect(h.children).toHaveLength(4);
      h.state.publicOk = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(h.manager.status().phase).toBe("running"); expect(h.children).toHaveLength(4);
      expect(h.remote).toHaveBeenCalledTimes(1); expect(h.cwd).toHaveBeenCalledTimes(1);
      expect(h.state.pending).toEqual([{ kind: "queue", state: queueState }]);
      await h.manager.stop({ shutdown: true });
    } finally { vi.useRealTimers(); }
  });

  it("rechecks work after asynchronous diagnostics before committing configuration", async () => {
    const h = fixture(); h.state.probeSideEffect = () => { h.state.pending = [{ kind: "turn", state: "running" }]; };
    await expect(h.manager.save(config)).rejects.toThrow("待核对");
    expect(h.files.has(join("C:/data", "deployment.json"))).toBe(false);
    expect(h.children).toHaveLength(0);
  });

  it.each(["waiting", "unknown"])("restores owned transport during %s work without changing task/configuration state", async queueState => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = fixture();
    try {
      await h.manager.save(config); await h.manager.start();
      h.state.pending = [{ kind: "queue", state: queueState }];
      const pendingBefore = structuredClone(h.state.pending);
      h.children[1]!.alive = false; h.children[1]!.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.children).toHaveLength(4); expect(h.children[0]!.send).toHaveBeenCalledTimes(1);
      expect(h.manager.status().phase).toBe("running");
      expect(h.remote).toHaveBeenCalledTimes(1); expect(h.cwd).toHaveBeenCalledTimes(1);
      expect(h.state.pending).toEqual(pendingBefore);
      await expect(h.manager.stop()).rejects.toThrow("待核对");
      await h.manager.stop({ shutdown: true });
      await vi.advanceTimersByTimeAsync(60000); expect(h.children).toHaveLength(4);
    } finally { vi.useRealTimers(); }
  });

  it("checks executables, ingress and networking without starting or modifying services", async () => {
    const h = fixture(); const result = await h.manager.check(config);
    expect(result).toMatchObject({ valid: true, connectivity: true });
    expect(h.dependencies.spawn).not.toHaveBeenCalled(); expect(h.files.size).toBe(1);
    expect(h.dependencies.probeExecutable).toHaveBeenCalledWith(config.cloudflaredPath, ["tunnel", "--config", config.tunnelConfigPath, "ingress", "validate"]);
  });
  it("saves atomically with a backup and never changes the supplied tunnel YAML", async () => {
    const h = fixture(); await h.manager.save(config); const yaml = h.files.get(config.tunnelConfigPath);
    await h.manager.save({ ...config, enabled: false });
    const backups = [...h.files.entries()].filter(([path]) => path.endsWith(".bak"));
    expect(backups).toHaveLength(1); expect(JSON.parse(backups[0]![1]).enabled).toBe(true);
    expect(h.files.get(config.tunnelConfigPath)).toBe(yaml); expect(h.children).toHaveLength(0);
    expect(h.manager.status().phase).toBe("stopped");
  });
  it("starts only owned hidden children on loopback and enables login startup only after connectivity passes", async () => {
    const h = fixture(); await h.manager.save(config);
    await expect(h.manager.setAutostart(true)).rejects.toThrow("先启动");
    expect((await h.manager.start()).phase).toBe("running");
    expect(h.dependencies.spawn).toHaveBeenNthCalledWith(1, config.nodePath, ["C:/app/deployment-child.mjs", "relay", config.nodePath, "C:/app/relay/server.js"], expect.objectContaining({ windowsHide: true, shell: false, env: expect.objectContaining({ HOST: "127.0.0.1", PORT: "48322", PUBLIC_ORIGIN: config.origin }) }));
    expect(h.dependencies.spawn).toHaveBeenNthCalledWith(2, config.nodePath, ["C:/app/deployment-child.mjs", "tunnel", config.cloudflaredPath, "tunnel", "--config", config.tunnelConfigPath, "run", config.tunnelId], expect.objectContaining({ windowsHide: true, shell: false }));
    expect(h.remote).toHaveBeenCalledWith(config.origin); expect(h.cwd).toHaveBeenCalledWith(config.cwd);
    await h.manager.setAutostart(true); expect(h.state.login).toBe(true);
    await h.manager.start(); expect(h.children).toHaveLength(2);
    await h.manager.stop(); expect(h.children.every(child => child.send.mock.calls.length === 1 && child.kill.mock.calls.length === 0)).toBe(true);
  });
  it("refuses occupied ports even when another server advertises a healthy relay", async () => {
    const h = fixture(); await h.manager.save(config); h.state.portFree = false;
    expect((await h.manager.check(config)).valid).toBe(false);
    await expect(h.manager.start()).rejects.toThrow("预检"); expect(h.children).toHaveLength(0);
  });
  it("does not adopt or start beside a live pre-existing launcher", async () => {
    const h = fixture(); h.files.set(join("C:/data", "launcher.json"), JSON.stringify({ relayPid: 42 })); h.state.externalAlive = true;
    expect((await h.manager.check(config)).valid).toBe(false);
    await expect(h.manager.save(config)).rejects.toThrow("既有"); expect(h.children).toHaveLength(0);
  });
  it("blocks configuration and ordinary stop during tasks but permits explicit final application cleanup", async () => {
    const h = fixture(); await h.manager.save(config); await h.manager.start();
    h.state.pending = [{ kind: "queue", state: "unknown" }];
    await expect(h.manager.stop()).rejects.toThrow("待核对");
    await expect(h.manager.save(config)).rejects.toThrow("待核对");
    expect(h.children.every(child => child.alive)).toBe(true);
    await h.manager.stop({ shutdown: true }); expect(h.children.every(child => !child.alive)).toBe(true);
  });
  it("permits first-time configuration with connection-only unknown while still reporting it", async () => {
    const h = fixture(); h.state.pending = [{ kind: "connection", state: "unknown" }];
    expect((await h.manager.check(config)).checks.find(check => check.key === "work")?.ok).toBe(false);
    await h.manager.save(config); expect((await h.manager.start()).phase).toBe("running");
    await expect(h.manager.setAutostart(true)).rejects.toThrow("待核对"); await h.manager.stop({ shutdown: true });
  });
  it("keeps public failures visible and never enables login startup after a failed test", async () => {
    const h = fixture(); h.state.publicOk = false; await h.manager.save(config);
    expect((await h.manager.start()).phase).toBe("degraded");
    await expect(h.manager.setAutostart(true)).rejects.toThrow(); expect(h.state.login).toBe(false);
    expect(h.remote).not.toHaveBeenCalled(); await h.manager.stop({ shutdown: true });
  });
  it("requires matching instance identity and refuses a different healthy public relay", async () => {
    const h = fixture(); h.state.differentInstance = true;
    await h.manager.save(config);
    expect((await h.manager.start()).phase).toBe("degraded");
    const spawnCalls = (h.dependencies.spawn as ReturnType<typeof vi.fn>).mock.calls;
    const nonce = spawnCalls[0]![2].env.PANEFLOW_RELAY_INSTANCE;
    expect(nonce).toMatch(/^[a-f0-9-]{36}$/);
    expect(h.dependencies.probeHealth).toHaveBeenCalledWith(`${config.origin}/health`, nonce);
    expect(h.dependencies.probeHealth).toHaveBeenCalledWith(`http://127.0.0.1:${config.port}/health`, nonce);
    expect(h.remote).not.toHaveBeenCalled();
    await expect(h.manager.setAutostart(true)).rejects.toThrow(); expect(h.state.login).toBe(false);
    await h.manager.stop({ shutdown: true });
  });
  it("checks the actual health response instance nonce rather than only a healthy protocol marker", async () => {
    const h = fixture(true);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const calls = (h.dependencies.spawn as ReturnType<typeof vi.fn>).mock.calls;
      const localNonce = calls[0]?.[2]?.env?.PANEFLOW_RELAY_INSTANCE;
      return { ok: true, json: async () => ({ ok: true, protocolVersion: 1, instanceId: url.startsWith("http://127.0.0.1") ? localNonce : "different-public-instance" }) };
    }));
    try {
      await h.manager.save(config);
      expect((await h.manager.start()).phase).toBe("degraded");
      expect(h.remote).not.toHaveBeenCalled();
      await expect(h.manager.setAutostart(true)).rejects.toThrow();
      await h.manager.stop({ shutdown: true });
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects corrupt saved configuration and mismatched ingress without overwriting recovery material", async () => {
    const h = fixture(); h.files.set(join("C:/data", "deployment.json"), "corrupt");
    await expect(h.manager.save(config)).rejects.toThrow("保留原文件");
    expect(h.files.get(join("C:/data", "deployment.json"))).toBe("corrupt");
    const other = fixture(); other.files.set(config.tunnelConfigPath, "tunnel: another\ningress:\n - hostname: pane.example.com\n   service: http://127.0.0.1:9999\n");
    expect((await other.manager.check(config)).valid).toBe(false);
  });
  it("rejects duplicate ingress hostnames rather than assuming a later correct rule wins", async () => {
    const h = fixture(); h.files.set(config.tunnelConfigPath, "tunnel: existing-id\ningress:\n  - hostname: pane.example.com\n    service: http://127.0.0.1:9999\n  - hostname: pane.example.com\n    service: http://127.0.0.1:48322\n");
    expect((await h.manager.check(config)).valid).toBe(false);
  });
});
