import { describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UpdateManager, validateUpdate, assertSeparateInstallData, assertNoLinkedAncestors } from "../../electron/main/update-manager";
import { releaseAssetUrl } from "../../electron/shared/update-contracts";
const payload = Buffer.from("controlled installer fixture");
const manifest = () => ({ schemaVersion: 1, version: "0.8.0", minProtocol: 1, maxProtocol: 1, notes: "test update", assets: {
  windows: { url: "https://github.com/kismet84/paneflow/releases/download/v0.8.0/PaneFlow-Desktop-0.8.0-Setup.exe", sha256: createHash("sha256").update(payload).digest("hex"), size: payload.length },
  android: { url: "https://github.com/kismet84/paneflow/releases/download/v0.8.0/PaneFlow-Android-0.8.0.apk", sha256: "0".repeat(64), size: 1, versionCode: 10, packageName: "com.codexpane.companion" }
} });
describe("explicit update validation", () => {
  it("rejects foreign release origins, credentials, downgrade, incompatible protocols and misleading filenames", () => {
    expect(validateUpdate(manifest(), "0.7.0").version).toBe("0.8.0");
    for (const url of ["https://github.com/other/repo/releases/download/v1/a.exe", "http://github.com/kismet84/paneflow/releases/download/v1/a.exe", "https://github.com.evil.test/kismet84/paneflow/releases/download/v1/a.exe", "https://user@github.com/kismet84/paneflow/releases/download/v1/a.exe"]) expect(releaseAssetUrl(url)).toBe(false);
    expect(() => validateUpdate(manifest(), "0.9.0")).toThrow();
    expect(() => validateUpdate({ ...manifest(), minProtocol: 2 }, "0.7.0")).toThrow("不兼容");
    const bad = manifest(); bad.assets.windows.url = bad.assets.windows.url.replace("0.8.0-Setup", "9.0.0-Setup"); expect(() => validateUpdate(bad,"0.7.0")).toThrow("名称");
  });
  it("refuses to overwrite colocated portable data, including dot-prefixed children", () => {
    const exe = resolve("test-results/install/PaneFlow Desktop.exe");
    for (const child of ["data", "..data"]) expect(() => assertSeparateInstallData(exe, resolve("test-results/install", child))).toThrow("便携");
    expect(() => assertSeparateInstallData(exe, resolve("test-results/profile"))).not.toThrow();
    expect(() => assertSeparateInstallData(exe, resolve("test-results"))).toThrow("程序目录");
  });
  it("rejects a linked ancestor before generating an installer plan", async () => {
    const directory=resolve("test-results",`update-link-${randomUUID()}`);
    await mkdir(join(directory,"actual"),{recursive:true});
    try { await symlink(join(directory,"actual"),join(directory,"link"),process.platform==="win32"?"junction":"dir"); await expect(assertNoLinkedAncestors(join(directory,"link","updates","new-file"))).rejects.toThrow("联接"); }
    finally { await rm(directory,{recursive:true,force:true}); }
  });
  it("keeps task guards and checksum failure ahead of any installation", async () => {
    const directory = resolve("test-results", `update-${randomUUID()}`); let busy = true;
    const download = vi.fn(async (url: string) => url.endsWith("update.json") ? Buffer.from(JSON.stringify(manifest())) : payload);
    const manager = new UpdateManager({ version: "0.7.0", dataDirectory: directory, executable: resolve("test-results/install/PaneFlow Desktop.exe"), helperScript: "unused", packaged: false, pendingWork: () => busy ? [{ state: "unknown" }] : [], quit: vi.fn(), download });
    try {
      await manager.check(); await expect(manager.prepare()).rejects.toThrow("任务"); expect(download).toHaveBeenCalledTimes(1);
      busy = false; expect((await manager.prepare()).prepared).toBe(true);
      expect(await readFile(join(directory,"updates/0.8.0/PaneFlow-Desktop-0.8.0-Setup.exe"))).toEqual(payload);
      await expect(manager.install()).rejects.toThrow("打包");
      const corrupt = new UpdateManager({ ...manager.options, download: async url => url.endsWith("update.json") ? Buffer.from(JSON.stringify(manifest())) : Buffer.from("corrupt") });
      await corrupt.check(); await expect(corrupt.prepare()).rejects.toThrow("校验"); expect(corrupt.status().prepared).toBe(false);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it("admits only one installer even when two requests arrive during asynchronous path checks", async () => {
    const directory=resolve("test-results",`update-concurrent-${randomUUID()}`), profile=join(directory,"profile"), helper=join(directory,"helper.ps1");
    await mkdir(directory,{recursive:true}); await writeFile(helper,"# isolated test helper");
    const launch=vi.fn(async()=>{}), quit=vi.fn();
    const manager=new UpdateManager({version:"0.7.0",dataDirectory:profile,executable:join(directory,"install","PaneFlow Desktop.exe"),helperScript:helper,packaged:true,pendingWork:()=>[],quit,launch,download:async url=>url.endsWith("update.json")?Buffer.from(JSON.stringify(manifest())):payload});
    try { await manager.check();await manager.prepare();const outcomes=await Promise.allSettled([manager.install(),manager.install()]);expect(outcomes.filter(x=>x.status==="fulfilled")).toHaveLength(1);expect(launch).toHaveBeenCalledTimes(1);expect(quit).toHaveBeenCalledTimes(1); }
    finally {await rm(directory,{recursive:true,force:true});}
  });
});
