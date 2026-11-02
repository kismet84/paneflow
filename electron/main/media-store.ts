import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { clipboard, nativeImage } from "electron";
import type { MediaAttachment } from "../shared/contracts.js";
import { stableManagedId } from "./managed-id.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 40_000_000;
const MEDIA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024;

export class MediaStore {
  readonly #directory: string;
  #maintenancePromise: Promise<void> | null = null;
  #maintenanceRequested = false;

  constructor(directory: string) {
    this.#directory = resolve(directory);
  }

  get directory(): string {
    return this.#directory;
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
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.png$/i.test(entry.name)) continue;
      const path = resolve(this.#directory, entry.name);
      if (dirname(path) !== this.#directory) continue;
      const metadata = await stat(path);
      if (metadata.mtimeMs < Date.now() - MEDIA_RETENTION_MS) {
        await unlink(path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      } else {
        files.push({ path, mtimeMs: metadata.mtimeMs, size: metadata.size });
      }
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (totalBytes <= MAX_MEDIA_BYTES) break;
      await unlink(file.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      totalBytes -= file.size;
    }
  }

  async pasteClipboard(): Promise<MediaAttachment> {
    const items = await clipboard.read();
    const item = items.find((entry) => entry.types.some((type) => type.startsWith("image/")));
    const type = item?.types.find((entry) => entry.startsWith("image/"));
    if (!item || !type) throw new Error("剪贴板里没有可用的图片。" );
    const value = await item.getType(type);
    if (!(value instanceof Blob)) throw new Error("剪贴板里的图片格式无法读取。" );
    const image = nativeImage.createFromBuffer(Buffer.from(await value.arrayBuffer()));
    if (image.isEmpty()) {
      throw new Error("剪贴板里没有可用的图片。" );
    }
    this.#validateDimensions(image.getSize());
    const png = image.toPNG();
    return this.#writePng(png, "剪贴板图片.png", stableManagedId(png));
  }

  async importPath(sourcePath: string): Promise<MediaAttachment> {
    const normalizedPath = resolve(sourcePath.trim().replace(/^['\"]|['\"]$/g, ""));
    const sourceStat = await stat(normalizedPath);
    if (!sourceStat.isFile() || sourceStat.size > MAX_IMAGE_BYTES) {
      throw new Error("请选择不超过 15 MB 的图片文件。" );
    }
    const bytes = await readFile(normalizedPath);
    const id = stableManagedId(bytes);
    const existingPath = this.resolveAttachment(id);
    try {
      const existing = await stat(existingPath);
      if (existing.isFile()) {
        const now = new Date();
        await utimes(existingPath, now, now);
        await this.#scheduleMaintenance();
        return { id, name: basename(normalizedPath, extname(normalizedPath)) + ".png", url: `codex-media://media/${id}`, size: existing.size, kind: "local", sourcePath: existingPath };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) {
      throw new Error("这个文件不是可识别的图片。" );
    }
    this.#validateDimensions(image.getSize());
    return this.#writePng(image.toPNG(), basename(normalizedPath, extname(normalizedPath)) + ".png", id);
  }

  resolveAttachment(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new Error("图片引用无效。" );
    }
    const path = resolve(this.#directory, `${id}.png`);
    if (dirname(path) !== this.#directory) {
      throw new Error("图片路径不在应用管理目录中。" );
    }
    return path;
  }

  async read(id: string): Promise<Buffer> {
    return readFile(this.resolveAttachment(id));
  }

  async #writePng(bytes: Buffer, name: string, requestedId?: string): Promise<MediaAttachment> {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("图片转换后超过 15 MB，请压缩后重试。" );
    }
    await mkdir(this.#directory, { recursive: true });
    const id = requestedId ?? randomUUID();
    const sourcePath = join(this.#directory, `${id}.png`);
    try {
      await writeFile(sourcePath, bytes, { flag: "wx" });
      await this.#scheduleMaintenance();
      return { id, name, url: `codex-media://media/${id}`, size: bytes.byteLength, kind: "local", sourcePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await stat(sourcePath);
      const now = new Date();
      await utimes(sourcePath, now, now);
      await this.#scheduleMaintenance();
      return { id, name, url: `codex-media://media/${id}`, size: existing.size, kind: "local", sourcePath };
    }
  }

  #validateDimensions(size: Electron.Size): void {
    if (size.width < 1 || size.height < 1 || size.width > MAX_IMAGE_DIMENSION || size.height > MAX_IMAGE_DIMENSION || size.width * size.height > MAX_IMAGE_PIXELS) {
      throw new Error("图片尺寸过大，请使用边长不超过 8192 像素、总像素不超过 4000 万的图片。" );
    }
  }
}
