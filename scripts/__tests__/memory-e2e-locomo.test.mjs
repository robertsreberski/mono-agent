import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextFor, sourceOnly } from "../lib/memory-e2e-dataset.mjs";
import { loadReusableArtifact } from "../lib/memory-e2e-checkpoint.mjs";
import {
  LOCOMO_ADAPTER_PROTOCOL,
  LOCOMO_CONFIRMATION_EXPERIMENT,
  LOCOMO_DEVELOPMENT_EXPERIMENT,
  LOCOMO_EXCHANGE_MAX_ENTRIES,
  LOCOMO_EXCHANGE_MAX_USER_BYTES,
  LOCOMO_HOSTED_PROFILE,
  LOCOMO_READER_PROMPT,
  LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS,
  lexicalAnswerScore,
  locomoCategory5Abstains,
  locomoExecutionProfile,
  makeLocomoPlan,
  parseLocomoTimestamp,
  projectLocomo,
  projectLocomoExchangeSession,
} from "../lib/memory-e2e-locomo.mjs";
import { nltkPorterStem, normalizeOfficialLocomoAnswer, officialLocomoScore } from "../lib/memory-e2e-locomo-score.mjs";
import { summarize, writeArtifacts } from "../lib/memory-e2e-report.mjs";
import { semanticReviewExport } from "../lib/memory-e2e-runner.mjs";

const dirs = [];
afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });

function sample(id, { sessions = 1, qaPerCategory = 8 } = {}) {
  const conversation = { speaker_a: "Alex", speaker_b: "Blair" };
  for (let session = 1; session <= sessions; session += 1) {
    conversation[`session_${session}_date_time`] = `9:0${session % 10} am on ${session} January, 2025`;
    conversation[`session_${session}`] = [
      { speaker: " Alex ", dia_id: `${id}-s${session}-d1`, text: `  exact first ${session}  `, ignored_summary: "LEAK_SENTINEL" },
      { speaker: "Blair", dia_id: `${id}-s${session}-d2`, text: `exact second ${session}`, img_url: "https://invalid.example/image", blip_caption: "LEAK_SENTINEL" },
      { speaker: "Alex", dia_id: `${id}-s${session}-d3`, text: `odd final ${session}` },
    ];
  }
  const qa = [];
  for (let category = 1; category <= 5; category += 1) for (let index = 0; index < qaPerCategory; index += 1) {
    qa.push({
      question: `QUESTION_SENTINEL ${id} category ${category} item ${index}?`,
      answer: `GOLD_ANSWER_${category}_${index}`,
      adversarial_answer: `ADVERSARIAL_GOLD_${category}_${index}`,
      category,
      evidence: [`${id}-s1-d${(index % 3) + 1}`],
      rubric: "LEAK_SENTINEL",
    });
  }
  return { sample_id: id, conversation, qa, observation: "LEAK_SENTINEL" };
}

function dataset() { return Array.from({ length: 10 }, (_, index) => sample(`conv-${index + 1}`, { sessions: (index % 3) + 1 })); }

