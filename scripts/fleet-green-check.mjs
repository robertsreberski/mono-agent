#!/usr/bin/env node
// Daily fleet green-check tracker for the v1 window (goal #168, epic #119).
//
// Read-only health probe of the live launchd mono-agent fleet. Its ONLY side
// effect is one dated checkpoint comment on issue #119 (skipped with --dry-run).
// It never restarts an instance, writes a config, or touches an artifact dir.
//
// Per instance it checks five things and surfaces a compact markdown table:
//   service   — `launchctl list <label>`: a running pid OR last exit 0 = pass.
//   runtime   — the exact plist Node executable reports the expected version + ABI.
//   validate  — exact plist Node + cli.js `validate --json`, exit 0 = pass.
//   memory    — exact plist Node + cli.js `memory audit --strict --json`:
//               healthy passes, in_progress warns, not_configured skips, and
//               every degraded/unhealthy/unknown/malformed result fails.
//   runs-24h  — deployed `cli.js metrics --since <24h-ago> --json` (cwd = dir):
//               surfaces run/failure counts and FAILS on any failure kind other
//               than a transient provider_unavailable failover (#136's expected
//               resilience-evidence kind), on an unclassified failure, or when
//               even a tolerated kind dominates the window (all runs failed, or
//               >50% over >=5 runs) — so a single failover in 110 runs reads
//               GREEN but 48-of-48 provider_auth reads RED. Cancelled runs are
//               lifecycle outcomes (surfaced in the note, never RED). Zero runs
//               is a non-RED "idle?" warning. `--strict-runs` fails on ANY
//               failed run; `--min-runs <n>` fails a too-quiet instance.
//
// Each probe retains and uses ProgramArguments[0] (Node) and [1] (cli.js) from
// that instance's plist. Neither the ambient `node` nor a cli.js inferred from
// this script's checkout is proof of the launchd runtime. With --expect-sha it
// fails on a mismatch (window mode); without it the sha is informational only.
//
// Verdict: `VERDICT: GREEN <date> sha <short>` or `VERDICT: RED <date> — <reason>`.
// Exits non-zero on RED so a wrapper can alert. No comment posted = not a green
// day; the 7-consecutive-day counter is human-audited from the dated comments.

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ISSUE_NUMBER = "119";
const REPO = "robertsreberski/mono-agent";
const LABEL_PREFIX = "com.mono-agent.";
const CLI_MARKER = "/packages/agent-app/";
const DEFAULT_EXPECT_NODE = "24.15.0";
const DEFAULT_EXPECT_ABI = "137";
const MEMORY_PASS_STATUSES = new Set(["healthy"]);
const MEMORY_WARN_STATUSES = new Set(["in_progress"]);
const MEMORY_SKIP_STATUSES = new Set(["not_configured"]);
const MEMORY_FAIL_STATUSES = new Set(["degraded", "unhealthy", "unknown"]);
const MEMORY_STATUSES = new Set([
  ...MEMORY_PASS_STATUSES,
  ...MEMORY_WARN_STATUSES,
  ...MEMORY_SKIP_STATUSES,
  ...MEMORY_FAIL_STATUSES,
]);
const BUJO_MEMORY_STATUSES = new Set([
  ...MEMORY_PASS_STATUSES,
  ...MEMORY_WARN_STATUSES,
  ...MEMORY_FAIL_STATUSES,
]);
const MEMORY_MODES = new Set(["lite", "journal", "bujo"]);
const MEMORY_REPORT_KEYS = ["schemaVersion", "backend", "mode", "status", "checkedAt", "issues", "counts"];
const MEMORY_REPORT_KEYS_WITHOUT_MODE = MEMORY_REPORT_KEYS.filter((key) => key !== "mode");
const MEMORY_COUNT_KEYS = [
  "pending",
  "due",
  "dead",
  "outbox",
  "temporary",
  "memories",
  "vectors",
  "missingVectors",
];
// Frozen by packages/memory/src/bujo/audit.ts. The producer emits issue codes
// in this order, so accepting a reordered or duplicated list would widen the
// supposedly closed fleet boundary beyond the CLI contract.
const MEMORY_ISSUE_CODES = [
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "database_unavailable",
  "native_module_unavailable",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "mutation_in_progress",
  "intake_invalid",
  "intake_pending",
  "dead_letters",
  "outbox_invalid",
  "outbox_pending",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
];
const MEMORY_ISSUE_INDEX = new Map(MEMORY_ISSUE_CODES.map((code, index) => [code, index]));
const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/u;

