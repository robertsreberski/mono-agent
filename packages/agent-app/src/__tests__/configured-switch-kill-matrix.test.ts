// Configured-host process-kill matrix for durable v5 model switches (P3).
// Real public config, Web-shaped persisted delivery IDs, faux providers, tools
// disabled. Each row: one producer killed at or after a durable boundary, two
// fresh-process redeliveries of the same message, then one new explicit
// delivery. Storage-level boundary matrices stay in agent-harness:
// managed-native-switch / managed-model-switch-storage / model-switch-return.
import { afterEach, expect, it } from "vitest";
import { TEST_TIMEOUT_MS, cleanupRoots, count, expectSettled, killAndRecover, resumeAfter, type Report } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);

/** One current journal, no model-change framing and the outgoing journal retired. */
function expectSwitched(report: Report, before: Report, model: string): void {
  expect(report.canonical.version).toBe(5); expect(report.canonical.providerSession.modelKey).toBe(`faux:${model}`);
  expect(report.modelChanges).toBe(0); expect(Object.keys(report.journals)).toHaveLength(1);
  for (const name of Object.keys(before.journals)) expect(report.journals[name]).toBeUndefined();
  expect(report.switchStates).toHaveLength(1); expect(report.artifacts).toHaveLength(1); // one durable handoff
}

// Summary route: the outgoing A summary is malformed (billed, rejected); no
// prior validated summary exists, so the checkpoint is refused and incoming B
// summarizes. Boundaries are listed in durable order.
it.each([
  "root-marker", "switch-intent", "attempt-started-outgoing", "summary-A", "attempt-finished-outgoing", "attempt-started-incoming", "summary-B",
  "artifact", "switch-ready", "guarded-epoch-staged", "guarded-epoch-renamed", "canonical-staged", "canonical", "native-removed",
  "switch-fence-removed", "turn-fence", "turn-B", "canonical#2",
])("structured A->B: SIGKILL at %s, two fresh redeliveries keep one switch and never rebill", async (phase) => {
  const { root, before, killed, first, second, armed } = await killAndRecover("structured", phase);
  const unknownOutgoing = phase === "attempt-started-outgoing" || phase === "summary-A";
  // An incoming attempt killed before its outcome stays charged; every
  // producer is spent, so redelivery is pending until a NEW explicit message.
  const pending = phase === "attempt-started-incoming" || phase === "summary-B";
  for (const report of [first, second]) {
    if (pending) {
      expect(report.results).toEqual([expect.objectContaining({ failure: "handoff_pending" })]);
      expect(report.canonical).toEqual(before.canonical); expect(report.switchStates[0]!.phase).toBe("pending");
      expect(report.switchStates[0]!.attempts).toEqual([{ producer: "outgoing", outcome: "rejected", generation: 0 }, { producer: "incoming", outcome: "started", generation: 0 }]);
      continue;
    }
    expect(report.results).toEqual([{ text: "Fictional B answer", warnings: [] }]);
    expectSwitched(report, before, "B"); expect(report.switchStates[0]!.phase).toBe("ready");
    expect(report.switchStates[0]!.attempts).toEqual([{ producer: "outgoing", outcome: unknownOutgoing ? "started" : "rejected", generation: 0 },
      { producer: "incoming", outcome: "accepted", generation: 0 }]);
    expect(report.artifacts).toEqual([expect.objectContaining({ producer: "incoming", summary: true })]);
    expectSettled(report);
  }
  expect(second.canonical.lastSwitch ?? null).toEqual(first.canonical.lastSwitch ?? null); expect(second.switchStates).toEqual(first.switchStates);
  // Billing: one slot per producer per generation, never repeated by redelivery.
  expect(count(armed, "summary", "A")).toBe(phase === "attempt-started-outgoing" ? 0 : 1);
  expect(count(armed, "summary", "B")).toBe(phase === "attempt-started-incoming" ? 0 : 1); expect(count(second.calls, "summary")).toBe(0);
  // One incoming dispatch per delivery; the killed one is never replayed.
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(["turn-B", "canonical#2"].includes(phase) ? 1 : 0);
  expect(count(first.calls, "turn", "B")).toBe(pending ? 0 : 1); expect(count(second.calls, "turn", "B")).toBe(pending ? 0 : 1);
  if (!pending) {
    expect(first.contexts.at(-1)).toContain("Fictional input fictional-seed");
    if (first.canonical.providerSession.epoch === first.canonical.lastSwitch.toEpoch) expect(first.contexts.at(-1)).toContain("Historical handoff");
    // A target epoch rotated after a pre-dispatch interruption reseeds canonical turns.
    else expect(first.contexts.at(-1)).toContain("No tools were replayed");
    const admitted = ["turn-fence", "turn-B", "canonical#2"].includes(phase);
    expect(first.canonical.messages).toHaveLength(admitted ? 6 : 4);
    if (admitted) expect(first.canonical.messages[3].content).toContain(phase === "canonical#2" ? "Fictional B answer" : "No tools were replayed");
    expect(second.canonical.messages.slice(0, 2)).toEqual(before.canonical.messages);
    expect(second.canonical.messages).toHaveLength(first.canonical.messages.length + 2);
  }
  // A new explicit delivery: ordinary, or (after pending) one new billed generation.
  const next = await resumeAfter(root, "structured");
  expect(next.results).toEqual([{ text: "Fictional B answer", warnings: [] }]); expectSwitched(next, before, "B"); expectSettled(next);
  expect(count(next.calls, "summary")).toBe(pending ? 2 : 0); expect(count(next.calls, "turn", "B")).toBe(1);
  if (pending) expect(next.switchStates[0]).toMatchObject({ generation: 1, authorizations: 1 });
}, TEST_TIMEOUT_MS);

