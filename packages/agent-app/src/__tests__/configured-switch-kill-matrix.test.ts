// Configured-host process-kill matrix for durable model switches (P3 A1/A2/A4).
// Real public config, Web-shaped persisted delivery IDs, faux providers, tools
// disabled. Storage-level boundary matrices stay in agent-harness:
// managed-native-switch / managed-model-switch-storage / native-switch-back.
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
    expect(report.artifacts).toEqual([expect.objectContaining({ producer: "checkpoint", native: false })]);
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

// Codex-shaped faux provenance with one stable fictional OAuth account. Under
// the opt-in every epoch, including the first one written before any switch,
// records the pinned lease provenance, so A->B and the killed B->A return both
// reuse native evidence: no summary producer is ever admitted or called.
it.each([
  "switch-intent", "artifact", "switch-ready", "model-change", "canonical",
  "switch-fence-removed", "turn-fence", "turn-A", "canonical#2",
])("A->B->A native return: SIGKILL at %s reuses every native segment once, with zero summary calls", async (phase) => {
  const { before, killed, first, second, armed, journal } = await killAndRecover("return", phase);
  for (const report of [first, second]) {
    expect(report.results).toEqual([{ text: "Fictional A answer", warnings: [] }]);
    expect(report.modelChanges).toBe(2); expect(report.canonical.native.chain).toHaveLength(3);
    expect(report.canonical.providerSession.modelKey).toBe("openai-codex:A");
    expect(report.switchStates.map((state) => state.phase)).toEqual(["ready", "ready"]);
    expect(report.switchStates.every((state) => state.attempts.length === 0 && state.generation === 0 && state.authorizations === 0)).toBe(true);
    expect(report.artifacts).toHaveLength(2);
    for (const artifact of report.artifacts) expect(artifact).toMatchObject({ native: true, producer: "checkpoint", summary: false });
    expectSettled(report);
  }
  const chain = first.canonical.native.chain as { journalId: string; provenance: { account: string | null } }[];
  for (const row of chain) expect(row.provenance.account).toMatch(/^codex-account-v1:[a-f0-9]{64}$/u);
  expect(new Set(chain.map((row) => row.provenance.account)).size).toBe(1);
  expect(second.canonical.lastSwitch).toEqual(first.canonical.lastSwitch); expect(second.switchStates).toEqual(first.switchStates);
  expect(armed.filter((call) => call.kind === "summary")).toEqual([]);
  expect(killed.calls.filter((call) => call.kind === "summary")).toEqual([]);
  // One incoming A dispatch per delivery; a killed admitted turn settles once, never replayed.
  const admitted = ["turn-fence", "turn-A", "canonical#2"].includes(phase);
  expect(count(killed.calls.filter((call) => call.armed), "turn")).toBe(["turn-A", "canonical#2"].includes(phase) ? 1 : 0);
  expect(first.canonical.messages).toHaveLength(before.canonical.messages.length + (admitted ? 4 : 2));
  if (admitted) expect(first.canonical.messages[before.canonical.messages.length + 1].content).toContain(phase === "canonical#2" ? "Fictional A answer" : "No tools were replayed");
  expect(second.canonical.messages).toHaveLength(first.canonical.messages.length + 2);
  expect(count(first.calls, "turn", "A")).toBe(1); expect(count(second.calls, "turn", "A")).toBe(1);
  // Native projection, not a structured handoff: the B turn arrives as native evidence.
  expect(first.contexts.at(-1)).toContain("Fictional input fictional-b-turn"); expect(first.contexts.at(-1)).not.toContain("Historical handoff");
  // A0 is byte-identical to before the return; B1 keeps its body and gains one model_change frame.
  expect(await journal(`${chain[0]!.journalId}.jsonl`)).toBe(before.bytes[`${chain[0]!.journalId}.jsonl`]);
  const b = Buffer.from(await journal(`${chain[1]!.journalId}.jsonl`), "base64").toString().trim().split("\n");
  const seeded = Buffer.from(before.bytes[`${chain[1]!.journalId}.jsonl`]!, "base64").toString().trim().split("\n");
  expect(b.slice(1, seeded.length)).toEqual(seeded.slice(1)); expect(b.slice(seeded.length).map((line) => JSON.parse(line).kind)).toEqual(["turn_start", "model_change", "turn_end"]);
  for (const row of chain.slice(0, -1)) expect(second.journals[`${row.journalId}.jsonl`]).toBe(first.journals[`${row.journalId}.jsonl`]);
}, TEST_TIMEOUT_MS);
