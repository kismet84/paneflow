import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessOwnershipLease } from "../../electron/main/process-ownership-lease";

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = resolve("test-results", `process-lease-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
};

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("ProcessOwnershipLease", () => {
  it("allows one owner and transfers ownership after release", () => {
    const path = resolve(temporaryRoot(), "remote", ".bridge-owner");
    const first = new ProcessOwnershipLease(path, 101, (pid) => pid === 101);
    const second = new ProcessOwnershipLease(path, 202, (pid) => pid === 101);
    expect(first.acquire()).toBe(true);
    expect(second.acquire()).toBe(false);
    first.release();
    expect(second.acquire()).toBe(true);
    second.release();
  });

  it("recovers a stale owner", async () => {
    const path = resolve(temporaryRoot(), "remote", ".bridge-owner");
    await mkdir(path, { recursive: true });
    await writeFile(resolve(path, "owner.json"), JSON.stringify({ pid: 303, token: "stale" }), "utf8");
    const lease = new ProcessOwnershipLease(path, 404, () => false);
    expect(lease.acquire()).toBe(true);
    lease.release();
  });
});
