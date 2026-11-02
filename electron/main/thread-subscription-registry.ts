import type { AppServerSupervisor } from "./app-server-supervisor.js";

export class ThreadSubscriptionRegistry {
  readonly #supervisor: AppServerSupervisor;
  readonly #owners = new Map<string, Set<string>>();

  constructor(supervisor: AppServerSupervisor) {
    this.#supervisor = supervisor;
  }

  acquire(threadId: string, owner: string): void {
    const owners = this.#owners.get(threadId) ?? new Set<string>();
    owners.add(owner);
    this.#owners.set(threadId, owners);
  }

  async release(threadId: string, owner: string): Promise<boolean> {
    const owners = this.#owners.get(threadId);
    if (!owners) {
      await this.#supervisor.call("thread/unsubscribe", { threadId });
      return true;
    }
    owners.delete(owner);
    if (owners.size) return false;
    this.#owners.delete(threadId);
    await this.#supervisor.call("thread/unsubscribe", { threadId });
    return true;
  }

  clearOwner(owner: string): void {
    for (const [threadId, owners] of this.#owners) {
      owners.delete(owner);
      if (!owners.size) this.#owners.delete(threadId);
    }
  }

  async releaseOwner(owner: string): Promise<void> {
    const releases: Promise<unknown>[] = [];
    for (const [threadId, owners] of this.#owners) {
      owners.delete(owner);
      if (!owners.size) {
        this.#owners.delete(threadId);
        releases.push(this.#supervisor.call("thread/unsubscribe", { threadId }));
      }
    }
    await Promise.allSettled(releases);
  }
}