// The ONLY failure kind treated as fleet-normal: a transient provider failover
// (this is #136's "healthy failover" resilience evidence). Every OTHER kind in
// the observability taxonomy — provider_auth, usage_limit, process_death,
// runtime_error, etc. (see KNOWN_ARTIFACT_FAILURE_KINDS in
// packages/observability/src/summary-schema.ts) — and any unclassified failure
// drives RED. Even a tolerated kind drives RED when it dominates the window
// (see the volume guard in evaluateRuns): tolerance is for the occasional blip,
// never for a wedged instance failing over on every run.
const TOLERATED_FAILURE_KINDS = new Set(["provider_unavailable"]);

// Volume guards: a tolerated kind stops being "a blip" once it dominates.
const RUNS_FAILURE_RATE_LIMIT = 0.5;
const RUNS_FAILURE_RATE_MIN_SAMPLE = 5;

// The cancelled* kind family (cancelled, cancelled_user/_shutdown/_stale/_signal
// — see failure-kinds.ts) is a lifecycle OUTCOME, not a failure: a superseding
// message cancelling an in-flight turn is expected. `metrics` buckets failure
// kinds across runs of ANY status, so these land in failureKindRates even with
// zero failed runs; they must never drive the verdict. Counts are surfaced.
const CANCELLED_KIND_PATTERN = /^cancelled(_|$)/u;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested under scripts/__tests__).
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    strictRuns: false,
    help: false,
    expectNode: DEFAULT_EXPECT_NODE,
    expectAbi: DEFAULT_EXPECT_ABI,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--strict-runs") {
      parsed.strictRuns = true;
    } else if (arg === "--labels") {
      parsed.labels = requireValue(argv, (i += 1), arg)
        .split(",")
        .map((label) => label.trim())
        .filter((label) => label.length > 0);
    } else if (arg === "--expect-sha") {
      parsed.expectSha = requireValue(argv, (i += 1), arg);
    } else if (arg === "--expect-node") {
      const value = requireValue(argv, (i += 1), arg);
      if (!/^\d+\.\d+\.\d+$/u.test(value)) {
        throw new Error("--expect-node requires an exact semantic version (for example 24.15.0).");
      }
      parsed.expectNode = value;
    } else if (arg === "--expect-abi") {
      const value = requireValue(argv, (i += 1), arg);
      if (!/^\d+$/u.test(value)) {
        throw new Error("--expect-abi requires a numeric Node modules ABI (for example 137).");
      }
      parsed.expectAbi = value;
    } else if (arg === "--min-runs") {
      const value = Number.parseInt(requireValue(argv, (i += 1), arg), 10);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error("--min-runs requires a non-negative integer.");
      }
      parsed.minRuns = value;
    } else if (arg === "--repo") {
      parsed.repo = requireValue(argv, (i += 1), arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

// Parse `launchctl list <label>` output. Loaded services print a plist-ish block
// with PID and LastExitStatus; a missing service exits non-zero with a "Could
// not find service" message.
export function parseLaunchctlList(text, exitCode) {
  if (exitCode !== 0) {
    return { found: false, pid: null, lastExitStatus: null };
  }
  const pid = matchInt(text, /"?PID"?\s*=\s*(\d+)/u);
  const lastExitStatus = matchInt(text, /"?LastExitStatus"?\s*=\s*(-?\d+)/u);
  return { found: true, pid, lastExitStatus };
}

function matchInt(text, pattern) {
  const match = text.match(pattern);
  return match === null ? null : Number.parseInt(match[1], 10);
}

// Derive the deploy checkout root from a plist cli.js path.
export function deriveRepoFromCliPath(cliPath) {
  if (typeof cliPath !== "string") {
    return null;
  }
  const index = cliPath.indexOf(CLI_MARKER);
  return index === -1 ? null : cliPath.slice(0, index);
}

// Reduce a `metrics --json` report's overall bucket to the fields we track.
export function reduceMetrics(report) {
  const overall = report?.overall;
  if (!isRecord(overall)) {
    throw new Error("invalid metrics report");
  }
  const totalRuns = Number(overall.totalRuns);
  const failedRuns = Number(overall.statusCounts?.failed ?? 0);
  if (!Number.isInteger(totalRuns) || totalRuns < 0 || !Number.isInteger(failedRuns) || failedRuns < 0 || failedRuns > totalRuns) {
    throw new Error("invalid metrics counts");
  }
  if (!Array.isArray(overall.failureKindRates)) {
    throw new Error("invalid metrics failure kinds");
  }
  const failureKinds = overall.failureKindRates.map((entry) => {
    const kind = isRecord(entry) && typeof entry.failureKind === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(entry.failureKind)
      ? entry.failureKind
      : "unknown";
    const count = isRecord(entry) ? Number(entry.count) : Number.NaN;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("invalid metrics failure count");
    }
    return { kind, count };
  });
  return {
    ran: true,
    totalRuns,
    failedRuns,
    failureKinds,
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// Classify the runs-24h check. `metrics` is a reduced object, an { error }, or
// { ran: false } when skipped (no working dir). Returns one of
// pass | warn | fail | skip with a human-readable note plus the untolerated
// (non-transient / unclassified) failure kinds. RED (fail) is driven by:
//   - any failure kind outside TOLERATED_FAILURE_KINDS, or an unclassified fail;
//   - --strict-runs and any failed run;
//   - a volume guard, so even a tolerated kind that dominates goes RED
//     (all runs failed, or >50% failed over >=5 runs);
//   - fewer than --min-runs runs in the window.
// Zero runs is a distinct non-RED "idle?" warning (a wedged scheduler looks
// different from a healthy quiet window, but the operator should still see it).
export function evaluateRuns(metrics, options = {}) {
  const strictRuns = options.strictRuns === true;
  const minRuns = typeof options.minRuns === "number" ? options.minRuns : undefined;
  if (metrics === undefined || metrics === null || metrics.ran === false) {
    if (metrics && typeof metrics.error === "string") {
      return { status: "fail", note: `metrics read failed — ${metrics.error}`, untoleratedKinds: [] };
    }
    return { status: "skip", note: "no runs data", untoleratedKinds: [] };
  }

  const { totalRuns, failedRuns } = metrics;
  const cancelledCount = metrics.failureKinds
    .filter((entry) => CANCELLED_KIND_PATTERN.test(entry.kind))
    .reduce((sum, entry) => sum + entry.count, 0);
  // Only non-cancelled kinds are candidates for "untolerated"; cancellations are
  // lifecycle outcomes attributable to cancelled (not failed) runs.
  const failureKinds = metrics.failureKinds.filter((entry) => !CANCELLED_KIND_PATTERN.test(entry.kind));
  const classified = failureKinds.reduce((sum, entry) => sum + entry.count, 0);
  const unclassified = Math.max(0, failedRuns - classified);
  const untoleratedKinds = failureKinds
    .filter((entry) => !TOLERATED_FAILURE_KINDS.has(entry.kind))
    .map((entry) => entry.kind);
  if (unclassified > 0) {
    untoleratedKinds.push("(unclassified)");
  }

  const failKindParts = [
    ...failureKinds.map((entry) => `${entry.kind}×${entry.count}`),
    ...(unclassified > 0 ? [`(unclassified)×${unclassified}`] : []),
  ];
  const kindsSummary = failKindParts.length === 0 ? "" : ` (${failKindParts.join(", ")})`;
  const cancelledSummary = cancelledCount > 0 ? `, ${cancelledCount} cancelled` : "";
  const counts = `${totalRuns} runs, ${failedRuns} failed${cancelledSummary}${kindsSummary}`;
  const failRate = totalRuns > 0 ? failedRuns / totalRuns : 0;

  if (strictRuns && failedRuns > 0) {
    return { status: "fail", note: `${counts} — strict`, untoleratedKinds };
  }
  if (untoleratedKinds.length > 0) {
    return { status: "fail", note: `${counts} — untolerated failure kind(s): ${untoleratedKinds.join(", ")}`, untoleratedKinds };
  }
  if (failedRuns > 0 && failedRuns === totalRuns) {
    return { status: "fail", note: `${counts} — all runs failed`, untoleratedKinds };
  }
  if (totalRuns >= RUNS_FAILURE_RATE_MIN_SAMPLE && failRate > RUNS_FAILURE_RATE_LIMIT) {
    return { status: "fail", note: `${counts} — failure rate ${(failRate * 100).toFixed(0)}% over ${totalRuns} runs`, untoleratedKinds };
  }
  if (minRuns !== undefined && totalRuns < minRuns) {
    return { status: "fail", note: `${counts} — below --min-runs ${minRuns}`, untoleratedKinds };
  }
  if (totalRuns === 0) {
    return { status: "warn", note: "0 runs (idle?)", untoleratedKinds };
  }
  return { status: "pass", note: counts, untoleratedKinds };
}

export function instanceName(label) {
  return label.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : label;
}

export function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : "unknown";
}

export function evaluateRuntime(runtime, expected = {}) {
  if (!runtime || runtime.ran !== true) {
    return { status: "fail", note: "runtime probe unavailable" };
  }
  const expectNode = expected.expectNode ?? DEFAULT_EXPECT_NODE;
  const expectAbi = expected.expectAbi ?? DEFAULT_EXPECT_ABI;
  if (runtime.node !== expectNode || runtime.abi !== expectAbi) {
    return {
      status: "fail",
      note: `runtime ${runtime.node}/abi${runtime.abi} != expected ${expectNode}/abi${expectAbi}`,
    };
  }
  return { status: "pass", note: `${runtime.node}/abi${runtime.abi}` };
}

function evaluateService(service) {
  if (!service || service.found !== true) {
    return { status: "fail", note: "service not found" };
  }
  if (typeof service.pid === "number") {
    return { status: "pass", note: `running (pid ${service.pid})` };
  }
  if (service.lastExitStatus === 0) {
    return { status: "pass", note: "loaded, last exit 0" };
  }
  return { status: "fail", note: `not running (last exit ${service.lastExitStatus ?? "?"})` };
}

function evaluateValidate(validate) {
  if (!validate || validate.ran !== true) {
    return { status: "fail", note: "validate probe unavailable" };
  }
  if (validate.validJson === true && validate.ok === true && validate.exitCode === 0) {
    return { status: "pass", note: "" };
  }
  if (validate.validJson !== true) {
    return { status: "fail", note: "validate returned malformed JSON" };
  }
  return { status: "fail", note: "validate reported errors" };
}

/** Parse the strict memory result even on exit 1, then enforce the full frozen contract. */
export function parseMemoryAudit(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || !isStrictMemoryReport(report)) {
    return { ran: true, malformed: true };
  }
  const expectedExit = MEMORY_FAIL_STATUSES.has(report.status) ? 1 : 0;
  if (exitCode !== expectedExit) {
    return { ran: true, malformed: true };
  }
  return { ran: true, status: report.status };
}

function isStrictMemoryReport(report) {
  if (report.schemaVersion !== 1
    || typeof report.backend !== "string"
    || typeof report.status !== "string"
    || !MEMORY_STATUSES.has(report.status)
    || !isValidIsoInstant(report.checkedAt)
    || !isClosedIssueList(report.issues)
    || !isClosedMemoryCounts(report.counts)) {
    return false;
  }

  if (report.backend === "bujo") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS)
      && typeof report.mode === "string"
      && MEMORY_MODES.has(report.mode)
      && BUJO_MEMORY_STATUSES.has(report.status);
  }
  if (report.backend === "none") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "not_configured"
      && report.issues.length === 0;
  }
  if (report.backend === "supermemory") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "unknown"
      && report.issues.length === 0;
  }
  return false;
}

