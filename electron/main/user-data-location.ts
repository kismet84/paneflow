import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export type UserDataLocationOptions = {
  explicitPath?: string;
  executablePath: string;
  applicationPath: string;
  fallbackUserDataPath: string;
  packaged: boolean;
};

export type UserDataLocation = {
  path: string;
  warning: string | null;
};

const ensureWritableDirectory = (path: string): void => {
  mkdirSync(path, { recursive: true });
  const probePath = join(path, `.write-probe-${randomUUID()}`);
  const descriptor = openSync(probePath, "wx");
  closeSync(descriptor);
  unlinkSync(probePath);
};

export const prepareUserDataLocation = (options: UserDataLocationOptions): UserDataLocation => {
  if (options.explicitPath) {
    const path = resolve(options.explicitPath);
    ensureWritableDirectory(path);
    return { path, warning: null };
  }

  const applicationDirectory = options.packaged ? dirname(options.executablePath) : options.applicationPath;
  const preferredPath = resolve(applicationDirectory, "data");

  try {
    ensureWritableDirectory(preferredPath);
    return { path: preferredPath, warning: null };
  } catch {
    const fallbackPath = resolve(options.fallbackUserDataPath);
    ensureWritableDirectory(fallbackPath);
    return {
      path: fallbackPath,
      warning: `程序所在目录不可写，用户数据已改存到 ${fallbackPath}。如需数据随程序保存，请将 Codex Pane 放到可写目录。`
    };
  }
};
