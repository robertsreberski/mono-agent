#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tokenFields = ["input", "cacheRead", "cacheWrite", "output"];
// Same token-weighted definition as measure-prompt-cache.mjs; unknown usage is
// not zero usage. Keep the benchmark's execution and report contract unchanged.
const ratio = ({ input, cacheRead, cacheWrite }) => {
  if (![input, cacheRead, cacheWrite].every(Number.isFinite)) return null;
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? cacheRead / total : null;
};
const changed = (before, after) => typeof before === "string" && typeof after === "string" ? before !== after : null;
const count = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const totalUsage = (requests) => {
  const totals = Object.fromEntries(tokenFields.map((key) => [key,
    requests.some((request) => request[key] === null) ? null : requests.reduce((sum, request) => sum + request[key], 0),
  ]));
  return { ...totals, cacheHitRatio: ratio(totals) };
};

const totalCost = (rows) => rows.some((row) => row.costUsd === null) ? null : rows.reduce((sum, row) => sum + row.costUsd, 0);
const fingerprintDifference = (before, after) => {
  if (before?.inputInterpretation !== "full" || after?.inputInterpretation !== "full"
    || !Array.isArray(before.messageFingerprints) || !Array.isArray(after.messageFingerprints)) return null;
  const limit = Math.min(before.messageFingerprints.length, after.messageFingerprints.length);
  for (let i = 0; i < limit; i += 1) if (before.messageFingerprints[i] !== after.messageFingerprints[i]) return i;
  return null; // Equal observed prefix, truncation, and appended tails prove no miss.
};

const textMetadata = (value) => typeof value === "string" && value.length > 0 ? value : null;
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const gapBucket = (gap) => gap === null ? "unknown" : gap < 0 ? "overlap" : gap < 300_000 ? "<5m" : gap < 3_600_000 ? "5–60m" : ">=60m";
const emptyRequest = () => ({ requestId: null, costUsd: null, input: null, cacheRead: null, cacheWrite: null, output: null });
const sumKnown = (rows, field) => {
  const values = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
  return { value: values.length ? values.reduce((sum, value) => sum + value, 0) : null, availableCount: values.length };
};
const messageEvidence = (request) => ({
  inputInterpretation: request?.inputInterpretation ?? "unavailable",
  logicalInputInterpretation: request?.logicalInputInterpretation ?? "unavailable",
  inputInterpretationSource: request?.inputInterpretationSource ?? "unavailable",
  messageCount: count(request?.messageCount),
  observedFingerprintCount: Array.isArray(request?.messageFingerprints) ? request.messageFingerprints.length : null,
  truncated: typeof request?.messageFingerprintsTruncated === "boolean" ? request.messageFingerprintsTruncated : null,
});

