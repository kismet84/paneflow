import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { deploymentConfigSchema, type DeploymentConfig, type DeploymentCheckResult, type DeploymentStatus } from "../shared/deployment-contracts.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { resolveCodexLaunch } from "./codex-process.js";

const executeFile = promisify(execFile);
export type OwnedChild = Pick<ChildProcess, "pid" | "send" | "once" | "on" | "off">;
export interface DeploymentDependencies {
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  pathKind(path: string): Promise<"file" | "directory" | "missing">;
  findExecutable(name: string): Promise<string | null>;
  probeExecutable(path: string, args: string[]): Promise<boolean>;
  portAvailable(port: number): Promise<boolean>;
  probeHealth(url: string, expectedInstance?: string): Promise<boolean>;
  processAlive(pid: number): boolean;
  spawn(path: string, args: string[], options: SpawnOptions): OwnedChild;
  wait(ms: number): Promise<void>;
  schedule(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}
export type DeploymentManagerOptions = {
  dataDirectory: string; relayEntry: string; version: string; codexPath?: string; childWrapper?: string;
  setRemoteSettings(origin: string): Promise<void>;
  setWorkingDirectory(cwd: string): void | Promise<void>;
  loginItem: { get(): boolean; set(enabled: boolean): void | Promise<void> };
  pendingWork(): unknown[];
  dependencies?: Partial<DeploymentDependencies>;
};

const defaults: DeploymentDependencies = {
  readText: path => readFile(path, "utf8"),
  writeText: (path, data) => writeFile(path, data, { mode: 0o600, flush: true }),
  mkdir: async path => { await mkdir(path, { recursive: true }); }, rename, copyFile,
  pathKind: async path => { try { const value = await stat(path); return value.isDirectory() ? "directory" : value.isFile() ? "file" : "missing"; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; } },
  findExecutable: async name => {
    if (name === "codex.exe") {
      const launch = resolveCodexLaunch();
      if (!launch.args.length && /(?:^|[\\/])codex\.exe$/i.test(launch.command)) return launch.command;
    }
    try { const { stdout } = await executeFile("where.exe", [name], { windowsHide: true, timeout: 5000 }); return stdout.split(/\r?\n/).find(line => /\.exe$/i.test(line.trim()))?.trim() ?? null; } catch { return null; }
  },
  probeExecutable: async (path, args) => { try { await executeFile(path, args, { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 }); return true; } catch { return false; } },
  portAvailable: port => new Promise(resolve => { const server = createServer(); server.once("error", () => resolve(false)); server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true))); }),
  probeHealth: async (url, expectedInstance) => { try { const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" }); if (!response.ok) return false; const data = await response.json() as { ok?: boolean; protocolVersion?: number; instanceId?: string }; return data.ok === true && data.protocolVersion === 1 && (!expectedInstance || data.instanceId === expectedInstance); } catch { return false; } },
  processAlive: pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
  spawn: (path, args, options) => spawn(path, args, options),
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  schedule: (callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; }, cancel: clearTimeout
};

/** Owns only the children it creates. It never adopts, kills, or replaces an external deployment. */
export class DeploymentManager extends EventEmitter {
  readonly #deps: DeploymentDependencies;
  readonly #serial = new SerialTaskQueue();
  #config: DeploymentConfig | null = null;
  #loaded = false;
  #relay: OwnedChild | null = null;
  #tunnel: OwnedChild | null = null;
  #wanted = false;
  #epoch = 0;
  #attempt = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #phase: DeploymentStatus["phase"] = "unconfigured";
  #message = "尚未配置本机部署";
  #connectivityValidated = false;
  #settingsApplied = false;
  #instanceNonce: string | null = null;
  readonly #stoppingChildren = new Set<OwnedChild>();
  constructor(readonly options: DeploymentManagerOptions) { super(); this.#deps = { ...defaults, ...options.dependencies }; }
  get #configPath(): string { return join(this.options.dataDirectory, "deployment.json"); }
  get #wrapperPath(): string { return this.options.childWrapper ?? join(process.cwd(), "scripts", "deployment-child.mjs"); }

  async getConfig(): Promise<DeploymentConfig | null> {
    if (!this.#loaded) {
      try { this.#config = deploymentConfigSchema.parse(JSON.parse(await this.#deps.readText(this.#configPath))); this.#phase = "stopped"; this.#message = "配置已读取，尚未启动自有服务"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.#phase = "error"; this.#message = "部署配置无法读取，已保留原文件，禁止自动覆盖"; throw new Error(this.#message, { cause: error }); } }
      this.#loaded = true;
    }
    return this.#config ? structuredClone(this.#config) : null;
  }

  status(): DeploymentStatus {
    return { phase: this.#phase, message: this.#message, version: this.options.version, configured: this.#config !== null, autostart: this.options.loginItem.get(), relayPid: this.#relay?.pid ?? null, tunnelPid: this.#tunnel?.pid ?? null, origin: this.#config?.origin ?? null };
  }

  async check(raw: unknown): Promise<DeploymentCheckResult> {
    const parsed = deploymentConfigSchema.safeParse(raw);
    if (!parsed.success) return { valid: false, connectivity: false, checks: [{ key: "config", label: "配置格式", ok: false, detail: parsed.error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("；") }] };
    const config = parsed.data;
    const checks: DeploymentCheckResult["checks"] = [];
    const add = (key: string, label: string, ok: boolean, detail: string) => checks.push({ key, label, ok, detail });
    const codex = this.options.codexPath ?? await this.#deps.findExecutable("codex.exe");
    const executableChecks = await Promise.all([
      codex ? this.#deps.pathKind(codex).then(kind => kind === "file" && this.#deps.probeExecutable(codex, ["--version"])) : false,
      this.#deps.pathKind(config.nodePath).then(kind => kind === "file" && this.#deps.probeExecutable(config.nodePath, ["--version"])),
      this.#deps.pathKind(config.cloudflaredPath).then(kind => kind === "file" && this.#deps.probeExecutable(config.cloudflaredPath, ["--version"]))
    ]);
    ["codex", "node", "cloudflared"].forEach((name, index) => add(name, `${name} 可执行文件`, executableChecks[index] === true, executableChecks[index] ? "可执行检查通过" : "未找到可用程序，请检查绝对路径与安装状态"));
    add("cwd", "工作目录", await this.#deps.pathKind(config.cwd) === "directory", "工作目录必须已存在");
    add("relayEntry", "中继程序", await this.#deps.pathKind(this.options.relayEntry) === "file", "使用本安装包提供的中继程序");
    add("childWrapper", "子进程看护", await this.#deps.pathKind(this.#wrapperPath) === "file", "桌面退出或崩溃时只清理本次自有子服务");
    const ownsPort = Boolean(this.#relay && this.#config?.port === config.port);
    add("port", "本地端口", ownsPort || await this.#deps.portAvailable(config.port), ownsPort ? "端口由当前管理器自有中继使用" : "必须空闲，仅监听 127.0.0.1；占用时不会停止现有程序");
    const external = await this.#hasExternalDeployment();
    add("externalDeployment", "既有部署", !external, external ? "检测到既有启动器的存活进程，保持原部署；不能重复启动" : "未检测到既有启动器的存活进程");
    let tunnelValid = false;
    try {
      const yaml = await this.#deps.readText(config.tunnelConfigPath);
      tunnelValid = this.#matchesTunnel(yaml, config) && executableChecks[2] === true && await this.#deps.probeExecutable(config.cloudflaredPath, ["tunnel", "--config", config.tunnelConfigPath, "ingress", "validate"]);
    } catch { /* Config contents may include credentials; never copy them into diagnostics. */ }
    add("tunnelConfig", "已有隧道配置", tunnelValid, tunnelValid ? "隧道标识、域名与本地端口匹配；未创建或修改云端资源" : "已有 YAML 必须包含匹配的 tunnel、hostname 和 http://127.0.0.1:端口 ingress，并通过 cloudflared 验证");
    const work = this.options.pendingWork();
    add("work", "当前任务", work.length === 0, work.length ? "存在执行、队列或连接状态待核对；操作时将再次检查" : "未发现待处理任务");
    const expectedInstance = ownsPort && this.#config?.origin === config.origin ? this.#instanceNonce ?? undefined : undefined;
    const [local, publicReachable] = await Promise.all([this.#deps.probeHealth(`http://127.0.0.1:${config.port}/health`, expectedInstance), this.#deps.probeHealth(`${config.origin}/health`, expectedInstance)]);
    add("localHealth", "本地中继连通", local, local ? "中继协议健康检查通过" : "未连接；启动后再测试");
    add("publicHealth", "固定公网入口", publicReachable, publicReachable ? "HTTPS 中继协议健康检查通过" : "公网未通过测试；不能开启登录自启");
    return { valid: checks.filter(check => !["localHealth", "publicHealth", "work"].includes(check.key)).every(check => check.ok), connectivity: local && publicReachable, checks };
  }

  async save(raw: unknown): Promise<DeploymentConfig> {
    return this.#serial.enqueue(async () => {
      await this.getConfig(); this.#guard(true);
      if (this.#relay || this.#tunnel) throw new Error("请先停止本管理器的服务再修改部署配置。");
      const config = deploymentConfigSchema.parse(raw);
      const result = await this.check(config);
      if (!result.valid) throw new Error(result.checks.filter(check => !check.ok && !["localHealth", "publicHealth", "work"].includes(check.key)).map(check => `${check.label}：${check.detail}`).join("；"));
      this.#guard(true);
      await this.#deps.mkdir(this.options.dataDirectory);
      if (this.#config) await this.#deps.copyFile(this.#configPath, `${this.#configPath}.${Date.now()}.${randomUUID()}.bak`);
      const temporary = `${this.#configPath}.${randomUUID()}.tmp`;
      await this.#deps.writeText(temporary, JSON.stringify(config, null, 2));
      await this.#deps.rename(temporary, this.#configPath);
      this.#config = config; this.#connectivityValidated = false; this.#settingsApplied = false;
      this.#setStatus("stopped", "配置已保存，现有云端资源未修改；请启动并测试连接");
      return structuredClone(config);
    });
  }

  async start(): Promise<DeploymentStatus> {
    return this.#serial.enqueue(async () => {
      const config = await this.getConfig();
      if (!config?.enabled) throw new Error("部署未配置或尚未启用，不会自动启动。");
      if (this.#relay || this.#tunnel) {
        if (this.#relay && this.#tunnel && this.#connectivityValidated && !this.#settingsApplied) {
          this.#guard(true);
          await this.options.setWorkingDirectory(config.cwd);
          this.#guard(true);
          await this.options.setRemoteSettings(config.origin);
          this.#settingsApplied = true;
          this.#setStatus("running", "本地中继与固定公网入口已通过连接测试");
        }
        return this.status();
      }
      this.#guard(true);
      const result = await this.check(config);
      if (!result.valid) throw new Error("部署预检未通过，请先检查路径、端口和既有隧道配置。");
      this.#guard(true); this.#wanted = true; this.#epoch++; this.#attempt = 0;
      await this.#launch(this.#epoch);
      return this.status();
    });
  }

  async stop(options: { shutdown?: boolean } = {}): Promise<DeploymentStatus> {
    return this.#serial.enqueue(async () => {
      if (!options.shutdown) this.#guard(false);
      this.#wanted = false; this.#epoch++; this.#connectivityValidated = false;
      if (this.#retry) this.#deps.cancel(this.#retry); this.#retry = null;
      await this.#stopOwned();
      this.#setStatus(this.#config ? "stopped" : "unconfigured", "本管理器创建的服务已停止；既有服务未操作");
      return this.status();
    });
  }

  async setAutostart(enabled: boolean): Promise<DeploymentStatus> {
    return this.#serial.enqueue(async () => {
      this.#guard(true);
      if (enabled) {
        if (!this.#config?.enabled || !this.#relay || !this.#tunnel || !this.#connectivityValidated) throw new Error("先启动本机部署并通过本地与公网连通测试，再开启登录自启。");
        const [local, remote] = await Promise.all([this.#deps.probeHealth(`http://127.0.0.1:${this.#config.port}/health`, this.#instanceNonce!), this.#deps.probeHealth(`${this.#config.origin}/health`, this.#instanceNonce!)]);
        this.#guard(false);
        if (!local || !remote) throw new Error("当前本地或公网连接测试失败，未开启登录自启。");
      }
      await this.options.loginItem.set(enabled);
      this.emit("status", this.status()); return this.status();
    });
  }

  #guard(allowInitialConnectionUnknown: boolean): void {
    const pending = this.options.pendingWork();
    const connectionOnly = pending.length > 0 && pending.every(work => work && typeof work === "object" && (work as { kind?: unknown }).kind === "connection");
    if (pending.length && !(allowInitialConnectionUnknown && connectionOnly)) throw new Error("当前有执行、排队或待核对任务，已阻止部署变更；请先处理后重试。");
  }

  async #hasExternalDeployment(): Promise<boolean> {
    try {
      const data = JSON.parse(await this.#deps.readText(join(this.options.dataDirectory, "launcher.json"))) as Record<string, unknown>;
      return ["supervisorPid", "relayPid", "tunnelPid"].some(key => Number.isInteger(data[key]) && Number(data[key]) > 0 && this.#deps.processAlive(Number(data[key])));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return true; }
  }

  #matchesTunnel(yaml: string, config: DeploymentConfig): boolean {
    // Accept the ordinary explicit ingress mapping; reject aliases/flow mappings rather than guess their meaning.
    if (/^[ \t]*[\w-]+:[ \t]*[&*!{[]/m.test(yaml)) return false;
    const scalar = (value: string) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    const tunnel = yaml.match(/^tunnel:\s*([^\r\n#]+)/m)?.[1];
    if (!tunnel || scalar(tunnel) !== config.tunnelId) return false;
    const entries = yaml.split(/^\s*-\s+hostname:\s*/m).slice(1);
    if (entries.some(entry => scalar(entry.split(/\r?\n/)[0] ?? "").includes("*"))) return false;
    const matches = entries.filter(entry => scalar(entry.split(/\r?\n/)[0] ?? "") === new URL(config.origin).hostname);
    if (matches.length !== 1) return false;
    return matches.some(entry => {
      const hostname = scalar(entry.split(/\r?\n/)[0] ?? "");
      const service = entry.match(/^\s+service:\s*([^\r\n#]+)/m)?.[1];
      return hostname === new URL(config.origin).hostname && service !== undefined && scalar(service) === `http://127.0.0.1:${config.port}`;
    });
  }

  async #launch(epoch: number, recovering = false): Promise<void> {
    const config = this.#config!;
    if (!this.#wanted || epoch !== this.#epoch) return;
    if (!recovering) this.#guard(true);
    if (!await this.#deps.portAvailable(config.port) || await this.#hasExternalDeployment()) { this.#wanted = false; this.#setStatus("error", "端口被其他服务占用或发现既有部署，未启动重复服务"); return; }
    this.#setStatus("starting", "正在启动自有本地中继与已有固定域名隧道");
    try {
      const instance = randomUUID(); this.#instanceNonce = instance;
      const relay = this.#deps.spawn(config.nodePath, [this.#wrapperPath, "relay", config.nodePath, this.options.relayEntry], { cwd: config.cwd, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, HOST: "127.0.0.1", PORT: String(config.port), PUBLIC_ORIGIN: config.origin, BASE_PATH: "/", PANEFLOW_RELAY_INSTANCE: instance } });
      this.#relay = relay;
      await this.#waitRelay(relay, config.port);
      if (!this.#wanted || epoch !== this.#epoch || this.#relay !== relay) return;
      if (!recovering) this.#guard(true);
      const tunnel = this.#deps.spawn(config.nodePath, [this.#wrapperPath, "tunnel", config.cloudflaredPath, "tunnel", "--config", config.tunnelConfigPath, "run", config.tunnelId], { cwd: config.cwd, windowsHide: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
      this.#tunnel = tunnel;
      this.#watch(relay, "relay", epoch); this.#watch(tunnel, "tunnel", epoch);
      let connected = false;
      for (let attempt = 0; attempt < 5 && this.#wanted && epoch === this.#epoch; attempt++) {
        const [local, remote] = await Promise.all([this.#deps.probeHealth(`http://127.0.0.1:${config.port}/health`, instance), this.#deps.probeHealth(`${config.origin}/health`, instance)]);
        if (local && remote && this.#relay === relay && this.#tunnel === tunnel) { connected = true; break; }
        await this.#deps.wait(1000 * Math.min(attempt + 1, 3));
      }
      if (!this.#wanted || epoch !== this.#epoch) return;
      this.#connectivityValidated = connected;
      if (connected) {
        if (!recovering) {
          this.#guard(true);
          await this.options.setWorkingDirectory(config.cwd);
          this.#guard(true);
          await this.options.setRemoteSettings(config.origin);
          this.#settingsApplied = true;
        }
        this.#attempt = 0;
        this.#setStatus(this.#settingsApplied ? "running" : "degraded", this.#settingsApplied ? "本地中继与固定公网入口已通过连接测试" : "连接已恢复，首次配置尚未应用；请手动启动完成配置");
      } else { this.#setStatus("degraded", "自有服务已启动，但公网连接测试未通过；正在重试健康检查"); this.#scheduleHealthProbe(epoch); }
    } catch {
      this.#connectivityValidated = false;
      await this.#stopOwned();
      this.#setStatus("error", "部署启动失败，已清理本次自有子进程；原配置与既有服务保留");
      this.#scheduleRetry(epoch);
    }
  }

  #waitRelay(child: OwnedChild, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { this.#deps.cancel(timer); child.off("message", message); child.off("error", failed); child.off("exit", failed); error ? reject(error) : resolve(); };
      const message = (value: unknown) => { const data = value as { type?: string; port?: number }; if (data?.type === "relay.ready" && data.port === port) finish(); };
      const failed = () => finish(new Error("自有中继启动失败"));
      const timer = this.#deps.schedule(failed, 15000);
      child.on("message", message); child.once("error", failed); child.once("exit", failed);
    });
  }
  #watch(child: OwnedChild, kind: "relay" | "tunnel", epoch: number): void {
    const closed = () => {
      if (kind === "relay" && this.#relay === child) this.#relay = null;
      if (kind === "tunnel" && this.#tunnel === child) this.#tunnel = null;
      this.#connectivityValidated = false;
      if (this.#stoppingChildren.has(child)) return;
      if (!this.#wanted || epoch !== this.#epoch) return;
      this.#setStatus("degraded", "自有部署子进程退出，等待安全重连");
      this.#scheduleRetry(epoch);
    };
    child.once("exit", closed);
    child.once("error", () => {
      this.#connectivityValidated = false;
      if (!this.#wanted || epoch !== this.#epoch || this.#stoppingChildren.has(child)) return;
      // An error does not prove process exit. Retain the owned handle until exit or verified cleanup.
      this.#setStatus("degraded", "自有部署子进程异常，保留句柄等待安全重连"); this.#scheduleRetry(epoch);
    });
  }
  #scheduleRetry(epoch: number): void {
    if (this.#retry || !this.#wanted || epoch !== this.#epoch) return;
    const delay = Math.min(30000, 1000 * 2 ** this.#attempt++);
    this.#retry = this.#deps.schedule(() => {
      this.#retry = null;
      void this.#serial.enqueue(async () => {
        if (!this.#wanted || epoch !== this.#epoch) return;
        // Transport recovery must work during approvals/unknown tasks. Only rebuild our owned
        // relay/tunnel; never stop Codex, change task/config state, or replay an operation.
        await this.#stopOwned(); await this.#launch(epoch, true);
      }).catch(() => { this.#setStatus("error", "自动重连未通过安全检查，请查看诊断后重试"); });
    }, delay);
  }
  #scheduleHealthProbe(epoch: number): void {
    if (this.#retry || !this.#wanted || epoch !== this.#epoch) return;
    this.#retry = this.#deps.schedule(() => {
      this.#retry = null;
      void this.#serial.enqueue(async () => {
        if (!this.#wanted || epoch !== this.#epoch || !this.#config) return;
        if (!this.#relay || !this.#tunnel) { this.#scheduleRetry(epoch); return; }
        const config = this.#config, instance = this.#instanceNonce;
        if (!instance) return;
        const [local, remote] = await Promise.all([this.#deps.probeHealth(`http://127.0.0.1:${config.port}/health`, instance), this.#deps.probeHealth(`${config.origin}/health`, instance)]);
        if (!this.#wanted || epoch !== this.#epoch) return;
        if (!local || !remote) { this.#scheduleHealthProbe(epoch); return; }
        this.#connectivityValidated = true; this.#attempt = 0;
        if (!this.#settingsApplied && this.options.pendingWork().length === 0) {
          // Complete the user's original start only when idle. Recovery never changes task state.
          this.#guard(false); await this.options.setWorkingDirectory(config.cwd);
          this.#guard(false); await this.options.setRemoteSettings(config.origin); this.#settingsApplied = true;
        }
        this.#setStatus("running", this.#settingsApplied ? "公网连接已恢复，并通过本地／公网实例一致性验证" : "公网连接已恢复；当前有任务，首次配置请空闲后手动启动完成");
      }).catch(() => { this.#setStatus("degraded", "连接恢复后配置尚未完成，保留服务；请空闲后手动启动"); });
    }, Math.min(30000, 1000 * 2 ** this.#attempt++));
  }
  async #stopOwned(): Promise<void> {
    const children = [this.#tunnel, this.#relay].filter((child): child is OwnedChild => child !== null);
    await Promise.all(children.map(async child => {
      this.#stoppingChildren.add(child);
      try {
        await new Promise<void>((resolve, reject) => {
          const done = (error?: Error) => { this.#deps.cancel(timer); child.off("exit", exited); error ? reject(error) : resolve(); };
          const exited = () => done();
          const timer = this.#deps.schedule(() => { if (child.pid && this.#deps.processAlive(child.pid)) done(new Error("自有子进程尚未退出，保留句柄以供重试清理")); else done(); }, 6000);
          child.once("exit", exited);
          try { child.send({ type: "deployment.stop" }, error => { if (error && (!child.pid || !this.#deps.processAlive(child.pid))) done(); }); }
          catch { if (!child.pid || !this.#deps.processAlive(child.pid)) done(); else done(new Error("无法停止自有子进程")); }
        });
        if (this.#relay === child) this.#relay = null;
        if (this.#tunnel === child) this.#tunnel = null;
      } finally { this.#stoppingChildren.delete(child); }
    }));
    this.#instanceNonce = null;
  }
  #setStatus(phase: DeploymentStatus["phase"], message: string): void { this.#phase = phase; this.#message = message; this.emit("status", this.status()); }
}
