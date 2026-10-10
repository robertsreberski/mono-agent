// Configured-host process-kill matrix for durable model switches (P3 A1/A2/A4).
// Real public config, Web-shaped persisted delivery IDs, faux providers, tools
// disabled. Storage-level boundary matrices stay in agent-harness:
// managed-native-switch / managed-model-switch-storage / model-switch-return.
import { afterEach, expect, it } from "vitest";
import { TEST_TIMEOUT_MS, cleanupRoots, count, expectSettled, killAndRecover } from "./fixtures/configured-switch-kill.js";

afterEach(cleanupRoots);

// Outgoing A summary is malformed (billed, rejected); the free exact checkpoint
// then supplies the artifact. Boundaries are listed in durable order.
it.each([
  "switch-intent", "attempt-started-outgoing", "summary-A", "attempt-finished-outgoing", "artifact", "switch-ready",
  "model-change", "canonical", "switch-fence-removed", "turn-fence", "turn-B", "canonical#2",
])("structured A->B: SIGKILL at %s, two fresh configured recoveries keep one switch and never rebill", async (phase) => {
  const { before, killed, first, second, armed, journal } = await killAndRecover("structured", phase);
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "Fictional B answer", warnings: [] }]);
    expect(report.modelChanges).toBe(1); expect(report.canonical.version).toBe(4);
    expect(report.canonical.providerSession.modelKey).toBe("faux:B"); expect(report.canonical.native.chain).toHaveLength(2);
    expect(report.switchStates).toHaveLength(1); expect(report.switchStates[0]!.phase).toBe("ready");
    expect(report.artifacts).toEqual([expect.objectContaining({ producer: "checkpoint", summary: false })]);
    expectSettled(report);
  }
  // Exactly-once switch record and stable retained evidence across both recoveries.
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch); expect(second.switchStates).toEqual(first.switchStates);
  const predecessors = first.canonical.native.chain.slice(0, -1).map((row: { journalId: string }) => `${row.journalId}.jsonl`);
  for (const name of predecessors) expect(second.journals[name]).toBe(first.journals[name]);
  // Billing: one outgoing slot per switchId generation. An admitted attempt
  // killed before/while calling the provider stays charged as outcome-unknown
  // ("started") and is never repeated; the free checkpoint follows.
  // Redelivering the same persisted Web message never opens a new billed generation.
  expect(first.switchStates[0]).toMatchObject({ generation: 0, authorizations: 0 });
  const unknown = phase === "attempt-started-outgoing" || phase === "summary-A";
  expect(first.switchStates[0]!.attempts).toEqual([{ producer: "outgoing", outcome: unknown ? "started" : "rejected", generation: 0 }]);
  expect(count(armed, "summary")).toBe(phase === "attempt-started-outgoing" ? 0 : 1);
  expect(count(first.calls, "summary")).toBe(phase === "switch-intent" ? 1 : 0); expect(count(second.calls, "summary")).toBe(0);
  // One incoming dispatch per explicit delivery; the killed one is never replayed.
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(["turn-B", "canonical#2"].includes(phase) ? 1 : 0);
  expect(count(first.calls, "turn", "B")).toBe(1); expect(count(second.calls, "turn", "B")).toBe(1);
  // A2: incoming request carries the handoff; seed history is never cut.
  expect(first.contexts.at(-1)).toContain("Fictional input fictional-seed");
  if (first.canonical.providerSession.epoch === first.canonical.lastSwitch.toEpoch) expect(first.contexts.at(-1)).toContain("Historical handoff");
  else {
    // C after a pre-dispatch interruption must reseed newer canonical turns,
    // not reapply a switch artifact whose epoch was already retired.
    expect(first.contexts.at(-1)).not.toContain("Historical handoff");
    expect(first.contexts.at(-1)).toContain("No tools were replayed");
  }
  // Predecessor A evidence: every seeded body record retained byte-for-byte; the
  // header is upgraded once with host authority and only the single
  // model_change frame is appended. Recovery never rewrites it again.
  const predecessor = `${first.canonical.native.chain[0].journalId}.jsonl`;
  const now = Buffer.from(await journal(predecessor), "base64").toString().trim().split("\n");
  const seeded = Buffer.from(before.bytes[predecessor]!, "base64").toString().trim().split("\n");
  expect(now.slice(1, seeded.length)).toEqual(seeded.slice(1));
  expect(now.slice(seeded.length).map((line) => JSON.parse(line).kind)).toEqual(["turn_start", "model_change", "turn_end"]);
  // Canonical: a killed incoming turn admitted before SIGKILL is settled once
  // (interrupted, or committed at canonical#2), never replayed as an answer.
  const admitted = ["turn-fence", "turn-B", "canonical#2"].includes(phase);
  expect(first.canonical.messages).toHaveLength(admitted ? 6 : 4);
  if (admitted) expect(first.canonical.messages[3].content).toContain(phase === "canonical#2" ? "Fictional B answer" : "No tools were replayed");
  expect(second.canonical.messages.slice(0, 2)).toEqual(before.canonical.messages);
  expect(second.canonical.messages).toHaveLength(first.canonical.messages.length + 2);
}, TEST_TIMEOUT_MS);

