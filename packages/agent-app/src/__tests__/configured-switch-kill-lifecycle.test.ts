// Configured-host process-kill matrix for reset and retention of a switched v5
// conversation (P3 A4). Storage-level phase matrices remain in agent-harness
// managed-native-lifecycle.
import { afterEach, expect, it } from "vitest";
import { TEST_TIMEOUT_MS, cleanupRoots, count, expectSettled, killAndRecover } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);

it.each(["lifecycle-intent", "native-removed", "switch-storage-removed", "canonical", "lifecycle-intent-removed"])(
  "reset of a switched conversation: SIGKILL at %s, two fresh resets finish deletion without provider calls", async (phase) => {
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
}, TEST_TIMEOUT_MS);

it.each(["lifecycle-intent", "native-removed", "switch-storage-removed", "canonical-removed", "lifecycle-intent-removed"])(
  "retention of a switched conversation: SIGKILL at %s, two fresh successor admissions finish deletion", async (phase) => {
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
}, TEST_TIMEOUT_MS);