describe("LoCoMo BuJo evaluation protocol (synthetic schema only)", () => {
  it("parses timestamps deterministically", () => {
    expect(parseLocomoTimestamp("9:05 am on 2 January, 2025")).toBe("2025-01-02T09:05:00.000Z");
    expect(parseLocomoTimestamp("12:10 pm on 12 December, 2025")).toBe("2025-12-12T12:10:00.000Z");
    expect(() => parseLocomoTimestamp("01/02/2025 09:05")).toThrow("locomo_invalid_timestamp");
  });

  it("preserves exact text, order, attribution and timestamp in adjacent human exchanges", () => {
    const raw = sample("conv-exchange").conversation;
    const exchanges = projectLocomoExchangeSession(raw, "session_1");
    expect(exchanges).toHaveLength(2);
    expect(exchanges.flatMap((turn) => turn.dialogue.map((entry) => entry.id))).toEqual([
      "conv-exchange-s1-d1", "conv-exchange-s1-d2", "conv-exchange-s1-d3",
    ]);
    expect(exchanges[0].dialogue).toEqual(raw.session_1.slice(0, 2).map((entry) => ({ id: entry.dia_id, speaker: entry.speaker, text: entry.text })));
    expect(exchanges[0].user).toContain(" Alex  said:   exact first 1  ");
    expect(exchanges[0].user).toContain("Blair said: exact second 1");
    expect(exchanges[0].timestamp).toBe("2025-01-01T09:01:00.000Z");
    expect(exchanges.every((turn) => turn.dialogue.length <= LOCOMO_EXCHANGE_MAX_ENTRIES)).toBe(true);
    expect(exchanges.every((turn) => Buffer.byteLength(turn.user, "utf8") <= LOCOMO_EXCHANGE_MAX_USER_BYTES)).toBe(true);
    expect(exchanges.every((turn) => turn.speaker === "LoCoMo human dialogue")).toBe(true);
    expect(exchanges.every((turn) => !/Assistant|tool claim|Alex said it was verified/u.test(turn.assistant))).toBe(true);
    expect(JSON.stringify(exchanges)).not.toMatch(/img_url|blip_caption|invalid\.example|LEAK_SENTINEL/u);

    raw.session_1[0].text = "x".repeat(LOCOMO_EXCHANGE_MAX_USER_BYTES);
    expect(() => projectLocomoExchangeSession(raw, "session_1")).toThrow("locomo_exchange_exceeds_bound");
  });

  it("freezes rank-5 development and previously unobserved rank-6 confirmation before inference", () => {
    const raw = dataset();
    const development = projectLocomo(raw, { experiment: LOCOMO_DEVELOPMENT_EXPERIMENT });
    const confirmation = projectLocomo(raw, { experiment: LOCOMO_CONFIRMATION_EXPERIMENT });
    expect(development.groups[0].partitionRank).toBe(5);
    expect(confirmation.groups[0].partitionRank).toBe(6);
    expect(development.groups[0].questions).toHaveLength(30);
    expect(confirmation.groups[0].questions).toHaveLength(20);
    expect(confirmation.partition.find((entry) => entry.rank === 6).observedLegacyUse).toBe("none_observed");
    expect(development.partition.find((entry) => entry.rank === 3).observedLegacyUse).toBe("protocol_selected_status_uncertain");
    expect(Object.fromEntries([1, 2, 3, 4, 5].map((category) => [category, development.groups[0].questions.filter((question) => question.evaluation.locomoCategory === category).length]))).toEqual({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 });
    expect(Object.fromEntries([1, 2, 3, 4, 5].map((category) => [category, confirmation.groups[0].questions.filter((question) => question.evaluation.locomoCategory === category).length]))).toEqual({ 1: 4, 2: 4, 3: 4, 4: 4, 5: 4 });
  });

  it("keeps references, evidence annotations and unrelated fields out of provider projections", () => {
    const corpus = projectLocomo(dataset(), { experiment: LOCOMO_DEVELOPMENT_EXPERIMENT });
    const group = corpus.groups[0];
    const source = sourceOnly(group);
    expect(JSON.stringify(source.turns)).toContain("exact first");
    expect(JSON.stringify(source.turns)).not.toMatch(/QUESTION_SENTINEL|GOLD_ANSWER|ADVERSARIAL_GOLD|LEAK_SENTINEL|evidence|category/u);
    expect(JSON.stringify(source.questions)).toContain("QUESTION_SENTINEL");
    expect(JSON.stringify(source.questions)).not.toMatch(/GOLD_ANSWER|ADVERSARIAL_GOLD|LEAK_SENTINEL|evidence/u);
    expect(contextFor(source, "bujo")).toEqual([]);
    expect(contextFor(source, "full-history")).toHaveLength(source.turns.length * 2);
    const associated = group.questions.find((question) => question.evaluation.imageAssociation.imageAssociatedEvidenceCount > 0);
    expect(associated.evaluation.imageAssociation.dependency).toBe("unknown");
  });

  it("binds prompt, projection, selection, arm and planned aggregate estimates into confirmation", () => {
    const corpus = projectLocomo(dataset(), { experiment: LOCOMO_DEVELOPMENT_EXPERIMENT });
    const profile = locomoExecutionProfile({
      reader: LOCOMO_HOSTED_PROFILE.reader,
      extractor: LOCOMO_HOSTED_PROFILE.extractor,
      embeddingProvider: "ollama",
      embeddingModel: "bge-m3:latest",
      dimension: 1024,
      piAuthPath: "/private/auth.json",
    }, { allowHostedTransfer: true });
    const plan = makeLocomoPlan({ corpus, sha256: "fixture", split: "evaluation", profile, codeRevision: "BASE", experiment: LOCOMO_DEVELOPMENT_EXPERIMENT, arm: "bujo" });
    expect(plan.arms).toEqual(["bujo"]);
    expect(plan.readerPrompt).toMatchObject({ id: LOCOMO_READER_PROMPT.id, text: LOCOMO_READER_PROMPT.text, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(plan.locomo).toMatchObject({
      protocol: LOCOMO_ADAPTER_PROTOCOL,
      experiment: { role: "development", partitionRank: 5, questionTarget: 30, selectionFrozenBeforeInference: true },
      source: { maxEntriesPerExchange: 2, losslessRule: expect.stringContaining("no trimming or truncation") },
      selected: { categoryDenominators: { 1: 6, 2: 6, 3: 6, 4: 6, 5: 6 }, answerableQuestions: 24, category5Questions: 6 },
      review: { blindArmLabels: true, paidAutomaticJudge: false },
    });
    expect(plan.perCall).toMatchObject({
      readerMaxTurns: 4, readerEstimatedInputTokens: 98_304, extractorEstimatedInputTokens: 8_192,
      reconciliationEstimatedInputTokens: 29_897, callTimeoutMs: 180_000,
      readinessTimeoutMs: 5_880_000, captureModelOutputAttempts: 16,
    });
    expect(plan.locomo.captureRecovery).toEqual({
      policy: "native_persisted_exponential_v1", maxAttempts: 16, retryBaseMs: 60_000,
      retryMaxMs: 21_600_000, scheduleSource: "durable_pending_record_nextAttemptAt",
      virtualClock: "advance_exactly_to_persisted_schedule", retryableFailure: "model_output_only",
    });
    expect(plan.locomo.executionGate.largestReservedPromptAndOutput).toBe(98_816);
    expect(plan.locomo.ceilings.captureAdmissions).toBe(corpus.groups[0].source.turns.length);
    expect(plan.locomo.ceilings.captureModelSteps).toBe(plan.locomo.ceilings.captureAdmissions * 32);
    expect(plan.locomo.ceilings.readerInvocations).toBe(30);
    expect(plan.locomo.ceilings.readerModelSteps).toBe(120);
    expect(plan.locomo.ceilings.semanticJudgeInvocations).toBe(0);
    expect(plan.limits.chatSteps).toBe(plan.locomo.ceilings.captureModelSteps + plan.locomo.ceilings.readerModelSteps);
    expect(plan.limits.embeddingCalls).toBe(plan.locomo.ceilings.captureModelSteps + plan.locomo.ceilings.readerRecallCalls);
    expect(plan.limits.outputTokens).toBe(plan.locomo.ceilings.captureModelSteps * 2_048
      + plan.locomo.ceilings.readerModelSteps * 512);
    expect(plan.limits.estimatedInputTokens).toBe(plan.locomo.ceilings.combinedInputTokensReserved);
    expect(plan.locomo.plannedComparisonAggregateMaximum).toMatchObject({
      scope: "planning_estimate_for_three_separately_enforced_invocations",
      plannedInvocations: 3, bujoRevisions: 2, fullHistoryReaders: 1, uniqueQuestions: 30, answerInvocations: 90,
      captureAdmissions: corpus.groups[0].source.turns.length * 2,
      extractionModelSteps: corpus.groups[0].source.turns.length * 32,
      reconciliationModelSteps: corpus.groups[0].source.turns.length * 32,
      captureModelSteps: corpus.groups[0].source.turns.length * 64,
      readerModelSteps: 360, semanticJudgeInvocations: 0,
      crossProcessAdmissionEnforced: false, perInvocationLimitsEnforcedSeparately: true, parentControlledExecutionRequired: true,
    });
    expect(plan.locomo.executionGate).toMatchObject({
      status: "dry_plan_only_parent_control_required",
      realExecutionApproved: false,
      requiredBeforeRealExecution: "materially_smaller_parent_approved_budget_strategy",
    });
    expect(plan.profile).not.toHaveProperty("piAuthPath");
    expect(JSON.stringify(plan)).not.toMatch(/QUESTION_SENTINEL|GOLD_ANSWER|exact first|private\/auth/u);
    const measuredPlan = makeLocomoPlan({
      corpus, sha256: "fixture", split: "evaluation",
      profile: { ...profile, outputBudgetMode: "measured" },
      codeRevision: "BASE", experiment: LOCOMO_DEVELOPMENT_EXPERIMENT, arm: "bujo",
    });
    expect(measuredPlan.locomo.executionGate).toMatchObject({
      status: "measured_output_mode_selected_external_authorization_required",
      realExecutionApproved: false,
      requiredBeforeRealExecution: "external_authorization_for_measured_output",
      outputAccounting: "observed_usage_not_wire_capped",
    });
    expect(measuredPlan.budgetEnforcement.outputTokens).toMatchObject({
      strictRealExecutionSupported: false,
      executionMode: "measured_output_explicit_opt_in",
    });
    expect(makeLocomoPlan({ corpus, sha256: "fixture", split: "evaluation", profile, codeRevision: "CANDIDATE", experiment: LOCOMO_DEVELOPMENT_EXPERIMENT, arm: "bujo" }).confirmation).not.toBe(plan.confirmation);
    expect(makeLocomoPlan({ corpus, sha256: "fixture", split: "evaluation", profile, codeRevision: "BASE", experiment: LOCOMO_DEVELOPMENT_EXPERIMENT, arm: "full-history" }).confirmation).not.toBe(plan.confirmation);
    expect(LOCOMO_RECONCILIATION_ESTIMATED_INPUT_TOKENS).toBe(29_897);
  });

  it("exports a four-way human rubric with blinded arm labels and separate answerability/image flags", () => {
    const corpus = projectLocomo(dataset(), { experiment: LOCOMO_DEVELOPMENT_EXPERIMENT });
    const group = corpus.groups[0];
    const question = group.questions[0];
    const plan = { locomo: { protocolIdentity: "1".repeat(64) } };
    const review = semanticReviewExport({
      groups: [group], plan,
      trials: ["full-history", "bujo"].map((arm) => ({ questionId: question.id, arm, answer: `${arm} answer` })),
    });
    expect(review.rubric).toMatchObject({ identity: "human-semantic-v1", labels: ["correct", "partial", "incorrect", "abstained"], paidAutomaticJudge: false });
    expect(review.items.map((item) => item.blindArm).sort()).toEqual(["A", "B"]);
    expect(review.items.every((item) => !Object.hasOwn(item, "arm") && typeof item.answerable === "boolean"
      && typeof item.imageAssociated === "boolean" && typeof item.imageDependency === "string")).toBe(true);
  });

  it("retains the pinned lexical metric and separates incomplete quality from zero", () => {
    expect(normalizeOfficialLocomoAnswer("The blue, and red bicycles!")).toBe("blue red bicycles");
    expect(nltkPorterStem("replacement")).toBe("replac");
    expect(officialLocomoScore("cats running, skies", "cat runs, sky", 1)).toBe(1);
    expect(officialLocomoScore("Paris", "Paris; France", 3)).toBe(1);
    expect(LOCOMO_READER_PROMPT).toMatchObject({
      id: "locomo-evidence-reader-v2",
      text: expect.stringContaining("answer exactly: No information available."),
    });
    expect(locomoCategory5Abstains("No information available.")).toBe(true);
    expect(officialLocomoScore("No information available.", null, 5)).toBe(1);
    expect(locomoCategory5Abstains("This was not mentioned.")).toBe(true);
    expect(lexicalAnswerScore("blue", ["blue bicycle"])).toEqual({ exact: false, f1: 2 / 3 });
    const diagnostic = { officialScore: 1 };
    const summary = summarize([
      { groupId: "g", questionId: "q", arm: "full-history", locomoCategory: 1, status: "completed", answer: "a", lexicalDiagnostic: diagnostic },
      { groupId: "g", questionId: "q", arm: "bujo", locomoCategory: 1, status: "unstarted", answer: null, automatic: [], rawRetrievals: [], tools: [] },
    ], [], "real", []);
    expect(summary).toMatchObject({
      qualityMeasured: false,
      semanticQualityMeasured: false,
      officialLexicalMetricMeasured: false,
    });
    expect(summary.locomoOfficial.byArm.bujo.overall).toEqual({ value: null, status: "invalid_incomplete", scheduled: 1, completed: 0 });
    expect(summary.diagnosticFunnel.status).toBe("incomplete_unmeasured");
    expect(summary.diagnosticFunnel.capture.candidates).toEqual({ availability: "unavailable", records: null });

    const complete = summarize([
      { groupId: "g", questionId: "q", arm: "full-history", locomoCategory: 5, status: "completed", answer: "No information available.", lexicalDiagnostic: diagnostic },
      { groupId: "g", questionId: "q", arm: "bujo", locomoCategory: 5, status: "completed", answer: "No information available.", lexicalDiagnostic: diagnostic, automatic: [{ status: "completed" }], rawRetrievals: [], tools: [] },
    ], [
      { arm: "bujo", stage: "admission", status: "completed" },
      { arm: "bujo", stage: "readiness_wait", status: "completed" },
    ], "real", [
      { arm: "bujo", stage: "extraction" },
      { arm: "bujo", stage: "reconciliation" },
      { arm: "bujo", stage: "inventory" },
    ]);
    expect(complete).toMatchObject({
      qualityMeasured: false,
      semanticQualityMeasured: false,
      officialLexicalMetricMeasured: true,
      semanticQA: { value: null, status: "annotation_pending" },
      humanReview: { status: "not_performed", sampleSize: 0 },
    });
    expect(complete.locomoOfficial.byArm.bujo.overall).toMatchObject({ value: 1, status: "complete" });
  });

  it("reuses only an exact complete immutable artifact identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-e2e-checkpoint-")); dirs.push(directory);
    const plan = {
      protocol: "memory-e2e-v1", confirmation: "confirm-a", codeRevision: "rev-a", corpusSha256: "corpus",
      arms: ["full-history"], profile: { reader: "model" }, readerPrompt: { sha256: "prompt" },
      workload: { trials: 1 }, locomo: {
        protocol: LOCOMO_ADAPTER_PROTOCOL, protocolIdentity: "protocol-id",
        source: { identitySha256: "source" }, selected: { questionIdentitySha256: "questions" },
        evaluator: { identity: "metric" },
      },
    };
    const bundle = {
      manifest: { ...plan, executionKind: "real", trialsNotStarted: 0, providerStop: null },
      summary: { diagnosticFunnel: { status: "complete" } },
      trials: [{ status: "completed" }], events: [], capture: [], review: {},
    };
    await writeArtifacts(directory, bundle);
    const canonicalDirectory = await realpath(directory);
    await expect(loadReusableArtifact(canonicalDirectory, plan)).resolves.toMatchObject({
      status: "reused_exact_completed_artifact",
      reuseScope: "complete_result_only_no_partial_capture_resume",
    });
    await expect(loadReusableArtifact(canonicalDirectory, { ...plan, confirmation: "confirm-b" })).rejects.toThrow("checkpoint_identity_mismatch");
    const incomplete = await mkdtemp(join(tmpdir(), "memory-e2e-checkpoint-incomplete-")); dirs.push(incomplete);
    await writeArtifacts(incomplete, { ...bundle, summary: { diagnosticFunnel: { status: "incomplete_unmeasured" } }, trials: [{ status: "unstarted" }] });
    await expect(loadReusableArtifact(await realpath(incomplete), plan)).rejects.toThrow("checkpoint_identity_mismatch");
  });
});
