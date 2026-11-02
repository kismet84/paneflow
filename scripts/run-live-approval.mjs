import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const playwrightCli = resolve(root, "node_modules", "@playwright", "test", "cli.js");
const marker = resolve(root, ".live-approval");
const configMarker = resolve(root, ".user-approval-fixture");
writeFileSync(marker, "live", "utf8");
writeFileSync(configMarker, "user", "utf8");
let status = 1;
try {
  const result = spawnSync(process.execPath, [playwrightCli, "test", "tests/e2e/electron-smoke.spec.ts"], {
    cwd: root,
    stdio: "inherit"
  });
  status = result.status ?? 1;
} finally {
  rmSync(marker, { force: true });
  rmSync(configMarker, { force: true });
}

process.exit(status);
