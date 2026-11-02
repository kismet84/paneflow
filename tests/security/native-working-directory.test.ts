import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNativeWorkingDirectory, isAsarPath } from "../../electron/main/native-working-directory";

describe("native process working directories", () => {
  it("rejects archive roots and descendants with either separator and mixed case", () => {
    for (const path of ["D:/app/resources/app.asar", "D:/app/resources/app.asar/bin", "D:\\app\\resources\\APP.ASAR\\bin"]) {
      expect(isAsarPath(path)).toBe(true);
      expect(() => assertNativeWorkingDirectory(path)).toThrow("ASAR");
    }
    expect(isAsarPath("D:/app/resources/app.asar.unpacked")).toBe(false);
    expect(isAsarPath("D:/project/asar-assets")).toBe(false);
  });

  it("accepts real directories and rejects files, missing paths and relative cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-native-cwd-"));
    try {
      const file = join(root, "archive.bin");
      await writeFile(file, "test");
      await mkdir(join(root, "app.asar.unpacked"));
      expect(() => assertNativeWorkingDirectory(root)).not.toThrow();
      expect(() => assertNativeWorkingDirectory(join(root, "app.asar.unpacked"))).not.toThrow();
      expect(() => assertNativeWorkingDirectory(file)).toThrow();
      expect(() => assertNativeWorkingDirectory(join(root, "missing"))).toThrow();
      expect(() => assertNativeWorkingDirectory("relative")).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
