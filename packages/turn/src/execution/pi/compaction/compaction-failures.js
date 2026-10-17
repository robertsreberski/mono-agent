import { createHash } from "node:crypto";
const failures = new Map();
const LIMIT = 2048;

/** Bounded, metadata-only process cache. A restart intentionally clears it. */
export function compactionFailureGuard({ scope, model, policy, tokens, trigger, now = Date.now() }) {
  if (!scope || policy.failureCooldownMs === 0) return null;
  const key = createHash("sha256").update(JSON.stringify([scope, model.provider, model.id, model.api,
    policy.effort, policy.summaryMaxTokens, policy.keepRecentTokens, policy.compactionMinSavingsTokens,
    policy.contextWindow, policy.failureCooldownMs, model.contextWindow, model.maxTokens, "summary-focus-v1"])).digest("hex");
  const cooldown = policy.failureCooldownMs ?? 900000;
  const previous = failures.get(key);
  const growth = previous ? Math.max(8192, Math.ceil(previous.tokens * 0.1)) : 0;
  const suppressed = trigger !== "manual" && previous && now - previous.at < cooldown && tokens - previous.tokens < growth;
  if (!suppressed) failures.delete(key);
  return {
    suppressed: Boolean(suppressed),
    warn: Boolean(suppressed && !previous.warned),
    retryAfterMs: suppressed ? Math.max(0, cooldown - (now - previous.at)) : 0,
    growthRequiredTokens: growth,
    suppress() { if (previous) previous.warned = true; },
    settle(outcome, attempted, reason) {
      if (outcome === "accepted") { failures.delete(key); return; }
      // Local headroom rejections are attempts too, but never billing evidence.
      if (!["failed", "headroom_unavailable"].includes(outcome) || !attempted || suppressed || reason === "aborted") return;
      failures.delete(key);
      failures.set(key, { at: now, tokens, warned: false });
      for (const [id, value] of failures) if (now - value.at >= 86400000) failures.delete(id);
      while (failures.size > LIMIT) failures.delete(failures.keys().next().value);
    },
  };
}
