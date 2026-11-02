import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareUserDataLocation } from "../../electron/main/user-data-location";

const createRoot = (): string => resolve("test-results", `user-data-location-${randomUUID()}`);

describe("Electron user data location", () => {
  it("stores packaged data beside the executable without reading fallback data", async () => {
    const root = createRoot();
    const fallback = join(root, "fallback");
    const install = join(root, "install");
    await mkdir(join(fallback, "workspaces"), { recursive: true });
    await mkdir(install, { recursive: true });
    await writeFile(join(fallback, "workspaces", "default.json"), "fallback-workspace", "utf8");
    try {
      const location = prepareUserDataLocation({
        executablePath: join(install, "Codex Pane.exe"),
        applicationPath: root,
        fallbackUserDataPath: fallback,
        packaged: true
      });
      expect(location).toEqual({ path: join(install, "data"), warning: null });
      expect(await readFile(join(fallback, "workspaces", "default.json"), "utf8")).toBe("fallback-workspace");
      await expect(readFile(join(location.path, "workspaces", "default.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors an explicit test path", async () => {
    const root = createRoot();
    const explicit = join(root, "isolated");
    try {
      const location = prepareUserDataLocation({
        explicitPath: explicit,
        executablePath: join(root, "Codex Pane.exe"),
        applicationPath: root,
        fallbackUserDataPath: join(root, "fallback"),
        packaged: true
      });
      expect(location).toEqual({ path: explicit, warning: null });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back with a readable warning when the adjacent path is unavailable", async () => {
    const root = createRoot();
    const fallback = join(root, "fallback");
    const install = join(root, "install");
    await mkdir(install, { recursive: true });
    await writeFile(join(install, "data"), "not-a-directory", "utf8");
    try {
      const location = prepareUserDataLocation({
        executablePath: join(install, "Codex Pane.exe"),
        applicationPath: root,
        fallbackUserDataPath: fallback,
        packaged: true
      });
      expect(location.path).toBe(fallback);
      expect(location.warning).toContain("程序所在目录不可写");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("sets the userData path before reading it", async () => {
    const source = await readFile(resolve("electron/main/index.ts"), "utf8");
    const setPathIndex = source.indexOf('app.setPath("userData"');
    const getPathIndex = source.indexOf('app.getPath("userData")');
    expect(setPathIndex).toBeGreaterThan(-1);
    expect(getPathIndex).toBeGreaterThan(setPathIndex);
  });
});
