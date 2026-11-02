import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

// Electron's patched fs treats paths inside ASAR archives as directories, but
// Windows child processes and MCP header helpers cannot use them as a cwd.
export const isAsarPath = (path: string): boolean => /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(path);

export const assertNativeWorkingDirectory = (path: string): void => {
  if (!path || !isAbsolute(path) || isAsarPath(path)) throw new Error("Codex 工作目录必须是真实磁盘目录，不能使用应用 ASAR 资源路径。请重新选择项目目录。");
  try {
    if (statSync(path).isDirectory()) return;
  } catch { /* Report a user-actionable cwd error instead of a spawn failure. */ }
  throw new Error("Codex 工作目录不存在或不是目录，请重新选择项目目录。");
};