function hasExactKeys(record, expectedKeys) {
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(record, key));
}

function isClosedIssueList(value) {
  if (!Array.isArray(value)) {
    return false;
  }
  let previousIndex = -1;
  for (const issue of value) {
    if (typeof issue !== "string") {
      return false;
    }
    const index = MEMORY_ISSUE_INDEX.get(issue);
    if (index === undefined || index <= previousIndex) {
      return false;
    }
    previousIndex = index;
  }
  return true;
}

function isClosedMemoryCounts(value) {
  return isRecord(value)
    && hasExactKeys(value, MEMORY_COUNT_KEYS)
    && MEMORY_COUNT_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function isValidIsoInstant(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const offsetHour = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
  const offsetMinute = match[10] === undefined ? 0 : Number.parseInt(match[10], 10);
  if (month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function evaluateMemory(memory) {
  if (!memory || memory.ran !== true) {
    return { status: "fail", memoryStatus: "malformed", note: "memory audit unavailable" };
  }
  if (memory.malformed === true || typeof memory.status !== "string") {
    return { status: "fail", memoryStatus: "malformed", note: "strict memory audit malformed" };
  }
  if (MEMORY_PASS_STATUSES.has(memory.status)) {
    return { status: "pass", memoryStatus: memory.status, note: "" };
  }
  if (MEMORY_WARN_STATUSES.has(memory.status)) {
    return { status: "warn", memoryStatus: memory.status, note: "memory mutation in progress" };
  }
  if (MEMORY_SKIP_STATUSES.has(memory.status)) {
    return { status: "skip", memoryStatus: memory.status, note: "memory not configured" };
  }
  if (MEMORY_FAIL_STATUSES.has(memory.status)) {
    return { status: "fail", memoryStatus: memory.status, note: `memory ${memory.status}` };
  }
  return { status: "fail", memoryStatus: "malformed", note: "strict memory audit malformed" };
}

const CELL = { pass: "ok", warn: "warn", fail: "FAIL", skip: "—" };

// The verdict + table. Pure: takes already-collected structured data.
export function buildFleetReport(input) {
  const { date, deployedSha, expectSha, expectNode, expectAbi, strictRuns, minRuns } = input;
  const rows = input.instances.map((instance) => {
    const name = instanceName(instance.label);
    // A plist that matched the prefix but could not be read is an unknown
    // config the fleet may be running blind — RED, never silently dropped.
    if (typeof instance.discoveryError === "string") {
      const service = { status: "fail", note: "plist unreadable" };
      const skipped = { status: "skip", note: "" };
      return {
        name,
        label: instance.label,
        service,
        runtime: skipped,
        validate: skipped,
        memory: { ...skipped, memoryStatus: "malformed" },
        runs: skipped,
        notes: service.note,
      };
    }
    const service = evaluateService(instance.service);
    const runtime = evaluateRuntime(instance.runtime, { expectNode, expectAbi });
    const validate = evaluateValidate(instance.validate);
    const memory = evaluateMemory(instance.memory);
    const runs = evaluateRuns(instance.metrics, { strictRuns, minRuns });
    const notes = [
      service.status !== "pass" ? service.note : null,
      runtime.status !== "pass" ? runtime.note : null,
      validate.status !== "pass" ? validate.note : null,
      memory.status !== "pass" ? memory.note : null,
      runs.note || null,
    ]
      .filter((note) => note !== null && note !== "")
      .join("; ");
    return { name, label: instance.label, service, runtime, validate, memory, runs, notes };
  });

  let reason = null;
  for (const row of rows) {
    if (row.service.status === "fail") {
      reason = `${row.name}: ${row.service.note}`;
      break;
    }
    if (row.runtime.status === "fail") {
      reason = `${row.name}: ${row.runtime.note}`;
      break;
    }
    if (row.validate.status === "fail") {
      reason = `${row.name}: ${row.validate.note}`;
      break;
    }
    if (row.memory.status === "fail") {
      reason = `${row.name}: ${row.memory.note}`;
      break;
    }
    if (row.runs.status === "fail") {
      reason = `${row.name}: ${row.runs.note}`;
      break;
    }
  }

  const shaKnown = typeof deployedSha === "string" && deployedSha.length >= 7;
  if (reason === null && typeof expectSha === "string" && expectSha.length > 0) {
    if (!shaKnown || !deployedSha.startsWith(expectSha)) {
      reason = `deployed sha ${shortSha(deployedSha)} != expected ${shortSha(expectSha)}`;
    }
  }
  if (reason === null && rows.length === 0) {
    reason = "no fleet instances discovered";
  }

  const verdict = reason === null ? "GREEN" : "RED";
  const verdictLine = verdict === "GREEN"
    ? `VERDICT: GREEN ${date} sha ${shortSha(deployedSha)}`
    : `VERDICT: RED ${date} — ${reason}`;

  const table = renderTable(rows);
  const shaLine = typeof expectSha === "string" && expectSha.length > 0
    ? `Deployed sha: ${shortSha(deployedSha)} (expected ${shortSha(expectSha)})`
    : `Deployed sha: ${shortSha(deployedSha)}`;
  const body = [
    `### Fleet green-check ${date}`,
    "",
    table,
    "",
    shaLine,
    "",
    verdictLine,
  ].join("\n");

  return { verdict, reason, rows, table, body, verdictLine, exitCode: verdict === "GREEN" ? 0 : 1 };
}

function renderTable(rows) {
  const header = "| instance | service | runtime | validate | memory | runs-24h | notes |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((row) => {
    const notes = row.notes.length > 0 ? row.notes.replace(/\|/gu, "\\|") : "";
    return `| ${row.name} | ${CELL[row.service.status]} | ${CELL[row.runtime.status]} | ${CELL[row.validate.status]} | ${row.memory.memoryStatus} | ${CELL[row.runs.status]} | ${notes} |`;
  });
  return [header, divider, ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Impure layer (thin, untested-live).
// ---------------------------------------------------------------------------

function discoverInstances(launchAgentsDir, runCommand, readdir) {
  const byLabel = new Map();
  let entries;
  try {
    entries = readdir(launchAgentsDir);
  } catch {
    return byLabel;
  }
  for (const entry of entries) {
    if (!entry.startsWith(LABEL_PREFIX) || !entry.endsWith(".plist")) {
      continue;
    }
    const plistPath = join(launchAgentsDir, entry);
    const filenameLabel = entry.slice(0, -".plist".length);
    const result = runCommand("plutil", ["-convert", "json", "-o", "-", plistPath]);
    if (result.status !== 0) {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, nodePath: null, cliPath: null, discoveryError: "plist conversion failed" });
      continue;
    }
    let plist;
    try {
      plist = JSON.parse(result.stdout);
    } catch {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, nodePath: null, cliPath: null, discoveryError: "plist JSON invalid" });
      continue;
    }
    if (!isRecord(plist)) {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, nodePath: null, cliPath: null, discoveryError: "plist JSON invalid" });
      continue;
    }
    const label = typeof plist.Label === "string" ? plist.Label : filenameLabel;
    const dir = typeof plist.WorkingDirectory === "string" ? plist.WorkingDirectory : null;
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
    const nodePath = typeof args[0] === "string" ? args[0] : null;
    const cliPath = typeof args[1] === "string" && args[1].endsWith("cli.js") ? args[1] : null;
    byLabel.set(label, { label, dir, nodePath, cliPath });
  }
  return byLabel;
}

