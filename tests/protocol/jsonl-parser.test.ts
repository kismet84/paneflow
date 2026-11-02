import { describe, expect, it, vi } from "vitest";
import { JsonLineParser } from "../../packages/protocol/src/jsonl-parser";

describe("JsonLineParser", () => {
  it("reassembles split lines and parses bursts", () => {
    const parser = new JsonLineParser();
    const messages: unknown[] = [];
    parser.on("message", ({ value }) => messages.push(value));
    parser.push('{"id":1,"res');
    parser.push('ult":{}}\n{"method":"warning","params":{}}\n');
    expect(messages).toEqual([{ id: 1, result: {} }, { method: "warning", params: {} }]);
  });

  it("isolates invalid JSON lines", () => {
    const parser = new JsonLineParser();
    const invalid = vi.fn();
    const messages = vi.fn();
    parser.on("invalid", invalid);
    parser.on("message", messages);
    parser.push("not-json\n{\"id\":2,\"result\":{}}\n");
    expect(invalid).toHaveBeenCalledOnce();
    expect(messages).toHaveBeenCalledOnce();
  });

  it("rejects oversized incomplete lines", () => {
    const parser = new JsonLineParser(16);
    const error = vi.fn();
    parser.on("error", error);
    parser.push("x".repeat(17));
    expect(error).toHaveBeenCalledOnce();
  });

  it("accepts a large burst when every individual line is within the limit", () => {
    const parser = new JsonLineParser(24);
    const messages: unknown[] = [];
    const error = vi.fn();
    parser.on("message", ({ value }) => messages.push(value));
    parser.on("error", error);
    parser.push('{"id":1,"result":{}}\n{"id":2,"result":{}}\n');
    expect(error).not.toHaveBeenCalled();
    expect(messages).toHaveLength(2);
  });

  it("preserves UTF-8 characters split across Buffer chunks", () => {
    const parser = new JsonLineParser();
    const messages: unknown[] = [];
    parser.on("message", ({ value }) => messages.push(value));
    const bytes = Buffer.from('{"message":"中文"}\n', "utf8");
    const splitAt = bytes.indexOf(Buffer.from("中")) + 1;
    parser.push(bytes.subarray(0, splitAt));
    parser.push(bytes.subarray(splitAt));
    expect(messages).toEqual([{ message: "中文" }]);
  });
});
