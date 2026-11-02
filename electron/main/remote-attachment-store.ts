import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import { attachmentSchema, type Attachment } from "../../packages/remote-protocol/src/index.js";

export const ATTACHMENT_CHUNK_BYTES = 48 * 1024;
const entrySchema = z.object({ uploadId: z.string().uuid(), deviceId: z.string(), threadId: z.string(), attachment: attachmentSchema, complete: z.boolean(), sent: z.boolean(), submitted: z.boolean().optional(), deleted: z.boolean().optional(), sourcePath: z.string().optional() });
type Entry = z.infer<typeof entrySchema>;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Only registered upload IDs can become paths. Metadata uses the desktop's protected storage. */
export class RemoteAttachmentStore {
  #entries = new Map<string, Entry>();
  constructor(readonly root?: string, readonly managedRoot?: string) {}
  async #check(path: string): Promise<void> {
    let current = resolve(path);
    for (;;) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error("附件路径含目录联接，已拒绝访问。"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
  }
  #directory(): string { if (!this.root) throw new Error("附件存储不可用，请升级电脑端。"); return this.root; }
  #path(e: Entry): string { return join(this.#directory(), e.attachment.id, e.attachment.name); }
  async load(): Promise<void> {
    if (!this.root) return;
    await this.#check(this.root); await mkdir(this.root, { recursive: true });
    let bytes: Buffer;
    try { await this.#check(join(this.root,"index.enc"));bytes = await readFile(join(this.root, "index.enc")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error("附件安全存储不可用。");
    const entries = z.array(entrySchema).max(10000).parse(JSON.parse(safeStorage.decryptString(bytes)));
    for (const e of entries) { this.#safeName(e.attachment.name); this.#entries.set(e.uploadId, e); }
  }
  async #save(): Promise<void> {
    const root = this.#directory(); await this.#check(root);
    if (!safeStorage.isEncryptionAvailable()) throw new Error("附件安全存储不可用。");
    await mkdir(root, { recursive: true }); const temporary = join(root, `${randomUUID()}.tmp`);
    await writeFile(temporary, safeStorage.encryptString(JSON.stringify([...this.#entries.values()])), { mode: 0o600, flush: true });
    for (let attempt=0;;attempt++) {
      try { await rename(temporary, join(root, "index.enc")); break; }
      catch(error) { if(attempt>=4 || !["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""))throw error; await new Promise(resolve=>setTimeout(resolve,50*(attempt+1))); }
    }
  }
  #safeName(name: string): void {
    if (!name || name.length > 180 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === "." || name === "..") throw new Error("附件名称无效。");
  }
  #owned(deviceId: string, threadId: string, uploadId: string): Entry {
    const e = this.#entries.get(uploadId);
    if (!e || e.deviceId !== deviceId || e.threadId !== threadId) throw new Error("附件不属于当前设备和会话。");
    return e;
  }
  async begin(deviceId: string, threadId: string, input: { uploadId: string; name: string; mime: string; size: number; sha256: string }) {
    this.#safeName(input.name); this.#directory();
    const existing = this.#entries.get(input.uploadId);
    if (existing) {
      const e = this.#owned(deviceId, threadId, input.uploadId);
      if (["name", "mime", "size", "sha256"].some(key => e.attachment[key as keyof Attachment] !== input[key as keyof typeof input])) throw new Error("上传标识已用于不同文件。");
      return this.status(deviceId, threadId, input.uploadId);
    }
    if (input.size < 1 || input.size > 20 * 1024 * 1024) throw new Error("附件大小须在 1 字节至 20 MiB 之间。");
    const entries = [...this.#entries.values()];
    if(entries.length>=10000)throw new Error("附件索引已达上限，请使用新的部署数据目录或联系维护者。");
    if (entries.filter(e => e.deviceId === deviceId && e.threadId === threadId && !e.sent&&!e.deleted).length >= 8) throw new Error("该会话待发送附件最多 8 个。");
    if (entries.filter(e=>!e.deleted).reduce((n,e) => n + e.attachment.size, input.size) > 512 * 1024 * 1024 || entries.filter(e => e.deviceId === deviceId&&!e.deleted).reduce((n,e) => n + e.attachment.size, input.size) > 128 * 1024 * 1024) throw new Error("附件存储配额已满，请删除不再需要的电脑附件副本后重试。");
    const image = /\.(png|jpe?g|webp|gif)$/i.test(input.name) && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(input.mime);
    const e: Entry = { uploadId: input.uploadId, deviceId, threadId, complete: false, sent: false, attachment: { id: randomUUID(), name: input.name, mime: input.mime, size: input.size, sha256: input.sha256, kind: image ? "image" : "file" } };
    this.#entries.set(e.uploadId, e);
    try { await this.#save(); } catch (error) { this.#entries.delete(e.uploadId); throw error; }
    return this.status(deviceId, threadId, input.uploadId);
  }
  async status(deviceId: string, threadId: string, uploadId: string) {
    const e = this.#owned(deviceId, threadId, uploadId); const path = this.#path(e); await this.#check(path);
    if(e.attachment.available===false)throw new Error("电脑附件副本已删除。");
    let offset = 0; try { offset = (await stat(path)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (offset > e.attachment.size || (e.complete && offset !== e.attachment.size)) throw new Error("附件文件已变化或丢失。");
    return { uploadId, offset, complete: e.complete, ...(e.complete ? { attachment: { ...e.attachment } } : {}) };
  }
  async chunk(deviceId: string, threadId: string, uploadId: string, offset: number, data: string) {
    const e = this.#owned(deviceId, threadId, uploadId); const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > ATTACHMENT_CHUNK_BYTES || bytes.toString("base64") !== data) throw new Error("附件分块编码无效。");
    const state = await this.status(deviceId, threadId, uploadId); const path = this.#path(e);
    if (offset < 0 || offset + bytes.length > e.attachment.size || offset > state.offset) throw new Error("附件偏移不一致，请先查询上传状态。");
    if (offset < state.offset) {
      if (offset + bytes.length > state.offset) throw new Error("附件分块与已有内容重叠。");
      const handle = await open(path, "r"); try { const old = Buffer.alloc(bytes.length); await handle.read(old, 0, old.length, offset); if (!old.equals(bytes)) throw new Error("重复分块内容不一致。"); } finally { await handle.close(); }
      return state;
    }
    if (e.complete) throw new Error("附件已完成，不可更改。");
    await mkdir(dirname(path), { recursive: true }); await this.#check(path);
    const handle = await open(path, "a", 0o600); try { await handle.write(bytes); await handle.sync(); } finally { await handle.close(); }
    return this.status(deviceId, threadId, uploadId);
  }
  async finish(deviceId: string, threadId: string, uploadId: string) {
    const e = this.#owned(deviceId, threadId, uploadId); const state = await this.status(deviceId, threadId, uploadId);
    if (state.offset !== e.attachment.size || digest(await readFile(this.#path(e))) !== e.attachment.sha256) throw new Error("附件未完整上传或校验失败。");
    const previous=e.complete; e.complete = true; try { await this.#save(); } catch(error) {e.complete=previous;throw error;} return this.status(deviceId, threadId, uploadId);
  }
  async cancel(deviceId: string, threadId: string, uploadId: string) {
    if (this.#entries.has(uploadId)) {
      const e=this.#owned(deviceId,threadId,uploadId); if(e.sent||e.submitted)throw new Error("附件已发送或发送结果待核对，不能作为草稿删除。");
      const path=this.#path(e); await this.#check(path);
      await unlink(path).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
      await rmdir(dirname(path)).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
      this.#entries.delete(uploadId);try{await this.#save();}catch(error){this.#entries.set(uploadId,e);throw error;}
    }
    return { uploadId, offset:0, complete:false, cancelled:true };
  }
  async inputs(deviceId: string, threadId: string, ids: string[]) {
    const entries = ids.map(id => [...this.#entries.values()].find(e => e.attachment.id === id));
    if (entries.some(e => !e || !e.complete || e.deviceId !== deviceId || e.threadId !== threadId)) throw new Error("附件尚未完成或不属于目标会话。");
    const result: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const e = entry!; await this.status(deviceId, threadId, e.uploadId);
      if (digest(await readFile(this.#path(e))) !== e.attachment.sha256) throw new Error("附件内容已变化。");
      result.push(e.attachment.kind === "image" ? { type: "localImage", path: this.#path(e), detail: "high" } : { type: "mention", name: e.attachment.name, path: this.#path(e) });
    }
    return result;
  }
  async submitted(deviceId:string,threadId:string,ids:string[],value:boolean):Promise<void>{
    const entries=ids.map(id=>[...this.#entries.values()].find(e=>e.attachment.id===id));
    if(entries.some(e=>!e||e.deviceId!==deviceId||e.threadId!==threadId||!e.complete||e.attachment.available===false))throw new Error("附件不可提交。");
    const old=entries.map(e=>e!.submitted);for(const e of entries)if(!e!.sent)e!.submitted=value;
    if(entries.length)try{await this.#save();}catch(error){entries.forEach((e,i)=>e!.submitted=old[i]);throw error;}
  }
  async delete(deviceId:string,threadId:string,id:string,authorize:()=>void=()=>{}):Promise<void>{
    const e=[...this.#entries.values()].find(e=>e.attachment.id===id);
    if(!e||e.threadId!==threadId||(e.deviceId!==deviceId&&e.deviceId!=="desktop-managed"))throw new Error("附件不属于当前设备和会话。");
    if(e.submitted&&!e.sent)throw new Error("附件发送结果待核对，暂不能删除电脑副本。");
    authorize();
    const previous=e.attachment.available;e.attachment.available=false;
    try{await this.#save();}catch(error){e.attachment.available=previous;throw error;}
    const path=this.#path(e);await this.#check(path);
    try{authorize();}catch(error){e.attachment.available=previous;try{await this.#save();}catch{e.attachment.available=false;throw new Error("附件未删除，状态恢复失败；请重连后核对。");}throw error;}
    await unlink(path).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
    await rmdir(dirname(path)).catch(error=>{if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;});
    e.deleted=true;try{await this.#save();}catch(error){e.deleted=false;throw error;}
  }
  async registerManaged(raw: unknown, threadId: string, authorize: () => void = () => {}): Promise<void> {
    if (!this.root) return;
    const candidates: Array<{path:string;name?:string;image:boolean}>=[];
    const walk=(value:unknown,depth=0)=>{if(depth>8||!value||typeof value!=="object")return;if(Array.isArray(value)){value.slice(0,1000).forEach(v=>walk(v,depth+1));return;}const r=value as Record<string,unknown>;
      if((r.type==="localImage"||r.type==="mention")&&typeof r.path==="string")candidates.push({path:r.path,name:typeof r.name==="string"?r.name:undefined,image:r.type==="localImage"});
      for(const key of ["turns","items","content","input","item"])walk(r[key],depth+1);
    };walk(raw);
    for(const candidate of candidates.slice(0,100)) {
      authorize();
      const path=resolve(candidate.path),expected=this.managedRoot?resolve(this.managedRoot,candidate.image?"media":"files"):"";
      const source=[...this.#entries.values()].find(e=>e.complete&&(e.sent||e.submitted||e.threadId===threadId)&&resolve(this.#path(e))===path);
      if(source?.threadId===threadId){if(!source.sent){source.sent=true;source.submitted=false;try{await this.#save();}catch(error){source.sent=false;source.submitted=true;throw error;}}continue;}
      if(!source&&(!expected||dirname(path)!==expected || !(candidate.image?/^[0-9a-f-]{36}\.png$/i:/^[0-9a-f-]{36}(?:\.[a-z0-9_-]{1,20})?$/i).test(basename(path))))continue;
      if([...this.#entries.values()].some(e=>e.sourcePath===path&&e.threadId===threadId&&e.complete))continue;
      let bytes:Buffer;
      try { await this.#check(path); const canonical=resolve(await realpath(source?dirname(path):expected),basename(path));if(resolve(await realpath(path)).toLocaleLowerCase()!==canonical.toLocaleLowerCase())continue; const info=await lstat(path);if(!info.isFile()||info.size<1||info.size>20*1024*1024)continue;bytes=await readFile(path);if(bytes.length!==info.size||(source&&digest(bytes)!==source.attachment.sha256))continue; } catch { continue; }
      authorize();
      if(this.#entries.size>=10000||[...this.#entries.values()].filter(e=>!e.deleted).reduce((sum,e)=>sum+e.attachment.size,bytes.length)>512*1024*1024)continue;
      let name=candidate.name??basename(path);try{this.#safeName(name);}catch{name=basename(path);}
      const id=randomUUID();const e:Entry={uploadId:randomUUID(),deviceId:"desktop-managed",threadId,complete:true,sent:true,sourcePath:path,attachment:{id,name,mime:source?.attachment.mime??(candidate.image?"image/png":"application/octet-stream"),size:bytes.length,sha256:digest(bytes),kind:candidate.image?"image":"file"}};
      const destination=this.#path(e);await this.#check(destination);await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:"wx",mode:0o600,flush:true});
      this.#entries.set(e.uploadId,e);try{await this.#save();}catch(error){this.#entries.delete(e.uploadId);throw error;}
    }
  }
  references(raw: unknown, threadId: string): Attachment[] {
    const paths = new Set<string>();
    const walk = (value: unknown, depth = 0) => { if (depth > 6 || !value || typeof value !== "object") return; if (Array.isArray(value)) { value.slice(0,100).forEach(x => walk(x,depth+1)); return; } const r = value as Record<string,unknown>; if (typeof r.path === "string") paths.add(resolve(r.path)); for (const key of ["content", "input"]) walk(r[key], depth+1); };
    walk(raw);
    return [...this.#entries.values()].filter(e => e.threadId === threadId && e.complete && e.sent && (paths.has(resolve(this.#path(e))) || Boolean(e.sourcePath&&paths.has(e.sourcePath)))).slice(0,8).map(e => ({ ...e.attachment }));
  }
  async read(deviceId: string, threadId: string, id: string, offset: number) {
    const e = [...this.#entries.values()].find(e => e.attachment.id === id);
    if (!e || !e.complete || e.threadId !== threadId || (!e.sent && e.deviceId !== deviceId)) throw new Error("附件不属于目标会话或尚未发送。");
    await this.status(e.deviceId, threadId, e.uploadId);
    if (offset < 0 || offset > e.attachment.size) throw new Error("附件读取偏移无效。");
    const buffer = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, e.attachment.size - offset));
    const handle = await open(this.#path(e), "r"); let count = 0;
    try { count = (await handle.read(buffer,0,buffer.length,offset)).bytesRead; } finally { await handle.close(); }
    return { attachmentId: id, offset, data: buffer.subarray(0,count).toString("base64"), eof: offset + count === e.attachment.size };
  }
}