function collectInstance(entry, since, runCommand) {
  if (typeof entry.discoveryError === "string") {
    return {
      label: entry.label,
      dir: null,
      discoveryError: entry.discoveryError,
      service: { found: false, pid: null, lastExitStatus: null },
      runtime: { ran: false },
      validate: { ran: false },
      memory: { ran: false },
      metrics: { ran: false },
    };
  }
  const service = parseLaunchctlList(...launchctlList(entry.label, runCommand));
  const runtime = entry.nodePath === null
    ? { ran: false }
    : runRuntimeProbe(entry.nodePath, runCommand);
  let validate = { ran: false };
  let memory = { ran: false };
  let metrics = { ran: false };
  if (entry.dir !== null && entry.nodePath !== null && entry.cliPath !== null) {
    validate = runValidate(entry.nodePath, entry.cliPath, entry.dir, runCommand);
    memory = runMemoryAudit(entry.nodePath, entry.cliPath, entry.dir, runCommand);
    metrics = runMetrics(entry.nodePath, entry.cliPath, entry.dir, since, runCommand);
  }
  return { label: entry.label, dir: entry.dir, service, runtime, validate, memory, metrics };
}

function launchctlList(label, runCommand) {
  const result = runCommand("launchctl", ["list", label]);
  return [result.stdout ?? "", result.status];
}

