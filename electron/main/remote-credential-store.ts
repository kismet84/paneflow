import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import { canonicalJwk } from "../../packages/remote-protocol/src/index.js";
import { normalizeRelayUrl } from "../shared/contracts.js";
import { SerialTaskQueue } from "./serial-task-queue.js";
import { generateP256KeyPair } from "./remote-crypto.js";

const isRelayUrl = (value: string): boolean => {
  if (!value) return true;
  try { normalizeRelayUrl(value); return true; } catch { return false; }
};

const publicJwkSchema = z.object({ kty: z.string(), crv: z.string(), x: z.string(), y: z.string() }).passthrough();
const passkeySchema = z.object({
  id: z.string().min(1).max(2_048),
  publicKey: z.string().min(1).max(16_384),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string().max(100)).max(20),
  name: z.string().min(1).max(200),
  createdAt: z.number().int().positive(),
  lastUsedAt: z.number().int().positive().nullable()
});
export const mobileDeviceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  signingPublicKey: publicJwkSchema,
  agreementPublicKey: publicJwkSchema,
  authentication: z.enum(["passkey", "native"]).optional(),
  passkey: passkeySchema.optional(),
  lastUsedAt: z.number().int().positive().nullable().optional(),
  createdAt: z.number().int().positive(),
  revokedAt: z.number().int().positive().nullable()
}).superRefine((device, context) => {
  if (device.authentication !== "native" && !device.passkey) context.addIssue({ code: "custom", message: "浏览器设备缺少 Passkey 凭据" });
  if (device.authentication === "native" && device.passkey) context.addIssue({ code: "custom", message: "原生设备不得冒充 Passkey 身份" });
});
const remoteCredentialSchema = z.object({
  version: z.literal(2),
  enabled: z.boolean(),
  relayUrl: z.string().refine(isRelayUrl, "中转服务地址无效"),
  channelId: z.string().regex(/^[a-f0-9]{64}$/),
  signingPublicKey: publicJwkSchema,
  protectedSigningPrivateKey: z.string().min(1).max(32_768),
  agreementPublicKey: publicJwkSchema,
  protectedAgreementPrivateKey: z.string().min(1).max(32_768),
  devices: z.array(mobileDeviceSchema).max(20)
});
const legacyCredentialSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  relayUrl: z.string().refine(isRelayUrl)
}).passthrough();

export type RemotePasskeyCredential = z.infer<typeof passkeySchema>;
export type RemoteMobileDevice = z.infer<typeof mobileDeviceSchema>;
export type RemoteCredentialState = z.infer<typeof remoteCredentialSchema>;

export class RemoteCredentialStore {
  readonly #path: string;
  readonly #saveQueue = new SerialTaskQueue();

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<RemoteCredentialState | null> {
    try {
      const raw = JSON.parse(await readFile(this.#path, "utf8"));
      const current = remoteCredentialSchema.safeParse(raw);
      if (current.success) return current.data;
      const legacy = legacyCredentialSchema.safeParse(raw);
      if (!legacy.success) throw new Error("远程设备凭据格式无效，已保留原文件；请恢复备份，不能自动重建身份。");
      const migrated = this.createIdentity();
      migrated.enabled = legacy.data.enabled;
      migrated.relayUrl = legacy.data.relayUrl;
      await this.save(migrated);
      return migrated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("无法读取远程设备凭据，已停止初始化以保留绑定。", { cause: error });
    }
  }

  async save(state: RemoteCredentialState): Promise<void> {
    const value = remoteCredentialSchema.parse(state);
    return this.#saveQueue.enqueue(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporaryPath = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8");
        await rename(temporaryPath, this.#path);
      } catch (error) {
        try { await unlink(temporaryPath); } catch { /* The temporary file may not exist. */ }
        throw error;
      }
    });
  }

  createIdentity(): RemoteCredentialState {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全保存远程访问密钥，不能启用远程访问。");
    const signing = generateP256KeyPair();
    const agreement = generateP256KeyPair();
    return {
      version: 2,
      enabled: false,
      relayUrl: "",
      channelId: createHash("sha256").update(canonicalJwk(signing.publicKey)).digest("hex"),
      signingPublicKey: publicJwkSchema.parse(signing.publicKey),
      protectedSigningPrivateKey: this.#protect(signing.privateKey),
      agreementPublicKey: publicJwkSchema.parse(agreement.publicKey),
      protectedAgreementPrivateKey: this.#protect(agreement.privateKey),
      devices: []
    };
  }

  revealSigningPrivateKey(state: RemoteCredentialState): JsonWebKey {
    return this.#reveal(state.protectedSigningPrivateKey);
  }

  revealAgreementPrivateKey(state: RemoteCredentialState): JsonWebKey {
    return this.#reveal(state.protectedAgreementPrivateKey);
  }

  static createPairingSecret(): { secret: string; hash: string } {
    const secret = randomBytes(32).toString("base64url");
    return { secret, hash: createHash("sha256").update(secret).digest("hex") };
  }

  #protect(key: JsonWebKey): string {
    return safeStorage.encryptString(JSON.stringify(key)).toString("base64");
  }

  #reveal(value: string): JsonWebKey {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("系统凭据保护当前不可用。");
    return JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))) as JsonWebKey;
  }
}
