import type { UsageSummary } from "../../packages/remote-protocol/src/index.js";
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Only expose usage fields, never account identities or raw upstream errors. */
export async function readRemoteUsage(call: (method: string, params: unknown) => Promise<unknown>, threadId?: string): Promise<UsageSummary> {
  const [limits, tokens] = await Promise.allSettled([
    call("account/rateLimits/read", undefined), call("account/usage/read", threadId ? { threadId } : {})
  ]);
  const usage: UsageSummary = { updatedAt: Date.now(), limitsAvailable: false, tokensAvailable: false, windows: [] };
  if (limits.status === "fulfilled") {
    const response = record(limits.value);
    const buckets = Object.values(record(response.rateLimitsByLimitId));
    if (!buckets.length && response.rateLimits) buckets.push(response.rateLimits);
    for (const raw of buckets.slice(0, 20)) {
      const bucket = record(raw);
      for (const key of ["primary", "secondary"]) {
        const window = record(bucket[key]);
        if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) continue;
        const label = typeof bucket.limitName === "string" ? bucket.limitName : typeof bucket.limitId === "string" ? bucket.limitId : "账户额度";
        usage.windows.push({ name: `${label.slice(0, 170)} · ${key === "primary" ? "主窗口" : "次窗口"}`, usedPercent: window.usedPercent,
          ...(integer(window.windowDurationMins) && window.windowDurationMins > 0 ? { windowMinutes: window.windowDurationMins } : {}),
          ...(integer(window.resetsAt) ? { resetsAt: window.resetsAt } : {}) });
      }
    }
    usage.limitsAvailable = usage.windows.length > 0;
  }
  if (!usage.limitsAvailable) usage.limitsError = "当前 Codex 未提供额度窗口，或暂时无法读取";
  if (tokens.status === "fulfilled") {
    const response = record(tokens.value), summary = record(response.summary);
    for (const key of ["lifetimeTokens", "peakDailyTokens", "currentStreakDays"] as const) {
      if (integer(summary[key])) { usage[key] = summary[key]; usage.tokensAvailable = true; }
    }
    const thread = record(response.threadUsage);
    if (threadId && thread.threadId === threadId && integer(thread.estimatedUsageUsdMicros)) {
      usage.threadId = threadId; usage.estimatedUsdMicros = thread.estimatedUsageUsdMicros;
    }
  }
  if (!usage.tokensAvailable) usage.tokensError = "当前 Codex 未提供 Token 汇总，或暂时无法读取";
  return usage;
}
