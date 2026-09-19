import { describe, expect, it } from "vitest";
import { contextFor, sourceOnly } from "../lib/memory-e2e-dataset.mjs";
import { lexicalAnswerScore, locomoCategory5Abstains, makeLocomoPlan, parseLocomoTimestamp, projectLocomo, projectLocomoSession } from "../lib/memory-e2e-locomo.mjs";
import { lexicalDiagnostic } from "../lib/memory-e2e-report.mjs";

function sample(id, { missing = [] } = {}) {
  const conversation = {
    speaker_a: "Alex",
    speaker_b: "Blair",
    session_1_date_time: "9:05 am on 2 January, 2025",
    session_1: [
      { speaker: "Alex", dia_id: `${id}-d1`, text: "SOURCE_SENTINEL from the first person.", ignored_summary: "LEAK_SENTINEL" },
      { speaker: "Blair", dia_id: `${id}-d2`, text: "A second reported statement.", img_url: "https://invalid.example/image", blip_caption: "LEAK_SENTINEL" },
    ],
  };
  const qa = [];
  for (let category = 1; category <= 5; category += 1) {
    if (missing.includes(category)) continue;
    qa.push({
      question: `QUESTION_SENTINEL category ${category}?`,
      answer: `GOLD_ANSWER_${category}`,
      adversarial_answer: `ADVERSARIAL_GOLD_${category}`,
      category,
      evidence: [category === 2 ? `${id}-d2` : `${id}-d1`],
      rubric: "LEAK_SENTINEL",
    });
  }
  return { sample_id: id, conversation, qa, observation: "LEAK_SENTINEL", session_summary: "LEAK_SENTINEL", event_summary: "LEAK_SENTINEL" };
}

function dataset() {
  return Array.from({ length: 10 }, (_, index) => sample(`conv-${index + 1}`));
}

