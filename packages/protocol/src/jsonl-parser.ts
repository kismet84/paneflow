import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export type JsonLineEvent = {
  line: string;
  value: unknown;
};

export class JsonLineParser extends EventEmitter {
  readonly #maxLineBytes: number;
  readonly #decoder = new StringDecoder("utf8");
  #buffer = "";

  constructor(maxLineBytes = 16 * 1024 * 1024) {
    super();
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer | string): void {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.#acceptLine(line);
      }
      newlineIndex = this.#buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxLineBytes) {
      this.#buffer = "";
      this.emit("error", new Error("app-server 返回了过大的单行消息，已停止解析以保护应用。"));
    }
  }

  end(): void {
    this.#buffer += this.#decoder.end();
    if (this.#buffer.trim()) {
      this.#acceptLine(this.#buffer.replace(/\r$/, ""));
    }
    this.#buffer = "";
  }

  #acceptLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.#maxLineBytes) {
      this.emit("error", new Error("app-server 返回了过大的单行消息，已停止解析以保护应用。"));
      return;
    }
    this.#parseLine(line);
  }

  #parseLine(line: string): void {
    try {
      this.emit("message", { line, value: JSON.parse(line) } satisfies JsonLineEvent);
    } catch {
      this.emit("invalid", line);
    }
  }
}
