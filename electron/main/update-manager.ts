import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat, copyFile, lstat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { UPDATE_MANIFEST_URL, newerVersion, releaseAssetUrl, updateManifestSchema, type UpdateManifest, type UpdateStatus } from "../shared/update-contracts.js";

const allowedDownloadHosts = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
export async function fetchRelease(url: string, limit: number): Promise<Buffer> {
  let target = url;
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || !allowedDownloadHosts.has(parsed.hostname)) throw new Error("更新下载地址不在允许的 GitHub 域名范围。");
    const response = await fetch(target, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) { const location = response.headers.get("location"); if (!location) throw new Error("更新重定向无效。"); target = new URL(location, target).href; continue; }
    if (!response.ok || !response.body) throw new Error(response.status === 404 ? "尚未发布可用更新清单。" : `更新服务返回 HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > limit) throw new Error("更新文件超过大小限制。");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) { size += chunk.length; if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error("更新文件超过大小限制。"); } chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  throw new Error("更新重定向次数过多。");
}
export function validateUpdate(raw: unknown, current: string): UpdateManifest {
  const manifest = updateManifestSchema.parse(raw);
  if (!newerVersion(manifest.version, current)) throw new Error("没有高于当前版本的更新。");
  if (manifest.minProtocol > 1 || manifest.maxProtocol < 1) throw new Error("此更新与当前协议不兼容，请先查看迁移说明。");
  for (const asset of Object.values(manifest.assets)) if (!releaseAssetUrl(asset.url)) throw new Error("更新文件必须来自 PaneFlow 仓库的版本发布。");
  if (!manifest.assets.windows.url.endsWith(`/PaneFlow-Desktop-${manifest.version}-Setup.exe`) || !manifest.assets.android.url.endsWith(`/PaneFlow-Android-${manifest.version}.apk`)) throw new Error("更新文件名称与版本不匹配。");
  return manifest;
}
export function assertSeparateInstallData(executable: string, data: string): void {
  const install = dirname(resolve(executable));
  const nested = relative(install, resolve(data));
  if (nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))) throw new Error("旧便携数据位于程序目录内，请先按迁移说明分离数据，已停止升级。");
  const reverse = relative(resolve(data), install);
  if (reverse !== ".." && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse)) throw new Error("程序目录不能位于数据目录内，已停止升级。");
  if (basename(executable) !== "PaneFlow Desktop.exe") throw new Error("此入口仅支持已打包的 PaneFlow Desktop。");
}
export async function assertNoLinkedAncestors(path: string): Promise<void> {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("升级路径含符号链接或目录联接，已停止并保留原数据。"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export class UpdateManager {
  #manifest: UpdateManifest | null = null;
  #installer: string | null = null;
  #busy = false;
  constructor(readonly options: { version: string; dataDirectory: string; executable: string; helperScript: string; packaged: boolean; pendingWork: () => unknown[]; maintenance?: (enabled: boolean) => Promise<void>; quit: () => void; download?: typeof fetchRelease; launch?: (helper: string, plan: string) => Promise<void> }) {}
  status(message = "检查 GitHub 发布的新版本。"): UpdateStatus { return { currentVersion: this.options.version, available: Boolean(this.#manifest), compatible: Boolean(this.#manifest), manifest: this.#manifest, message, prepared: Boolean(this.#installer) }; }
  async check(): Promise<UpdateStatus> {
    if (this.#busy) throw new Error("更新操作进行中。");
    this.#manifest = null; this.#installer = null;
    const bytes = await (this.options.download ?? fetchRelease)(UPDATE_MANIFEST_URL, 128 * 1024);
    const raw = updateManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (!newerVersion(raw.version, this.options.version)) return this.status("当前已是已发布的最新版本。");
    this.#manifest = validateUpdate(raw, this.options.version);
    return this.status("有新版本。下载后仍需明确确认安装；运行中的任务必须先结束。");
  }
  #idle(): void { if (this.options.pendingWork().length) throw new Error("存在运行中、排队或结果未知的任务，请处理完后再升级。"); }
  async prepare(): Promise<UpdateStatus> {
    if (this.#busy || !this.#manifest) throw new Error("请先检查更新，等待当前操作完成。");
    this.#idle(); this.#busy = true;
    try {
      const asset = this.#manifest.assets.windows;
      const bytes = await (this.options.download ?? fetchRelease)(asset.url, asset.size);
      if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("更新文件校验失败，旧程序和数据保持不变。");
      const directory = join(this.options.dataDirectory, "updates", this.#manifest.version);
      await mkdir(directory, { recursive: true });
      const installer = join(directory, `PaneFlow-Desktop-${this.#manifest.version}-Setup.exe`);
      await writeFile(installer + ".part", bytes, { flush: true }); await rename(installer + ".part", installer);
      this.#installer = installer;
      return this.status("安装包校验通过。确认安装后将备份配置和旧程序；失败自动恢复旧程序，恢复材料保留。");
    } finally { this.#busy = false; }
  }
  async install(): Promise<void> {
    if (this.#busy || !this.#manifest || !this.#installer || !this.options.packaged) throw new Error("请在正式打包程序中完成下载后安装。");
    this.#idle(); assertSeparateInstallData(this.options.executable, this.options.dataDirectory);
    this.#busy = true;
    try {
      await assertNoLinkedAncestors(this.options.executable); await assertNoLinkedAncestors(this.options.dataDirectory); await assertNoLinkedAncestors(this.#installer);
      const bytes = await readFile(this.#installer), asset = this.#manifest.assets.windows;
      if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("安装前校验失败。");
      await stat(this.options.helperScript);
      const planDirectory = join(this.options.dataDirectory, "updates", `apply-${Date.now()}`); await mkdir(planDirectory, { recursive: true });
      const helper = join(planDirectory, "apply-update.ps1"); await copyFile(this.options.helperScript, helper);
      const plan = join(planDirectory, "plan.json");
      await writeFile(plan, JSON.stringify({ processId: process.pid, executable: resolve(this.options.executable), dataDirectory: resolve(this.options.dataDirectory), installer: resolve(this.#installer), version: this.#manifest.version, sha256: asset.sha256, backupDirectory: join(planDirectory, "backup") }), { flush: true });
      await this.options.maintenance?.(true);
      this.#idle();
      if (this.options.launch) await this.options.launch(helper, plan);
      else {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", helper, "-PlanPath", plan], { detached: true, windowsHide: true, stdio: "ignore" });
        await new Promise<void>((ok, fail) => { child.once("spawn", ok); child.once("error", fail); }); child.unref();
      }
      this.options.quit();
    } catch (error) { await this.options.maintenance?.(false); this.#busy = false; throw error; }
  }
}
