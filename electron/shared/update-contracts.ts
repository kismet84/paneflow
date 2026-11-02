import { z } from "zod";

export const UPDATE_MANIFEST_URL = "https://github.com/kismet84/paneflow/releases/latest/download/update.json";
const assetSchema = z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(800 * 1024 * 1024) });
export const updateManifestSchema = z.object({
  schemaVersion: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/),
  minProtocol: z.number().int().positive(), maxProtocol: z.number().int().positive(), notes: z.string().max(30_000),
  assets: z.object({ windows: assetSchema, android: assetSchema.extend({ versionCode: z.number().int().positive(), packageName: z.literal("com.codexpane.companion") }) })
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export type UpdateStatus = { currentVersion: string; available: boolean; compatible: boolean; manifest: UpdateManifest | null; message: string; prepared: boolean };
export function newerVersion(candidate: string, current: string): boolean {
  const a = candidate.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}
export function releaseAssetUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith("/kismet84/paneflow/releases/download/") && url.pathname.split("/").length === 7; } catch { return false; }
}
