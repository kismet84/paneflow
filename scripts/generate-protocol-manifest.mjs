import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const generatedDirectory = resolve("packages/protocol/src/generated");
const definitions = {
  clientRequests: "ClientRequest.ts",
  serverRequests: "ServerRequest.ts",
  serverNotifications: "ServerNotification.ts"
};

const manifest = {
  codexVersion: "0.149.1",
  upstreamTag: "rust-v0.149.1",
  upstreamCommit: "ff29a44391deccde0aba0f8390337d7f3c319ea4",
  generationCommand: "codex app-server generate-ts --experimental",
  groups: {}
};

for (const [group, file] of Object.entries(definitions)) {
  const source = await readFile(resolve(generatedDirectory, file), "utf8");
  const methods = [...source.matchAll(/"method":\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((method, index, all) => all.indexOf(method) === index)
    .sort();
  manifest.groups[group] = {
    count: methods.length,
    sha256: createHash("sha256").update(source).digest("hex"),
    methods
  };
}

await writeFile(resolve("packages/protocol/protocol-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
