import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, armsFor, loadCorpus, makePlan, serializableProfile, sourceOnly, contextFor, validateCorpus } from "../lib/memory-e2e-dataset.mjs";
import { Budget, BenchmarkError, canonicalFailureKind, captureLlm, failureKindOf, isFatalFailureKind, meteredEmbeddings, meteredRuntime, realProviders, scriptedProviders, usageOf } from "../lib/memory-e2e-providers.mjs";
import { percentiles, ratio, lexicalDiagnostic, safeArtifact, ownedParent, summarize } from "../lib/memory-e2e-report.mjs";
import { automaticRecallObservation, awaitReady, captureFailureKindFor, captureRetryCause, cleanupTrial, currentCaptureRetryCause, persistedCaptureRetrySchedule, readySnapshot } from "../lib/memory-e2e-runner.mjs";
import { prepareRealBuild, verifyRealBuild, BUILD_POLICY } from "../lib/memory-e2e-build.mjs";
import { main, parseArguments, profileFrom } from "../memory-e2e-benchmark.mjs";
import { CompletedTurnIntakeManager, inspectCompletedTurnIntake } from "../../packages/memory/src/bujo/capture-intake.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const budgets = [];
const dirs = [];
afterEach(async () => { for (const b of budgets.splice(0)) b.close(); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
async function setup() { const loaded = await loadCorpus(); const plan = makePlan(loaded); const budget = new Budget(plan); budgets.push(budget); return { ...loaded, plan, budget }; }
const ready = { intake: { pending: 0, dead: 0, due: 0, transitioning: 0, retrying: 0, resolved: 1 }, shutdown: { timedOut: false, discarded: 0 } };
const realProviderPlan = { perCall: { embeddingTimeoutMs: 23_456 } };

describe("memory E2E benchmark contracts (not model quality)", () => {
  it("standalone success exits after output even when a dependency retains a handle", () => {
    const child = spawnSync(process.execPath, [
      "--import=data:text/javascript,setInterval(() => {}, 10000)",
      join(root, "scripts/memory-e2e-benchmark.mjs"), "--dry-run",
    ], { cwd: root, encoding: "utf8", timeout: 3000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).confirmation).toMatch(/^[0-9a-f]{64}$/u);
  });
  it("freezes the fictional corpus and covers the five arms/six evaluation categories", async () => {
    const { corpus, sha256, plan } = await setup();
    expect(sha256).toBe("db8fe538f1abbd94511f95c356b111e5eca33cdb2e15fb2ccdaee9681b6889c0");
    expect(corpus.groups).toHaveLength(8);
    expect(new Set(corpus.groups.filter((g) => g.split === "evaluation").map((g) => g.evaluation.category)).size).toBe(6);
    expect(plan.arms).toEqual(ARMS);
    expect(plan.workload).toEqual({ questions: 2, trials: 10, historicalTurnsPerMemoryArm: 8, captureStepsMaximum: 16, readerStepsMaximum: 30 });
    expect(plan.perCall.embeddingTimeoutMs).toBe(30_000);
    const shorterEmbeddingDeadline = makePlan({ corpus, sha256, perCall: { embeddingTimeoutMs: 29_999 } });
    expect(shorterEmbeddingDeadline.confirmation).not.toBe(plan.confirmation);
    expect(makePlan({ corpus, sha256, split: "evaluation" }).limits.chatSteps).toBe(138);
  });
  it("keeps labels and arbitrary gold fields out of the closed source projection", async () => {
    const { corpus } = await setup(); const group = structuredClone(corpus.groups[0]);
    group.answer = "GOLD_CANARY"; group.source.answer = "GOLD_CANARY"; group.source.turns[0].has_answer = "GOLD_CANARY"; group.source.question.evidence = "GOLD_CANARY"; group.evaluation.answer = "GOLD_CANARY";
    const source = sourceOnly(group);
    expect(JSON.stringify(source)).not.toContain("GOLD_CANARY");
    expect(source.turns[0]).toMatchObject({ speaker: "Mira", timestamp: "2025-01-10T12:00:00.000Z", sessionId: "s1" });
    expect(contextFor(source, "recent-only")).toEqual(contextFor(source, "bujo"));
    expect(contextFor(source, "recent-only")).toHaveLength(2);
    expect(contextFor(source, "full-history")).toHaveLength(8);
  });
  it("rejects reordered dates and ambiguous timestamps", async () => {
    const { corpus } = await setup(); const bad = structuredClone(corpus);
    bad.groups[0].source.turns[0].timestamp = "01/10/2025";
    expect(() => validateCorpus(bad)).toThrow("invalid_turn");
  });
  it("does not construct providers or touch credentials in dry run / refused real run", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const output = [];
    expect(await main(["--dry-run"], { stdout: (text) => output.push(JSON.parse(text)) })).toBe(0);
    expect(output[0].confirmation).toMatch(/^[0-9a-f]{64}$/u);
    await expect(main(["--real"])).rejects.toThrow("real_execution_requires_confirmed_profile");
    expect(network).not.toHaveBeenCalled();
    expect(() => parseArguments(["--memory-path", "/private"])).toThrow();
    expect(() => parseArguments(["--real", "--real"])).toThrow();
    expect(parseArguments(["--allow-hosted-locomo-transfer"])).toEqual({ "allow-hosted-locomo-transfer": true });
    expect(parseArguments(["--locomo-experiment", "locomo-bujo-eval-v1-rank5-development-30"]))
      .toEqual({ "locomo-experiment": "locomo-bujo-eval-v1-rank5-development-30" });
    await expect(main(["--dry-run", "--locomo-experiment", "locomo-bujo-eval-v1-rank5-development-30"]))
      .rejects.toThrow("locomo_experiment_requires_locomo");
    expect(() => profileFrom({ reader: "openai:model" })).toThrow("incomplete_profile");
    await expect(main(["--dry-run", "--corpus", "locomo-v1", "--reader", "openai:model", "--extractor", "openai:model", "--embedding-provider", "ollama", "--embedding-model", "fixture", "--dimension", "8"]))
      .rejects.toThrow("locomo_hosted_transfer_ack_required");
    await expect(main(["--dry-run", "--allow-hosted-locomo-transfer"]))
      .rejects.toThrow("hosted_locomo_transfer_ack_requires_locomo");
  });
  it("records null, hit, truncation and degradation without inferring private content", () => {
    const selectHits = (hits) => hits.filter((hit) => hit.score >= 0.5);
    expect(automaticRecallObservation({
      block: undefined,
      outcome: { hits: [], retrievalMode: "hybrid" },
      query: "synthetic",
      selectHits,
    })).toEqual({
      content: null, source: null, bytes: 0, hitCount: 0, truncated: false,
      retrievalMode: "hybrid", degradation: null, status: "completed",
    });
    expect(automaticRecallObservation({
      block: { content: "## Memory\n\n- synthetic hit", source: "memory", truncated: false },
      outcome: { hits: [{ score: 0.9 }], retrievalMode: "hybrid" },
      query: "synthetic",
      selectHits,
    })).toMatchObject({ content: "## Memory\n\n- synthetic hit", source: "memory", hitCount: 1, truncated: false });
    expect(automaticRecallObservation({
      block: { content: "## Memory\n\n- synt", source: "memory", truncated: true },
      outcome: {
        hits: [{ score: 0.9 }, { score: 0.4 }], retrievalMode: "lexical_only",
        degradation: { code: "embedding_unavailable" },
      },
      query: "synthetic",
      selectHits,
    })).toMatchObject({
      bytes: 17, hitCount: 1, truncated: true,
      retrievalMode: "lexical_only", degradation: "embedding_unavailable",
    });
  });

  it("the direct confirmed real command cannot import production/providers before a required build", async () => {
    const profile = ["--reader", "fixture:reader", "--extractor", "fixture:extractor", "--embedding-provider", "ollama", "--embedding-model", "fixture", "--dimension", "8"];
    let plan;
    await main(["--dry-run", ...profile], { stdout: (text) => { plan = JSON.parse(text); } });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const prepareBuild = vi.fn(async () => { throw new Error("synthetic_build_refused"); });
    await expect(main(["--real", ...profile, "--confirm-plan", plan.confirmation], { prepareBuild })).rejects.toThrow("synthetic_build_refused");
    expect(prepareBuild).toHaveBeenCalledOnce(); expect(network).not.toHaveBeenCalled();
  });
  it("discloses and preflights the selected Codex wire-cap limitation before build or providers", async () => {
    const profile = ["--reader", "openai-codex:reader", "--extractor", "openai-codex:extractor", "--embedding-provider", "ollama", "--embedding-model", "fixture", "--dimension", "8"];
    const output = [];
    await main(["--dry-run", ...profile], { stdout: (text) => output.push(JSON.parse(text)) });
    expect(output[0].budgetEnforcement).toEqual({
      providerTransport: {
        requested: "sse",
        piMaxRetries: 0,
        automaticWebSocketFallback: false,
        observedAttempts: "unknown_unless_provider_reports",
      },
      outputTokens: {
        accounting: "pre_admission_reservation",
        providerHint: "providerCheckMaxTokens",
        wireCap: "unsupported_by_selected_openai_codex_provider",
        strictRealExecutionSupported: false,
        executionMode: "strict_output_cap_required",
      },
    });
    expect(output[0].limitations).toContain("providerCheckMaxTokens is not a universal wire-enforced output cap");
    const prepareBuild = vi.fn();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    await expect(main(["--real", ...profile, "--confirm-plan", output[0].confirmation], { prepareBuild }))
      .rejects.toThrow("strict_output_budget_unsupported");
    expect(prepareBuild).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("binds an explicit measured-output opt-in and preserves build-first real execution", async () => {
    const profile = ["--reader", "openai-codex:reader", "--extractor", "openai-codex:extractor", "--embedding-provider", "ollama", "--embedding-model", "fixture", "--dimension", "8", "--allow-measured-output"];
    let plan;
    await main(["--dry-run", ...profile], { stdout: (text) => { plan = JSON.parse(text); } });
    expect(plan.profile.outputBudgetMode).toBe("measured");
    expect(plan.budgetEnforcement.outputTokens).toMatchObject({
      accounting: "pre_admission_reservation_plus_observed_usage",
      wireCap: "unsupported_by_selected_openai_codex_provider",
      strictRealExecutionSupported: false,
      executionMode: "measured_output_explicit_opt_in",
    });
    expect(plan.limitations).toContain("explicit measured-output mode records observed usage but does not enforce a wire output cap");
    const prepareBuild = vi.fn(async () => { throw new Error("synthetic_build_refused"); });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    await expect(main(["--real", ...profile, "--confirm-plan", plan.confirmation], { prepareBuild }))
      .rejects.toThrow("synthetic_build_refused");
    expect(prepareBuild).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
  });
  it("flush alone cannot certify pending, dead, dropped, delayed or missing index work", async () => {
    expect(readySnapshot(ready)).toBe(true);
    for (const key of ["pending", "dead", "due", "transitioning", "retrying"]) expect(readySnapshot({ ...ready, intake: { ...ready.intake, [key]: 1 } })).toBe(false);
    expect(readySnapshot({ ...ready, capture: {} })).toBe(false);
    const index = { queued: 0, inFlight: 0, remainingBacklog: 0, recoveryFilesRemaining: 0, failed: 0, dropped: 0, discarded: 0 };
    expect(readySnapshot({ ...ready, index })).toBe(true);
    for (const key of Object.keys(index)) expect(readySnapshot({ ...ready, index: { ...index, [key]: 1 } })).toBe(false);
    await expect(awaitReady({ flush: async () => {}, queueSnapshot: () => ({ ...ready, intake: { ...ready.intake, pending: 1 } }) }, 20)).rejects.toThrow("capture_not_ready");
    await expect(awaitReady({ flush: () => new Promise(() => {}) }, 5)).rejects.toThrow("readiness_timeout");
  });
  it("advances to persisted native retry schedules, reports recovery, and preserves non-output stops", async () => {
    const id = "a".repeat(64);
    let attempts = 0; let now = Date.parse("2026-09-20T00:00:00.000Z");
    const retries = []; const outcomes = [];
    const recovered = await awaitReady({
      flush: async () => { attempts += 1; },
      queueSnapshot: () => attempts >= 2 ? ready : { ...ready, intake: { ...ready.intake, pending: 1, resolved: 0 } },
    }, 100, undefined, {
      id, maxAttempts: 16,
      inspect: () => ({ items: [{ id, state: attempts >= 2 ? "resolved" : "pending", attempt: 1, ...(attempts >= 2 ? {} : { lastError: "model_output" }) }] }),
      persistedSchedule: (item) => ({ id, attempt: item.attempt, nextAttemptAt: "2026-09-20T00:01:00.000Z" }),
      advanceClock: (value) => { const advance = Date.parse(value) - now; now = Date.parse(value); return advance; },
      onRetry: (value) => retries.push(value), onReady: (value) => outcomes.push(value),
    });
    expect(recovered).toEqual(ready);
    expect(attempts).toBe(2);
    expect(now).toBe(Date.parse("2026-09-20T00:01:00.000Z"));
    expect(retries).toEqual([{
      attempt: 1, failureKind: "model_output", recoveryCause: "model_output",
      nextAttemptAt: "2026-09-20T00:01:00.000Z", advanceMs: 60_000,
    }]);
    expect(outcomes).toEqual([{ attempt: 2, priorFailures: 1, status: "recovered_success" }]);

    let providerAttempts = 0;
    await expect(awaitReady({
      flush: async () => { providerAttempts += 1; },
      queueSnapshot: () => ({ ...ready, intake: { ...ready.intake, pending: 1, resolved: 0 } }),
    }, 100, undefined, {
      id, maxAttempts: 16,
      inspect: () => ({ items: [{ id, state: "pending", attempt: 1, lastError: "provider" }] }),
      persistedSchedule: () => { throw new Error("must not read schedule"); },
      advanceClock: () => { throw new Error("must not advance"); },
      onRetry: () => { throw new Error("must not retry"); },
    })).rejects.toThrow("capture_not_ready");
    expect(providerAttempts).toBe(1);
  });

  it("admits only a current-attempt finite capture-step provider failure", () => {
    const pending = { lastError: "provider" };
    const finite = {
      stage: "reconciliation", status: "capture_step_budget_exhausted",
      failureKind: "budget_exceeded", providerReportedFailureKind: "usage_limit", maxTurnsHit: true,
    };
    expect(captureRetryCause(pending, finite)).toBe("finite_capture_step");
    expect(captureRetryCause(pending, { ...finite, maxTurnsHit: false })).toBeNull();
    expect(captureRetryCause(pending, { ...finite, providerReportedFailureKind: "provider_auth" })).toBeNull();
    expect(captureRetryCause(pending, { ...finite, status: "provider_failed" })).toBeNull();
    const correlated = currentCaptureRetryCause([
      { groupId: "g", arm: "bujo", ...finite },
      { groupId: "other", arm: "bujo", ...finite },
      { groupId: "g", arm: "bujo", stage: "reconciliation", status: "completed" },
    ], 1, { groupId: "g", arm: "bujo" }, pending);
    expect(correlated).toEqual({ cause: null, nextCursor: 3 });
    expect(captureRetryCause({ lastError: "processing" }, finite)).toBeNull();
    expect(captureRetryCause({ lastError: "model_output" }, { status: "completed" })).toBe("model_output");
    expect(captureRetryCause({ lastError: "model_output" }, { status: "capture_timeout_settled" }))
      .toBe("settled_capture_timeout");

    const structured = {
      stage: "extraction",
      status: "structured_result_missing",
      runtimeSettlement: "fulfilled",
      structuredOutputFailure: "structured_result_missing",
      failureKind: null,
      providerReportedFailureKind: null,
      maxTurnsHit: false,
    };
    expect(captureRetryCause(pending, structured)).toBe("settled_structured_output");
    for (const status of ["structured_result_key_missing", "structured_result_unserializable"]) {
      expect(captureRetryCause(pending, {
        ...structured, status, structuredOutputFailure: status, stage: "reconciliation",
      })).toBe("settled_structured_output");
    }
    expect(captureRetryCause(pending, { ...structured, runtimeSettlement: "unknown" })).toBeNull();
    expect(captureRetryCause(pending, { ...structured, structuredOutputFailure: "provider_failed" })).toBeNull();
    expect(captureRetryCause(pending, { ...structured, failureKind: "provider_auth" })).toBeNull();
    expect(captureRetryCause(pending, { ...structured, providerReportedFailureKind: "usage_limit" })).toBeNull();
    expect(captureRetryCause(pending, { ...structured, maxTurnsHit: true })).toBeNull();
    for (const status of ["provider_failed", "provider_timeout_or_cancelled", "provider_settlement_unknown", "output_limit_reached", "unfinished_tool_loop"]) {
      expect(captureRetryCause(pending, { ...structured, status, structuredOutputFailure: status })).toBeNull();
    }
    const staleStructured = currentCaptureRetryCause([
      { groupId: "g", arm: "bujo", ...structured },
      { groupId: "g", arm: "bujo", stage: "extraction", status: "provider_failed" },
    ], 0, { groupId: "g", arm: "bujo" }, pending);
    expect(staleStructured).toEqual({ cause: null, nextCursor: 2 });
  });

  it("bounds persistent finite capture-step failures at the native provider dead letter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-step-exhaustion-test-")); dirs.push(directory);
    const maxAttempts = 16; let attempts = 0; let now = new Date("2026-09-20T00:00:00.000Z");
    const exhausted = []; const scheduled = [];
    const intake = new CompletedTurnIntakeManager({
      root: directory, clock: () => now, writeSummary: async () => {},
      capture: async () => {
        attempts += 1;
        const error = new Error("finite capture step exhausted"); error.name = "MemoryModelError"; throw error;
      },
    });
    const admission = intake.admit({
      runId: "runner-native-step-exhaustion", conversationId: "conversation", summary: "summary", captureText: "source",
    });
    const finite = {
      status: "capture_step_budget_exhausted", failureKind: "budget_exceeded",
      providerReportedFailureKind: "usage_limit", maxTurnsHit: true,
    };
    await expect(awaitReady({
      flush: () => intake.flush(),
      queueSnapshot: () => ({ intake: intake.snapshot(), shutdown: { timedOut: false, discarded: 0 } }),
    }, 2000, undefined, {
      id: admission.id, maxAttempts,
      inspect: () => inspectCompletedTurnIntake(directory, now),
      persistedSchedule: (item) => persistedCaptureRetrySchedule(admission.source, item),
      advanceClock: (value) => { const advance = Date.parse(value) - now.getTime(); now = new Date(value); return advance; },
      retryCause: (item) => captureRetryCause(item, finite),
      onRetry: (value) => scheduled.push(value), onExhausted: (value) => exhausted.push(value),
    })).rejects.toThrow("capture_not_ready");
    expect(attempts).toBe(16);
    expect(scheduled).toHaveLength(15);
    expect(scheduled.every((entry) => entry.failureKind === "provider"
      && entry.recoveryCause === "finite_capture_step")).toBe(true);
    expect(exhausted).toEqual([{
      attempt: 16, failureKind: "provider", recoveryCause: "finite_capture_step",
    }]);
    expect(inspectCompletedTurnIntake(directory, now).items[0]).toMatchObject({
      id: admission.id, state: "dead", attempt: 16, lastError: "provider",
    });
    intake.finishShutdown();
  });

  it("bounds repeated settled structured-contract failures at the native provider dead letter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-structured-exhaustion-test-")); dirs.push(directory);
    const { budget } = await setup();
    const maxAttempts = 16; let attempts = 0; let now = new Date("2026-09-20T00:00:00.000Z");
    const exhausted = []; const scheduled = []; const tag = { groupId: "g", arm: "bujo" };
    const llm = captureLlm({ run: async () => ({ text: "plausible fallback" }) }, {
      model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag,
    });
    const intake = new CompletedTurnIntakeManager({
      root: directory, clock: () => now, writeSummary: async () => {},
      capture: async () => {
        attempts += 1;
        try {
          await llm.complete("extract", { label: "capture:extract", outputSchema: { type: "object" } });
        } catch (cause) {
          const error = new Error("settled structured contract failure", { cause });
          error.name = "MemoryModelError";
          throw error;
        }
        return "captured";
      },
    });
    const admission = intake.admit({
      runId: "runner-native-structured-exhaustion", conversationId: "conversation", summary: "summary", captureText: "source",
    });
    let cursor = 0;
    await expect(awaitReady({
      flush: () => intake.flush(),
      queueSnapshot: () => ({ intake: intake.snapshot(), shutdown: { timedOut: false, discarded: 0 } }),
    }, 2000, budget, {
      id: admission.id, maxAttempts,
      inspect: () => inspectCompletedTurnIntake(directory, now),
      persistedSchedule: (item) => persistedCaptureRetrySchedule(admission.source, item),
      advanceClock: (value) => { const advance = Date.parse(value) - now.getTime(); now = new Date(value); return advance; },
      retryCause: (item) => {
        const classified = currentCaptureRetryCause(budget.events, cursor, tag, item);
        cursor = classified.nextCursor;
        return classified.cause;
      },
      onRetry: (value) => scheduled.push(value), onExhausted: (value) => exhausted.push(value),
    })).rejects.toThrow("capture_not_ready");
    expect(attempts).toBe(16);
    expect(scheduled).toHaveLength(15);
    expect(scheduled.every((entry) => entry.failureKind === "provider"
      && entry.recoveryCause === "settled_structured_output")).toBe(true);
    expect(exhausted).toEqual([{
      attempt: 16, failureKind: "provider", recoveryCause: "settled_structured_output",
    }]);
    expect(budget.events).toHaveLength(16);
    expect(budget.events.every((entry) => entry.status === "structured_result_missing"
      && entry.runtimeSettlement === "fulfilled"
      && entry.structuredOutputFailure === "structured_result_missing")).toBe(true);
    expect(inspectCompletedTurnIntake(directory, now).items[0]).toMatchObject({
      id: admission.id, state: "dead", attempt: 16, lastError: "provider",
    });
    intake.finishShutdown();
  });

  it("bounds persistent malformed output at the actual native dead letter and records exhaustion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-exhaustion-test-")); dirs.push(directory);
    const maxAttempts = 16; let attempts = 0; let now = new Date("2026-09-20T00:00:00.000Z");
    const exhausted = []; const scheduled = [];
    const intake = new CompletedTurnIntakeManager({
      root: directory, clock: () => now, writeSummary: async () => {},
      capture: async () => {
        attempts += 1;
        const error = new Error("persistently malformed structured output"); error.name = "MemoryModelOutputError"; throw error;
      },
    });
    const admission = intake.admit({
      runId: "runner-native-exhaustion", conversationId: "conversation", summary: "summary", captureText: "source",
    });
    await expect(awaitReady({
      flush: () => intake.flush(),
      queueSnapshot: () => ({ intake: intake.snapshot(), shutdown: { timedOut: false, discarded: 0 } }),
    }, 2000, undefined, {
      id: admission.id, maxAttempts,
      inspect: () => inspectCompletedTurnIntake(directory, now),
      persistedSchedule: (item) => persistedCaptureRetrySchedule(admission.source, item),
      advanceClock: (value) => { const advance = Date.parse(value) - now.getTime(); now = new Date(value); return advance; },
      onRetry: (value) => scheduled.push(value), onExhausted: (value) => exhausted.push(value),
    })).rejects.toThrow("capture_not_ready");
    expect(attempts).toBe(16);
    expect(scheduled).toHaveLength(15);
    expect(scheduled.map((entry) => entry.advanceMs)).toEqual([
      60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_840_000, 7_680_000,
      15_360_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000, 21_600_000,
    ]);
    expect(exhausted).toEqual([{
      attempt: 16, failureKind: "model_output", recoveryCause: "model_output",
    }]);
    expect(inspectCompletedTurnIntake(directory, now).items[0]).toMatchObject({ state: "dead", attempt: 16 });
    intake.finishShutdown();
  });

  it("drives actual durable intake from malformed first output to one atomic recovered success", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-intake-test-")); dirs.push(directory);
    let now = new Date("2026-09-20T00:00:00.000Z"); let captureAttempts = 0;
    const commits = []; const outcomes = []; const retries = [];
    const intake = new CompletedTurnIntakeManager({
      root: directory, clock: () => now,
      writeSummary: async () => {},
      capture: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) {
          const error = new Error("malformed structured output"); error.name = "MemoryModelOutputError"; throw error;
        }
        commits.push("complete-plan"); return "captured";
      },
    });
    const admission = intake.admit({
      runId: "runner-native-recovery", conversationId: "conversation", summary: "summary", captureText: "source",
    });
    const recovered = await awaitReady({
      flush: () => intake.flush(),
      queueSnapshot: () => ({ intake: intake.snapshot(), shutdown: { timedOut: false, discarded: 0 } }),
    }, 1000, undefined, {
      id: admission.id, maxAttempts: 16,
      inspect: () => inspectCompletedTurnIntake(directory, now),
      persistedSchedule: (item) => persistedCaptureRetrySchedule(admission.source, item),
      advanceClock: (value) => { const advance = Date.parse(value) - now.getTime(); now = new Date(value); return advance; },
      onRetry: (value) => retries.push(value), onReady: (value) => outcomes.push(value),
    });
    expect(recovered.intake).toMatchObject({ pending: 0, dead: 0, resolved: 1 });
    expect(captureAttempts).toBe(2);
    expect(commits).toEqual(["complete-plan"]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1, advanceMs: 60_000 });
    expect(outcomes).toEqual([{ attempt: 2, priorFailures: 1, status: "recovered_success" }]);
    expect(inspectCompletedTurnIntake(directory, now).items[0]).toMatchObject({ state: "resolved", attempt: 1 });
    intake.finishShutdown();
  });

  it("reads only validated retry coordinates from the persisted pending record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "retry-schedule-test-")); dirs.push(directory);
    const id = "c".repeat(64); const source = join(directory, "pending.json");
    await writeFile(source, JSON.stringify({ state: "pending", id, attempt: 2, nextAttemptAt: "2026-09-20T00:03:00.000Z", captureText: "not returned" }));
    await expect(persistedCaptureRetrySchedule(source, { id, attempt: 2 })).resolves.toEqual({
      id, attempt: 2, nextAttemptAt: "2026-09-20T00:03:00.000Z",
    });
    await expect(persistedCaptureRetrySchedule(source, { id, attempt: 1 })).rejects.toThrow("capture_recovery_invalid");
  });

  it("reserves steps/output, pins SSE with no retries, and reports cap enforcement honestly", async () => {
    const { budget } = await setup(); const run = vi.fn(async () => ({ text: "answer", model: "faux:observed" }));
    await meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("system", { model: { provider: "openai-codex", reference: "openai-codex:requested" }, messages: [{ role: "user", content: "question" }], abortSignal: new AbortController().signal });
    expect(run.mock.calls[0][1]).toMatchObject({ maxTurns: 3, providerCheckMaxTokens: 512, compaction: { enabled: false }, piTransport: "sse", piMaxRetries: 0, effort: "none" });
    expect(budget.used.chatSteps).toBe(3);
    expect(budget.events[0]).toMatchObject({
      outputTokenLimitRequested: 512,
      outputCapEnforcement: "unsupported_by_selected_provider",
      requestedTransport: "sse",
      configuredTransportRetries: 0,
      transportAttempts: null,
      costUsd: null,
      executedModel: "faux:observed",
      usage: { inputTokens: null },
    });
    expect(usageOf({ input: 0 })).toMatchObject({ inputTokens: 0, outputTokens: null });
  });
  it("keeps local reader step exhaustion distinct from terminal provider quota", async () => {
    const { budget } = await setup();
    budget.plan.perCall.readerMaxTurns = 20;
    budget.plan.limits.chatSteps = 20;
    budget.plan.limits.outputTokens = 20 * budget.plan.perCall.readerOutputTokens;
    budget.plan.limits.estimatedInputTokens = 1_000_000;
    const run = vi.fn(async () => ({
      text: "partial answer must not complete",
      error: "local max turns",
      failureKind: "usage_limit",
      numTurns: 20,
      diagnostics: { max_turns_hit: true, max_turns: 20 },
    }));
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", { messages: [] }))
      .rejects.toMatchObject({ code: "reader_step_budget_exhausted", failureKind: "budget_exceeded" });
    expect(run.mock.calls[0][1].maxTurns).toBe(20);
    expect(budget.providerStop).toBeNull();
    expect(budget.events[0]).toMatchObject({
      status: "reader_step_budget_exhausted", failureKind: "budget_exceeded",
      providerReportedFailureKind: "usage_limit", maxTurnsHit: true, observedModelTurns: 20,
    });
  });
  it("rejects hidden compaction and does not execute after exhausted reservations", async () => {
    const { budget } = await setup();
    const run = vi.fn(async (_s, o) => { o.onEvent({ type: "compaction_started" }); return { text: "answer" }; });
    const options = { messages: [], abortSignal: new AbortController().signal };
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options)).rejects.toThrow("unexpected_compaction");
    budget.used.chatSteps = budget.plan.limits.chatSteps;
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options)).rejects.toThrow("budget_exhausted");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("does not confuse an aborted signal with provider settlement", async () => {
    const { budget } = await setup(); let finish;
    budget.track(new Promise((resolve) => { finish = resolve; }));
    budget.controller.abort();
    await expect(budget.settle(5)).rejects.toThrow("provider_settlement_unknown");
    finish(); await budget.settle(10);
    expect(budget.pending.size).toBe(0);
  });
  it("accepts a valid embedding completion within the plan-bound deadline", async () => {
    const { budget } = await setup();
    budget.plan.perCall.embeddingTimeoutMs = 40;
    const embeddings = meteredEmbeddings({
      id: "fixture",
      embed: async (texts) => new Promise((resolve) => setTimeout(() => resolve(texts.map(() => [1, 0])), 10)),
    }, { budget, tag: {}, dimension: 2 });
    await expect(embeddings.embed(["fictional"])).resolves.toEqual([[1, 0]]);
    expect(budget.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "embedding", status: "completed" }),
      expect.objectContaining({ stage: "embedding_validation", status: "accepted" }),
    ]));
    expect(budget.admissionStopped).toBe(false);
    expect(budget.pending.size).toBe(0);
  });
  it.each(["deadline", "caller abort", "global abort"])("bounds an embedding body pending after headers: %s", async (mode) => {
    const { budget } = await setup();
    budget.plan.perCall.embeddingTimeoutMs = mode === "deadline" ? 10 : 1000;
    const caller = new AbortController();
    let rejectBody;
    const body = new Promise((_, reject) => { rejectBody = reject; });
    const headers = vi.fn(async () => ({ json: () => body }));
    const embeddings = meteredEmbeddings({ id: "fixture", embed: async () => (await headers()).json() }, { budget, tag: {} });
    const pending = embeddings.embed(["fictional"], { abortSignal: caller.signal });
    const rejected = expect(pending).rejects.toThrow("embedding_timeout_or_cancelled");
    if (mode === "caller abort") caller.abort();
    if (mode === "global abort") budget.controller.abort();
    await rejected;
    expect(headers).toHaveBeenCalledOnce();
    expect(budget.events[0].status).toBe("embedding_timeout_or_cancelled");
    expect(budget.pending.size).toBe(1);
    await expect(embeddings.embed(["not admitted"])).rejects.toThrow("provider_admission_stopped");
    await expect(budget.settle(5)).rejects.toThrow("provider_settlement_unknown");
    rejectBody(new Error("late private failure"));
    await budget.settle(100);
  });
  it("bounds a non-cooperative reader and retains its original promise", async () => {
    const { budget } = await setup(); budget.plan.perCall.callTimeoutMs = 10;
    let finish;
    const raw = new Promise((resolve) => { finish = resolve; });
    await expect(meteredRuntime({ run: () => raw }, { budget, stage: "reader", tag: {} }).run("s", { messages: [] })).rejects.toThrow("provider_timeout_or_cancelled");
    expect(budget.pending.has(raw)).toBe(true);
    expect(budget.controller.signal.aborted).toBe(true);
    finish({ text: "late answer" }); await budget.settle(100);
  });
  it("keeps a non-settling capture timeout terminal and admits no second call", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 10;
    const run = vi.fn(() => new Promise(() => {}));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_settlement_unknown");
    expect(run).toHaveBeenCalledOnce();
    expect(budget.controller.signal.aborted).toBe(true);
    expect(budget.events[0]).toMatchObject({
      status: "provider_settlement_unknown", timeoutScope: "capture_call_local",
      timeoutSettlement: "unknown", timeoutUsage: "unknown", latePayloadAccepted: false,
    });
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledOnce();
  });
  it("keeps global cancellation terminal even when a capture runtime settles after abort", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 1000;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({ text: "late global result" }), { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    const pending = metered.run("s", { messages: [] });
    await new Promise((resolve) => setImmediate(resolve));
    budget.controller.abort(new BenchmarkError("runtime_budget_exhausted"));
    await expect(pending).rejects.toThrow("provider_timeout_or_cancelled");
    expect(budget.admissionStopped).toBe(true);
    expect(budget.events[0]).not.toHaveProperty("timeoutSettlement");
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledOnce();
    await budget.settle(100);
  });
  it.each(["global", "caller"])("keeps %s cancellation terminal during local timeout settlement", async (scope) => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 1000;
    const caller = new AbortController();
    let finish;
    let sawTimeout;
    const timeoutObserved = new Promise((resolve) => { sawTimeout = resolve; });
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      finish = resolve;
      options.abortSignal.addEventListener("abort", sawTimeout, { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    const pending = metered.run("s", { messages: [], abortSignal: caller.signal });
    const assertion = expect(pending).rejects.toThrow("provider_timeout_or_cancelled");
    await timeoutObserved;
    await new Promise((resolve) => setImmediate(resolve));
    (scope === "global" ? budget.controller : caller).abort();
    finish({ text: "", cancelled: true, error: null, failureKind: null, diagnostics: { pi_stop_reason: "aborted" } });
    await assertion;
    expect(budget.admissionStopped).toBe(true);
    expect(budget.controller.signal.aborted).toBe(true);
    expect(budget.events[0].status).not.toBe("capture_timeout_settled");
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledOnce();
    await budget.settle(100);
  });
  it.each(["provider_auth", "usage_limit"])("keeps capture %s terminal under timeout-recovery policy", async (failureKind) => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn(async () => ({ text: "", error: "not retained", failureKind }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({ code: "provider_failed", failureKind });
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind });
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledOnce();
  });
  it("keeps a provider-auth result that settles after capture timeout sticky", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({
        text: "", error: "not retained", failureKind: "provider_auth",
      }), { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({ failureKind: "provider_auth" });
    expect(budget.providerStop).toMatchObject({ failureKind: "provider_auth" });
    expect(budget.events[0]).toMatchObject({
      timeoutSettlement: "fulfilled_discarded", providerReportedFailureKind: "provider_auth",
      latePayloadAccepted: false,
    });
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledOnce();
  });
  it("records settled finite-step evidence before classifying a local capture timeout", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({
        text: "", error: "not retained", failureKind: "usage_limit",
        diagnostics: { max_turns_hit: true },
      }), { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({
      code: "capture_step_budget_exhausted", failureKind: "budget_exceeded",
    });
    expect(budget.providerStop).toBeNull();
    expect(budget.events[0]).toMatchObject({
      status: "capture_step_budget_exhausted",
      failureKind: "budget_exceeded",
      providerReportedFailureKind: "usage_limit",
      maxTurnsHit: true,
      timeoutSettlement: "fulfilled_discarded",
      latePayloadAccepted: false,
    });
    expect(captureRetryCause({ lastError: "provider" }, budget.events[0])).toBe("finite_capture_step");
  });
  it.each([
    { label: "provider auth even with a max-turn flag", failureKind: "provider_auth", maxTurnsHit: true },
    { label: "hosted quota without a max-turn flag", failureKind: "usage_limit", maxTurnsHit: false },
  ])("keeps settled $label terminal after a local capture timeout", async ({ failureKind, maxTurnsHit }) => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => resolve({
        text: "", error: "not retained", failureKind,
        diagnostics: { max_turns_hit: maxTurnsHit },
      }), { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({
      code: "provider_failed", failureKind,
    });
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind });
    expect(budget.events[0]).toMatchObject({
      status: "provider_failed", failureKind,
      providerReportedFailureKind: failureKind, maxTurnsHit,
    });
    expect(captureRetryCause({ lastError: "provider" }, budget.events[0])).toBeNull();
  });
  it.each(["immediate", "after local timeout"])("keeps a generic runtime rejection %s terminal", async (timing) => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = timing === "immediate"
      ? vi.fn(async () => { throw new Error("synthetic generic rejection"); })
      : vi.fn((_system, options) => new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(new Error("synthetic generic rejection")), { once: true });
        }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({ code: "provider_failed" });
    expect(budget.events[0].status).toBe("provider_failed");
    expect(budget.events[0].status).not.toBe("capture_timeout_settled");
    expect(captureRetryCause({ lastError: "provider" }, budget.events[0])).toBeNull();
  });
  it("keeps a positively identified local abort rejection on the settled-timeout recovery path", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => {
        const error = new Error("synthetic local abort");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toMatchObject({ code: "capture_timeout_settled" });
    expect(budget.events[0]).toMatchObject({
      status: "capture_timeout_settled", timeoutSettlement: "rejected", latePayloadAccepted: false,
    });
  });
  it("keeps compaction observed while a capture timeout settles terminal", async () => {
    const { budget } = await setup();
    budget.plan.locomo = { captureRecovery: { timeoutPolicy: "settled_capture_runtime_only" } };
    budget.plan.perCall.callTimeoutMs = 10;
    budget.plan.perCall.captureTimeoutSettlementMs = 100;
    const run = vi.fn((_system, options) => new Promise((resolve) => {
      options.abortSignal.addEventListener("abort", () => {
        options.onEvent({ type: "compaction" });
        resolve({ text: "late compacted result" });
      }, { once: true });
    }));
    const metered = meteredRuntime({ run }, { budget, stage: "extraction", tag: {} });
    await expect(metered.run("s", { messages: [] })).rejects.toThrow("unexpected_compaction");
    expect(budget.providerStop).toBeNull();
    expect(budget.events[0]).toMatchObject({
      status: "unexpected_compaction", timeoutSettlement: "fulfilled_discarded",
      latePayloadAccepted: false,
    });
    expect(budget.events[0].status).not.toBe("capture_timeout_settled");
    expect(run).toHaveBeenCalledOnce();
  });
  it("settlement follows promises created by a capture continuation", async () => {
    const { budget } = await setup(); let finishCapture, finishEmbedding;
    const capture = budget.track(new Promise((resolve) => { finishCapture = resolve; }));
    capture.then(() => budget.track(new Promise((resolve) => { finishEmbedding = resolve; })));
    const settlement = budget.settle(10);
    const rejected = expect(settlement).rejects.toThrow("provider_settlement_unknown");
    finishCapture(); await rejected;
    expect(budget.pending.size).toBe(1);
    finishEmbedding(); await budget.settle(100);
  });
  it.each([{ timedOut: true, discarded: 0 }, { timedOut: false, discarded: 1 }])("rejects resolved store close with abandoned drain %j", async (shutdown) => {
    const { budget } = await setup(); const close = vi.fn(async () => {});
    await expect(cleanupTrial({ budget, store: { close, queueSnapshot: () => ({ shutdown }) } }, 100)).rejects.toThrow("store_shutdown_unsettled");
    expect(close).toHaveBeenCalledOnce();
    expect(budget.admissionStopped).toBe(true);
  });
  it("quiesces producers before the final stable settlement check", async () => {
    const { budget } = await setup(); let finish;
    const order = [];
    const store = { queueSnapshot: () => ready, close: async () => {
      order.push("store");
      budget.track(new Promise((resolve) => { finish = resolve; }));
    } };
    const result = cleanupTrial({ budget, reader: { dispose: async () => { order.push("reader"); } }, store, providers: { close: async () => { order.push("providers"); } } }, 20);
    await expect(result).rejects.toThrow(/cleanup_timeout|provider_settlement_unknown/u);
    expect(order).toEqual(["reader", "store", "providers"]);
    expect(budget.pending.size).toBe(1);
    finish(); await budget.settle(100);
  });
  it("bounds harness/provider disposal under one cleanup deadline", async () => {
    for (const resource of ["reader", "providers"]) {
      const { budget } = await setup(); let fail;
      const raw = new Promise((_, reject) => { fail = reject; });
      await expect(cleanupTrial({ budget, [resource]: { dispose: () => raw, close: () => raw } }, 10)).rejects.toThrow("cleanup_timeout");
      expect(budget.admissionStopped).toBe(true);
      fail(new Error("late failure")); await budget.settle(100);
    }
  });
  it("necessarily removes stale dist and rebuilds the source-pinned closure before attesting outputs", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-test-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(join(path, "dist"), { recursive: true });
    await writeFile(join(path, "dist/stale.js"), "stale source");
    const calls = [];
    const exec = (command, args) => {
      calls.push([command, args]);
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path }]);
      // The synchronous production build is replaced only by a local synthetic writer.
      expect(args).toEqual(["--filter", "@mono-agent/agent-app...", "run", "build"]);
      return "";
    };
    // No output from a purported successful build must fail, not certify stale bytes.
    await expect(prepareRealBuild(directory, "HEAD_A", { exec })).rejects.toThrow();
    await expect(readFile(join(path, "dist/stale.js"))).rejects.toThrow();
    expect(calls.some(([command, args]) => command === "pnpm" && args.includes("build"))).toBe(true);
    expect(BUILD_POLICY).toBe("fresh-clean-head-agent-app-closure-v1");
  });
  it("records fresh output/source identity after a successful synthetic closure build", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-good-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(path, { recursive: true });
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path }]);
      mkdirSync(join(path, "dist")); writeFileSync(join(path, "dist/index.js"), "fresh output"); return "";
    };
    const build = await prepareRealBuild(directory, "HEAD_A", { exec });
    expect(build).toMatchObject({ policy: BUILD_POLICY, sourceHead: "HEAD_A", packages: ["packages/agent-app"] });
    expect(build.outputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect((await setup()).plan.realBuildPolicy).toBe(BUILD_POLICY);
    await verifyRealBuild(directory, build, { exec });
    await writeFile(join(path, "dist/index.js"), "changed after build");
    await expect(verifyRealBuild(directory, build, { exec })).rejects.toThrow("build_output_changed");
    await expect(verifyRealBuild(directory, build, { exec: (_command, args) => args.includes("rev-parse") ? "HEAD_B" : "" })).rejects.toThrow("build_source_changed_or_dirty");
  });
  it("handles the source-JavaScript runtime's generated declarations without requiring dist", async () => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-runtime-")); dirs.push(directory);
    const app = join(directory, "packages/agent-app"); const runtime = join(directory, "packages/agent-runtime");
    await mkdir(app, { recursive: true }); await mkdir(join(runtime, "src"), { recursive: true });
    await mkdir(join(runtime, "types")); await writeFile(join(runtime, "types/stale.d.ts"), "stale");
    await writeFile(join(runtime, "src/index.js"), "tracked source");
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? "HEAD_A" : "";
      if (args.includes("list")) return JSON.stringify([{ path: app }, { path: runtime }]);
      mkdirSync(join(app, "dist")); writeFileSync(join(app, "dist/index.js"), "fresh output");
      mkdirSync(join(runtime, "types")); writeFileSync(join(runtime, "types/index.d.ts"), "fresh types"); return "";
    };
    const build = await prepareRealBuild(directory, "HEAD_A", { exec });
    expect(build.outputRoots).toEqual(["packages/agent-app/dist", "packages/agent-runtime/types"]);
    await expect(readFile(join(runtime, "types/stale.d.ts"))).rejects.toThrow();
    expect(await readFile(join(runtime, "src/index.js"), "utf8")).toBe("tracked source");
    await verifyRealBuild(directory, build, { exec });
  });
  it.each(["head", "dirt"])("rejects source %s drift during build before provider admission", async (mode) => {
    const directory = await mkdtemp(join(await ownedParent(root), "build-drift-")); dirs.push(directory);
    const path = join(directory, "packages/agent-app"); await mkdir(path, { recursive: true });
    let built = false;
    const exec = (command, args) => {
      if (command === "git") return args.includes("rev-parse") ? (built && mode === "head" ? "HEAD_B" : "HEAD_A") : (built && mode === "dirt" ? " M source" : "");
      if (args.includes("list")) return JSON.stringify([{ path }]);
      built = true; return "";
    };
    await expect(prepareRealBuild(directory, "HEAD_A", { exec })).rejects.toThrow("build_source_changed_or_dirty");
    expect(built).toBe(true);
  });
  it("preserves capture prompt and no-tool provider shape, rejects provider failures", async () => {
    const { budget } = await setup(); const run = vi.fn(async () => ({ text: "{}" }));
    const llm = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag: {} });
    await llm.complete("STRICT_PROMPT", { label: "capture:extract" });
    expect(run.mock.calls[0][1]).toMatchObject({ messages: [{ role: "user", content: "STRICT_PROMPT" }], allowedTools: [], mcpServers: {}, maxTurns: 1, providerCheckMaxTokens: 2048, compaction: { enabled: false }, piTransport: "sse", piMaxRetries: 0 });
    const production = await readFile(new URL("../../packages/agent-app/src/configured-agent.ts", import.meta.url), "utf8");
    for (const phrase of run.mock.calls[0][0].split(/(?<=\.) /u)) expect(production).toContain(phrase);
    await expect(meteredRuntime({ run: async () => ({ error: "secret error", text: "" }) }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal })).rejects.toThrow("provider_failed");
  });
  it("projects authoritative extraction and reconciliation results into the exact capture trace", async () => {
    const extraction = await setup();
    const extractionSchema = { type: "object", required: ["memories"] };
    const extracted = { memories: [{ type: "note", text: "Mira likes cobalt." }], entities: [], relations: [] };
    const extractionRun = vi.fn(async () => ({
      text: "plausible text fallback must not win",
      structuredResult: extracted,
      diagnostics: { pi_stop_reason: "toolUse", max_turns_hit: false },
    }));
    const extractionTrace = [];
    const extractor = captureLlm({ run: extractionRun }, {
      model: { provider: "fixture", reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions",
      budget: extraction.budget, tag: { groupId: "g" }, capture: (entry) => extractionTrace.push(entry),
    });
    await expect(extractor.complete("extract", { label: "capture:extract", outputSchema: extractionSchema }))
      .resolves.toBe(JSON.stringify(extracted));
    expect(extractionRun.mock.calls[0][1].outputSchema).toBe(extractionSchema);
    expect(extractionTrace).toEqual([expect.objectContaining({ stage: "extraction", output: JSON.stringify(extracted) })]);

    const reconciliation = await setup();
    const decisions = [{ index: 0, action: "add" }];
    const reconcileRun = vi.fn(async () => ({ text: "not parser input", structuredResult: { decisions } }));
    const reconcileTrace = [];
    const reconciler = captureLlm({ run: reconcileRun }, {
      model: { provider: "fixture", reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions",
      budget: reconciliation.budget, tag: {}, capture: (entry) => reconcileTrace.push(entry),
    });
    await expect(reconciler.complete("reconcile", {
      label: "capture:reconcile-batch", outputSchema: { type: "object" }, structuredResultKey: "decisions",
    })).resolves.toBe(JSON.stringify(decisions));
    expect(reconcileTrace[0]).toMatchObject({ stage: "reconciliation", output: JSON.stringify(decisions) });
  });

  it("accepts empty text only for a successful structured settlement and keeps terminal toolUse distinct", async () => {
    const { budget } = await setup();
    const result = { text: "", structuredResult: { memories: [] }, diagnostics: { pi_stop_reason: "toolUse", max_turns_hit: false } };
    await expect(meteredRuntime({ run: async () => result }, { budget, stage: "extraction", tag: {} })
      .run("s", { messages: [], outputSchema: { type: "object" } })).resolves.toBe(result);
    expect(budget.events[0]).toMatchObject({ status: "completed", maxTurnsHit: false });

    const unfinished = await setup();
    await expect(meteredRuntime({ run: async () => ({ text: "", diagnostics: { pi_stop_reason: "toolUse" } }) }, { budget: unfinished.budget, stage: "reader", tag: {} })
      .run("s", { messages: [] })).rejects.toThrow("unfinished_tool_loop");
  });

  it.each([
    ["provider failure", { failureKind: "provider_unavailable", error: "private", structuredResult: { ok: true } }, "provider_failed"],
    ["runtime error", { error: "private", structuredResult: { ok: true } }, "provider_failed"],
    ["cancelled", { cancelled: true, structuredResult: { ok: true } }, "provider_timeout_or_cancelled"],
    ["cancelled before returned failure", { cancelled: true, failureKind: "usage_limit", error: "private", structuredResult: { ok: true } }, "provider_timeout_or_cancelled"],
    ["compacted", { structuredResult: { ok: true } }, "unexpected_compaction"],
    ["max turns", { structuredResult: { ok: true }, diagnostics: { max_turns_hit: true } }, "capture_step_budget_exhausted"],
    ["missing structured payload", { text: "plausible fallback" }, "structured_result_missing"],
  ])("rejects %s before accepting a structured payload", async (_label, result, code) => {
    const { budget } = await setup();
    const run = vi.fn(async (_system, options) => {
      if (code === "unexpected_compaction") options.onEvent({ type: "compaction_started" });
      return result;
    });
    await expect(meteredRuntime({ run }, { budget, stage: "extraction", tag: {} })
      .run("s", { messages: [], outputSchema: { type: "object" } })).rejects.toThrow(code);
    expect(budget.events[0].status).toBe(code);
    if (code === "structured_result_missing") {
      expect(budget.events[0]).toMatchObject({
        runtimeSettlement: "fulfilled",
        structuredOutputFailure: "structured_result_missing",
      });
      expect(captureRetryCause({ lastError: "provider" }, budget.events[0]))
        .toBe("settled_structured_output");
    }
    if (result.cancelled) expect(budget.providerStop).toBeNull();
  });

  it.each([
    ["missing key", { other: [] }, "structured_result_key_missing"],
    ["unserializable selected value", { decisions: 1n }, "structured_result_unserializable"],
  ])("fails closed on reconciliation projection %s and records the settled boundary", async (_label, structuredResult, code) => {
    const { budget } = await setup(); const trace = [];
    const llm = captureLlm({ run: async () => ({ text: "[]", structuredResult }) }, {
      model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag: { groupId: "projection", arm: "bujo" }, capture: (entry) => trace.push(entry),
    });
    await expect(llm.complete("reconcile", {
      label: "capture:reconcile-batch", outputSchema: { type: "object" }, structuredResultKey: "decisions",
    })).rejects.toThrow(code);
    expect(trace).toEqual([]);
    expect(summarize([], budget.events, "scripted").arms.bujo.stages.reconciliation.attempted).toBe(1);
    expect(budget.events).toHaveLength(2);
    expect(budget.events[0]).toMatchObject({ stage: "reconciliation", status: "completed" });
    expect(budget.events[1]).toMatchObject({
      stage: "capture_projection", captureStage: "reconciliation",
      status: code, runtimeSettlement: "fulfilled",
      structuredOutputFailure: code, failureKind: null,
      providerReportedFailureKind: null, maxTurnsHit: false,
    });
    expect(captureRetryCause({ lastError: "provider" }, budget.events[1]))
      .toBe("settled_structured_output");
    expect(currentCaptureRetryCause(budget.events, 0, { groupId: "projection", arm: "bujo" }, { lastError: "provider" }))
      .toEqual({ cause: "settled_structured_output", nextCursor: 2 });
    expect(currentCaptureRetryCause(budget.events, 2, { groupId: "projection", arm: "bujo" }, { lastError: "provider" }))
      .toEqual({ cause: null, nextCursor: 2 });
    expect(summarize([], budget.events, "scripted").arms.bujo.stages.capture_projection.attempted).toBe(1);
  });

  it("meters bounded embedding text into both the combined and embedding-specific hard budgets", async () => {
    const { plan } = await setup();
    const budget = new Budget({ ...plan, limits: { ...plan.limits, embeddingInputTokens: 1 } });
    const embed = vi.fn(async () => [[1]]);
    await expect(meteredEmbeddings({ id: "fixture", embed }, { budget, tag: {} }).embed(["twelve bytes"])).rejects.toThrow("budget_exhausted");
    expect(embed).not.toHaveBeenCalled();
    expect(budget.used.embeddingInputTokens).toBe(0);
    budget.close();
  });
  it("retains a non-fatal returned failure kind without stopping admission", async () => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "provider_unavailable", error: "route down", text: "" }));
    const failure = await meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal }).catch((error) => error);
    expect(failure.message).toBe("provider_failed");
    expect(failureKindOf(failure)).toBe("provider_unavailable");
    expect(budget.events[0]).toMatchObject({ status: "provider_failed", failureKind: "provider_unavailable" });
    expect(budget.providerStop).toBeNull();
    expect(budget.admissionStopped).toBe(false);
  });
  it("maps a structured native context failure to a typed benchmark error", async () => {
    const { budget } = await setup();
    const failure = await meteredRuntime({ run: async () => ({ failureKind: "context_limit", error: "private", text: "" }) }, { budget, stage: "reader", tag: {} })
      .run("s", { messages: [], abortSignal: new AbortController().signal }).catch((error) => error);
    expect(failure.message).toBe("native_context_limit");
    expect(failureKindOf(failure)).toBe("context_limit");
    expect(budget.events[0]).toMatchObject({ status: "native_context_limit", failureKind: "context_limit" });
  });
  it.each(["provider_auth", "usage_limit"])("stops provider admission after fatal reader failure: %s", async (failureKind) => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind, error: "route dead", text: "" }));
    const options = () => ({ messages: [], abortSignal: new AbortController().signal });
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(budget.events[0]).toMatchObject({ status: "provider_failed", failureKind });
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind });
    // Factory, model and embedding admissions share one reserve gate: the next
    // setup refuses before any of them run, and nothing dispatches again.
    const factory = vi.fn();
    expect(() => { budget.reserve({}); factory(); }).toThrow("provider_admission_stopped");
    expect(factory).not.toHaveBeenCalled();
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_admission_stopped");
    await expect(meteredEmbeddings({ id: "fixture", embed: async () => [] }, { budget, tag: {} }).embed(["fictional"])).rejects.toThrow("provider_admission_stopped");
    expect(run).toHaveBeenCalledTimes(1);
    expect(budget.events).toHaveLength(1);
  });
  it("keeps untrusted failure kinds and raw errors out of events", async () => {
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "EVIL sk-123456789012", error: "boom Bearer canary https://host/x /Users/example", text: "" }));
    await expect(meteredRuntime({ run }, { budget, stage: "reader", tag: {} }).run("s", { messages: [], abortSignal: new AbortController().signal })).rejects.toThrow("provider_failed");
    expect(budget.events[0].failureKind).toBeNull();
    expect(JSON.stringify(budget.events[0])).not.toMatch(/EVIL|123456789012|Bearer|host\/|example/u);
    expect(budget.providerStop).toBeNull();
    expect(canonicalFailureKind("EVIL sk-123456789012")).toBeNull();
    expect(canonicalFailureKind("provider_auth")).toBe("provider_auth");
    expect(isFatalFailureKind("usage_limit")).toBe(true);
    expect(isFatalFailureKind("provider_unavailable")).toBe(false);
  });
  it("recognizes structured thrown failures and ignores hostile thrown values", async () => {
    const options = () => ({ messages: [], abortSignal: new AbortController().signal });
    const { budget } = await setup();
    const structured = Object.assign(new Error("private boom"), { failureKind: "usage_limit" });
    const fatal = await meteredRuntime({ run: async () => { throw structured; } }, { budget, stage: "extraction", tag: {} }).run("s", options()).catch((error) => error);
    expect(fatal.message).toBe("provider_failed");
    expect(failureKindOf(fatal)).toBe("usage_limit");
    expect(budget.events[0]).toMatchObject({ stage: "extraction", status: "provider_failed", failureKind: "usage_limit" });
    expect(budget.providerStop).toMatchObject({ failureKind: "usage_limit" });
    const hostileSetup = await setup();
    const hostile = Object.assign(new Error("boom"), { failureKind: { nested: "sk-123456789012" } });
    await expect(meteredRuntime({ run: async () => { throw hostile; } }, { budget: hostileSetup.budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(hostileSetup.budget.events[0].failureKind).toBeNull();
    expect(hostileSetup.budget.providerStop).toBeNull();
    const rawSetup = await setup();
    await expect(meteredRuntime({ run: async () => { throw "raw boom"; } }, { budget: rawSetup.budget, stage: "reader", tag: {} }).run("s", options())).rejects.toThrow("provider_failed");
    expect(rawSetup.budget.events[0].failureKind).toBeNull();
    expect(rawSetup.budget.providerStop).toBeNull();
  });
  it("carries fatal extraction and reconciliation categories through capture", async () => {
    const tag = { groupId: "g", arm: "bujo" };
    const { budget } = await setup();
    const run = vi.fn(async () => ({ failureKind: "provider_auth", error: "dead", text: "" }));
    const llm = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "workspace", sessionsRoot: "sessions", budget, tag });
    await expect(llm.complete("TURN:\nUser: hi\nAssistant: ho", {})).rejects.toThrow("provider_failed");
    expect(budget.events[0]).toMatchObject({ stage: "extraction", failureKind: "provider_auth" });
    expect(budget.providerStop).toMatchObject({ failureKind: "provider_auth" });
    expect(captureFailureKindFor(budget.events, tag)).toBe("provider_auth");
    expect(captureFailureKindFor(budget.events, { groupId: "other", arm: "bujo" })).toBeNull();
    const reconciled = await setup();
    const reconcile = captureLlm({ run }, { model: { reference: "fixture:model" }, workspace: "w", sessionsRoot: "s", budget: reconciled.budget, tag });
    await expect(reconcile.complete("batch", { label: "capture:reconcile-batch" })).rejects.toThrow("provider_failed");
    expect(reconciled.budget.events[0]).toMatchObject({ stage: "reconciliation", failureKind: "provider_auth" });
    expect(captureFailureKindFor(reconciled.budget.events, tag)).toBe("provider_auth");
  });
  it("keeps a terminal provider stop sticky through successful cleanup", async () => {
    const { budget } = await setup();
    budget.stopProviders("provider_failed", "provider_auth");
    const store = { queueSnapshot: () => ready, close: vi.fn(async () => {}) };
    await cleanupTrial({ budget, store, providers: { close: async () => {} } }, 100);
    expect(store.close).toHaveBeenCalledOnce();
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind: "provider_auth" });
    // Cleanup reopens its temporary gating, but the terminal stop still refuses.
    expect(budget.admissionStopped).toBe(false);
    expect(() => budget.reserve({})).toThrow("provider_admission_stopped");
    // First fatal evidence wins; later evidence neither clears nor overwrites it.
    budget.stopProviders("other", "usage_limit");
    expect(budget.providerStop).toMatchObject({ code: "provider_failed", failureKind: "provider_auth" });
  });
  it("reports structured failure categories on summary failures", async () => {
    const trials = [
      { groupId: "g1", arm: "recent-only", status: "provider_failed", runtimeFailureKind: "provider_auth", captureFailureKind: null },
      { groupId: "g2", arm: "bujo", status: "capture_not_ready", runtimeFailureKind: null, captureFailureKind: "usage_limit" },
      { groupId: "g3", arm: "bujo", status: "provider_failed", runtimeFailureKind: null, captureFailureKind: null },
    ];
    const summary = summarize(trials, [], "real");
    expect(summary.arms["recent-only"].failures).toEqual([{ groupId: "g1", status: "provider_failed", failureKind: "provider_auth" }]);
    expect(summary.arms.bujo.failures).toEqual([
      { groupId: "g2", status: "capture_not_ready", failureKind: "usage_limit" },
      { groupId: "g3", status: "provider_failed", failureKind: null },
    ]);
  });
  it("parses the explicit Pi auth path consistently with other profile flags", () => {
    const full = { reader: "openai-codex:model", extractor: "openai-codex:model", "embedding-provider": "ollama", "embedding-model": "m", dimension: "8" };
    expect(profileFrom({ ...full, "pi-auth-path": " /tmp/fixture-auth.json " })).toMatchObject({ piAuthPath: "/tmp/fixture-auth.json" });
    expect(profileFrom(full).piAuthPath).toBeUndefined();
    expect(() => profileFrom({ "pi-auth-path": "/tmp/fixture-auth.json" })).toThrow("incomplete_profile");
    expect(() => profileFrom({ ...full, "pi-auth-path": "   " })).toThrow("invalid_pi_auth_path");
    expect(() => profileFrom({ ...full, "pi-auth-path": "/tmp/fixture\nauth.json" })).toThrow("invalid_pi_auth_path");
    expect(() => parseArguments(["--pi-auth-path", "a", "--pi-auth-path", "b"])).toThrow();
    expect(() => parseArguments(["--real", "--pi-auth-path"])).toThrow();
  });
  it("binds only the auth fingerprint into the confirmed plan, never the raw path", async () => {
    const { corpus, sha256 } = await setup();
    const base = { reader: "fixture:reader", extractor: "fixture:extractor", embeddingProvider: "ollama", embeddingModel: "m", dimension: 8 };
    const withAuth = { ...base, piAuthPath: "/tmp/fixture-auth.json" };
    const a = makePlan({ corpus, sha256, profile: withAuth });
    expect(a.profile.piAuthFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(a.profile.piAuthPath).toBeUndefined();
    expect(JSON.stringify(a)).not.toContain("fixture-auth");
    const again = makePlan({ corpus, sha256, profile: { ...withAuth } });
    expect(again.profile.piAuthFingerprint).toBe(a.profile.piAuthFingerprint);
    expect(again.confirmation).toBe(a.confirmation);
    const changed = makePlan({ corpus, sha256, profile: { ...withAuth, piAuthPath: "/tmp/other-auth.json" } });
    expect(changed.profile.piAuthFingerprint).not.toBe(a.profile.piAuthFingerprint);
    expect(changed.confirmation).not.toBe(a.confirmation);
    const ambient = makePlan({ corpus, sha256, profile: base });
    expect(ambient.profile).toEqual(base);
    expect(ambient.profile.piAuthFingerprint).toBeUndefined();
    expect(serializableProfile(null)).toBeNull();
  });
  it("wires one shared Pi auth resolver into both real runtimes, preserving ambient auth when omitted", async () => {
    const resolver = async () => "fixture-key";
    const modules = {
      runtime: { createMonoRuntime: vi.fn(() => ({})), parseMonoRuntimeModelReference: (value) => ({ reference: value }), createPiOAuthApiKeyResolver: vi.fn(() => resolver) },
      search: { createEmbeddingProvider: vi.fn(() => ({})), createCircuitBreakerEmbeddingProvider: vi.fn((raw) => raw) },
    };
    const profile = { reader: "fixture:reader", extractor: "fixture:extractor", embeddingProvider: "ollama", embeddingModel: "m", dimension: 8, piAuthPath: "/tmp/fixture-auth.json" };
    await expect(realProviders(profile, { workspace: "workspace", modules, plan: null }))
      .rejects.toThrow("invalid_embedding_timeout_plan");
    const provided = await realProviders(profile, { workspace: "workspace", modules, plan: realProviderPlan });
    expect(provided.kind).toBe("real");
    expect(modules.runtime.createPiOAuthApiKeyResolver).toHaveBeenCalledOnce();
    expect(modules.runtime.createPiOAuthApiKeyResolver).toHaveBeenCalledWith({ path: "/tmp/fixture-auth.json" });
    expect(modules.runtime.createMonoRuntime).toHaveBeenCalledTimes(2);
    expect(modules.runtime.createMonoRuntime.mock.calls[0][0]).toMatchObject({ workspace: "workspace" });
    expect(modules.runtime.createMonoRuntime.mock.calls[0][0].resolvePiApiKey).toBe(resolver);
    expect(modules.runtime.createMonoRuntime.mock.calls[1][0].resolvePiApiKey).toBe(resolver);
    expect(modules.search.createEmbeddingProvider).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 23_456 }));
    const ambientModules = { runtime: { createMonoRuntime: vi.fn(() => ({})), parseMonoRuntimeModelReference: (value) => ({ reference: value }) }, search: modules.search };
    await realProviders({ ...profile, piAuthPath: undefined }, { workspace: "workspace", modules: ambientModules, plan: realProviderPlan });
    expect(ambientModules.runtime.createMonoRuntime.mock.calls[0][0]).toEqual({ workspace: "workspace" });
    expect(ambientModules.runtime.createMonoRuntime.mock.calls[1][0]).toEqual({ workspace: "workspace" });
    await expect(realProviders(profile, { workspace: "workspace", modules: ambientModules, plan: realProviderPlan })).rejects.toThrow("pi_auth_resolver_unavailable");
  });
  it("pins LoCoMo provider construction to explicit loopback endpoints and client context metadata", async () => {
    const optionsForLocal = vi.fn((model, providers) => ({ customProvider: providers[0], customModel: { model }, modelCapabilities: { context_window: 65_536 }, isPrivateProvider: true }));
    const modules = {
      runtime: {
        createMonoRuntime: vi.fn((options) => ({ options })),
        parseMonoRuntimeModelReference: (value) => { const [provider, ...name] = value.split(":"); return { provider, model: name.join(":"), reference: value }; },
        runtimeOptionsForLocalProvider: optionsForLocal,
      },
      search: { createEmbeddingProvider: vi.fn(() => ({})), createCircuitBreakerEmbeddingProvider: vi.fn((raw) => raw) },
    };
    const profile = {
      reader: "ollama:gemma4:31b", extractor: "ollama:gemma4:31b",
      embeddingProvider: "ollama", embeddingModel: "bge-m3:latest", dimension: 1024,
      ollamaEndpoint: "http://127.0.0.1:11434", embeddingEndpoint: "http://127.0.0.1:11434", clientContextWindow: 65_536,
    };
    await realProviders(profile, { workspace: "workspace", modules, plan: realProviderPlan });
    const runtimeOptions = modules.runtime.createMonoRuntime.mock.calls[0][0];
    expect(runtimeOptions).toMatchObject({ workspace: "workspace", resolveAttempt: expect.any(Function) });
    runtimeOptions.resolveAttempt({ model: { provider: "ollama", model: "gemma4:31b", reference: "ollama:gemma4:31b" } });
    expect(optionsForLocal.mock.calls[0][1][0]).toMatchObject({ id: "ollama", type: "ollama", baseUrl: "http://127.0.0.1:11434", trustPublicUrl: false });
    expect(optionsForLocal.mock.calls[0][1][0].models[0].capabilities).toMatchObject({ context_window: 65_536, max_tokens: 2048 });
    expect(modules.search.createEmbeddingProvider).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "http://127.0.0.1:11434", model: "bge-m3:latest" }));
    await expect(realProviders({ ...profile, ollamaEndpoint: "http://localhost:11434" }, { workspace: "workspace", modules, plan: realProviderPlan })).rejects.toThrow("invalid_local_ollama_profile");
  });
  it("uses the existing hosted Pi resolver while keeping LoCoMo embeddings on numeric loopback", async () => {
    const resolver = async () => "fixture-key";
    const modules = {
      runtime: {
        createMonoRuntime: vi.fn((options) => ({ options })),
        parseMonoRuntimeModelReference: (reference) => ({ provider: "openai-codex", model: "gpt-5.6-luna", reference }),
        createPiOAuthApiKeyResolver: vi.fn(() => resolver),
        runtimeOptionsForLocalProvider: vi.fn(() => { throw new Error("hosted_chat_must_not_use_local_resolver"); }),
      },
      search: { createEmbeddingProvider: vi.fn(() => ({})), createCircuitBreakerEmbeddingProvider: vi.fn((raw) => raw) },
    };
    const profile = {
      reader: "openai-codex:gpt-5.6-luna", extractor: "openai-codex:gpt-5.6-luna",
      embeddingProvider: "ollama", embeddingModel: "bge-m3:latest", dimension: 1024,
      piAuthPath: "/private/existing-pi-auth.json", embeddingEndpoint: "http://127.0.0.1:11434",
      hostedChatContextWindow: 272_000, locomoDatasetTransferAck: "selected-public-locomo-projection-to-hosted-luna",
    };
    await realProviders(profile, { workspace: "workspace", modules, plan: realProviderPlan });
    expect(modules.runtime.createPiOAuthApiKeyResolver).toHaveBeenCalledWith({ path: "/private/existing-pi-auth.json" });
    expect(modules.runtime.createMonoRuntime).toHaveBeenCalledTimes(2);
    expect(modules.runtime.createMonoRuntime.mock.calls[0][0]).toEqual({ workspace: "workspace", resolvePiApiKey: resolver });
    expect(modules.runtime.runtimeOptionsForLocalProvider).not.toHaveBeenCalled();
    expect(modules.search.createEmbeddingProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: "ollama", model: "bge-m3:latest", endpoint: "http://127.0.0.1:11434",
    }));
  });
  it("dry-run binds the auth fingerprint without touching credentials or network", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const profile = ["--reader", "fixture:reader", "--extractor", "fixture:extractor", "--embedding-provider", "ollama", "--embedding-model", "m", "--dimension", "8"];
    const output = [];
    expect(await main(["--dry-run", ...profile, "--pi-auth-path", "/tmp/fixture-auth.json"], { stdout: (text) => output.push(JSON.parse(text)) })).toBe(0);
    expect(output[0].profile.piAuthFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(output[0])).not.toContain("fixture-auth");
    expect(network).not.toHaveBeenCalled();
    // A confirmation taken without the auth selection does not authorize a run with it.
    const plain = [];
    await main(["--dry-run", ...profile], { stdout: (text) => plain.push(JSON.parse(text)) });
    await expect(main(["--real", ...profile, "--pi-auth-path", "/tmp/fixture-auth.json", "--confirm-plan", plain[0].confirmation])).rejects.toThrow("real_execution_requires_confirmed_profile");
    expect(network).not.toHaveBeenCalled();
  });
  it("labels unknown/empty populations, tiny-sample latency, and lexical diagnostics honestly", () => {
    expect(percentiles([])).toMatchObject({ n: 0, p50: null, p95: null });
    expect(percentiles([5, 1, 2, 3, 4, 6])).toMatchObject({ n: 6, p50: 3, p95: 6, exploratory: true });
    expect(ratio(0, 0).value).toBeNull();
    const gold = { accepted: ["amber"], forbidden: ["violet"] };
    expect(lexicalDiagnostic("It is not amber", gold, "real").value).toBe(false);
    expect(lexicalDiagnostic("amber", gold, "scripted").value).toBeNull();
    expect(lexicalDiagnostic("amber or violet", gold, "real").value).toBe(false);
    expect(lexicalDiagnostic("The blue bicycle", { ...gold, accepted: ["blue bicycle"], locomoCategory: 4 }, "real"))
      .toEqual({
        status: "locomo_official_pinned", metric: "porter_token_f1", officialScore: 1,
        secondaryNormalizedDiagnostic: { exact: true, f1: 1 },
      });
  });
  it("redacts path/credential/endpoint canaries without treating unknown values as zero", () => {
    const safe = JSON.stringify(safeArtifact({ prompt: "/Users/example/memory sk-123456789012 https://host/?token=secret", headers: { Authorization: "Bearer canary" }, cost: null, answer: "Fictional cobalt." }));
    expect(safe).not.toMatch(/example|123456789012|Bearer|host\//u);
    expect(JSON.parse(safe)).toMatchObject({ cost: null, answer: "Fictional cobalt." });
  });
  it("refuses symlinked output ancestors", async () => {
    await mkdir(join(root, ".worklab-tmp"), { recursive: true });
    const dir = await mkdtemp(join(root, ".worklab-tmp", "e2e-safety-")); dirs.push(dir);
    await symlink(root, join(dir, ".worklab-tmp"));
    await expect(ownedParent(dir)).rejects.toThrow("unsafe_output_root");
  });
  it("scripted extractor is independent of gold and changes payload shape only on the schema path", async () => {
    const providers = scriptedProviders();
    expect(providers.kind).toBe("scripted");
    const messages = [{ content: "\nTURN:\nUser (Fiction): A green cup.\nAssistant: Noted." }];
    const textResult = await providers.extractor.run("", { messages });
    expect(JSON.parse(textResult.text).memories[0].text).toBe("Fiction said: A green cup.");
    expect(textResult).not.toHaveProperty("structuredResult");
    const structured = await providers.extractor.run("", { messages, outputSchema: { type: "object" } });
    expect(structured.text).toBe("");
    expect(structured.structuredResult.memories[0].text).toBe("Fiction said: A green cup.");

    const reconciliation = await providers.extractor.run("", {
      messages: [{ content: 'candidates [{"index": 2}]' }], outputSchema: { type: "object" },
    });
    expect(reconciliation).toEqual({ text: "", structuredResult: { decisions: [{ index: 2, action: "add" }] } });
  });
});

