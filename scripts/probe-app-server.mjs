import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

const child = spawn(process.platform === "win32" ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" : "codex", process.platform === "win32" ? ["/d", "/s", "/c", "codex", "app-server"] : ["app-server"], {
  shell: false,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"]
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let childFailure = null;

const rejectPending = (error) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
};
child.on("error", (error) => {
  childFailure = error.code === "ENOENT"
    ? new Error("Codex CLI was not found. Install Codex and make sure `codex` is available on PATH.")
    : new Error(`Codex app-server failed to start: ${error.message}`);
  rejectPending(childFailure);
});
child.on("exit", (code, signal) => {
  if (!pending.size || childFailure) return;
  rejectPending(new Error(`Codex app-server exited before the probe completed (${signal ?? `code ${code ?? "unknown"}`}).`));
});

const write = (message) => {
  if (childFailure) throw childFailure;
  child.stdin.write(`${JSON.stringify(message)}\n`);
};
const call = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`${method} timed out`));
  }, 15_000);
  pending.set(id, { resolve, reject, timer, method });
  write({ id, method, params });
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === "currentTime/read") {
    write({ id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
    return;
  }
  if (message.id === undefined || message.method) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
  else request.resolve(message.result);
});

const main = async () => {
  const initialized = await call("initialize", {
    clientInfo: { name: "codex_pane_probe", title: "Codex Pane Probe", version: packageVersion },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: null, extensions: { "openai/form": {} } }
  });
  write({ method: "initialized" });
  const [account, models, threads, rateLimits, config, permissionProfiles] = await Promise.all([
    call("account/read", { refreshToken: false }),
    call("model/list", { limit: 10 }),
    call("thread/list", { limit: 1 }),
    call("account/rateLimits/read").catch(() => null),
    call("config/read", { includeLayers: false, cwd: null }),
    call("permissionProfile/list", { cursor: null, limit: 100, cwd: null })
  ]);
  const summary = {
    initialize: {
      userAgent: initialized.userAgent ?? null,
      codexHome: initialized.codexHome ?? null,
      platformFamily: initialized.platformFamily ?? null,
      platformOs: initialized.platformOs ?? null
    },
    account: account.account ? { type: account.account.type, planType: account.account.planType ?? null } : null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
    modelCount: Array.isArray(models.data) ? models.data.length : 0,
    threadProbeCount: Array.isArray(threads.data) ? threads.data.length : 0,
    effectiveConfig: {
      model: config?.config?.model ?? null,
      modelProvider: config?.config?.model_provider ?? null,
      sandboxMode: config?.config?.sandbox_mode ?? null,
      approvalPolicy: config?.config?.approval_policy ?? null,
      approvalReviewer: config?.config?.approvals_reviewer ?? null
    },
    permissionProfileCount: Array.isArray(permissionProfiles?.data) ? permissionProfiles.data.length : 0,
    rateLimitBuckets: Object.entries(rateLimits?.rateLimitsByLimitId ?? {}).map(([id, bucket]) => ({
      id,
      primaryWindowMins: bucket?.primary?.windowDurationMins ?? null,
      secondaryWindowMins: bucket?.secondary?.windowDurationMins ?? null
    }))
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
};

main().then(() => child.kill()).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  child.kill();
  process.exitCode = 1;
});
