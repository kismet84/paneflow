/** Persisted goals are cross-window metadata; never block task controls on a full scan. */
export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
const statuses = new Set<GoalStatus>(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
type Entry = { expires: number; status: GoalStatus | null; known: boolean };
export class RemoteTaskCatalog {
  #cache = new Map<string, Entry>();
  #pending = new Map<string, Promise<void>>();
  #queue: Array<() => Promise<void>> = [];
  #active = 0;
  constructor(private readonly call: (method: string, params: unknown) => Promise<unknown>, private readonly now = Date.now) {}
  #schedule(id: string): Promise<void> {
    const existing=this.#pending.get(id);if(existing)return existing;
    let done!: () => void;
    const promise=new Promise<void>(resolve=>{done=resolve;});
    this.#pending.set(id,promise);
    this.#queue.push(async()=>{
      try {
        const response=object(await this.call("thread/goal/get",{threadId:id}));
        const status=object(response.goal).status;
        this.#cache.set(id,{expires:this.now()+15_000,known:"goal" in response,status:statuses.has(status as GoalStatus)?status as GoalStatus:null});
      } catch {this.#cache.set(id,{expires:this.now()+5_000,known:false,status:null});}
      finally {this.#pending.delete(id);done();}
    });
    this.#pump();return promise;
  }
  #pump(): void {
    while(this.#active<4&&this.#queue.length){
      const work=this.#queue.shift()!;this.#active++;
      void work().finally(()=>{this.#active--;this.#pump();});
    }
  }
  async enrich(rows: unknown[]): Promise<Record<string, unknown>[]> {
    const values=rows.map(object);
    const work=values.flatMap(row=>typeof row.id==="string"&&(!this.#cache.has(row.id)||this.#cache.get(row.id)!.expires<=this.now())?[this.#schedule(row.id)]:[]);
    // Fast metadata can join this snapshot; slow metadata appears on the next refresh.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(work),new Promise<void>(resolve=>{timer=setTimeout(resolve,150);timer.unref?.();})]);
    if(timer)clearTimeout(timer);
    const result=values.map(row=>{
      const entry=typeof row.id==="string"?this.#cache.get(row.id):undefined;
      const known=entry?.known===true&&entry.expires>this.now();
      return {...row,goalStatus:known?entry.status:null,goalStateKnown:known};
    });
    if(this.#cache.size>2_000)for(const [id,entry]of this.#cache)if(entry.expires<=this.now())this.#cache.delete(id);
    return result;
  }
}