function consecutiveFirstRequests(runs, since) {
  const previousRuns = new Map();
  const pairs = [];
  const excluded = {};
  const groups = new Map();
  for (const run of runs) {
    const previousRun = previousRuns.get(run.conversationId);
    previousRuns.set(run.conversationId, run);
    if (since !== undefined && Date.parse(run.startedAt) < Date.parse(since)) continue;
    const first = run.analysisRequests[0];
    const last = previousRun?.analysisRequests.at(-1);
    const end = timestamp(previousRun?.endedAt);
    const idleGapMs = end === null ? null : Date.parse(run.startedAt) - end;
    const reasons = [];
    if (!previousRun) reasons.push("missing_baseline");
    if (!first) reasons.push("missing_first_request");
    if (previousRun && !last) reasons.push("missing_previous_request");
    if (previousRun && first && last) {
      if (![first.model, first.api, last.model, last.api].every((value) => value && value !== "unknown")) reasons.push("missing_model_api");
      else if (first.model !== last.model || first.api !== last.api) reasons.push("model_api_changed");
      if (!run.providerSessionId || !previousRun.providerSessionId) reasons.push("missing_provider_session");
      else if (run.providerSessionId !== previousRun.providerSessionId) reasons.push("provider_session_changed");
    }
    if (idleGapMs !== null && idleGapMs < 0) reasons.push("overlap");
    for (const reason of reasons) excluded[reason] = (excluded[reason] ?? 0) + 1;
    const toolsChanged = first?.supported === true && last?.supported === true ? changed(last.toolsFingerprint, first.toolsFingerprint) : null;
    const observed = Array.isArray(first?.observedCacheTtls) && first.observedCacheTtls.length ? first.observedCacheTtls.join("+") : "unknown";
    const retention = `requested=${first?.requestedCacheRetention ?? "unknown"};observed=${observed}`;
    const tokens = Object.fromEntries(tokenFields.map((key) => [key, count(first?.[key])]));
    const pair = {
      conversationId: run.conversationId, runId: run.runId, previousRunId: previousRun?.runId ?? null,
      firstRequestId: first?.requestId ?? null, previousLastRequestId: last?.requestId ?? null,
      model: first?.model ?? null, api: first?.api ?? null,
      comparable: reasons.length === 0, exclusionReasons: reasons,
      idleGapMs, idleGap: gapBucket(idleGapMs), retention,
      tools: toolsChanged === null ? "unknown" : toolsChanged ? "changed" : "stable",
      systemChanged: changed(last?.systemFingerprint, first?.systemFingerprint),
      firstChangedMessageIndex: fingerprintDifference(last, first),
      messageEvidence: { previous: messageEvidence(last), current: messageEvidence(first) },
      tokens, uncachedInput: tokens.input === null || tokens.cacheWrite === null ? null : tokens.input + tokens.cacheWrite,
      cacheHitRatio: reasons.length ? null : ratio(tokens),
      firstRequestCostUsd: count(first?.costUsd), runCostUsd: run.runCostUsd,
    };
    pairs.push(pair);
    // Resets, overlaps and absent baselines are evidence gaps, not hits/misses.
    if (!pair.comparable) continue;
    const key = JSON.stringify([pair.model, pair.api, pair.tools, pair.idleGap, retention]);
    const group = groups.get(key) ?? [];
    group.push(pair); groups.set(key, group);
  }
  const cohorts = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rows]) => {
    const [first] = rows;
    const tokens = Object.fromEntries(tokenFields.map((key) => [key, sumKnown(rows.map((row) => row.tokens), key).value]));
    const tokenCoverage = Object.fromEntries(tokenFields.map((key) => [key, sumKnown(rows.map((row) => row.tokens), key).availableCount]));
    const complete = rows.filter((row) => [row.tokens.input, row.tokens.cacheRead, row.tokens.cacheWrite].every(Number.isFinite));
    const hitTokens = totalUsage(complete.map((row) => row.tokens));
    const cost = sumKnown(rows, "firstRequestCostUsd"); const runCost = sumKnown(rows, "runCostUsd");
    return {
      model: first.model, api: first.api, tools: first.tools, idleGap: first.idleGap, retention: first.retention,
      pairCount: rows.length, tokens, tokenCoverage,
      uncachedInput: sumKnown(rows, "uncachedInput").value,
      uncachedInputAvailableCount: sumKnown(rows, "uncachedInput").availableCount,
      cacheHitRatio: complete.length ? ratio(hitTokens) : null, cacheHitRatioAvailableCount: complete.length,
      firstRequestCostUsd: cost.value, firstRequestCostAvailableCount: cost.availableCount,
      runCostUsd: runCost.value, runCostAvailableCount: runCost.availableCount,
    };
  });
  return { pairs, excluded, coverage: { runCount: pairs.length, comparablePairCount: pairs.filter((pair) => pair.comparable).length, excludedRunCount: pairs.filter((pair) => !pair.comparable).length }, cohorts };
}

