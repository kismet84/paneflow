import net from "node:net";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const MAX_FRAME = 8 * 1024 * 1024;
export type OfficialGrant = { threadId: string; pipe: string };
/** The desktop's own plugin channel. No process lifecycle or arbitrary RPC forwarding. */
export class OfficialDesktopControl {
  constructor(private readonly request = pipeRequest, private readonly discover = discoverPipes) {}
  async acquire(threadId: string): Promise<OfficialGrant> {
    const pipes = await this.discover();
    if (pipes.length !== 1) throw new Error(pipes.length ? "检测到多个官方桌面实例，请先明确要连接的实例。" : "未找到官方 Codex 桌面控制通道，请保持官方桌面端开启。");
    const grant = { threadId, pipe: pipes[0]! };
    await this.tool(grant, "read_thread", { threadId, hostId: "local", turnLimit: 1, includeOutputs: false });
    return grant;
  }
  async send(grant: OfficialGrant, prompt: string): Promise<void> {
    await this.tool(grant, "send_message_to_thread", { threadId: grant.threadId, hostId: "local", prompt });
  }
  private async tool(grant: OfficialGrant, tool: "read_thread" | "send_message_to_thread", args: Record<string, unknown>): Promise<void> {
    const result = await this.request(grant.pipe, "tools/call", { namespace: "codex_app", tool, arguments: args,
      callerSource: "codex", threadId: grant.threadId, hostId: "local", turnId: `paneflow-${randomUUID()}`, callId: `paneflow-${randomUUID()}` });
    if (!result || result.success !== true) {
      const detail = Array.isArray(result?.contentItems) ? result.contentItems.map((v: { text?: string }) => v.text || "").join("\n") : "";
      throw new Error(detail.slice(0, 1000) || "官方桌面端未确认操作结果，请核对会话，不要重复发送。");
    }
  }
}
export async function discoverPipes(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const names = await readdir("\\\\.\\pipe\\");
  return names.filter(name => /^codex-app-tools-[a-f0-9-]{36}$/i.test(name)).map(name => "\\\\.\\pipe\\" + name);
}
export function pipeRequest(pipe: string, method: string, params: unknown): Promise<any> {
  if (!/^\\\\\.\\pipe\\codex-app-tools-[a-f0-9-]{36}$/i.test(pipe)) return Promise.reject(new Error("官方控制通道地址无效。"));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipe); let pending = Buffer.alloc(0), done = false;
    const finish = (error?: Error, result?: unknown) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(new Error("官方桌面端响应超时，结果待核对；未自动重发。")), 20000);
    socket.once("error", error => finish(error));socket.once("close", () => { if (!done) finish(new Error("官方桌面连接中断，结果待核对。")); });
    socket.once("connect", () => { const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })); const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); socket.write(Buffer.concat([header, bytes])); });
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]); if (pending.length < 4) return;
      const size = pending.readUInt32LE(0); if (!size || size > MAX_FRAME) { finish(new Error("官方响应长度无效。")); return; }
      if (pending.length < size + 4) return;
      try { const reply = JSON.parse(pending.subarray(4, size + 4).toString("utf8")); if (reply.id !== 1) throw Error("官方响应标识无效。"); if (reply.error) throw Error(reply.error.message || "官方控制失败。"); finish(undefined, reply.result); } catch (error) { finish(error as Error); }
    });
  });
}
