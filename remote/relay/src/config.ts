import { z } from "zod";

const publicOriginSchema = z.string().url().transform((value, context) => {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.protocol !== "https:" && !localHttp) {
    context.addIssue({ code: "custom", message: "PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment" });
    return z.NEVER;
  }
  return url.origin;
});

const basePathSchema = z.string().trim().default("/").transform((value, context) => {
  const candidate = value || "/";
  if (!/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?\/?$/.test(candidate)) {
    context.addIssue({ code: "custom", message: "BASE_PATH must contain only URL-safe path segments" });
    return z.NEVER;
  }
  return candidate.replace(/\/+$/, "") || "/";
});

const configSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  PUBLIC_ORIGIN: publicOriginSchema,
  BASE_PATH: basePathSchema,
  MAX_CHANNELS: z.coerce.number().int().min(1).max(100_000).default(10_000),
  MAX_CONNECTIONS: z.coerce.number().int().min(2).max(200_000).default(20_000),
  MAX_MOBILES_PER_CHANNEL: z.coerce.number().int().min(1).max(50).default(10)
});

export type RelayConfig = z.infer<typeof configSchema>;
export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): RelayConfig => configSchema.parse(environment);
