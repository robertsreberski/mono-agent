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

export async function summarizePromptCache({ artifactsDir = ".mono-agent/artifacts", conversation, since } = {}) {
  if (since !== undefined && (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(since) || !Number.isFinite(Date.parse(since)))) {
    throw new Error("--since must be an ISO timestamp.");
  }
  const directory = resolve(artifactsDir);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".events.jsonl")).sort();
  const runs = [];
  const warnings = [];
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
    let current;
    const lines = (await readFile(resolve(directory, name), "utf8")).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim()) continue;
      let event;
      try { event = JSON.parse(lines[index]); }
      catch { throw new Error(`Invalid JSON in ${name}:${index + 1}; retry after the artifact write completes.`); }
      if (event?.type === "prompt_cache_diagnostic") {
        const previous = requests.at(-1);
        // Project metadata explicitly: never copy arbitrary artifact content.
        current = {
          requestOrdinal: event.requestOrdinal,
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
        requests.push(current);
      } else if (event?.type === "context_usage" && current) {
        // Like the benchmark, keep the latest usage snapshot for this request;
        // snapshots are not additive and must not inflate token totals.
        const tokens = event.tokens ?? {};
        Object.assign(current, { input: count(tokens.input), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheCreation), output: count(tokens.output) });
      }
    }
    runs.push({ runId: summary.runId, conversationId: summary.conversationId, startedAt: summary.startedAt, requestCount: requests.length, requests, totals: totalUsage(requests) });
  }
  runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.runId.localeCompare(b.runId));
  const previousRuns = new Map();
  for (const run of runs) {
    const previous = previousRuns.get(run.conversationId)?.requests.at(-1);
    for (const request of run.requests) {
      request.toolsChangedFromPreviousRun = changed(previous?.toolsFingerprint, request.toolsFingerprint);
      request.systemChangedFromPreviousRun = changed(previous?.systemFingerprint, request.systemFingerprint);
      request.cacheHitRatio = ratio(request);
    }
    previousRuns.set(run.conversationId, run);
  }
  // Retain earlier runs for comparison, even when hidden by the time filter.
  const selected = runs.filter((run) => since === undefined || Date.parse(run.startedAt) >= Date.parse(since));
  const requests = selected.flatMap((run) => run.requests);
  return { runs: selected, requestCount: requests.length, totals: totalUsage(requests), warnings };
}

export function formatPromptCache(report) {
  const value = (v) => v === null || v === undefined ? "?" : String(v);
  const flip = (v) => v === null ? "?" : v ? "changed" : "same";
  const usage = (v) => tokenFields.map((key) => value(v[key])).join(" / ");
  const hit = (v) => v === null ? "?" : `${(100 * v).toFixed(2)}%`;
  const lines = [];
  for (const run of report.runs) {
    lines.push(`${run.runId}  conversation=${run.conversationId}  ${run.startedAt}  requests=${run.requestCount}`,
      "request | input / cacheRead / cacheWrite / output | wire (logical; source) | tools/system within run | tools/system vs previous run | hit");
    for (const request of run.requests) lines.push(`${value(request.requestOrdinal)} | ${usage(request)} | ${request.inputInterpretation} (${request.logicalInputInterpretation}; ${request.inputInterpretationSource}) | ${flip(request.toolsChangedWithinRun)}/${flip(request.systemChangedWithinRun)} | ${flip(request.toolsChangedFromPreviousRun)}/${flip(request.systemChangedFromPreviousRun)} | ${hit(request.cacheHitRatio)}`);
    lines.push(`run totals: ${usage(run.totals)}; hit=${hit(run.totals.cacheHitRatio)}`, "");
  }
  lines.push(`TOTAL requests=${report.requestCount}: ${usage(report.totals)}; weighted hit=${hit(report.totals.cacheHitRatio)}`,
    "? = unavailable or no comparison baseline. Fingerprint changes indicate payload changes, not proof of a cache miss.");
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
