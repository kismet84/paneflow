import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { codexEnvironment, resolveCodexLaunch, spawnCodex, terminateCodexProcess, useCodexFixtureForTests } from "../../electron/main/codex-process";

describe("Codex process working directory", () => {
  it("bypasses local MCP endpoints while preserving external proxies and existing exclusions", () => {
    const original = { HTTPS_PROXY: "http://127.0.0.1:7897", NO_PROXY: "example.org", no_proxy: "internal.test" };
    const result = codexEnvironment(original);
    expect(result.HTTPS_PROXY).toBe(original.HTTPS_PROXY);
    expect(result.NO_PROXY).toBe("example.org,internal.test,localhost,127.0.0.1,::1");
    expect(result.no_proxy).toBe(result.NO_PROXY);
    expect(original.NO_PROXY).toBe("example.org");
  });
  it("terminates a directly managed Codex process without process-enumeration privileges", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    await terminateCodexProcess(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("resolves the long-lived npm Codex process instead of its short-lived cmd shim", async () => {
    const root = resolve("test-results", `codex-launch-${randomUUID()}`);
    const script = join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
    const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const executable = join(root, "node_modules", "@openai", "codex", "node_modules", "@openai", platformPackage, "vendor", target, "bin", "codex.exe");
    await Promise.all([mkdir(join(root, "node_modules", "@openai", "codex", "bin"), { recursive: true }), mkdir(dirname(executable), { recursive: true })]);
    await Promise.all([writeFile(join(root, "codex.cmd"), "@echo off", "utf8"), writeFile(script, "", "utf8"), writeFile(executable, "", "utf8")]);
    try {
      expect(resolveCodexLaunch({ PATH: root, ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toEqual({ command: executable, args: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts app-server with the explicitly configured global default directory", async () => {
    const cwd = resolve("test-results", `app-server-cwd-${randomUUID()}`);
    await mkdir(cwd, { recursive: true });
    useCodexFixtureForTests(resolve("tests", "fixtures", "fake-codex", "fake-app-server.mjs"));
    const child = spawnCodex(["app-server"], { cwd, env: { ...process.env, CODEX_PANE_REPORT_FIXTURE_CWD: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    try {
      const response = new Promise<Record<string, unknown>>((resolveResponse, reject) => {
        let output = "";
        child.once("error", reject);
        child.stdout?.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const lineEnd = output.indexOf("\n");
          if (lineEnd >= 0) resolveResponse(JSON.parse(output.slice(0, lineEnd)) as Record<string, unknown>);
        });
      });
      child.stdin?.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
      const message = await response;
      expect((message.result as Record<string, unknown>).fixtureCwd).toBe(cwd);
    } finally {
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      child.kill();
      await exited;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
import { spawn } from "node:child_process";
