import { afterEach, expect, it } from "vitest";
import { checkFallback, cleanupRoots, killAndRecover, type Scenario } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);
it.each(["fallback", "fallback-wake", "fallback-switch"] as const)("configured %s commits the backup once, warns after cold settlement, and reseeds all canonical turns", async (scenario) => {
  const report = await checkFallback(scenario);
  const answer = report.results.at(-2)!;
  expect(answer.text).toContain("Fictional A answer"); expect(answer.warnings).toEqual(["degraded_native_context"]);
  expect(answer.runtimeWarnings).toEqual([expect.objectContaining({ warning_kind: "degraded_native_context", message: expect.stringContaining("available conversation history") })]);
  expect(report.detached.canonical.version).toBe(4); expect(report.detached.canonical.providerSession.modelKey).toBe("faux:B");
  expect(report.detached.canonical.native.chain).toHaveLength(2);
  expect(report.detached.canonical.lastSwitch).toEqual(report.receiptBefore);
  const expected = scenario === "fallback-switch" ? 4 : 6;
  expect(report.detached.canonical.messages).toHaveLength(expected); expect(report.canonical.messages).toHaveLength(expected + 2);
  expect(report.canonical.lastSwitch).toEqual(report.receiptBefore); expect(report.results.at(-1)!.warnings).toEqual([]);
  const armed = report.calls.filter((call) => call.armed);
  // The existing harness retries one conversational request three times.
  // These are not additional router lease executions or replayed turns.
  expect(armed.filter((call) => call.kind === "turn").map((call) => call.model)).toEqual(["B", "B", "B", "B", "A"]);
  expect(report.preparedRuns!.filter((run) => run.armed)).toEqual([{ model: "B", armed: true }]);
  expect(armed.filter((call) => call.kind === "summary")).toHaveLength(scenario === "fallback-switch" ? 1 : 0);
  // No duplicate prefix or extra handoff after the accepted switch. The cold
  // current epoch must not reapply its stale artifact over newer host turns.
  expect(report.calls.filter((call) => call.kind === "summary")).toHaveLength(1);
  const backup = report.contexts.at(-2)!, next = report.contexts.at(-1)!;
  expect(backup.match(/Fictional input fictional-seed(?!-b)/gu)).toHaveLength(1);
  expect(next).toContain("Fictional input fictional-seed"); expect(next).toContain("Fictional A answer");
  expect(next).toContain(scenario === "fallback-wake" ? "Fictional input undefined" : "Fictional input fictional-fallback");
  expect(report.pending).toEqual([]); expect(report.dirty).toEqual([]); expect(report.operations).toEqual([]);
}, 30_000);
it("a no-ID model-change refusal on a native-bound conversation never reaches any backup or summary", async () => {
  const report = await checkFallback("fallback-refusal");
  expect(report.results.at(-1)!.failure).toBe("native_cold_model_change_unavailable");
  expect(report.calls.filter((call) => call.armed)).toEqual([]); expect(report.canonical.messages).toHaveLength(4);
}, 30_000);

// Real configured host + real filesystem boundaries, faux transport only.
// Recover twice without delivering a new message: storage must never replay
// providers, handoff summaries or admitted tools.
it.each([
  ["K1", "before-detach", "failed"], ["K2", "detached", "interrupted"],
  ["K3", "backup", "interrupted"], ["K3-tool", "backup-tool", "interrupted"],
  ["K4", "candidate", "completed"], ["K5", "canonical", "completed"], ["K6", "cold-finished", "completed"],
])("%s: SIGKILL at %s, two fresh storage-only configured recoveries settle %s once", async (_key, phase, outcome) => {
  const { before, killed, first, second } = await killAndRecover("fallback" as Scenario, phase!);
  for (const report of [first, second]) {
    expect(report.calls).toEqual([]); expect(report.results).toEqual([]); expect(report.contexts).toEqual([]);
    expect(report.canonical.messages).toHaveLength(before.canonical.messages.length + 2);
    const answer = report.canonical.messages.at(-1).content;
    expect(answer).toContain(outcome === "completed" ? "Fictional A answer" : outcome === "failed" ? "previous turn failed" : "previous turn was interrupted");
    expect(report.canonical.lastSwitch).toEqual(before.canonical.lastSwitch);
    expect(report.canonical.native.chain).toHaveLength(before.canonical.native.chain.length);
    expect(report.pending).toEqual([]); expect(report.dirty).toEqual([]); expect(report.operations).toEqual([]);
    expect(report.switchFiles.filter((name) => name.endsWith(".fence.json"))).toEqual([]); expect(report.stats.reservedBytes).toBe(0);
  }
  expect(second.canonical).toEqual(first.canonical); expect(second.journals).toEqual(first.journals);
  const predecessor = `${before.canonical.native.chain[0].journalId}.jsonl`;
  expect(first.journals[predecessor]).toBe(before.journals[predecessor]);
  expect(second.toolRecords).toBe(first.toolRecords); if (phase === "backup-tool") expect(killed.calls.filter((call) => call.kind === "tool")).toHaveLength(1);
}, 40_000);

it("cold model change plus backup streams and returns degradation exactly once by kind", async () => {
  const report = await checkFallback("fallback-cold"), answer = report.results.at(-2)!;
  expect(answer.text).toContain("Fictional B answer");
  expect(answer.warnings).toEqual(["degraded_native_context"]);
  expect(answer.runtimeWarnings).toEqual([expect.objectContaining({ warning_kind: "degraded_native_context" })]);
  expect(report.detached.canonical.native.chain).toHaveLength(32);
  expect(report.detached.canonical.providerSession.modelKey).toBe("faux:A");
  expect(report.detached.canonical.lastSwitch).toMatchObject({ kind: "cold" });
  expect(report.detached.canonical.messages).toHaveLength(6);
  expect(report.preparedRuns!.filter((run) => run.armed)).toEqual([{ model: "A", armed: true }]);
  expect(report.calls.filter((call) => call.armed && call.kind === "turn").map((call) => call.model)).toEqual(["A", "A", "A", "A", "B"]);
  expect(report.calls.filter((call) => call.armed && call.kind === "summary")).toEqual([]);
  expect(report.results.at(-1)!.warnings).toEqual([]);
}, 30_000);