export async function summarizePromptCache({ artifactsDir = ".mono-agent/artifacts", conversation, since } = {}) {
  if (since !== undefined && (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(since) || !Number.isFinite(Date.parse(since)))) {
    throw new Error("--since must be an ISO timestamp.");
  }
  const directory = resolve(artifactsDir);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".events.jsonl")).sort();
  const runs = [];
  const warnings = [];
  const analysisRuns = [];
  for (const name of names) {
    let summary;
    try {
      summary = JSON.parse(await readFile(resolve(directory, name.replace(/\.events\.jsonl$/u, ".summary.json")), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error(`Cannot read run summary for ${name}.`);
      warnings.push(`Skipped ${name}: companion summary unavailable.`);
      continue;
    }
    if (typeof summary.runId !== "string" || typeof summary.conversationId !== "string" || !Number.isFinite(Date.parse(summary.startedAt))) {
      throw new Error(`Invalid run summary for ${name}.`);
    }
    if (conversation !== undefined && summary.conversationId !== conversation) continue;
    const requests = [];
    const operations = new Map();
    let current;
    let runCostUsd = null;
    const analysisRequests = [];
    const byRequestId = new Map();
    const usageSnapshots = new Map();
    const lines = (await readFile(resolve(directory, name), "utf8")).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let event;
      try { event = JSON.parse(lines[index]); }
      catch { throw new Error(`Invalid JSON in ${name}:${index + 1}; retry after the artifact write completes.`); }
      if (event?.type === "cost_accumulated") {
        runCostUsd = count(event.cumulativeUsd);
      } else if (event?.type === "context_compaction") {
        if (typeof event.operationId !== "string") continue;
        const accounting = event.accounting ?? {};
        operations.set(event.operationId, {
          operationId: event.operationId, status: event.status, trigger: event.trigger,
          accountingAvailable: accounting.version === 1 && event.status !== "running",
          reason: event.reason ?? null, durationMs: count(accounting.durationMs),
          transcriptBefore: count(accounting.transcriptBefore), transcriptAfter: count(accounting.transcriptAfter),
          afterSource: ["preview", "persisted"].includes(accounting.afterSource) ? accounting.afterSource : null,
          fullRequestBefore: count(accounting.fullRequestBefore), fullRequestAfter: count(accounting.fullRequestAfter),
          requests: (Array.isArray(accounting.requests) ? accounting.requests : []).map((row) => ({
            requestId: row.requestId, phase: "summary", requestOrdinal: row.requestOrdinal,
            status: row.status, reason: row.reason, durationMs: count(row.durationMs),
            ...Object.fromEntries(tokenFields.map((key) => [key, count(row[key])])), costUsd: count(row.costUsd),
          })),
        });
      } else if (event?.type === "prompt_cache_diagnostic" && (event.phase === undefined || event.phase === "assistant")) {
        const previous = requests.at(-1);
        // Project metadata explicitly: never copy arbitrary artifact content.
        current = {
          requestOrdinal: event.requestOrdinal,
          requestId: event.requestId ?? null, phase: "assistant", costUsd: null,
          model: textMetadata(event.model), api: textMetadata(event.api),
          messageCount: count(event.messageCount),
          messageFingerprintsTruncated: typeof event.messageFingerprintsTruncated === "boolean" ? event.messageFingerprintsTruncated : null,
          requestedCacheRetention: ["short", "long", "unset"].includes(event.requestedCacheRetention) ? event.requestedCacheRetention : null,
          observedCacheTtls: Array.isArray(event.observedCacheTtls) ? [...new Set(event.observedCacheTtls.filter((ttl) => ["5m", "1h"].includes(ttl)))].sort() : null,
          messageFingerprints: event.messageFingerprints ?? null,
          supported: event.supported === true,
          toolsFingerprint: event.toolDefinitionsFingerprint ?? null,
          systemFingerprint: event.systemFingerprint ?? null,
          inputInterpretation: event.inputInterpretation ?? "unavailable",
          logicalInputInterpretation: event.logicalInputInterpretation ?? "unavailable",
          inputInterpretationSource: event.inputInterpretationSource ?? "unavailable",
          toolsChangedWithinRun: changed(previous?.toolsFingerprint, event.toolDefinitionsFingerprint),
          systemChangedWithinRun: changed(previous?.systemFingerprint, event.systemFingerprint),
          input: null, cacheRead: null, cacheWrite: null, output: null,
        };
        current.firstChangedMessageIndex = fingerprintDifference(previous, current);
        requests.push(current);
        const existing = current.requestId && byRequestId.get(current.requestId);
        if (existing) { Object.assign(existing, current); current = existing; requests[requests.length - 1] = existing; }
        else { analysisRequests.push(current); if (current.requestId) byRequestId.set(current.requestId, current); }
      } else if (event?.type === "context_usage" && event.phase !== "summary") {
        // Like the benchmark, keep the latest usage snapshot for this request;
        // snapshots are not additive and must not inflate token totals.
        const target = event.requestId ? requests.find((request) => request.requestId === event.requestId) : current;
        const tokens = event.tokens ?? {};
        const snapshot = { costUsd: count("providerCostUsd" in event ? event.providerCostUsd : event.costUsd), input: count(tokens.input), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheCreation), output: count(tokens.output) };
        if (target) Object.assign(target, snapshot);
        if (event.requestId) {
          usageSnapshots.set(event.requestId, snapshot);
          if (!byRequestId.has(event.requestId)) {
            const unknown = { ...emptyRequest(), requestId: event.requestId };
            byRequestId.set(event.requestId, unknown); analysisRequests.push(unknown);
          }
        }
      }
    }
    for (const [id, snapshot] of usageSnapshots) Object.assign(byRequestId.get(id), snapshot);
    analysisRuns.push({ runId: summary.runId, conversationId: summary.conversationId, startedAt: summary.startedAt,
      endedAt: summary.endedAt ?? null, providerSessionId: textMetadata(summary.providerSessionId), runCostUsd, analysisRequests });
    runs.push({ runId: summary.runId, conversationId: summary.conversationId, startedAt: summary.startedAt, requestCount: requests.length, requests, compactions: [...operations.values()], totals: totalUsage(requests) });
  }
  runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId));
  const previousRuns = new Map();
  for (const run of runs) {
    const previous = previousRuns.get(run.conversationId)?.requests.at(-1);
    for (const request of run.requests) {
      request.firstChangedMessageIndexFromPreviousRun = fingerprintDifference(previous, request);
      request.toolsChangedFromPreviousRun = changed(previous?.toolsFingerprint, request.toolsFingerprint);
      request.systemChangedFromPreviousRun = changed(previous?.systemFingerprint, request.systemFingerprint);
      request.cacheHitRatio = ratio(request);
    }
    previousRuns.set(run.conversationId, run);
  }
  // Retain earlier runs for comparison, even when hidden by the time filter.
  const selected = runs.filter((run) => since === undefined || Date.parse(run.startedAt) >= Date.parse(since));
  const requests = selected.flatMap((run) => run.requests);
  const summaryRequests = selected.flatMap((run) => run.compactions.flatMap((operation) => operation.accountingAvailable
    ? operation.requests : [{ input: null, output: null, cacheRead: null, cacheWrite: null, costUsd: null }]));
  analysisRuns.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return { consecutiveFirstRequests: consecutiveFirstRequests(analysisRuns, since), summaryTotals: totalUsage(summaryRequests), assistantCostUsd: totalCost(requests), summaryCostUsd: totalCost(summaryRequests), runs: selected, requestCount: requests.length, totals: totalUsage(requests), warnings };
}

