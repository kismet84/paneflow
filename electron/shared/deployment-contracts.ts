import { z } from "zod";

const absolutePath = z.string().trim().min(1).max(4096).refine(value => /^(?:[A-Za-z]:[\\/]|\/)/.test(value), "请填写绝对路径");
export const deploymentConfigSchema = z.object({
  origin: z.string().trim().url().refine(value => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); } catch { return false; }
  }, "请填写固定 HTTPS 域名入口，不含路径、账号或参数").transform(value => new URL(value).origin),
  nodePath: absolutePath,
  cloudflaredPath: absolutePath,
  tunnelConfigPath: absolutePath,
  tunnelId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/, "隧道标识无效"),
  cwd: absolutePath,
  port: z.number().int().min(1024).max(65535),
  enabled: z.boolean()
}).strict();
export type DeploymentConfig = z.infer<typeof deploymentConfigSchema>;
export type DeploymentCheck = { key: string; label: string; ok: boolean; detail: string };
export type DeploymentCheckResult = { valid: boolean; connectivity: boolean; checks: DeploymentCheck[] };
export type DeploymentStatus = {
  phase: "unconfigured" | "stopped" | "starting" | "running" | "degraded" | "error";
  message: string;
  version: string;
  configured: boolean;
  autostart: boolean;
  relayPid: number | null;
  tunnelPid: number | null;
  origin: string | null;
};
