import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { compactionFailureGuard } from "../../execution/pi/compaction/compaction-failures.js";
const base = { scope: "fictional-session", model: { provider: "faux", id: "model", api: "faux" },
  policy: { effort: "auto", summaryMaxTokens: 12000, failureCooldownMs: 900000 }, tokens: 500000, trigger: "proactive", now: 100 };
it("suppresses across reopened controllers, warns once and resets on growth/cooldown/config", () => {
  activeGuard(compactionFailureGuard(base)).settle("failed", true, "output_truncated");
  const repeated = activeGuard(compactionFailureGuard({ ...base, now: 200 }));
  expect(repeated).toMatchObject({ suppressed: true, warn: true, growthRequiredTokens: 50000 });
  repeated.suppress();
  expect(compactionFailureGuard({ ...base, trigger: "reactive_overflow", now: 300 })).toMatchObject({ suppressed: true, warn: false });
  expect(activeGuard(compactionFailureGuard({ ...base, tokens: 549999 })).suppressed).toBe(true);
  expect(activeGuard(compactionFailureGuard({ ...base, tokens: 550000 })).suppressed).toBe(false);
  activeGuard(compactionFailureGuard(base)).settle("failed", true, "empty_summary");
  expect(activeGuard(compactionFailureGuard({ ...base, policy: { ...base.policy, effort: "low" } })).suppressed).toBe(false);
  expect(activeGuard(compactionFailureGuard({ ...base, now: 900100 })).suppressed).toBe(false);
});
it("isolates sessions, ignores unattempted/aborted work, clears success and bypasses manual", () => {
  const input = { ...base, scope: "another-session" };
  (activeGuard(compactionFailureGuard(input)).settle)("failed", false);
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(false);
  activeGuard(compactionFailureGuard(input)).settle("failed", true, "aborted");
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(false);
  activeGuard(compactionFailureGuard(input)).settle("failed", true, "provider_error");
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(true);
  expect(activeGuard(compactionFailureGuard({ ...input, scope: "new-epoch" })).suppressed).toBe(false);
  expect(activeGuard(compactionFailureGuard({ ...input, trigger: "manual" })).suppressed).toBe(false);
  expect(compactionFailureGuard({ ...input, scope: null })).toBeNull();
  expect(compactionFailureGuard({ ...input, policy: { failureCooldownMs: 0 } })).toBeNull();
  (activeGuard(compactionFailureGuard(input)).settle)("accepted", true);
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(false);
});

it("suppresses cheap headroom rejection but permits retry after model ceilings change", () => {
  const input = { ...base, scope: "fictional-headroom-model", model: { ...base.model, contextWindow: 10000, maxTokens: 512 } };
  activeGuard(compactionFailureGuard(input)).settle("headroom_unavailable", true, "insufficient_summary_headroom");
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(true);
  expect(activeGuard(compactionFailureGuard({ ...input, model: { ...input.model, contextWindow: 200000 } })).suppressed).toBe(false);
  expect(activeGuard(compactionFailureGuard({ ...input, model: { ...input.model, maxTokens: 4096 } })).suppressed).toBe(false);
});

it.each(["insufficient_savings", "not_reducible"])("never caches a successful-summary %s veto as failure", (outcome) => {
  const input = { ...base, scope: `fictional-${outcome}` };
  activeGuard(compactionFailureGuard(input)).settle(outcome, true, "completed");
  expect(activeGuard(compactionFailureGuard(input)).suppressed).toBe(false);
});

function activeGuard(value: ReturnType<typeof compactionFailureGuard>) {
  assert.ok(value);
  return value;
}