// A -> B -> A return is an ordinary structured transfer. The valid outgoing B
// summary is accepted from the paid slot; boundaries cover paid admission, the
// summary outcome, artifact, readiness, canonical publication and incoming P2.
it.each([
  "switch-intent", "attempt-started-outgoing", "summary-B", "artifact", "switch-ready", "model-change",
  "canonical", "switch-fence-removed", "turn-fence", "turn-A", "canonical#2",
])("A->B->A structured return: SIGKILL at %s keeps one transition and never rebills", async (phase) => {
  const { before, killed, first, second, armed, journal } = await killAndRecover("return", phase);
  // Killed after admission but before the summary was durably accepted: the
  // attempt stays charged as outcome-unknown and the free exact fallback follows.
  const unknown = phase === "attempt-started-outgoing" || phase === "summary-B";
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "Fictional A answer", warnings: [] }]);
    expect(report.modelChanges).toBe(2); expect(report.canonical.native.chain).toHaveLength(3);
    expect(report.canonical.providerSession.modelKey).toBe("faux:A");
    const back = report.switchStates.find((state) => state.to === "faux:A")!;
    expect(report.switchStates.map((state) => state.phase)).toEqual(["ready", "ready"]);
    expect(back).toMatchObject({ from: "faux:B", generation: 0, authorizations: 0 });
    expect(back.attempts).toEqual([{ producer: "outgoing", outcome: unknown ? "started" : "accepted", generation: 0 }]);
    expect(report.artifacts.find((artifact) => artifact.switchId === back.switchId))
      .toMatchObject(unknown ? { producer: "checkpoint", summary: false } : { producer: "outgoing", summary: true });
    expectSettled(report);
  }
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch); expect(second.switchStates).toEqual(first.switchStates);
  // One paid outgoing B slot per switchId generation: never called twice.
  expect(count(armed, "summary", "B")).toBe(phase === "attempt-started-outgoing" ? 0 : 1); expect(count(armed, "summary", "A")).toBe(0);
  expect(count(first.calls, "summary")).toBe(phase === "switch-intent" ? 1 : 0); expect(count(second.calls, "summary")).toBe(0);
  // One incoming A dispatch per delivery; a killed admitted turn settles once, never replayed.
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
  // A0 is byte-identical to before the return; B1 keeps its body and gains one model_change frame.
  const chain = first.canonical.native.chain as { journalId: string }[];
  expect(await journal(`${chain[0]!.journalId}.jsonl`)).toBe(before.bytes[`${chain[0]!.journalId}.jsonl`]);
  const b = Buffer.from(await journal(`${chain[1]!.journalId}.jsonl`), "base64").toString().trim().split("\n");
  const seeded = Buffer.from(before.bytes[`${chain[1]!.journalId}.jsonl`]!, "base64").toString().trim().split("\n");
  expect(b.slice(1, seeded.length)).toEqual(seeded.slice(1)); expect(b.slice(seeded.length).map((line) => JSON.parse(line).kind)).toEqual(["turn_start", "model_change", "turn_end"]);
  for (const row of chain.slice(0, -1)) expect(second.journals[`${row.journalId}.jsonl`]).toBe(first.journals[`${row.journalId}.jsonl`]);
}, TEST_TIMEOUT_MS);
