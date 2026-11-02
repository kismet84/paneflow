import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BASELINE, SERVER_REQUEST_METHODS } from "../../packages/protocol/src/method-manifest";

const extractMethods = (file: string): string[] => {
  const source = readFileSync(resolve("packages/protocol/src/generated", file), "utf8");
  return [...source.matchAll(/"method":\s*"([^"]+)"/g)].map((match) => match[1]!).filter((method, index, all) => all.indexOf(method) === index);
};

describe("generated protocol baseline", () => {
  it("matches the pinned method counts", () => {
    expect(extractMethods("ClientRequest.ts")).toHaveLength(BASELINE.counts.clientRequests);
    expect(extractMethods("ServerRequest.ts")).toHaveLength(BASELINE.counts.serverRequests);
    expect(extractMethods("ServerNotification.ts")).toHaveLength(BASELINE.counts.serverNotifications);
  });

  it("matches the checked-in method manifest and source hashes", () => {
    const manifest = JSON.parse(readFileSync(resolve("packages/protocol/protocol-manifest.json"), "utf8")) as {
      groups: Record<string, { count: number; sha256: string; methods: string[] }>;
    };
    const mappings = { clientRequests: "ClientRequest.ts", serverRequests: "ServerRequest.ts", serverNotifications: "ServerNotification.ts" };
    for (const [group, file] of Object.entries(mappings)) {
      const source = readFileSync(resolve("packages/protocol/src/generated", file), "utf8");
      expect(manifest.groups[group]?.methods).toEqual(extractMethods(file).sort());
      expect(manifest.groups[group]?.sha256).toBe(createHash("sha256").update(source).digest("hex"));
    }
  });

  it("has an explicit policy entry for every server request", () => {
    expect([...SERVER_REQUEST_METHODS].sort()).toEqual(extractMethods("ServerRequest.ts").sort());
  });
});