// A -> B -> A return. Summary route: the valid outgoing B summary is accepted.
// Checkpoint route: an outgoing attempt killed before its outcome stays
// charged, and the exact previously validated A -> B summary plus the B suffix
// is accepted for free.
it.each([
  "switch-intent", "attempt-started-outgoing", "summary-B", "artifact", "switch-ready", "guarded-epoch-renamed",
  "canonical", "native-removed", "switch-fence-removed", "turn-fence", "turn-A", "canonical#2",
])("A->B->A return: SIGKILL at %s keeps one transition and never rebills", async (phase) => {
  const { root, before, killed, first, second, armed } = await killAndRecover("return", phase);
  const unknown = phase === "attempt-started-outgoing" || phase === "summary-B";
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "Fictional A answer", warnings: [] }]);
    expectSwitched(report, before, "A");
    expect(report.switchStates[0]).toMatchObject({ from: "faux:B", to: "faux:A", phase: "ready", generation: 0, authorizations: 0 });
    expect(report.switchStates[0]!.attempts).toEqual([{ producer: "outgoing", outcome: unknown ? "started" : "accepted", generation: 0 }]);
    // A checkpoint artifact carries the prior validated summary inside its checkpoint, not a new one.
    expect(report.artifacts[0]).toMatchObject({ producer: unknown ? "checkpoint" : "outgoing", summary: !unknown });
    expectSettled(report);
  }
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch); expect(second.switchStates).toEqual(first.switchStates);
  expect(count(armed, "summary", "B")).toBe(phase === "attempt-started-outgoing" ? 0 : 1); expect(count(armed, "summary", "A")).toBe(0);
  expect(count(second.calls, "summary")).toBe(0);
  const admitted = ["turn-fence", "turn-A", "canonical#2"].includes(phase);
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(["turn-A", "canonical#2"].includes(phase) ? 1 : 0);
  expect(first.canonical.messages).toHaveLength(before.canonical.messages.length + (admitted ? 4 : 2));
  if (admitted) expect(first.canonical.messages[before.canonical.messages.length + 1].content).toContain(phase === "canonical#2" ? "Fictional A answer" : "No tools were replayed");
  expect(second.canonical.messages).toHaveLength(first.canonical.messages.length + 2);
  expect(count(first.calls, "turn", "A")).toBe(1); expect(count(second.calls, "turn", "A")).toBe(1);
  // The intervening B turn arrives inside the structured handoff, not as native envelopes.
  expect(first.contexts.at(-1)).toContain("Fictional input fictional-b-turn");
  if (first.canonical.providerSession.epoch === first.canonical.lastSwitch.toEpoch) expect(first.contexts.at(-1)).toContain("Historical handoff");
  else expect(first.contexts.at(-1)).toContain("No tools were replayed");
  const next = await resumeAfter(root, "return");
  expect(next.results).toEqual([{ text: "Fictional A answer", warnings: [] }]); expectSwitched(next, before, "A"); expectSettled(next);
  expect(count(next.calls, "summary")).toBe(0); expect(count(next.calls, "turn", "A")).toBe(1);
}, TEST_TIMEOUT_MS);

// A switch whose outgoing journal was lost externally: canonical history is
// summarized by the same order (never a summary-less change); there is no
// outgoing journal to retire.
it.each(["switch-intent", "summary-B", "artifact", "guarded-epoch-renamed", "canonical", "switch-fence-removed", "turn-A", "canonical#2"])(
  "missing-journal B->A switch: SIGKILL at %s keeps one transition and never rebills", async (phase) => {
  const { root, before, killed, first, second, armed } = await killAndRecover("missing-switch", phase);
  expect(before.journals).toEqual({});
  for (const report of [first, second]) {
    expect(report.results).toEqual([expect.objectContaining({ text: "Fictional A answer" })]);
    expectSwitched(report, before, "A");
    expect(report.switchStates[0]!.attempts).toEqual([{ producer: "outgoing", outcome: phase === "summary-B" ? "started" : "accepted", generation: 0 }]);
    expect(report.artifacts[0]).toMatchObject({ producer: phase === "summary-B" ? "checkpoint" : "outgoing" });
    expectSettled(report);
  }
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch);
  expect(count(armed, "summary", "B")).toBe(1); expect(count(armed, "summary", "A")).toBe(0); expect(count(second.calls, "summary")).toBe(0);
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(["turn-A", "canonical#2"].includes(phase) ? 1 : 0);
  expect(count(first.calls, "turn", "A")).toBe(1); expect(count(second.calls, "turn", "A")).toBe(1);
  const next = await resumeAfter(root, "missing-switch");
  expect(next.results).toEqual([{ text: "Fictional A answer", warnings: [] }]); expectSwitched(next, before, "A"); expectSettled(next);
  expect(count(next.calls, "summary")).toBe(0); expect(count(next.calls, "turn", "A")).toBe(1);
}, TEST_TIMEOUT_MS);
