import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

type LeaseOwner = { pid: number; token: string };

const processExists = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export class ProcessOwnershipLease {
  readonly #directory: string;
  readonly #ownerPath: string;
  readonly #pid: number;
  readonly #token = randomUUID();
  readonly #processExists: (pid: number) => boolean;
  #owned = false;

  constructor(directory: string, pid = process.pid, processExistsCheck = processExists) {
    this.#directory = directory;
    this.#ownerPath = join(directory, "owner.json");
    this.#pid = pid;
    this.#processExists = processExistsCheck;
  }

  get owned(): boolean { return this.#owned; }

  acquire(): boolean {
    if (this.#owned) return true;
    mkdirSync(dirname(this.#directory), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        mkdirSync(this.#directory);
        writeFileSync(this.#ownerPath, JSON.stringify({ pid: this.#pid, token: this.#token } satisfies LeaseOwner), { encoding: "utf8", flag: "wx" });
        this.#owned = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          this.#cleanupDirectory(this.#directory);
          throw error;
        }
      }
      const owner = this.#readOwner();
      if (owner && this.#processExists(owner.pid)) return false;
      if (!owner) {
        try {
          if (Date.now() - statSync(this.#directory).mtimeMs < 5_000) return false;
        } catch {
          continue;
        }
      }
      const staleDirectory = `${this.#directory}.stale-${this.#token}`;
      try {
        renameSync(this.#directory, staleDirectory);
        this.#cleanupDirectory(staleDirectory);
      } catch {
        return false;
      }
    }
    return false;
  }

  release(): void {
    if (!this.#owned) return;
    const owner = this.#readOwner();
    if (!owner || owner.pid !== this.#pid || owner.token !== this.#token) {
      this.#owned = false;
      return;
    }
    const releasedDirectory = `${this.#directory}.released-${this.#token}`;
    try {
      renameSync(this.#directory, releasedDirectory);
      this.#cleanupDirectory(releasedDirectory);
    } finally {
      this.#owned = false;
    }
  }

  #readOwner(): LeaseOwner | null {
    try {
      const value = JSON.parse(readFileSync(this.#ownerPath, "utf8")) as Partial<LeaseOwner>;
      return Number.isSafeInteger(value.pid) && typeof value.token === "string" ? value as LeaseOwner : null;
    } catch {
      return null;
    }
  }

  #cleanupDirectory(directory: string): void {
    const ownerPath = join(directory, "owner.json");
    try { if (existsSync(ownerPath)) unlinkSync(ownerPath); } catch { /* Another instance may already be cleaning it. */ }
    try { if (existsSync(directory)) rmdirSync(directory); } catch { /* A concurrent owner may have replaced the directory. */ }
  }
}
