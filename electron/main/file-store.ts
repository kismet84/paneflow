import { constants } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink, utimes } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { FileReference } from "../shared/contracts.js";
import { stableManagedId } from "./managed-id.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MANAGED_FILE_BYTES = 1024 * 1024 * 1024;

export class FileStore {
  readonly #directory: string;
  #maintenancePromise: Promise<void> | null = null;
  #maintenanceRequested = false;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    await this.#scheduleMaintenance();
  }

  #scheduleMaintenance(): Promise<void> {
    this.#maintenanceRequested = true;
    if (this.#maintenancePromise) return this.#maintenancePromise;
    const operation = (async () => {
      while (this.#maintenanceRequested) {
        this.#maintenanceRequested = false;
        await this.#enforceRetentionAndQuota();
      }
    })();
    const tracked = operation.finally(() => {
      if (this.#maintenancePromise === tracked) this.#maintenancePromise = null;
    });
    this.#maintenancePromise = tracked;
    return tracked;
  }

  async #enforceRetentionAndQuota(): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}(?:\.[a-z0-9_-]{1,20})?$/i.test(entry.name)) continue;
      const path = resolve(this.#directory, entry.name);
      if (dirname(path) !== this.#directory) continue;
      const metadata = await stat(path);
      if (metadata.mtimeMs < Date.now() - FILE_RETENTION_MS) await unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      else files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= MAX_MANAGED_FILE_BYTES) break;
      await unlink(file.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      totalBytes -= file.size;
    }
  }

  async importPath(sourcePath: string): Promise<FileReference> {
    const normalizedPath = resolve(sourcePath.trim().replace(/^['"]|['"]$/g, ""));
    const sourceStat = await stat(normalizedPath);
    if (!sourceStat.isFile() || sourceStat.size > MAX_FILE_BYTES) {
      throw new Error("请选择不超过 100 MB 的文件。" );
    }
    const id = stableManagedId(`${process.platform === "win32" ? normalizedPath.toLocaleLowerCase() : normalizedPath}\0${sourceStat.size}\0${sourceStat.mtimeMs}\0${sourceStat.ctimeMs}`);
    const name = basename(normalizedPath);
    const destination = this.resolveAttachment(id, name);
    try {
      await copyFile(normalizedPath, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const now = new Date();
      await utimes(destination, now, now);
    }
    await this.#scheduleMaintenance();
    return { id, name, path: destination, managed: true };
  }

  resolveAttachment(id: string, name: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("文件引用无效。" );
    const extension = extname(basename(name));
    const safeExtension = /^\.[a-z0-9_-]{1,20}$/i.test(extension) ? extension : "";
    const path = resolve(this.#directory, `${id}${safeExtension}`);
    if (dirname(path) !== this.#directory) {
      throw new Error("文件路径不在应用管理目录中。" );
    }
    return path;
  }
}