describe("LoCoMo pinned-data adapter (synthetic schema only)", () => {
  it("parses upstream timestamps deterministically and rejects ambiguous input", () => {
    expect(parseLocomoTimestamp("9:05 am on 2 January, 2025")).toBe("2025-01-02T09:05:00.000Z");
    expect(parseLocomoTimestamp("12:10 pm on 12 December, 2025")).toBe("2025-12-12T12:10:00.000Z");
    expect(() => parseLocomoTimestamp("01/02/2025 09:05")).toThrow("locomo_invalid_timestamp");
  });

  it("preserves both humans as reports instead of assigning one the assistant role", () => {
    const projected = projectLocomoSession(sample("conv-x").conversation, "session_1");
    expect(projected.speaker).toBe("LoCoMo transcript");
    expect(projected.user).toContain("Alex reported: SOURCE_SENTINEL");
    expect(projected.user).toContain("Blair reported: A second reported statement.");
    expect(projected.assistant).toBe("The session transcript was recorded without adding claims.");
    expect(projected.assistant).not.toMatch(/Alex|Blair|SOURCE_SENTINEL/u);
    expect(JSON.stringify(projected)).not.toMatch(/img_url|blip_caption|invalid\.example|LEAK_SENTINEL/u);
  });

  it("freezes conversation-disjoint selection and keeps evaluator data out of capture/context projections", () => {
    const corpus = projectLocomo(dataset());
    expect(corpus.groups).toHaveLength(2);
    expect(corpus.groups.map((group) => group.split)).toEqual(["development", "evaluation"]);
    expect(new Set(corpus.groups.map((group) => group.id)).size).toBe(2);
    for (const group of corpus.groups) {
      const source = sourceOnly(group);
      const captureBytes = JSON.stringify(source.turns);
      expect(captureBytes).toContain("SOURCE_SENTINEL");
      expect(captureBytes).not.toMatch(/QUESTION_SENTINEL|GOLD_ANSWER|ADVERSARIAL_GOLD|LEAK_SENTINEL|evidence|category/u);
      expect(JSON.stringify(source.questions)).toContain("QUESTION_SENTINEL");
      expect(JSON.stringify(source.questions)).not.toMatch(/GOLD_ANSWER|ADVERSARIAL_GOLD|LEAK_SENTINEL|evidence|"category":/u);
      expect(contextFor(source, "bujo")).toEqual([]);
      expect(contextFor(source, "full-history")).toHaveLength(2);
      expect(group.questions.find((question) => question.evaluation.locomoCategory === 2).evaluation.imageAssociation).toEqual({
        evidenceCount: 1,
        imageAssociatedEvidenceCount: 1,
        dependency: "unknown",
      });
    }
  });

  it("selects QA by original index hash before outcomes and binds exact bounded work", () => {
    const raw = dataset();
    raw.forEach((entry) => entry.qa.push({ question: "another question", answer: "different", category: 1, evidence: [`${entry.sample_id}-d1`] }));
    const corpus = projectLocomo(raw);
    const group = corpus.groups.find((value) => value.split === "development");
    const selected = group.questions.find((question) => question.evaluation.locomoCategory === 1);
    expect(selected.evaluation.originalQaIndex).toBeTypeOf("number");
    expect(selected.evaluation.selectionHash).toMatch(/^[0-9a-f]{64}$/u);
    const plan = makeLocomoPlan({ corpus, sha256: "fixture", split: "development", codeRevision: "HEAD" });
    // Image association is diagnostic only: all five selected questions run in both arms.
    expect(plan.workload).toMatchObject({ questions: 5, trials: 10, captureStepsMaximum: 2, readerStepsMaximum: 30 });
    expect(plan.limits).toMatchObject({ chatSteps: 32, embeddingCalls: 17, estimatedInputTokens: 1_575_648, embeddingInputTokens: 84_704, outputTokens: 19_456 });
    expect(plan.locomo.ceilings).toMatchObject({ captureAdmissions: 1, captureModelSteps: 2, readerInvocations: 10, readerModelSteps: 30, chatInputTokensReserved: 1_490_944, embeddingInputTokensReserved: 84_704, semanticJudgeInvocations: 0 });
    expect(plan.locomo.executionGate).toMatchObject({ status: "blocked_pending_synthetic_native_context_probe", nativeNumCtxConfigured: false, redirectsRejectedByExistingAdapter: false, silentNativeTruncationDetectable: false });
    expect(JSON.stringify(plan)).not.toMatch(/QUESTION_SENTINEL|GOLD_ANSWER|SOURCE_SENTINEL/u);
  });

  it("never treats category-5 answer fields as truth and applies only the pinned abstention rule", () => {
    const corpus = projectLocomo(dataset());
    const question = corpus.groups[0].questions.find((value) => value.evaluation.locomoCategory === 5);
    expect(question.evaluation.accepted).toEqual([]);
    expect(question.evaluation.forbidden).toEqual([]);
    expect(locomoCategory5Abstains("There is no information available in the conversation.")).toBe(true);
    expect(locomoCategory5Abstains("That was not mentioned.")).toBe(true);
    expect(locomoCategory5Abstains("ADVERSARIAL_GOLD_5")).toBe(false);
    expect(lexicalDiagnostic("ADVERSARIAL_GOLD_5", question.evaluation, "real")).toEqual({
      status: "locomo_adversarial_abstention_only",
      exact: null,
      f1: null,
      abstained: false,
    });
  });

  it("implements deterministic normalized exact/F1 without model grading", () => {
    expect(lexicalAnswerScore("The blue, bicycle!", ["blue bicycle"])).toEqual({ exact: true, f1: 1 });
    expect(lexicalAnswerScore("blue", ["blue bicycle"])).toEqual({ exact: false, f1: 2 / 3 });
    expect(lexicalAnswerScore("green", ["blue bicycle"])).toEqual({ exact: false, f1: 0 });
  });
});
