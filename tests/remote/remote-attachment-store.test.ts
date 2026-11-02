import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
const faults=vi.hoisted(()=>({unlinkOnce:false,failSaveAfterUnlink:false,renameOnce:false,onRename:null as null|(()=>void)}));
vi.mock("node:fs/promises",async importOriginal=>{const actual=await importOriginal<typeof import("node:fs/promises")>();return {...actual,
  unlink:async(...args:Parameters<typeof actual.unlink>)=>{if(faults.unlinkOnce){faults.unlinkOnce=false;throw Object.assign(new Error("injected unlink failure"),{code:"EACCES"});}const result=await actual.unlink(...args);if(faults.failSaveAfterUnlink){faults.failSaveAfterUnlink=false;faults.renameOnce=true;}return result;},
  rename:async(...args:Parameters<typeof actual.rename>)=>{if(faults.renameOnce){faults.renameOnce=false;throw Object.assign(new Error("injected rename failure"),{code:"EIO"});}const result=await actual.rename(...args);const hook=faults.onRename;faults.onRename=null;hook?.();return result;}
};});
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() } }));
import { RemoteAttachmentStore } from "../../electron/main/remote-attachment-store";
import { projectTurnItems } from "../../electron/main/remote-projector";
const roots: string[] = [];
afterEach(async () => {Object.assign(faults,{unlinkOnce:false,failSaveAfterUnlink:false,renameOnce:false,onRename:null}); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() { const root = await mkdtemp(join(tmpdir(), "paneflow-attachment-")); roots.push(root); const store = new RemoteAttachmentStore(root); await store.load(); return { root, store }; }
const request = (data = Buffer.from("hello attachment"), name = "readme.txt") => ({ uploadId: randomUUID(), name, mime: "text/plain", size: data.length, sha256: createHash("sha256").update(data).digest("hex") });
describe("remote attachments", () => {
  it.each(["revoked","running"])("rechecks %s after the durable tombstone write and preserves the file",async reason=>{
    const {store}=await setup(),bytes=Buffer.from("hello attachment"),input=request(bytes);await store.begin("p","t",input);await store.chunk("p","t",input.uploadId,0,bytes.toString("base64"));const done=await store.finish("p","t",input.uploadId),id=done.attachment!.id;
    const inputs=await store.inputs("p","t",[id]);await store.registerManaged({content:inputs},"t");let allowed=true;faults.onRename=()=>{allowed=false;};
    await expect(store.delete("p","t",id,()=>{if(!allowed)throw new Error(reason);})).rejects.toThrow(reason);
    expect(await readFile(inputs[0]!.path as string)).toEqual(bytes);expect(store.references({content:inputs},"t")[0]!.available).not.toBe(false);
  });
  it.each(["unlink","final-save"])("retains a retryable tombstone after %s failure and only releases quota on success",async phase=>{
    const {store,root}=await setup(),bytes=Buffer.from("hello attachment"),input=request(bytes);await store.begin("p","t",input);await store.chunk("p","t",input.uploadId,0,bytes.toString("base64"));const done=await store.finish("p","t",input.uploadId),id=done.attachment!.id;
    const inputs=await store.inputs("p","t",[id]);await store.registerManaged({content:inputs},"t");if(phase==="unlink")faults.unlinkOnce=true;else faults.failSaveAfterUnlink=true;
    await expect(store.delete("p","t",id)).rejects.toThrow("injected");
    const failed=JSON.parse(await readFile(join(root,"index.enc"),"utf8"))[0];expect(failed.attachment.available).toBe(false);expect(failed.deleted).not.toBe(true);
    await store.delete("p","t",id);const success=JSON.parse(await readFile(join(root,"index.enc"),"utf8"))[0];expect(success.deleted).toBe(true);expect(success.attachment.available).toBe(false);
  });
  it("registers only exact desktop managed paths referenced by the thread and preserves scoped history across restart", async () => {
    const {root}=await setup();const managed=join(root,"desktop");await mkdir(join(managed,"media"),{recursive:true});await mkdir(join(managed,"files"),{recursive:true});
    const image=join(managed,"media",randomUUID()+".png"),file=join(managed,"files",randomUUID()+".txt"),outside=join(root,"private.txt");
    await writeFile(image,"image fixture");await writeFile(file,"document fixture");await writeFile(outside,"private");
    const store=new RemoteAttachmentStore(join(root,"remote"),managed);await store.load();
    const content=[{type:"localImage",path:image},{type:"mention",path:file,name:"original.txt"},{type:"mention",path:outside,name:"private.txt"}];
    await store.registerManaged({turns:[{items:[{content}]}]},"thread");
    const refs=store.references({content},"thread");expect(refs).toHaveLength(2);expect(refs[1]!.name).toBe("original.txt");
    expect(store.references({content},"other")).toEqual([]);
    const again=new RemoteAttachmentStore(join(root,"remote"),managed);await again.load();expect(again.references({content},"thread")).toEqual(refs);
    expect((await again.read("phone","thread",refs[1]!.id,0)).data).toBe(Buffer.from("document fixture").toString("base64"));
    // A managed-looking file in a linked directory must never grant remote access.
    const linkedRoot=join(root,"linked-desktop");await mkdir(linkedRoot);await symlink(join(managed,"files"),join(linkedRoot,"files"),"junction");
    const denied=new RemoteAttachmentStore(join(root,"denied"),linkedRoot);await denied.load();const linkedContent=[{type:"mention",path:join(linkedRoot,"files",basename(file))}];await denied.registerManaged({content:linkedContent},"thread");
    expect(denied.references({content:linkedContent},"thread")).toEqual([]);
  });
  it("resumes after restart, rejects conflicting replay, verifies hash and projects scoped history", async () => {
    const { store, root } = await setup(); const bytes = Buffer.from("hello attachment"); const input = request(bytes);
    await store.begin("phone", "thread", input);
    await store.chunk("phone", "thread", input.uploadId, 0, bytes.subarray(0,5).toString("base64"));
    const resumed = new RemoteAttachmentStore(root); await resumed.load();
    expect((await resumed.status("phone", "thread", input.uploadId)).offset).toBe(5);
    expect((await resumed.chunk("phone", "thread", input.uploadId, 0, bytes.subarray(0,5).toString("base64"))).offset).toBe(5);
    await expect(resumed.chunk("phone", "thread", input.uploadId, 0, Buffer.from("other").toString("base64"))).rejects.toThrow("不一致");
    await resumed.chunk("phone", "thread", input.uploadId, 5, bytes.subarray(5).toString("base64"));
    const complete = await resumed.finish("phone", "thread", input.uploadId); const id = complete.attachment!.id;
    await expect(resumed.read("other", "thread", id, 0)).rejects.toThrow();
    const inputs = await resumed.inputs("phone", "thread", [id]);
    expect(inputs[0]).toMatchObject({ type: "mention", name: "readme.txt" });
    await resumed.submitted("phone","thread",[id],true);
    await expect(resumed.cancel("phone","thread",input.uploadId)).rejects.toThrow("待核对");
    await expect(resumed.read("other","thread",id,0)).rejects.toThrow();
    await resumed.registerManaged({content:inputs},"thread");
    await resumed.registerManaged({content:inputs},"thread");
    const items = projectTurnItems({ id: "thread", turns: [{ items: [{ id: "message", type: "userMessage", content: inputs }] }] }, (raw, thread) => resumed.references(raw,thread));
    expect(items[0]).toMatchObject({ attachments: [{ id }] });
    expect(resumed.references({ content: inputs }, "other-thread")).toEqual([]);
    expect((await resumed.read("other", "thread", id, 0)).data).toBe(bytes.toString("base64"));
    await expect(resumed.read("other", "other-thread", id, 0)).rejects.toThrow();
  });
  it("rejects path names, cross-device IDs, oversized chunks and corrupt completion", async () => {
    const { store } = await setup(); const input = request();
    for (const name of ["../x", "D:\\x", "x:y", "CON.txt", "x."]) await expect(store.begin("p","t",{ ...input, name })).rejects.toThrow();
    await store.begin("p","t",input);
    await expect(store.status("q","t",input.uploadId)).rejects.toThrow();
    await expect(store.begin("p","t",{...input,name:"other.txt"})).rejects.toThrow();
    await expect(store.chunk("p","t",input.uploadId,0,Buffer.alloc(49153).toString("base64"))).rejects.toThrow();
    await store.chunk("p","t",input.uploadId,0,Buffer.alloc(input.size).toString("base64"));
    await expect(store.finish("p","t",input.uploadId)).rejects.toThrow("校验");
    expect((await store.status("p","t",input.uploadId)).complete).toBe(false);
    expect((await store.cancel("p","t",input.uploadId)).cancelled).toBe(true);
    expect((await store.cancel("p","t",input.uploadId)).cancelled).toBe(true);
  });
  it("fails closed when content changes and limits pending attachments", async () => {
    const { store } = await setup(); const bytes=Buffer.from("hello attachment"), input=request(bytes);
    await store.begin("p","t",input); await store.chunk("p","t",input.uploadId,0,bytes.toString("base64")); const done=await store.finish("p","t",input.uploadId);
    const inputs=await store.inputs("p","t",[done.attachment!.id]);await store.registerManaged({content:inputs},"t"); await writeFile(inputs[0]!.path as string, Buffer.alloc(bytes.length));
    await expect(store.inputs("p","t",[done.attachment!.id])).rejects.toThrow("变化");
    for(let i=0;i<8;i++)await store.begin("p","t",request());
    await expect(store.begin("p","t",request())).rejects.toThrow("最多 8");
  });
  it("rejects a junction redirected outside the attachment root", async () => {
    const { store, root } = await setup(); const input=request(); await store.begin("p","t",input);
    const metadata=JSON.parse(await readFile(join(root,"index.enc"),"utf8"));
    const outside=await mkdtemp(join(tmpdir(),"paneflow-outside-")); roots.push(outside);
    await symlink(outside,join(root,metadata[0].attachment.id),"junction");
    await expect(store.chunk("p","t",input.uploadId,0,Buffer.from("hello attachment").toString("base64"))).rejects.toThrow("联接");
  });
  it("preparation alone remains cancellable and explicit deletion retains a history tombstone", async()=>{
    const {store,root}=await setup(),bytes=Buffer.from("hello attachment"),input=request(bytes);
    await store.begin("p","t",input);await store.chunk("p","t",input.uploadId,0,bytes.toString("base64"));const done=await store.finish("p","t",input.uploadId),id=done.attachment!.id;
    const inputs=await store.inputs("p","t",[id]);await store.submitted("p","t",[id],true);await store.submitted("p","t",[id],false);
    // Definitive pre-dispatch rejection can release preparation without sharing the file.
    await expect(store.read("q","t",id,0)).rejects.toThrow();
    await store.registerManaged({content:inputs},"t");
    await expect(store.delete("q","t",id)).rejects.toThrow();
    await store.delete("p","t",id);await store.delete("p","t",id);
    expect(store.references({content:inputs},"t")).toMatchObject([{id,available:false}]);
    await expect(store.read("p","t",id,0)).rejects.toThrow("已删除");
    const reloaded=new RemoteAttachmentStore(root);await reloaded.load();expect(reloaded.references({content:inputs},"t")).toMatchObject([{id,available:false}]);
  });
});
