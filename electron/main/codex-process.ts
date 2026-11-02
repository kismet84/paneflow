import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { assertNativeWorkingDirectory } from "./native-working-directory.js";
import { delimiter, join } from "node:path";

let testFixturePath: string | null = null;
let testCodexArgsPrefix: string[] = [];

export const useCodexFixtureForTests = (path: string): void => {
  testFixturePath = path;
};

export const useCodexArgsPrefixForTests = (args: string[]): void => {
  testCodexArgsPrefix = [...args];
};

type CodexLaunch = { command: string; args: string[] };

export const codexEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const bypass = [...new Set([environment.NO_PROXY, environment.no_proxy, "localhost,127.0.0.1,::1"]
    .filter(Boolean).join(",").split(",").map((entry) => entry.trim()).filter(Boolean))].join(",");
  return { ...environment, NO_PROXY: bypass, no_proxy: bypass };
};

export const resolveCodexLaunch = (environment: NodeJS.ProcessEnv = process.env): CodexLaunch => {
  const pathDirectories = (environment.PATH ?? environment.Path ?? "")
    .split(delimiter)
    .map((directory) => directory.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of pathDirectories) {
    const executable = join(directory, "codex.exe");
    if (existsSync(executable)) return { command: executable, args: [] };
    const shim = join(directory, "codex.cmd");
    const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!existsSync(shim) || !existsSync(script)) continue;
    const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    const platformPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
    const nativeCandidates = [
      join(directory, "node_modules", "@openai", "codex", "node_modules", "@openai", platformPackage, "vendor", target, "bin", "codex.exe"),
      join(directory, "node_modules", "@openai", "codex", "vendor", target, "bin", "codex.exe")
    ];
    const nativeExecutable = nativeCandidates.find(existsSync);
    if (nativeExecutable) return { command: nativeExecutable, args: [] };
    const localNode = join(directory, "node.exe");
    return { command: existsSync(localNode) ? localNode : "node", args: [script] };
  }
  const commandProcessor = environment.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  return { command: commandProcessor, args: ["/d", "/s", "/c", "codex"] };
};

export const spawnCodex = (args: readonly string[], options: SpawnOptions = {}): ChildProcess => {
  if (typeof options.cwd === "string") assertNativeWorkingDirectory(options.cwd);
  options = { ...options, env: codexEnvironment(options.env ?? process.env) };
  if (testFixturePath) {
    return spawn("node", [testFixturePath, ...args], { ...options, shell: false, windowsHide: true });
  }
  if (process.platform === "win32") {
    const launch = resolveCodexLaunch(options.env ?? process.env);
    return spawn(launch.command, [...launch.args, ...testCodexArgsPrefix, ...args], {
      ...options,
      shell: false,
      windowsHide: true
    });
  }
  return spawn("codex", [...testCodexArgsPrefix, ...args], { ...options, shell: false });
};

export const forceTerminateProcessTree = (pid: number | undefined): Promise<void> => {
  if (!pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", shell: false });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { killer.kill(); } catch { /* The cleanup process may already have exited. */ }
      finish();
    }, 5_000);
    killer.once("error", finish);
    killer.once("exit", finish);
  });
};

export const terminateCodexProcess = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exitListener: (() => void) | null = null;
  const exited = new Promise<boolean>((resolve) => {
    exitListener = () => resolve(true);
    child.once("exit", exitListener);
  });
  try { child.kill("SIGKILL"); } catch { /* The process may already be exiting. */ }
  const exitedDirectly = await Promise.race([exited, new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))]);
  if (!exitedDirectly) {
    await forceTerminateProcessTree(child.pid);
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
  }
  if (exitListener) child.removeListener("exit", exitListener);
};
