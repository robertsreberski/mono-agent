import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, expectTypeOf, it, vi } from "vitest";
import { createTurnBinding } from "../engine/turn-evidence.js";
import { journalEntrySuffix } from "../engine/session-store.js";
import { sessionEntryToContextMessages } from "../engine/compaction-kit/context.js";
import { safeStat } from "../tools/shared/dedup.js";
import { sandboxFailureDiagnostic } from "../tools/shared/sandbox-diagnostics.js";
import { capLines, formatSearchLines, ripgrepMissingMessage } from "../tools/shared/ripgrep.js";
import { commandAdmission } from "../tools/commands/command-admission.js";
import { localEndpointError } from "../tools/web/local/config.js";
import { unsupportedParallelFetchOption } from "../tools/web/parallel-web-fetch.js";
import { canonicalizeSearchUrl, parseRetryAfter } from "../tools/web/search-providers/shared.js";
import { duckDuckGoRegion, normalizeSearchCountry } from "../tools/web/web-search-country.js";
import { refreshCachedSearchEnvelope } from "../tools/web/web-actionable.js";
import { parseContextLimitFromError, normalizePiErrorMessage } from "../providers/pi/errors.js";
import { effectivePayloadEffort } from "../providers/pi/effective-effort.js";
import { isOpenCodeModel } from "../execution/pi/provider-attribution.js";
import { compactionFailureGuard } from "../execution/pi/compaction/compaction-failures.js";
import { createGuardedCompactionHook, effectiveContextWindow, tryCompact } from "../execution/pi/compaction/compaction-driver.js";
import { checkNativeInheritedPrefix, prepareNativeHandoffSummaryRequest } from "../execution/pi/handoff-producer.js";
import { runHarnessPrompt } from "../execution/pi/prompt-operation.js";
import { createLiveInputPromptEpoch } from "../execution/pi/turn-runner.js";
import { subagentUsageForRun } from "../tools/delegation/agent-tool.js";
import { createAskParentTool } from "../tools/delegation/ask-parent-tool.js";
import { createAgentManageTool } from "../tools/delegation/agent-manage-tool.js";
import { createStructuredOutputTool } from "../tools/pi-tools.js";
import { prepareSummaryInput } from "../execution/pi/compaction/compaction-summary.js";
import { captureSessionRecovery } from "../execution/pi/session-results.js";

it("keeps internal filesystem and command absence explicit", () => {
  expectTypeOf(safeStat("")).toEqualTypeOf<import("node:fs").Stats | null>();
  expect(safeStat(join(tmpdir(), randomUUID()))).toBeNull();
  expect(sandboxFailureDiagnostic(false, "")).toBeUndefined();
  const diagnostic = sandboxFailureDiagnostic(true, "ordinary stderr");
  expect(diagnostic).toHaveProperty("code", undefined);
  expect(formatSearchLines([])).toBeUndefined();
  expect(capLines("")).toBeUndefined();
  expect(ripgrepMissingMessage()).toContain("ripgrep");
  expect(commandAdmission({ background: false, wakeOnCompletion: undefined, processJobsController: undefined })).toBeUndefined();
  expect(journalEntrySuffix("notes.txt")).toBeUndefined();
  expect(createTurnBinding({ kind: "host", ownerKey: "fictional-owner", historyBucket: "fictional-bucket", turnId: "fictional-turn", handleId: "fictional-handle", baseRevision: 0 }, {})).toBeUndefined();
  expect(sessionEntryToContextMessages({ type: "unsupported" })).toBeUndefined();
});

it("keeps absent web diagnostics, retry hints and country mappings distinct", () => {
  expect(localEndpointError(undefined)).toBeUndefined();
  expect(unsupportedParallelFetchOption({})).toBeUndefined();
  expect(canonicalizeSearchUrl("not a URL")).toBeNull();
  expect(parseRetryAfter(new Response())).toBeUndefined();
  expect(duckDuckGoRegion("ZZ", undefined)).toBeUndefined();
  expect(normalizeSearchCountry(undefined)).toHaveProperty("value", undefined);
  expect(refreshCachedSearchEnvelope("invalid envelope", {}, "fictional query")).toBeNull();
});

