import { describe, expect, it } from "vitest";
import { summarizeNotice } from "../../src/notice-summary";
describe("desktop diagnostic summary", () => {
  it("explains invalid cwd without flooding the workspace with transport stack", () => {
    const message = "MCP 服务 open-design 启动失败： MCP HTTP headers helper failed to start: 目录名称无效。 (os error 267)";
    expect(summarizeNotice(message)).toContain("open-design");
    expect(summarizeNotice(message)).toContain("工作目录不存在或无效");
    expect(summarizeNotice(message)).not.toContain("Transport");
  });
  it("preserves short notices and limits other long notices", () => {
    expect(summarizeNotice("已连接")).toBe("已连接");
    expect(summarizeNotice("x".repeat(1000)).length).toBeLessThan(240);
  });
});
