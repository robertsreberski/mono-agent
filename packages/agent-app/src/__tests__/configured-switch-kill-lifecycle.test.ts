// Configured-host process-kill matrix for current-only cold change, reset and
// retention of a multi-epoch chain (P3 A4). Storage-level phase matrices remain
// in agent-harness managed-native-lifecycle / managed-native-cold-change.
import { afterEach, expect, it } from "vitest";
import { cleanupRoots, count, expectSettled, killAndRecover } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);

// A real 32-member guarded chain (structured A->B first), then an explicit
// persisted Web B->A message selects the owned current-only cold change.
it.each(["lifecycle-intent", "canonical", "native-removed", "lifecycle-intent-removed", "turn-A"])(
  "current-only cold change: SIGKILL at %s records one cold receipt, keeps 31 predecessors and never bills a summary", async (phase) => {
  const { before, killed, first, second, armed } = await killAndRecover("cold", phase);
  const retired = `${before.canonical.native.chain.at(-1).journalId}.jsonl`;
  for (const report of [first, second]) {
    // Warning semantics: the one-turn degraded-context warning belongs to the
    // turn that applied the cold change. Every boundary here is after durable
    // cold intent, so recovery completes it storage-only and the next turn is
    // ordinary same-model work: no repeated (or late) warning.
    expect(report.results).toEqual([{ text: "Fictional A answer", warnings: [] }]);
    expect(report.canonical.lastSwitch.kind).toBe("cold"); expect(report.canonical.providerSession.modelKey).toBe("faux:A");
    expect(report.canonical.native.chain).toHaveLength(32); expect(report.canonical.native.projection).toBeNull();
    expect(report.canonical.native.chain.slice(0, -1)).toEqual(before.canonical.native.chain.slice(0, -1));
    for (const row of before.canonical.native.chain.slice(0, -1)) expect(report.journals[`${row.journalId}.jsonl`]).toBe(before.journals[`${row.journalId}.jsonl`]);
    expect(report.journals[retired]).toBeUndefined(); // only the old current epoch (C)
    expect(report.modelChanges).toBe(before.modelChanges); expect(report.switchStates).toEqual(before.switchStates);
    expectSettled(report);
  }
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch);
  expect(count(armed, "summary")).toBe(0);
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(phase === "turn-A" ? 1 : 0);
  expect(count(first.calls, "turn", "A")).toBe(1); expect(count(second.calls, "turn", "A")).toBe(1);
  // Cold replay context: canonical history, including the retained B answer.
  expect(first.contexts.at(-1)).toContain("Fictional B answer"); expect(first.contexts.at(-1)).toContain("Fictional input fictional-seed");
}, 60_000);

it.each(["lifecycle-intent", "native-removed", "native-removed#2", "switch-storage-removed", "canonical", "lifecycle-intent-removed"])(
  "reset of a switched chain: SIGKILL at %s, two fresh resets finish whole-chain deletion without provider calls", async (phase) => {
  const { first, second, armed } = await killAndRecover("reset", phase);
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "reset" }]);
    expect(report.canonical.messages).toEqual([]); expect(report.canonical.native ?? null).toBeNull();
    expect(report.journals).toEqual({}); expect(report.switchFiles).toEqual([]); expect(report.modelChanges).toBe(0);
    expectSettled(report);
  }
  // Each explicit reset rotates to a fresh empty epoch; nothing else survives.
  expect({ ...second.canonical, providerSession: undefined }).toEqual({ ...first.canonical, providerSession: undefined });
  expect(first.canonical).toMatchObject({ version: 3, providerSession: { revision: 0 } }); expect(armed).toEqual([]);
}, 60_000);

it.each(["lifecycle-intent", "native-removed", "switch-storage-removed", "canonical-removed", "lifecycle-intent-removed"])(
  "retention of a switched chain: SIGKILL at %s, two fresh successor admissions finish whole-chain deletion", async (phase) => {
  const { before, first, second, armed } = await killAndRecover("retention", phase);
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "Fictional A answer", warnings: [] }]);
    expect(report.canonical).toBeNull(); expect(report.switchFiles).toEqual([]); expect(report.modelChanges).toBe(0);
    for (const name of Object.keys(before.journals)) expect(report.journals[name]).toBeUndefined();
    expect(Object.keys(report.journals)).toHaveLength(1); // the successor's own epoch
    expect(report.stats.conversations).toBe(1); expectSettled(report);
  }
  expect(second.successor.messages).toHaveLength(first.successor.messages.length + 2);
  expect(count(armed, "summary")).toBe(0); expect(count(first.calls, "turn")).toBe(1); expect(count(second.calls, "turn")).toBe(1);
}, 60_000);