export function formatPromptCache(report) {
  const value = (v) => v === null || v === undefined ? "?" : String(v);
  const flip = (v) => v === null ? "?" : v ? "changed" : "same";
  const usage = (v) => tokenFields.map((key) => value(v[key])).join(" / ");
  const hit = (v) => v === null ? "?" : `${(100 * v).toFixed(2)}%`;
  const lines = [];
  for (const run of report.runs) {
    lines.push(`${run.runId}  conversation=${run.conversationId}  ${run.startedAt}  requests=${run.requestCount}`,
      "request | input / cacheRead / cacheWrite / output | wire (logical; source) | tools/system within run | tools/system vs previous run | hit | first changed message (within/previous run)");
    for (const request of run.requests) lines.push(`${value(request.requestOrdinal)} | ${usage(request)} | ${request.inputInterpretation} (${request.logicalInputInterpretation}; ${request.inputInterpretationSource}) | ${flip(request.toolsChangedWithinRun)}/${flip(request.systemChangedWithinRun)} | ${flip(request.toolsChangedFromPreviousRun)}/${flip(request.systemChangedFromPreviousRun)} | ${hit(request.cacheHitRatio)} | ${value(request.firstChangedMessageIndex)}/${value(request.firstChangedMessageIndexFromPreviousRun)}`);
    for (const operation of run.compactions ?? []) lines.push(`compaction ${operation.operationId}: ${operation.status} (${operation.trigger}; ${operation.reason ?? "completed"}); transcript ${value(operation.transcriptBefore)} -> ${value(operation.transcriptAfter)} (${value(operation.afterSource)}); summary requests=${operation.requests.length}; summary cost USD=${value(operation.accountingAvailable ? totalCost(operation.requests) : null)}`);
    lines.push(`run totals: ${usage(run.totals)}; hit=${hit(run.totals.cacheHitRatio)}`, "");
  }
  lines.push(`Cost USD: assistant=${value(report.assistantCostUsd)}; summary=${value(report.summaryCostUsd)}`);
  lines.push(`TOTAL requests=${report.requestCount}: ${usage(report.totals)}; weighted hit=${hit(report.totals.cacheHitRatio)}`,
    "? = unavailable or no comparison baseline. Fingerprint changes indicate payload changes, not proof of a cache miss.");
  if (report.consecutiveFirstRequests) {
    const analysis = report.consecutiveFirstRequests;
    lines.push("", `Consecutive first requests: comparable=${analysis.coverage.comparablePairCount}; excluded=${analysis.coverage.excludedRunCount}; exclusions=${JSON.stringify(analysis.excluded)}`);
    for (const cohort of analysis.cohorts) lines.push(`${cohort.model} (${cohort.api}) | tools=${cohort.tools} | gap=${cohort.idleGap} | ${cohort.retention} | pairs=${cohort.pairCount} | weighted hit=${hit(cohort.cacheHitRatio)} (coverage ${cohort.cacheHitRatioAvailableCount}/${cohort.pairCount}) | first-request USD=${value(cohort.firstRequestCostUsd)} (${cohort.firstRequestCostAvailableCount}/${cohort.pairCount}) | run USD=${value(cohort.runCostUsd)} (${cohort.runCostAvailableCount}/${cohort.pairCount})`);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}

async function main(argv) {
  const options = {};
  let json = false;
  const flags = { "--artifacts-dir": "artifactsDir", "--conversation": "conversation", "--since": "since" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") { json = true; continue; }
    if (!flags[flag] || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("Usage: summarize-prompt-cache.mjs [--artifacts-dir path] [--conversation id] [--since ISO] [--json]");
    options[flags[flag]] = argv[++index];
  }
  const report = await summarizePromptCache(options);
  process.stdout.write(`${json ? JSON.stringify(report, null, 2) : formatPromptCache(report)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