describe("bujo-learning-v1 corpus selection (baseline diagnosis, not model quality)", () => {
  it("freezes the corpus and restricts it to the baseline and reference arms", async () => {
    const { corpus, sha256 } = await loadCorpus("bujo-learning-v1");
    expect(sha256).toBe("abef34dff9d24c83dcf8ccb2c79496693c85461834fadc33f3f4a64dd4b5c58b");
    expect(corpus.groups).toHaveLength(8);
    expect(armsFor(corpus)).toEqual(["bujo", "full-history"]);
    // Eight distinct diagnostic categories, one per scenario.
    expect(new Set(corpus.groups.map((g) => g.evaluation.category)).size).toBe(8);
    const plan = makePlan({ corpus, sha256, split: "evaluation" });
    expect(plan.arms).toEqual(["bujo", "full-history"]);
    expect(plan.workload).toEqual({ questions: 8, trials: 16, historicalTurnsPerMemoryArm: 17, captureStepsMaximum: 34, readerStepsMaximum: 48 });
    // The declared workload must fit the split's own step ceiling.
    expect(plan.workload.captureStepsMaximum + plan.workload.readerStepsMaximum)
      .toBeLessThanOrEqual(plan.limits.chatSteps);
  });

  it("keeps every evidence turn out of the recent-only reader context", async () => {
    const { corpus } = await loadCorpus("bujo-learning-v1");
    for (const group of corpus.groups) {
      const source = sourceOnly(group);
      const recent = JSON.stringify(contextFor(source, "bujo"));
      // The bujo arm must recover evidence from memory, never from context.
      for (const id of group.evaluation.evidenceTurnIds) {
        const evidence = group.source.turns.find((turn) => turn.id === id);
        expect(recent).not.toContain(evidence.user);
      }
      expect(Buffer.byteLength(recent)).toBeLessThanOrEqual(2048);
    }
  });

  it("never leaks rubric, category or accepted answers into the source projection", async () => {
    const { corpus } = await loadCorpus("bujo-learning-v1");
    for (const group of corpus.groups) {
      const projected = JSON.stringify(sourceOnly(group));
      expect(projected).not.toContain(group.evaluation.rubric);
      expect(projected).not.toContain(group.evaluation.category);
      for (const accepted of group.evaluation.accepted) expect(projected.toLowerCase()).not.toContain(`"${accepted.toLowerCase()}"`);
    }
  });

  it("preserves fictional-v1 semantics and rejects unknown or malformed corpora", async () => {
    const original = await loadCorpus();
    const development = makePlan(original);
    expect(development.arms).toEqual(ARMS);
    expect(development.workload).toEqual({ questions: 2, trials: 10, historicalTurnsPerMemoryArm: 8, captureStepsMaximum: 16, readerStepsMaximum: 30 });
    expect(makePlan({ ...original, split: "evaluation" }).workload.questions).toBe(6);
    await expect(loadCorpus("../../../etc/passwd")).rejects.toThrow("invalid_corpus_name");
    await expect(loadCorpus("unknown-v9")).rejects.toThrow("invalid_corpus_name");
    const { corpus } = await loadCorpus("bujo-learning-v1");
    expect(() => validateCorpus({ ...corpus, arms: ["bujo", "bujo"] })).toThrow("invalid_arms");
    expect(() => validateCorpus({ ...corpus, arms: ["nonexistent"] })).toThrow("invalid_arms");
    expect(() => validateCorpus({ ...corpus, turnsPerGroup: { min: 3, max: 2 } })).toThrow("invalid_turn_bounds");
    // A group outside the declared bounds must fail rather than run short.
    const short = structuredClone(corpus);
    short.groups[0].source.turns = short.groups[0].source.turns.slice(0, 1);
    expect(() => validateCorpus(short)).toThrow("invalid_turns");
  });

  it("selects the corpus from the CLI and binds it into the confirmation digest", async () => {
    const lines = [];
    await main(["--dry-run", "--corpus", "bujo-learning-v1", "--split", "evaluation"], { stdout: (value) => lines.push(value) });
    const plan = JSON.parse(lines[0]);
    expect(plan.corpus).toBe("bujo-learning-v1");
    expect(plan.arms).toEqual(["bujo", "full-history"]);
    expect(plan.confirmation).toMatch(/^[0-9a-f]{64}$/u);

    const other = [];
    await main(["--dry-run", "--split", "evaluation"], { stdout: (value) => other.push(value) });
    const base = JSON.parse(other[0]);
    expect(base.corpus).toBe("fictional-v1");
    // A different corpus must invalidate a confirmation taken for another one.
    expect(base.confirmation).not.toBe(plan.confirmation);
    await expect(main(["--dry-run", "--corpus", "nope"])).rejects.toThrow("invalid_corpus_name");
  });

  it.each(["bujo-learning-v1", "capture-fidelity-v1"])(
    "rejects an omitted split for evaluation-only corpus %s",
    async (corpusName) => {
      const loaded = await loadCorpus(corpusName);
      expect(() => makePlan(loaded)).toThrow("empty_corpus_split");
      await expect(main(["--dry-run", "--corpus", corpusName])).rejects.toThrow("empty_corpus_split");
    },
  );

  it.each(["bujo-learning-v1", "capture-fidelity-v1"])(
    "rejects an explicitly empty split for %s before build or providers",
    async (corpusName) => {
      const prepareBuild = vi.fn();
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
      await expect(main(["--real", "--corpus", corpusName, "--split", "development"], { prepareBuild }))
        .rejects.toThrow("empty_corpus_split");
      expect(prepareBuild).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );
});

describe("capture-fidelity-v1 frozen controls", () => {
  it("binds the author-visible controls to an exact fixture and bounded workload", async () => {
    const { corpus, sha256 } = await loadCorpus("capture-fidelity-v1");
    expect(sha256).toBe("485dfe3f52da5e51a72a667721d30b5646d9c51d6cb0a3a327c727e88a3bb34e");
    expect(corpus.groups).toHaveLength(6);
    expect(armsFor(corpus)).toEqual(["bujo", "full-history"]);
    expect(new Set(corpus.groups.map((group) => group.evaluation.category)).size).toBe(6);
    const plan = makePlan({ corpus, sha256, split: "evaluation" });
    expect(plan.workload).toEqual({
      questions: 6,
      trials: 12,
      historicalTurnsPerMemoryArm: 18,
      captureStepsMaximum: 36,
      readerStepsMaximum: 36,
    });
    expect(plan.workload.captureStepsMaximum + plan.workload.readerStepsMaximum)
      .toBeLessThanOrEqual(plan.limits.chatSteps);
  });

  it("keeps annotations out of both arms and evidence out of BuJo recent context", async () => {
    const { corpus } = await loadCorpus("capture-fidelity-v1");
    for (const group of corpus.groups) {
      const source = sourceOnly(group);
      const projected = JSON.stringify(source);
      expect(projected).not.toContain(group.evaluation.rubric);
      expect(projected).not.toContain(group.evaluation.category);
      expect(projected).not.toContain("expectedMemory");
      expect(contextFor(source, "full-history")).toHaveLength(source.turns.length * 2);
      const recent = JSON.stringify(contextFor(source, "bujo"));
      for (const id of group.evaluation.evidenceTurnIds) {
        const evidence = group.source.turns.find((turn) => turn.id === id);
        expect(recent).not.toContain(evidence.user);
      }
    }
  });
});