function runRuntimeProbe(nodePath, runCommand) {
  const result = runCommand(nodePath, [
    "-p",
    "JSON.stringify({node:process.versions.node,abi:process.versions.modules})",
  ]);
  if (result.status !== 0) {
    return { ran: false };
  }
  const parsed = parseJsonObject(result.stdout ?? "");
  if (parsed === null || typeof parsed.node !== "string" || !/^\d+\.\d+\.\d+$/u.test(parsed.node)
    || typeof parsed.abi !== "string" || !/^\d+$/u.test(parsed.abi)) {
    return { ran: false };
  }
  return { ran: true, node: parsed.node, abi: parsed.abi };
}

function runValidate(nodePath, cliPath, dir, runCommand) {
  const result = runCommand(nodePath, [cliPath, "validate", "--json"], { cwd: dir });
  const parsed = parseJsonObject(result.stdout ?? "");
  if (parsed === null || typeof parsed.ok !== "boolean") {
    return { ran: true, exitCode: result.status, validJson: false };
  }
  return { ran: true, exitCode: result.status, validJson: true, ok: parsed.ok };
}

function runMemoryAudit(nodePath, cliPath, dir, runCommand) {
  const result = runCommand(nodePath, [cliPath, "memory", "audit", "--strict", "--json"], { cwd: dir });
  return parseMemoryAudit(result.stdout ?? "", result.status);
}

