// SIGKILL boundaries for the owner-approved cold boundary that recovers an
// externally missing current journal (P4 PR D). Real configured host, faux
// transport only. Each row: one killed producer, two fresh storage-only
// recoveries (no provider, summary or tool replay), then one later message.
import { afterEach, expect, it } from "vitest";
import { cleanupRoots, expectSettled, freshRoot, killAndRecover, resumeAfter, runFresh, type Scenario } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);
it.each([
  ["missing", "lifecycle-intent", "unadmitted"], ["missing", "guarded-epoch-renamed", "unadmitted"], ["missing", "canonical", "unadmitted"], ["missing", "lifecycle-intent-removed", "unadmitted"],
  ["missing", "turn-fence", "interrupted"], ["missing", "turn-B", "interrupted"], ["missing", "canonical#2", "completed"],
  ["missing-switch", "lifecycle-intent", "unadmitted"], ["missing-switch", "canonical", "unadmitted"],
  ["missing-chain", "lifecycle-intent", "unadmitted"], ["missing-chain", "guarded-epoch-renamed", "unadmitted"], ["missing-chain", "canonical", "unadmitted"],
  ["missing-predecessor", "lifecycle-intent", "unadmitted"], ["missing-predecessor", "canonical", "unadmitted"], ["missing-predecessor", "lifecycle-intent-removed", "unadmitted"],
  ["missing-v3", "turn-fence", "interrupted"], ["missing-v3", "turn-A", "interrupted"], ["missing-v3", "canonical", "completed"],
] as const)("%s: SIGKILL at %s, two fresh recoveries settle the cold boundary once (%s)", async (scenario, phase, outcome) => {
  const { root, before, killed, first, second, journal } = await killAndRecover(scenario as Scenario, phase);
  const v4 = scenario !== "missing-v3", switching = scenario === "missing-switch" || scenario === "missing-predecessor";
  const model = scenario === "missing" || scenario === "missing-chain" ? "B" : "A";
  for (const report of [first, second]) {
    expect(report.calls).toEqual([]); expect(report.contexts).toEqual([]);
    expectSettled(report);
    // The canonical epoch never points at the lost journal after recovery.
    expect(report.canonical.providerSession.epoch).not.toBe(before.canonical.providerSession.epoch);
    expect(report.canonical.messages).toHaveLength(before.canonical.messages.length + (outcome === "unadmitted" ? 0 : 2));
    if (outcome !== "unadmitted") expect(report.canonical.messages.at(-1).content).toContain(outcome === "completed" ? `Fictional ${model} answer` : "previous turn was interrupted");
    if (v4) {
      expect(report.canonical.native.chain).toHaveLength(2); expect(report.canonical.native.chain[0]).toEqual(before.canonical.native.chain[0]);
      // Same-model loss keeps the switch receipt; a switch request records one cold receipt.
      if (switching) expect(report.canonical.lastSwitch).toMatchObject({ kind: "cold", fromEpoch: before.canonical.providerSession.epoch });
      else expect(report.canonical.lastSwitch).toEqual(before.canonical.lastSwitch);
      expect(report.canonical.providerSession.modelKey).toBe(`faux:${model}`);
    }
  }
  expect(second.canonical).toEqual(first.canonical); expect(second.journals).toEqual(first.journals);
  // At most the killed dispatch itself reached the provider; never a second one.
  const dispatched = ["turn-A", "turn-B", "canonical#2"].includes(phase) || !v4 && phase === "canonical";
  expect(killed.calls.filter((call) => call.armed && call.kind === "turn")).toHaveLength(dispatched ? 1 : 0);
  // A retained predecessor is byte-stable; a lost one stays absent, never recreated.
  if (v4) {
    const predecessor = `${before.canonical.native.chain[0].journalId}.jsonl`;
    if (before.bytes[predecessor] === undefined) await expect(journal(predecessor)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await journal(predecessor)).toBe(before.bytes[predecessor]);
  }
  // A later explicit message dispatches once on the recovered epoch. The warning
  // belonged to the killed turn; recovery never replays it.
  const resumed = await resumeAfter(root, scenario as Scenario);
  expect(resumed.results).toEqual([{ text: `Fictional ${model} answer`, warnings: [] }]);
  expect(resumed.calls.filter((call) => call.kind === "turn")).toHaveLength(1); expect(resumed.calls.filter((call) => call.kind === "summary")).toEqual([]);
  expect(resumed.contexts.at(-1)!.split("Fictional input fictional-seed").length - 1).toBe(1);
  expectSettled(resumed);
}, 50_000);

it("a deleted native root (machine move) recovers on the next message in a fresh process, then stays warm", async () => {
  const root = await freshRoot();
  const setup = await runFresh(root, "missing-root", "produce");
  expect(setup.results.map((result) => result.text)).toEqual(["Fictional A answer", "Fictional B answer"]);
  const first = await resumeAfter(root, "missing-root");
  expect(first.results).toEqual([{ text: "Fictional B answer", warnings: ["degraded_native_context"] }]);
  expect(first.calls.filter((call) => call.kind === "turn")).toHaveLength(1); expect(first.calls.filter((call) => call.kind === "summary")).toEqual([]);
  expect(first.contexts.at(-1)!.split("Fictional input fictional-switch").length - 1).toBe(1);
  expect(first.canonical.native.chain).toHaveLength(2); expect(first.canonical.native.chain[0]).toEqual(setup.canonical.native.chain[0]);
  expect(first.canonical.lastSwitch).toEqual(setup.canonical.lastSwitch); expectSettled(first);
  const second = await resumeAfter(root, "missing-root");
  expect(second.results).toEqual([{ text: "Fictional B answer", warnings: [] }]);
  expect(second.canonical.providerSession.epoch).toBe(first.canonical.providerSession.epoch); expectSettled(second);
}, 50_000);
