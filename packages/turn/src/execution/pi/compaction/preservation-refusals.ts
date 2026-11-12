import { createHash } from "node:crypto";

// Process-local paid-refusal bound, separate from provider failures/cooldowns.
// Store only whole-input/session digests and counts; never tuple or prefix text.
interface Refusal { identity: string; tokens: number }
const scopes = new Map<string, Refusal>();
const harnesses = new WeakMap<object, Refusal>();
const LIMIT = 2048;
const scopeKey = (scope: unknown) => typeof scope === "string" ? createHash("sha256").update(scope).digest("hex") : undefined;

export function clearProactivePreservationRefusal(scope: unknown, harness: object) {
  const key = scopeKey(scope);
  if (key === undefined) harnesses.delete(harness); else scopes.delete(key);
}

export function proactivePreservationGuard(scope: unknown, harness: object, identity: string, tokens: number) {
  const key = scopeKey(scope);
  const previous = key === undefined ? harnesses.get(harness) : scopes.get(key);
  // Match the existing idle failure guard's meaningful-growth threshold, without
  // its timeout or its ability to suppress reactive overflow recovery.
  const growth = previous ? Math.max(8192, Math.ceil(previous.tokens * 0.1)) : 0;
  return {
    suppressed: previous?.identity === identity && tokens - previous.tokens < growth,
    growthRequiredTokens: growth,
    refused(paid: boolean) {
      if (!paid) return;
      const record = { identity, tokens };
      if (key === undefined) harnesses.set(harness, record);
      else {
        scopes.delete(key); scopes.set(key, record);
        while (scopes.size > LIMIT) scopes.delete(scopes.keys().next().value!);
      }
    },
  };
}