function runMetrics(nodePath, cliPath, dir, since, runCommand) {
  const result = runCommand(nodePath, [cliPath, "metrics", "--since", since, "--json"], { cwd: dir });
  if (result.status !== 0) {
    return { ran: false, error: "metrics command failed" };
  }
  try {
    return reduceMetrics(JSON.parse(result.stdout));
  } catch {
    return { ran: false, error: "metrics JSON malformed" };
  }
}

function resolveDeployRepo(discovered, override) {
  if (typeof override === "string" && override.length > 0) {
    return { repo: resolve(override), warning: null };
  }
  const repos = new Set();
  for (const entry of discovered.values()) {
    const repo = deriveRepoFromCliPath(entry.cliPath);
    if (repo !== null) {
      repos.add(repo);
    }
  }
  if (repos.size === 0) {
    return { repo: null, warning: "no deploy checkout derivable from plists" };
  }
  const [first] = repos;
  return { repo: first, warning: repos.size > 1 ? `instances span ${repos.size} checkouts; using ${first}` : null };
}

function readDeployedSha(repo, runCommand) {
  if (repo === null) {
    return null;
  }
  const result = runCommand("git", ["-C", repo, "rev-parse", "HEAD"]);
  const sha = result.status === 0 ? (result.stdout ?? "").trim() : "";
  return /^[0-9a-f]{40,64}$/iu.test(sha) ? sha.toLowerCase() : null;
}

function runCommandSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

export async function runFleetGreenCheck(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandSync;
  const launchAgentsDir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const readdir = options.readdir ?? readdirSync;
  const now = options.now ?? new Date();

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    return { exitCode: 1 };
  }
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return { exitCode: 0 };
  }

  const discovered = discoverInstances(launchAgentsDir, runCommand, readdir);
  const selectedLabels = args.labels ?? [...discovered.keys()];
  const { repo: deployRepo, warning: repoWarning } = resolveDeployRepo(discovered, args.repo);
  const deployedSha = readDeployedSha(deployRepo, runCommand);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const date = now.toISOString().slice(0, 10);

  const instances = selectedLabels.map((label) => {
    const entry = discovered.get(label) ?? { label, dir: null, nodePath: null, cliPath: null };
    return collectInstance(entry, since, runCommand);
  });

  const report = buildFleetReport({
    date,
    deployedSha,
    expectSha: args.expectSha,
    expectNode: args.expectNode,
    expectAbi: args.expectAbi,
    strictRuns: args.strictRuns,
    ...(args.minRuns === undefined ? {} : { minRuns: args.minRuns }),
    instances,
  });

  let body = report.body;
  if (repoWarning !== null) {
    body = `${body}\n\n> note: ${repoWarning}`;
  }

  stdout.write(`${body}\n`);

  if (!args.dryRun) {
    const result = runCommand("gh", ["issue", "comment", ISSUE_NUMBER, "--repo", REPO, "--body", body]);
    if (result.status !== 0) {
      stderr.write(`Failed to post comment to #${ISSUE_NUMBER}.\n`);
      return { exitCode: report.exitCode === 0 ? 1 : report.exitCode };
    }
    stdout.write(`Posted checkpoint to #${ISSUE_NUMBER}.\n`);
  }

  return { exitCode: report.exitCode };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/fleet-green-check.mjs [--dry-run] [--labels <csv>] [--expect-sha <sha>]",
    "                                     [--expect-node <version>] [--expect-abi <abi>]",
    "                                     [--strict-runs] [--min-runs <n>] [--repo <path>]",
    "",
    "Read-only daily green-check of the launchd mono-agent fleet. Prints a markdown",
    "table + verdict; without --dry-run also posts it as a comment to issue #119.",
    "Dates and the 24h runs window are UTC-anchored. Exits non-zero on RED.",
    "",
    "Runs-24h drives RED on any failure kind other than a transient",
    "provider_unavailable failover, on an unclassified failure, or when even a",
    "tolerated kind dominates (all runs failed, or >50% over >=5 runs). Zero runs",
    "is a non-RED 'idle?' warning.",
    "",
    "  --dry-run       Print only; do not post the GitHub comment.",
    "  --labels <csv>  Check these launchd labels instead of auto-discovering plists",
    "                  (a bogus label yields a RED row — used to simulate RED).",
    "  --expect-sha    Fail if the deployed sha does not match (v1 window mode).",
    `  --expect-node   Require each plist Node to report this version (default ${DEFAULT_EXPECT_NODE}).`,
    `  --expect-abi    Require each plist Node to report this modules ABI (default ${DEFAULT_EXPECT_ABI}).`,
    "  --strict-runs   Fail runs-24h on ANY failed run, not just untolerated ones.",
    "  --min-runs <n>  Fail an instance with fewer than n runs in the window.",
    "  --repo <path>   Override only the deploy checkout used for the sha probe.",
  ].join("\n");
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runFleetGreenCheck();
  process.exitCode = result.exitCode;
}