it("represents provider metadata absence without inventing values", () => {
  expectTypeOf(parseContextLimitFromError("")).toEqualTypeOf<number | null>();
  expect(parseContextLimitFromError("No context limit supplied")).toBeNull();
  expectTypeOf(effectivePayloadEffort({}, {})).toEqualTypeOf<string | undefined>();
  expect(effectivePayloadEffort({}, { reasoning: true })).toBeUndefined();
  expect(effectivePayloadEffort({}, {})).toBe("none");
  expectTypeOf(normalizePiErrorMessage("  ")).toEqualTypeOf<string | null>();
  expect(normalizePiErrorMessage("  ")).toBeNull();
  expect(isOpenCodeModel({})).toBe(false);
  expect(isOpenCodeModel({ baseUrl: "https://opencode.ai/v1" })).toBe(true);
});

it("allows pure handoff preflight without a completion callback", async () => {
  const model = { provider: "faux", id: "fictional", contextWindow: 100000, maxTokens: 4096 };
  expect(prepareNativeHandoffSummaryRequest({ model, prepared: { status: "prepared", older: [], recent: [], ledger: [] }, outputReserve: 1000 }).status).toBe("ready");
  const fit = await checkNativeInheritedPrefix([], model);
  expectTypeOf(fit).toEqualTypeOf<import("../contracts/native-storage.js").RuntimeHandoffFit>();
  expect(fit.status).toBe("ready");
});

it("admits omitted prompt images and reports an initially unowned prompt epoch", async () => {
  const prompt = vi.fn(async () => ({ status: "completed" }));
  const waitForIdle = vi.fn(async () => {});
  await expect(runHarnessPrompt({ prompt, waitForIdle }, "Fictional prompt")).resolves.toEqual({ runError: null });
  expect(prompt).toHaveBeenCalledWith("Fictional prompt");
  expect(waitForIdle).toHaveBeenCalledOnce();
  const epoch = createLiveInputPromptEpoch({ harness: { subscribe: () => () => {} }, onEvent: () => {} });
  expectTypeOf(epoch.ownedRunId()).toEqualTypeOf<string | undefined>();
  expectTypeOf<Extract<ReturnType<typeof epoch.consumedInputIds>, null>>().toEqualTypeOf<null>();
  expectTypeOf<Extract<ReturnType<typeof epoch.silenceRefusalReason>, null>>().toEqualTypeOf<null>();
  expect(epoch.ownedRunId()).toBeUndefined();
  expect(epoch.consumedInputIds()).toEqual([]);
  epoch.close();
});

it("reports unscoped guards and unmeasured compaction rather than fabricated measurements", async () => {
  expect(compactionFailureGuard({ scope: undefined, model: {}, policy: {}, tokens: 0, trigger: "manual" })).toBeNull();
  const guarded = createGuardedCompactionHook({});
  expect(guarded.getDecision()).toBeNull();
  expect(effectiveContextWindow({}, { model: { contextWindow: 100000 } }, {})).toBe(100000);
  const result = await tryCompact({}, { trigger: "manual", onEvent: () => {}, runtimeWarnings: [] });
  expect(result).toMatchObject({ applied: false, tokensBefore: null, reduced: null });
});

it("declines unavailable tool factories and allows unscoped subagent usage", () => {
  expect(createAskParentTool(null)).toBeNull();
  expect(createAgentManageTool(undefined)).toBeNull();
  expect(createStructuredOutputTool(undefined, () => {})).toBeNull();
  expect(subagentUsageForRun(undefined)).toMatchObject({ costUsd: 0 });
});

it("keeps missing file-op sets empty without asserting an arbitrary record key", () => {
  const input = prepareSummaryInput({ messagesToSummarize: [], turnPrefixMessages: [], retainedTail: [], fileOps: {} });
  expect(input.preparation.fileOps).toEqual({ read: new Set(), written: new Set(), edited: new Set() });
});

it("returns no recovery receipt for nondurable sessions", async () => {
  expectTypeOf<Extract<Awaited<ReturnType<typeof captureSessionRecovery>>, undefined>>().toEqualTypeOf<undefined>();
  await expect(captureSessionRecovery({}, { options: { sessionRecovery: { runId: "fictional-run", revision: 0 } },
    providerSessionId: "fictional-session", modelKey: "faux:fictional", model: {}, pending: false })).resolves.toBeUndefined();
});
