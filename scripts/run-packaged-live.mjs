import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const executablePath = resolve(root, "release", "win-unpacked", "PaneFlow Desktop.exe");
const playwrightCli = resolve(root, "node_modules", "@playwright", "test", "cli.js");
const marker = resolve(root, ".packaged-live");
writeFileSync(marker, "live", "utf8");
const result = spawnSync(process.execPath, [playwrightCli, "test", "tests/e2e/packaged-smoke.spec.ts", ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, CODEX_PANE_PACKAGED_EXE: executablePath },
  stdio: "inherit"
});
rmSync(marker, { force: true });

process.exit(result.status ?? 1);
