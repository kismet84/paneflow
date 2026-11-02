import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("app-server release probe", () => {
  it("reports a missing Codex CLI without an unhandled child-process stack", () => {
    if (process.platform === "win32") return;
    const result = spawnSync(process.execPath, [resolve("scripts/probe-app-server.mjs")], {
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      timeout: 10_000
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Codex CLI was not found");
    expect(result.stderr).not.toContain("Unhandled 'error' event");
  });
});
