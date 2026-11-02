import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../../electron/main/persistence";

const state = (draft: string) => ({
  version: 1 as const,
  layout: "quad" as const,
  splitSizes: {},
  defaultCwd: "",
  focusedPaneId: null,
  panes: [{ id: "pane-1", threadId: null, cwd: "", draft, attachments: [], model: null, effort: null }],
  window: { width: 1200, height: 800, maximized: false }
});

describe("StateStore I/O", () => {
  it("serializes concurrent atomic saves and leaves the final JSON readable", async () => {
    const directory = resolve("test-results", `state-store-${randomUUID()}`);
    const path = resolve(directory, "workspace.json");
    await mkdir(directory, { recursive: true });
    try {
      const store = new StateStore(path);
      await Promise.all(Array.from({ length: 20 }, (_, index) => store.save(state(`draft-${index}`))));
      expect((await store.load())?.panes[0]?.draft).toBe("draft-19");
      const content = await readFile(path, "utf8");
      expect(() => JSON.parse(content)).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses an unexpectedly large workspace file before parsing it", async () => {
    const directory = resolve("test-results", `state-store-large-${randomUUID()}`);
    const path = resolve(directory, "workspace.json");
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(path, "x".repeat(8 * 1024 * 1024 + 1), "utf8");
      const store = new StateStore(path);
      expect(await store.load()).toBeNull();
      expect(store.loadWarning).toContain("无法读取");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
