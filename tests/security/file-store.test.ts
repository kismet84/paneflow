import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../../electron/main/file-store";

let testDirectory = "";

afterEach(async () => {
  if (testDirectory) await rm(testDirectory, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("copies a selected file into the managed data directory and preserves its extension", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "codex-pane-files-"));
    const source = join(testDirectory, "notes.txt");
    const managedDirectory = join(testDirectory, "data", "files");
    await writeFile(source, "managed attachment", "utf8");
    const store = new FileStore(managedDirectory);
    await store.initialize();

    const reference = await store.importPath(source);
    const duplicate = await store.importPath(source);
    const managedPath = store.resolveAttachment(reference.id, reference.name);

    expect(reference).toMatchObject({ name: "notes.txt", managed: true });
    expect(duplicate.id).toBe(reference.id);
    expect(await readdir(managedDirectory)).toHaveLength(1);
    expect(managedPath).toContain(managedDirectory);
    expect(managedPath).toMatch(/\.txt$/);
    expect(await readFile(managedPath, "utf8")).toBe("managed attachment");
  });

  it("removes stale managed files during startup without touching unrelated entries", async () => {
    testDirectory = await mkdtemp(join(tmpdir(), "codex-pane-files-"));
    const managedDirectory = join(testDirectory, "data", "files");
    const store = new FileStore(managedDirectory);
    await store.initialize();
    const stale = join(managedDirectory, "11111111-1111-4111-8111-111111111111.txt");
    const unrelated = join(managedDirectory, "keep-me.txt");
    await writeFile(stale, "stale", "utf8");
    await writeFile(unrelated, "unrelated", "utf8");
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await store.initialize();

    expect(await readdir(managedDirectory)).toEqual(["keep-me.txt"]);
  });
});
