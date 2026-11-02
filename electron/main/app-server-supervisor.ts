import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { JsonLineParser, RuntimeProtocolValidator, isResponse, isServerRequest, parseEnvelope, type JsonRpcError, type JsonRpcNotification, type JsonRpcResponse, type RequestId } from "../../packages/protocol/src/index.js";
import { BASELINE, UNREGISTERED_CAPABILITY_REQUEST_METHODS } from "../../packages/protocol/src/method-manifest.js";
import type { ConnectionState, ProtocolEvent } from "../shared/contracts.js";
import { spawnCodex, terminateCodexProcess } from "./codex-process.js";
import { assertNativeWorkingDirectory } from "./native-working-directory.js";
import { redactSensitiveText } from "./sensitive-data.js";

type PendingCall = {
  generation: number;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

export const createServerRequestKey = (generation: number, id: RequestId): string => `${generation}:${typeof id}:${String(id)}`;

export class AppServerSupervisor extends EventEmitter {
  #child: ChildProcessWithoutNullStreams | null = null;
  #generation = 0;
  #nextRequestId = 1;
  #pending = new Map<RequestId, PendingCall>();
  #serverRequests = new Map<string, { generation: number; id: RequestId; method: string }>();
  #activeTurns = new Map<string, string>();
  #stopping = false;
  #restartUsed = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #stabilityTimer: NodeJS.Timeout | null = null;
  #validator: RuntimeProtocolValidator | null = null;
  #deltaNotifications = new Map<string, JsonRpcNotification>();
  #deltaTimer: NodeJS.Timeout | null = null;
  #workingDirectory: string;
  readonly #clientVersion: string;
  #state: ConnectionState = {
    phase: "stopped",
    generation: 0,
    codexVersion: null,
    compatible: null,
    message: "Codex 服务尚未启动"
  };

  constructor(workingDirectory: string, clientVersion: string) {
    super();
    this.#workingDirectory = workingDirectory;
    this.#clientVersion = clientVersion;
  }

  setWorkingDirectory(workingDirectory: string): void {
    this.#workingDirectory = workingDirectory;
  }

  get state(): ConnectionState {
    return { ...this.#state };
  }

  get hasActiveWork(): boolean {
    return this.#activeTurns.size > 0 || this.#serverRequests.size > 0;
  }

  get isRunning(): boolean {
    return this.#child !== null;
  }

  setRuntimeValidator(validator: RuntimeProtocolValidator): void {
    this.#validator = validator;
  }

  async interruptActiveWork(): Promise<void> {
    const turns = [...this.#activeTurns.entries()];
    await Promise.allSettled(turns.map(([threadId, turnId]) => this.call("turn/interrupt", { threadId, turnId }, 5_000)));
    for (const request of [...this.#serverRequests.values()]) {
      if (request.generation !== this.#generation) continue;
      try {
        this.respondToServer(request.generation, request.id, undefined, { code: -32000, message: "应用正在退出，请求已取消。" });
      } catch {
        // Turn interruption may resolve the request first.
      }
    }
  }

  async start(): Promise<void> {
    if (this.#child) {
      return;
    }
    this.#stopping = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#stabilityTimer) clearTimeout(this.#stabilityTimer);
    this.#generation += 1;
    this.#setState("starting", "正在连接本机 Codex…");

    const version = await this.#readVersion();
    this.#state.codexVersion = version;
    this.#state.compatible = version === BASELINE.codexVersion;

    await new Promise<void>((resolve, reject) => {
      const child = spawnCodex(["app-server"], {
        cwd: this.#workingDirectory,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env
      }) as ChildProcessWithoutNullStreams;
      this.#child = child;
      const parser = new JsonLineParser();
      const stderrDecoder = new StringDecoder("utf8");
      let stderrBuffer = "";
      let settled = false;

      const failStart = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (error) => {
        this.#child = null;
        failStart(new Error(`无法启动 Codex。请确认 codex 已安装并可从 PATH 运行。${error.message ? ` ${error.message}` : ""}`));
      });
      child.stdout.on("data", (chunk: Buffer) => parser.push(chunk));
      child.stdout.on("end", () => parser.end());
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuffer += stderrDecoder.write(chunk);
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) this.#emitProtocol("diagnostic", { level: "stderr", message: this.#redact(line) });
        }
        if (stderrBuffer.length > 20_000) {
          this.#emitProtocol("diagnostic", { level: "stderr", message: this.#redact(stderrBuffer.slice(0, 20_000)) });
          stderrBuffer = "";
        }
      });
      child.stderr.on("end", () => {
        stderrBuffer += stderrDecoder.end();
        if (stderrBuffer) this.#emitProtocol("diagnostic", { level: "stderr", message: this.#redact(stderrBuffer) });
      });
      const generation = this.#generation;
      child.stdin.on("error", (error) => void this.#handleTransportError(child, generation, new Error(`Codex 输入通道失败：${error.message}`)));
      parser.on("message", ({ value }: { value: unknown }) => {
        if (this.#child === child && this.#generation === generation) this.#handleMessage(value);
      });
      parser.on("invalid", (line: string) => {
        this.#emitProtocol("diagnostic", { level: "warning", message: "Codex 返回了无法识别的协议行", preview: this.#redact(line.slice(0, 500)) });
      });
      parser.on("error", (error: Error) => void this.#handleTransportError(child, generation, error));
      child.once("exit", (code, signal) => this.#handleExit(child, generation, code, signal));
    });

    try {
      await this.call("initialize", {
        clientInfo: { name: "codex_pane", title: "Codex Pane", version: this.#clientVersion },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
          optOutNotificationMethods: null,
          extensions: { "openai/form": {} }
        }
      }, 15_000);
      this.notify("initialized");
      const compatibilityMessage = this.#state.compatible
        ? `Codex ${version} 已连接`
        : `Codex ${version} 已连接；当前版本尚未完成全量兼容验证`;
      this.#setState("ready", compatibilityMessage);
      this.#stabilityTimer = setTimeout(() => { this.#restartUsed = false; }, 30_000);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#restartUsed = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (this.#stabilityTimer) {
      clearTimeout(this.#stabilityTimer);
      this.#stabilityTimer = null;
    }
    const child = this.#child;
    this.#child = null;
    this.#rejectAll(new Error("Codex 服务已停止"));
    this.#serverRequests.clear();
    this.#activeTurns.clear();
    this.#clearDeltaNotifications();
    if (child) {
      await this.#teardownChild(child);
    }
    this.#setState("stopped", "Codex 服务已停止");
  }

  async call(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const child = this.#child;
    if (!child || this.#state.phase === "stopped" || this.#state.phase === "error" || this.#state.phase === "restarting") {
      return Promise.reject(new Error("Codex 服务未连接，请先重试连接。"));
    }
    const cwd = params && typeof params === "object" && "cwd" in params ? params.cwd : undefined;
    if (typeof cwd === "string" && cwd) assertNativeWorkingDirectory(cwd);
    if (method === "thread/resume" && params && typeof params === "object" && "threadId" in params && !cwd) {
      const response = await this.call("thread/read", { threadId: params.threadId, includeTurns: false }, timeoutMs) as { thread?: { cwd?: string } };
      if (response.thread?.cwd) assertNativeWorkingDirectory(response.thread.cwd);
    }
    const id = this.#nextRequestId++;
    const generation = this.#generation;
    const request = { id, method, params };
    const validation = this.#validator?.validateClientRequest(request);
    if (validation && !validation.valid) {
      return Promise.reject(new Error(`Codex 请求参数不符合 ${BASELINE.codexVersion} 固定协议：${method}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex 操作等待超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { generation, resolve, reject, timer });
      try {
        this.#write(request);
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const notification = params === undefined ? { method } : { method, params };
    const validation = this.#validator?.validateClientNotification(notification);
    if (validation && !validation.valid) throw new Error(`Codex 通知不符合 ${BASELINE.codexVersion} 固定协议：${method}`);
    this.#write(notification);
  }

  respondToServer(requestGeneration: number, id: RequestId, result?: unknown, error?: JsonRpcError): void {
    const key = this.#serverRequestKey(requestGeneration, id);
    if (requestGeneration !== this.#generation || !this.#serverRequests.has(key)) {
      throw new Error("该确认请求已经过期，请等待 Codex 刷新状态。" );
    }
    const pendingRequest = this.#serverRequests.get(key)!;
    if (!error) {
      const validation = this.#validator?.validateServerResponse(pendingRequest.method, result);
      if (validation && !validation.valid) {
        throw new Error(`确认响应不符合 ${pendingRequest.method} 的固定协议，请检查填写内容后重试。`);
      }
    }
    this.#write(error ? { id, error } : { id, result });
    this.#serverRequests.delete(key);
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child || !child.stdin.writable) {
      throw new Error("Codex 连接不可用，请重试连接。" );
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(value: unknown): void {
    let envelope;
    try {
      envelope = parseEnvelope(value);
    } catch (error) {
      this.#emitProtocol("diagnostic", { level: "warning", message: "Codex 返回了格式不完整的消息", details: String(error) });
      return;
    }

    if (isResponse(envelope)) {
      if (this.#deltaNotifications.size) this.#flushDeltaNotifications();
      this.#handleResponse(envelope);
      return;
    }
    if (isServerRequest(envelope)) {
      if (this.#deltaNotifications.size) this.#flushDeltaNotifications();
      const validation = this.#validator?.validateServerRequest(envelope);
      if (validation && !validation.valid) {
        this.#emitProtocol("diagnostic", { level: "warning", message: `Codex 服务请求参数不符合 ${BASELINE.codexVersion} Schema：${envelope.method}`, errors: validation.errors.slice(0, 5) });
        this.#write({ id: envelope.id, error: { code: -32602, message: "Codex Pane 无法安全处理格式不完整的服务请求。" } });
        return;
      }
      if (envelope.method === "currentTime/read") {
        const result = { currentTimeAt: Math.floor(Date.now() / 1000) };
        const responseValidation = this.#validator?.validateServerResponse(envelope.method, result);
        if (responseValidation && !responseValidation.valid) {
          this.#write({ id: envelope.id, error: { code: -32603, message: "Codex Pane 无法生成有效的时间响应。" } });
          return;
        }
        this.#write({ id: envelope.id, result });
        return;
      }
      if ((UNREGISTERED_CAPABILITY_REQUEST_METHODS as readonly string[]).includes(envelope.method)) {
        this.#emitProtocol("diagnostic", { level: "warning", message: `Codex 请求了未注册的客户端能力，已安全拒绝：${envelope.method}` });
        this.#write({ id: envelope.id, error: { code: -32601, message: "Codex Pane 未注册此客户端能力。" } });
        return;
      }
      const key = this.#serverRequestKey(this.#generation, envelope.id);
      this.#serverRequests.set(key, { generation: this.#generation, id: envelope.id, method: envelope.method });
      this.#emitProtocol("server-request", envelope);
      return;
    }
    if (this.#bufferDeltaNotification(envelope)) return;
    if (this.#deltaNotifications.size) this.#flushDeltaNotifications();
    this.#handleNotification(envelope);
  }

  #bufferDeltaNotification(envelope: JsonRpcNotification): boolean {
    if (!envelope.method.includes("/delta") && !envelope.method.endsWith("outputDelta")) return false;
    const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
    const field = typeof params.delta === "string" ? "delta" : typeof params.output === "string" ? "output" : null;
    if (!field) return false;
    const key = [envelope.method, params.threadId, params.turnId, params.itemId].map(String).join(":");
    const previous = this.#deltaNotifications.get(key);
    if (previous) {
      const previousParams = previous.params as Record<string, unknown>;
      previousParams[field] = `${typeof previousParams[field] === "string" ? previousParams[field] : ""}${typeof params[field] === "string" ? params[field] : ""}`;
    } else {
      this.#deltaNotifications.set(key, { ...envelope, params: { ...params } });
    }
    if (!this.#deltaTimer) this.#deltaTimer = setTimeout(() => this.#flushDeltaNotifications(), 32);
    return true;
  }

  #flushDeltaNotifications(): void {
    if (this.#deltaTimer) clearTimeout(this.#deltaTimer);
    this.#deltaTimer = null;
    const notifications = [...this.#deltaNotifications.values()];
    this.#deltaNotifications.clear();
    for (const notification of notifications) this.#handleNotification(notification);
  }

  #clearDeltaNotifications(): void {
    if (this.#deltaTimer) clearTimeout(this.#deltaTimer);
    this.#deltaTimer = null;
    this.#deltaNotifications.clear();
  }

  #handleNotification(envelope: JsonRpcNotification): void {
    const validation = this.#validator?.validateServerNotification(envelope);
    if (validation && !validation.valid) {
      this.#emitProtocol("diagnostic", { level: "warning", message: `Codex 通知与固定 Schema 存在差异：${envelope.method}`, errors: validation.errors.slice(0, 5) });
    }
    if (envelope.method === "serverRequest/resolved") {
      const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.#serverRequests.delete(this.#serverRequestKey(this.#generation, requestId));
      }
    }
    if (envelope.method === "turn/started" || envelope.method === "turn/completed") {
      const params = envelope.params && typeof envelope.params === "object" ? envelope.params as Record<string, unknown> : {};
      const turn = params.turn && typeof params.turn === "object" ? params.turn as Record<string, unknown> : {};
      const threadId = typeof params.threadId === "string" ? params.threadId : null;
      const turnId = typeof turn.id === "string" ? turn.id : null;
      if (threadId && turnId) {
        if (envelope.method === "turn/started") this.#activeTurns.set(threadId, turnId);
        else this.#activeTurns.delete(threadId);
      }
    }
    this.#emitProtocol("notification", envelope);
  }

  #handleResponse(response: JsonRpcResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) {
      this.#emitProtocol("diagnostic", { level: "warning", message: "收到已过期或未知的 Codex 响应", id: response.id });
      return;
    }
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (pending.generation !== this.#generation) {
      pending.reject(new Error("Codex 已重新连接，旧请求结果已忽略。"));
      return;
    }
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  async #handleTransportError(child: ChildProcessWithoutNullStreams, generation: number, error: Error): Promise<void> {
    if (this.#stopping || this.#child !== child || this.#generation !== generation) return;
    this.#rejectAll(error);
    this.#serverRequests.clear();
    this.#activeTurns.clear();
    this.#clearDeltaNotifications();
    this.#child = null;
    await this.#teardownChild(child);
    if (this.#stopping || this.#generation !== generation) return;
    this.#scheduleRestart(error.message);
  }

  #handleExit(child: ChildProcessWithoutNullStreams, generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child || this.#generation !== generation) return;
    this.#child = null;
    this.#rejectAll(new Error("Codex 服务意外退出"));
    this.#serverRequests.clear();
    this.#activeTurns.clear();
    this.#clearDeltaNotifications();
    if (this.#stopping) {
      return;
    }
    const detail = code === null ? signal ?? "未知原因" : `退出码 ${code}`;
    this.#scheduleRestart(detail);
  }

  async #teardownChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    child.removeAllListeners();
    child.stdin.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    await terminateCodexProcess(child);
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #readVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawnCodex(["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      const failOversizedOutput = (): void => {
        finish(() => reject(new Error("codex --version 返回内容异常，已停止读取。")));
        void terminateCodexProcess(child);
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error("读取 Codex 版本超时。请在终端确认 codex --version 可以正常结束。")));
        void terminateCodexProcess(child);
      }, 10_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length + stderr.length > 64 * 1024) failOversizedOutput();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stdout.length + stderr.length > 64 * 1024) failOversizedOutput();
      });
      child.once("error", () => finish(() => reject(new Error("找不到 codex 命令。请安装 Codex CLI，并确认终端中可以运行 codex --version。"))));
      child.once("exit", (code) => {
        if (code !== 0) {
          finish(() => reject(new Error(`无法读取 Codex 版本。${this.#redact(stderr).trim()}`)));
          return;
        }
        const match = stdout.match(/codex-cli\s+([^\s]+)/i);
        finish(() => resolve(match?.[1] ?? (stdout.trim() || "未知")));
      });
    });
  }

  #setState(phase: ConnectionState["phase"], message: string): void {
    this.#state = { ...this.#state, phase, generation: this.#generation, message };
    this.emit("state", this.state);
  }

  #emitProtocol(kind: ProtocolEvent["kind"], payload: unknown): void {
    this.emit("protocol", { generation: this.#generation, kind, payload } satisfies ProtocolEvent);
  }

  #serverRequestKey(generation: number, id: RequestId): string {
    return createServerRequestKey(generation, id);
  }

  #redact(text: string): string {
    return redactSensitiveText(text);
  }

  #scheduleRestart(detail: string): void {
    if (!this.#restartUsed) {
      this.#restartUsed = true;
      this.#setState("restarting", `Codex 服务意外中断（${detail}），正在尝试恢复…`);
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        void this.start().catch((error) => this.#setState("error", `Codex 自动恢复失败：${String(error)}`));
      }, 500);
      return;
    }
    this.#setState("error", `Codex 服务再次中断（${detail}），请手动重试。`);
  }
}
