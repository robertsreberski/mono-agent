import { describe, expect, it } from "vitest";
import { QUESTIONS, TURNS, runMemoryBehaviourScorecard, scoreBehaviour } from "../lib/memory-behaviour-scorecard.mjs";

describe("fictional completed-turn memory behaviour scorecard", () => {
  it("replays the actual intake and verifies the logical rebuild projection", async () => {
    const result = await runMemoryBehaviourScorecard();
    expect(result.passed).toBe(true);
    expect(result.turns).toBe(TURNS.length);
    expect(result.questions).toHaveLength(QUESTIONS.length);
    expect(result.gates).toMatchObject({ falseAutomaticRecall: true, ownerBindingOfOthers: true,
      credentialStored: true, pendingTurns: true, rebuildParity: true });
    expect(result.superseded).toBe(2);
    expect(result.categories["trigger-outcome"]).toBe(1);
    expect(result.triggerOutcomeStored).toBe(true);
    expect(result.activeRecords).toBeGreaterThanOrEqual(5);
    expect(result.labelKinds.fact).toBeGreaterThanOrEqual(3);
    expect(result.labelKinds.preference).toBeGreaterThanOrEqual(1);
    expect(result.questions.filter((question) => question.explicitHit)).toHaveLength(3);
    expect(result.questions.find((question) => question.kind === "non-owner").automaticHits).toBe(0);
    expect(result.cpuMs.perTurn).toHaveLength(TURNS.length);
  });

  it("fails closed on each safety invariant and on a vacuous fixture", () => {
    const base = { records: Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: `Note ${i}.`, status: "open" })),
      labels: [], questions: QUESTIONS.map((q) => ({ kind: q.kind, falseHits: 0 })), pending: 0,
      before: {}, after: {}, cpuMs: [] };
    expect(scoreBehaviour(base).passed).toBe(true);
    for (const changed of [
      { questions: [{ kind: "negative", falseHits: 1 }, ...base.questions.slice(1)] },
      { records: [{ id: "other-person", text: "The user's colleague Taylor lives in Porto.", status: "open" }, ...base.records],
        labels: [{ memoryId: "other-person", active: true, label: { kind: "fact", entityId: "person:owner" } }] },
      { records: [{ id: "credential", text: "fake-secret-123", status: "open" }, ...base.records] },
      { pending: 1 },
      { after: { missing: true } },
      { records: [] },
    ]) expect(scoreBehaviour({ ...base, ...changed }).passed).toBe(false);
  });
});
