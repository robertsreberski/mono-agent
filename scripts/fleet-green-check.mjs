#!/usr/bin/env node
// Daily fleet green-check tracker for the v1 window (goal #168, epic #119).
//
// Read-only health probe of the live launchd mono-agent fleet. Its ONLY side
// effect is one dated checkpoint comment on issue #119 (skipped with --dry-run).
// It never restarts an instance, writes a config, or touches an artifact dir.
//
// Per instance it checks six things and surfaces a compact markdown table:
//   service   — `launchctl list <label>`: every selected job must have a pid.
//   loaded    — a running pid must have started after this checkout's atomic,
//               clean, sha/runtime-bound build marker; the marker, checkout,
//               and launchd pid are re-read to close deploy/restart races.
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
// Each probe retains and uses the exact Node + cli.js invocation, including the
// hardened `/usr/bin/env -i` wrapper emitted by current managed LaunchAgents,
// the service's exact absolute --config/--env-file values, and its complete
// allowlisted operational environment. Neither the ambient `node`, a cli.js inferred from this checkout,
// cwd-default configuration, nor the checker's ambient PATH is proof of the
// launchd runtime. With --expect-sha every selected process, checkout, and build
// marker must match that full sha exactly. Loaded-code proof is mandatory for
// every selected service.
//
// Verdict: `VERDICT: GREEN <date> sha <short>` or `VERDICT: RED <date> — <reason>`.
// Exits non-zero on RED so a wrapper can alert. No comment posted = not a green
// day; the 7-consecutive-day counter is human-audited from the dated comments.

import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ISSUE_NUMBER = "119";
const REPO = "robertsreberski/mono-agent";
const LABEL_PREFIX = "com.mono-agent.";
const LABEL_PATTERN = /^com\.mono-agent\.[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const MAX_LABEL_FOLDER_SEGMENT = 40;
const CLI_MARKER = "/packages/agent-app/";
const DEFAULT_EXPECT_NODE = "24.15.0";
const DEFAULT_EXPECT_ABI = "137";
const BUILD_PROVENANCE_PROBE = fileURLToPath(new URL("./build-provenance-probe.mjs", import.meta.url));
const MANAGED_RUNTIME_ATTESTATION_PROBE = fileURLToPath(new URL("./managed-runtime-attestation-probe.mjs", import.meta.url));
const COMMAND_TIMEOUT_MS = Object.freeze({
  plist: 5_000,
  service: 5_000,
  loaded: 30_000,
  attestation: 120_000,
  process: 5_000,
  runtime: 5_000,
  validate: 30_000,
  memory: 60_000,
  metrics: 30_000,
  git: 5_000,
  github: 30_000,
});
const LAUNCHD_PROBE_ENV_KEYS = Object.freeze([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "__CF_USER_TEXT_ENCODING",
]);
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
  "health_check_failed",
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
  "work_stalled",
  "temporary_artifacts",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
];
const MEMORY_ISSUE_INDEX = new Map(MEMORY_ISSUE_CODES.map((code, index) => [code, index]));
const MEMORY_UNKNOWN_ISSUES = new Set([
  "database_unavailable",
  "native_module_unavailable",
  "health_check_failed",
]);
const MEMORY_UNHEALTHY_ISSUES = new Set([
  "manifest_missing",
  "manifest_invalid",
  "configured_identity_mismatch",
  "database_missing",
  "sqlite_integrity_failed",
  "metadata_mismatch",
  "fts_mismatch",
  "vector_mismatch",
  "orphaned_rows",
  "canonical_mismatch",
  "canonical_invalid",
  "intake_invalid",
  "outbox_invalid",
  "temporary_artifacts",
]);
const MEMORY_DEGRADED_ISSUES = new Set([
  "dead_letters",
  "work_stalled",
  "runtime_missing",
  "runtime_stale",
  "runtime_invalid",
]);
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
const BUILD_MARKER_KEYS = Object.freeze([
  "schemaVersion",
  "gitSha",
  "completedAt",
  "nodeVersion",
  "nodeAbi",
  "sourceState",
  "outputDigest",
  "dependencyDigest",
]);
const BUILD_MARKER_SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const BUILD_MARKER_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;
const PROCESS_START_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u;
const PROCESS_MONTH_INDEX = new Map([
  ["Jan", 0], ["Feb", 1], ["Mar", 2], ["Apr", 3], ["May", 4], ["Jun", 5],
  ["Jul", 6], ["Aug", 7], ["Sep", 8], ["Oct", 9], ["Nov", 10], ["Dec", 11],
]);
const PROCESS_WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const CLOSED_SYSTEM_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
const CLOSED_GIT_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
});
const PLUTIL = "/usr/bin/plutil";
const LAUNCHCTL = "/bin/launchctl";
const ENV = "/usr/bin/env";
const MANAGED_BACKGROUND_WORKER_ENV = "MONO_AGENT_MANAGED_WORKER";
// Keep this fail-closed list aligned with BACKGROUND_OPERATIONAL_ENV_NAMES in
// packages/agent-app/src/background-environment.ts. The lifecycle marker is
// added by managedBackgroundEnvironment rather than the public allowlist.
export const MANAGED_BACKGROUND_ENV_NAMES = new Set([
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  MANAGED_BACKGROUND_WORKER_ENV,
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
]);
const MANAGED_PLIST_KEYS = Object.freeze([
  "Label",
  "ProgramArguments",
  "WorkingDirectory",
  "RunAtLoad",
  "KeepAlive",
  "StandardOutPath",
  "StandardErrorPath",
  "ThrottleInterval",
  "ProcessType",
]);

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
      parsed.labels = parseLabelCsv(requireValue(argv, (i += 1), arg), arg);
    } else if (arg === "--expect-labels") {
      parsed.expectLabels = parseLabelCsv(requireValue(argv, (i += 1), arg), arg);
    } else if (arg === "--expect-sha") {
      const value = requireValue(argv, (i += 1), arg);
      if (!BUILD_MARKER_SHA_PATTERN.test(value)) {
        throw new Error("--expect-sha requires a full lowercase 40-64 character hexadecimal sha.");
      }
      parsed.expectSha = value;
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
      throw new Error("Unknown argument.");
    }
  }
  if (parsed.labels !== undefined && parsed.expectLabels !== undefined
    && !sameStringSet(parsed.labels, parsed.expectLabels)) {
    throw new Error("--labels must exactly match --expect-labels when both are provided.");
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

function parseLabelCsv(value, flag) {
  const labels = value.split(",").map((label) => label.trim());
  if (labels.length === 0
    || labels.some((label) => !LABEL_PATTERN.test(label))
    || new Set(labels).size !== labels.length) {
    throw new Error(`${flag} requires a non-empty, duplicate-free CSV of canonical mono-agent labels.`);
  }
  return labels;
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

export function evaluateExpectedLabels(actualLabels, expectedLabels) {
  if (expectedLabels === undefined) return null;
  const actual = new Set(actualLabels);
  const expected = new Set(expectedLabels);
  let missing = 0;
  let extra = 0;
  for (const label of expected) {
    if (!actual.has(label)) missing += 1;
  }
  for (const label of actual) {
    if (!expected.has(label)) extra += 1;
  }
  return missing === 0 && extra === 0
    ? null
    : `fleet labels mismatch (missing ${missing}, extra ${extra})`;
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

export function parseBuildProvenanceProbe(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || report.schemaVersion !== 2 || typeof report.status !== "string") {
    return { status: "malformed" };
  }
  if (report.status === "missing" || report.status === "unsafe" || report.status === "malformed") {
    return exitCode === 1 && hasExactKeys(report, ["schemaVersion", "status"])
      ? { status: report.status }
      : { status: "malformed" };
  }
  if (report.status !== "ok"
    || exitCode !== 0
    || !hasExactKeys(report, ["schemaVersion", "status", "marker", "fingerprint", "outputDigest", "dependencyDigest"])
    || typeof report.fingerprint !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.fingerprint)
    || typeof report.outputDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.outputDigest)
    || typeof report.dependencyDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.dependencyDigest)
    || !isRecord(report.marker)
    || !hasExactKeys(report.marker, BUILD_MARKER_KEYS)) {
    return { status: "malformed" };
  }
  const marker = report.marker;
  const completedAtMs = Date.parse(marker.completedAt);
  if (marker.schemaVersion !== 2
    || typeof marker.gitSha !== "string"
    || !BUILD_MARKER_SHA_PATTERN.test(marker.gitSha)
    || typeof marker.completedAt !== "string"
    || !Number.isFinite(completedAtMs)
    || new Date(completedAtMs).toISOString() !== marker.completedAt
    || typeof marker.nodeVersion !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(marker.nodeVersion)
    || typeof marker.nodeAbi !== "string"
    || !/^\d+$/u.test(marker.nodeAbi)
    || (marker.sourceState !== "clean" && marker.sourceState !== "dirty")
    || typeof marker.outputDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(marker.outputDigest)
    || typeof marker.dependencyDigest !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(marker.dependencyDigest)) {
    return { status: "malformed" };
  }
  return {
    status: "ok",
    fingerprint: report.fingerprint,
    outputDigest: report.outputDigest,
    dependencyDigest: report.dependencyDigest,
    marker: {
      schemaVersion: 2,
      gitSha: marker.gitSha,
      completedAt: marker.completedAt,
      nodeVersion: marker.nodeVersion,
      nodeAbi: marker.nodeAbi,
      sourceState: marker.sourceState,
      outputDigest: marker.outputDigest,
      dependencyDigest: marker.dependencyDigest,
    },
  };
}

export function parseManagedRuntimeAttestationProbe(text, exitCode) {
  const report = parseJsonObject(text);
  if (report === null || report.schemaVersion !== 1 || typeof report.status !== "string") {
    return { status: "malformed" };
  }
  if (report.status === "unsafe") {
    return exitCode === 1 && hasExactKeys(report, ["schemaVersion", "status"])
      ? { status: "unsafe" }
      : { status: "malformed" };
  }
  if (report.status !== "ok"
    || exitCode !== 0
    || !hasExactKeys(report, ["schemaVersion", "status", "fingerprint", "installedAt"])
    || typeof report.fingerprint !== "string"
    || !BUILD_MARKER_FINGERPRINT_PATTERN.test(report.fingerprint)
    || !isValidIsoInstant(report.installedAt)) {
    return { status: "malformed" };
  }
  return { status: "ok", fingerprint: report.fingerprint, installedAt: report.installedAt };
}

export function parseProcessStart(text, exitCode) {
  if (exitCode !== 0 || typeof text !== "string") {
    return { ran: false };
  }
  const value = text.trim().replace(/\s+/gu, " ");
  const match = PROCESS_START_PATTERN.exec(value);
  if (match === null) {
    return { ran: false };
  }
  const month = PROCESS_MONTH_INDEX.get(match[2]);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const year = Number.parseInt(match[7], 10);
  if (month === undefined || year < 1000 || year > 9999
    || day < 1 || day > daysInMonth(year, month + 1)
    || hour > 23 || minute > 59 || second > 59) {
    return { ran: false };
  }
  const startedAtMs = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(startedAtMs);
  if (!Number.isFinite(startedAtMs)
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month
    || parsed.getUTCDate() !== day
    || PROCESS_WEEKDAYS[parsed.getUTCDay()] !== match[1]) {
    return { ran: false };
  }
  return { ran: true, startedAtMs };
}

export function evaluateLoaded(loaded, service, runtime, expected = {}) {
  if (!service || typeof service.pid !== "number") {
    return { status: "fail", note: "running process required" };
  }
  if (!loaded || loaded.ran !== true) {
    return { status: "fail", note: "loaded-code probe unavailable" };
  }
  if (loaded.checkoutUnavailable === true) {
    return { status: "fail", note: "deploy checkout unavailable" };
  }
  if (loaded.launchDefinitionInitial?.timedOut === true) {
    return { status: "fail", note: "loaded launch definition probe timed out" };
  }
  if (loaded.launchDefinitionInitial?.status !== "ok") {
    return { status: "fail", note: "loaded launch definition unavailable" };
  }
  if (loaded.processStart?.timedOut === true) {
    return { status: "fail", note: "process start probe timed out" };
  }
  if (loaded.processStart?.ran !== true) {
    return { status: "fail", note: "process start unavailable" };
  }
  if (loaded.processIdentity?.timedOut === true) {
    return { status: "fail", note: "process identity probe timed out" };
  }
  if (loaded.processIdentity?.ran !== true) {
    return { status: "fail", note: "process identity unavailable" };
  }
  if (loaded.managed !== true && loaded.processIdentity.argvMatches !== true) {
    return { status: "fail", note: "process arguments do not match plist" };
  }
  if (loaded.processIdentity.executableMatches !== true) {
    return { status: "fail", note: "process executable does not match plist" };
  }
  if (loaded.processIdentity.cwdMatches !== true) {
    return { status: "fail", note: "process working directory does not match plist" };
  }
  if (typeof loaded.checkoutInitial?.error === "string") {
    const timedOut = loaded.checkoutInitial.error === "checkout probe timed out";
    const changed = loaded.checkoutInitial.error === "checkout changed during probe";
    return {
      status: "fail",
      note: timedOut ? "checkout probe timed out" : changed ? "checkout changed during probe" : "checkout probe unavailable",
    };
  }
  if (loaded.checkoutInitial?.clean !== true) {
    return { status: "fail", note: "deploy checkout dirty" };
  }
  if (loaded.markerInitial?.timedOut === true) {
    return { status: "fail", note: "build marker probe timed out" };
  }
  if (loaded.markerInitial?.status !== "ok") {
    const notes = {
      missing: "build marker missing",
      unsafe: "build marker unsafe",
      malformed: "build marker malformed",
    };
    return { status: "fail", note: notes[loaded.markerInitial?.status] ?? "build marker malformed" };
  }
  if (loaded.managed === true) {
    if (loaded.runtimeAttestationInitial?.timedOut === true) {
      return { status: "fail", note: "managed runtime attestation timed out" };
    }
    if (loaded.runtimeAttestationInitial?.status !== "ok") {
      return { status: "fail", note: "managed runtime attestation failed" };
    }
  }
  if (loaded.serviceRecheck?.timedOut === true) {
    return { status: "fail", note: "service recheck timed out" };
  }
  if (loaded.serviceRecheck?.found !== service.found
    || loaded.serviceRecheck?.pid !== service.pid
    || loaded.serviceRecheck?.lastExitStatus !== service.lastExitStatus) {
    return { status: "fail", note: "service changed during probe" };
  }
  if (loaded.launchDefinitionInitial?.timedOut === true
    || loaded.launchDefinitionFinal?.timedOut === true
    || loaded.launchDefinitionTerminal?.timedOut === true) {
    return { status: "fail", note: "loaded launch definition probe timed out" };
  }
  if (loaded.launchDefinitionInitial?.status !== "ok"
    || loaded.launchDefinitionFinal?.status !== "ok"
    || loaded.launchDefinitionTerminal?.status !== "ok") {
    return { status: "fail", note: "loaded launch definition unavailable" };
  }
  if (loaded.launchDefinitionInitial.fingerprint !== loaded.launchDefinitionFinal.fingerprint
    || loaded.launchDefinitionFinal.fingerprint !== loaded.launchDefinitionTerminal.fingerprint) {
    return { status: "fail", note: "loaded launch definition changed during probe" };
  }
  if (loaded.managed === true) {
    if (loaded.runtimeAttestationInitial?.timedOut === true || loaded.runtimeAttestationFinal?.timedOut === true) {
      return { status: "fail", note: "managed runtime attestation timed out" };
    }
    if (loaded.runtimeAttestationInitial?.status !== "ok"
      || loaded.runtimeAttestationFinal?.status !== "ok") {
      return { status: "fail", note: "managed runtime attestation failed" };
    }
    if (loaded.runtimeAttestationInitial.fingerprint !== loaded.runtimeAttestationFinal.fingerprint) {
      return { status: "fail", note: "managed runtime changed during probe" };
    }
    if (loaded.runtimeAttestationInitial.installedAt !== loaded.runtimeAttestationFinal.installedAt) {
      return { status: "fail", note: "managed runtime install changed during probe" };
    }
  }
  if (loaded.markerInitial?.timedOut === true || loaded.markerFinal?.timedOut === true) {
    return { status: "fail", note: "build marker probe timed out" };
  }
  if (typeof loaded.checkoutInitial?.error === "string" || typeof loaded.checkoutFinal?.error === "string") {
    const timedOut = loaded.checkoutInitial?.error === "checkout probe timed out"
      || loaded.checkoutFinal?.error === "checkout probe timed out";
    const changed = loaded.checkoutInitial?.error === "checkout changed during probe"
      || loaded.checkoutFinal?.error === "checkout changed during probe";
    return {
      status: "fail",
      note: timedOut ? "checkout probe timed out" : changed ? "checkout changed during probe" : "checkout probe unavailable",
    };
  }
  const initialMarker = loaded.markerInitial;
  const finalMarker = loaded.markerFinal;
  if (!initialMarker || !finalMarker
    || initialMarker.status !== finalMarker.status
    || (initialMarker.status === "ok"
      && (initialMarker.fingerprint !== finalMarker.fingerprint
        || initialMarker.outputDigest !== finalMarker.outputDigest
        || initialMarker.dependencyDigest !== finalMarker.dependencyDigest))) {
    return { status: "fail", note: "build changed during probe" };
  }
  if (initialMarker.status !== "ok") {
    const notes = {
      missing: "build marker missing",
      unsafe: "build marker unsafe",
      malformed: "build marker malformed",
    };
    return { status: "fail", note: notes[initialMarker.status] ?? "build marker malformed" };
  }
  if (typeof loaded.checkoutInitial?.sha !== "string" || typeof loaded.checkoutFinal?.sha !== "string") {
    return { status: "fail", note: "checkout sha unavailable" };
  }
  if (loaded.checkoutInitial.sha !== loaded.checkoutFinal.sha) {
    return { status: "fail", note: "checkout changed during probe" };
  }
  if (loaded.checkoutInitial.clean !== true || loaded.checkoutFinal.clean !== true) {
    return { status: "fail", note: "deploy checkout dirty" };
  }
  if (initialMarker.marker.sourceState !== "clean") {
    return { status: "fail", note: "build source not clean" };
  }
  if (initialMarker.marker.gitSha !== loaded.checkoutInitial.sha) {
    return { status: "fail", note: "build marker sha mismatch" };
  }
  if (initialMarker.outputDigest !== initialMarker.marker.outputDigest
    || finalMarker.outputDigest !== finalMarker.marker.outputDigest) {
    return { status: "fail", note: "build output digest mismatch" };
  }
  if (initialMarker.dependencyDigest !== initialMarker.marker.dependencyDigest
    || finalMarker.dependencyDigest !== finalMarker.marker.dependencyDigest) {
    return { status: "fail", note: "build dependency digest mismatch" };
  }
  if (loaded.plistRecheck?.timedOut === true) {
    return { status: "fail", note: "plist recheck timed out" };
  }
  if (loaded.plistRecheck?.status !== "ok"
    || loaded.plistRecheck.fingerprint !== loaded.plistFingerprint
    || loaded.plistRecheck.shapeFingerprint !== loaded.plistShapeFingerprint) {
    return { status: "fail", note: "launchd plist changed during probe" };
  }
  if (typeof expected.expectSha === "string"
    && (loaded.checkoutInitial.sha !== expected.expectSha
      || initialMarker.marker.gitSha !== expected.expectSha)) {
    return { status: "fail", note: `loaded sha ${shortSha(loaded.checkoutInitial.sha)} != expected ${shortSha(expected.expectSha)}` };
  }
  if (!runtime || runtime.ran !== true
    || initialMarker.marker.nodeVersion !== runtime.node
    || initialMarker.marker.nodeAbi !== runtime.abi) {
    return { status: "fail", note: "build/runtime mismatch" };
  }
  if (loaded.processStart?.timedOut === true) {
    return { status: "fail", note: "process start probe timed out" };
  }
  if (loaded.processStart?.ran !== true) {
    return { status: "fail", note: "process start unavailable" };
  }
  if (loaded.processIdentity?.timedOut === true) {
    return { status: "fail", note: "process identity probe timed out" };
  }
  if (loaded.processIdentity?.ran !== true) {
    return { status: "fail", note: "process identity unavailable" };
  }
  if (loaded.managed !== true && loaded.processIdentity.argvMatches !== true) {
    return { status: "fail", note: "process arguments do not match plist" };
  }
  if (loaded.managed === true && loaded.processIdentity.executableMatches !== true) {
    return { status: "fail", note: "process executable does not match plist" };
  }
  if (loaded.processIdentity.cwdMatches !== true) {
    return { status: "fail", note: "process working directory does not match plist" };
  }
  if (loaded.processStart.startedAtMs <= Date.parse(initialMarker.marker.completedAt)) {
    return { status: "fail", note: "process predates build" };
  }
  if (loaded.managed === true
    && loaded.processStart.startedAtMs <= Math.floor(
      Date.parse(loaded.runtimeAttestationInitial.installedAt) / 1_000,
    ) * 1_000) {
    return { status: "fail", note: "process predates managed runtime" };
  }
  return { status: "pass", note: "" };
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
  return typeof label === "string" && LABEL_PATTERN.test(label)
    ? label.slice(LABEL_PREFIX.length)
    : "invalid-label";
}

export function shortSha(sha) {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : "unknown";
}

export function evaluateRuntime(runtime, expected = {}) {
  if (runtime?.timedOut === true) {
    return { status: "fail", note: "runtime probe timed out" };
  }
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
  if (service?.timedOut === true) {
    return { status: "fail", note: "service probe timed out" };
  }
  if (!service || service.found !== true) {
    return { status: "fail", note: "service not found" };
  }
  if (typeof service.pid === "number") {
    return { status: "pass", note: `running (pid ${service.pid})` };
  }
  return { status: "fail", note: `not running (last exit ${service.lastExitStatus ?? "?"})` };
}

function evaluateValidate(validate) {
  if (validate?.timedOut === true) {
    return { status: "fail", note: "validate command timed out" };
  }
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
      && BUJO_MEMORY_STATUSES.has(report.status)
      && report.status === deriveBuiltInMemoryStatus(report.issues)
      && hasValidBuiltInCountSemantics(report.mode, report.issues, report.counts);
  }
  if (report.backend === "none") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "not_configured"
      && report.issues.length === 0
      && hasOnlyZeroMemoryCounts(report.counts);
  }
  if (report.backend === "supermemory") {
    return hasExactKeys(report, MEMORY_REPORT_KEYS_WITHOUT_MODE)
      && report.status === "unknown"
      && report.issues.length === 0
      && hasOnlyZeroMemoryCounts(report.counts);
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

function hasOnlyZeroMemoryCounts(counts) {
  return MEMORY_COUNT_KEYS.every((key) => counts[key] === 0);
}

function deriveBuiltInMemoryStatus(issues) {
  if (issues.some((issue) => MEMORY_UNKNOWN_ISSUES.has(issue))) return "unknown";
  if (issues.some((issue) => MEMORY_UNHEALTHY_ISSUES.has(issue))) return "unhealthy";
  if (issues.some((issue) => MEMORY_DEGRADED_ISSUES.has(issue))) return "degraded";
  return issues.length === 0 ? "healthy" : "in_progress";
}

function hasValidBuiltInCountSemantics(mode, issues, counts) {
  const has = (issue) => issues.includes(issue);
  if (counts.due > counts.pending
    || has("intake_pending") !== (counts.pending > 0)
    || has("dead_letters") !== (counts.dead > 0)
    || has("outbox_pending") !== (counts.outbox > 0)
    || has("temporary_artifacts") !== (counts.temporary > 0)) {
    return false;
  }
  if (counts.outbox > 0 && !has("mutation_in_progress")) return false;

  const expectedMissingVectors = mode === "lite" ? 0 : Math.max(0, counts.memories - counts.vectors);
  if (counts.missingVectors !== expectedMissingVectors) return false;
  if (mode === "journal" && counts.missingVectors > 0 && !has("mutation_in_progress")) return false;
  if (mode === "bujo" && counts.vectors !== counts.memories && !has("vector_mismatch")) return false;
  if (mode === "lite" && counts.vectors !== 0 && !has("vector_mismatch")) return false;
  if (counts.vectors > counts.memories && !has("vector_mismatch")) return false;
  return true;
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
  if (memory?.timedOut === true) {
    return { status: "fail", memoryStatus: "malformed", note: "memory audit timed out" };
  }
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
  const {
    date,
    deployedSha,
    deployedShaError,
    fleetLabelError,
    expectSha,
    expectNode,
    expectAbi,
    strictRuns,
    minRuns,
  } = input;
  const rows = input.instances.map((instance) => {
    const name = instanceName(instance.label);
    // A plist that matched the prefix but could not be read is an unknown
    // config the fleet may be running blind — RED, never silently dropped.
    if (typeof instance.discoveryError === "string") {
      const service = {
        status: "fail",
        note: instance.discoveryError === "plist probe timed out" ? "plist probe timed out" : "plist unreadable",
      };
      const skipped = { status: "skip", note: "" };
      return {
        name,
        label: instance.label,
        service,
        loaded: skipped,
        runtime: skipped,
        validate: skipped,
        memory: { ...skipped, memoryStatus: "malformed" },
        runs: skipped,
        notes: service.note,
      };
    }
    const service = evaluateService(instance.service);
    const runtime = evaluateRuntime(instance.runtime, { expectNode, expectAbi });
    const loaded = evaluateLoaded(instance.loaded, instance.service, instance.runtime, { expectSha });
    const validate = evaluateValidate(instance.validate);
    const memory = evaluateMemory(instance.memory);
    const runs = evaluateRuns(instance.metrics, { strictRuns, minRuns });
    const notes = [
      service.status !== "pass" ? service.note : null,
      loaded.status === "fail" ? loaded.note : null,
      runtime.status !== "pass" ? runtime.note : null,
      validate.status !== "pass" ? validate.note : null,
      memory.status !== "pass" ? memory.note : null,
      runs.note || null,
    ]
      .filter((note) => note !== null && note !== "")
      .join("; ");
    return { name, label: instance.label, service, loaded, runtime, validate, memory, runs, notes };
  });

  let reason = typeof fleetLabelError === "string" ? fleetLabelError : null;
  if (reason === null) {
    for (const row of rows) {
      if (row.service.status === "fail") {
        reason = `${row.name}: ${row.service.note}`;
        break;
      }
      if (row.loaded.status === "fail"
        && !(row.loaded.note === "build/runtime mismatch" && row.runtime.status === "fail")) {
        reason = `${row.name}: ${row.loaded.note}`;
        break;
      }
      if (row.runtime.status === "fail") {
        reason = `${row.name}: ${row.runtime.note}`;
        break;
      }
      if (row.loaded.status === "fail") {
        reason = `${row.name}: ${row.loaded.note}`;
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
  }

  const shaKnown = typeof deployedSha === "string" && deployedSha.length >= 7;
  if (reason === null && typeof deployedShaError === "string") {
    reason = deployedShaError;
  }
  if (reason === null && typeof expectSha === "string" && expectSha.length > 0) {
    if (!shaKnown || deployedSha !== expectSha) {
      reason = `deployed sha ${shortSha(deployedSha)} != expected ${shortSha(expectSha)}`;
    }
  }
  if (reason === null) {
    const checkoutShas = new Set(input.instances
      .map((instance) => instance.loaded?.checkoutInitial?.sha)
      .filter((sha) => typeof sha === "string"));
    if (checkoutShas.size > 1) {
      reason = `instances span ${checkoutShas.size} deploy revisions`;
    } else if (shaKnown && checkoutShas.size === 1 && !checkoutShas.has(deployedSha)) {
      reason = `deployed sha ${shortSha(deployedSha)} differs from loaded checkout`;
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
  const header = "| instance | service | loaded | runtime | validate | memory | runs-24h | notes |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map((row) => {
    const notes = row.notes.length > 0 ? row.notes.replace(/\|/gu, "\\|") : "";
    return `| ${row.name} | ${CELL[row.service.status]} | ${CELL[row.loaded.status]} | ${CELL[row.runtime.status]} | ${CELL[row.validate.status]} | ${row.memory.memoryStatus} | ${CELL[row.runs.status]} | ${notes} |`;
  });
  return [header, divider, ...lines].join("\n");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function managedPlistTopologyFingerprint(entries) {
  if (!Array.isArray(entries)) return null;
  const managed = entries
    .filter((entry) => typeof entry === "string" && entry.startsWith(LABEL_PREFIX) && entry.endsWith(".plist"))
    .toSorted();
  return sha256(JSON.stringify(managed));
}

function readValidatedLaunchdPlist(plistPath, filenameLabel, runCommand, inspectPath) {
  const directoryPath = dirname(plistPath);
  const directoryInitial = inspectPath(directoryPath, "directory");
  const plistInitial = inspectPath(plistPath, "plist");
  if (directoryInitial === null || plistInitial === null) return { status: "unavailable" };
  const result = runCommand(PLUTIL, ["-convert", "json", "-o", "-", plistPath], {
    timeout: COMMAND_TIMEOUT_MS.plist,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) return { status: "unavailable", timedOut: true };
  if (result.status !== 0 || typeof result.stdout !== "string") return { status: "unavailable" };
  const directoryFinal = inspectPath(directoryPath, "directory");
  const plistFinal = inspectPath(plistPath, "plist");
  if (directoryFinal !== directoryInitial || plistFinal !== plistInitial) {
    return { status: "unavailable" };
  }

  const plist = parseJsonObject(result.stdout);
  if (plist === null || typeof plist.Label !== "string" || plist.Label !== filenameLabel) {
    return { status: "unavailable" };
  }
  const dir = typeof plist.WorkingDirectory === "string"
    && !/[\u0000-\u001f\u007f]/u.test(plist.WorkingDirectory)
    && isAbsolute(plist.WorkingDirectory)
    ? plist.WorkingDirectory
    : null;
  const program = parseLaunchdProgramArguments(plist.ProgramArguments);
  const managedPathEnv = program?.pathEnv;
  const pathEnv = managedPathEnv
    ?? parseLaunchdPathEnvironment(plist.EnvironmentVariables);
  if (program === null || pathEnv === null || dir === null) return { status: "unavailable" };
  if (typeof program.configPath !== "string"
    || deriveLaunchdLabel(program.configPath) !== filenameLabel) {
    return { status: "unavailable" };
  }
  // Current managed plists carry their closed environment exclusively inside
  // `/usr/bin/env -i`; accepting a second environment source would weaken the
  // exact process/environment proof.
  if (managedPathEnv !== undefined && plist.EnvironmentVariables !== undefined) {
    return { status: "unavailable" };
  }
  if (program.managed === true
    ? !isExactManagedPlist(plist, plistPath, filenameLabel)
    : !isExactLegacyPlist(plist, plistPath, filenameLabel)) {
    return { status: "unavailable" };
  }

  const closedShape = {
    label: filenameLabel,
    plistPath,
    dir,
    pathEnv,
    stdoutPath: plist.StandardOutPath,
    stderrPath: plist.StandardErrorPath,
    ...program,
  };
  return {
    status: "ok",
    fingerprint: sha256(JSON.stringify({
      converted: result.stdout,
      directoryIdentity: directoryFinal,
      plistIdentity: plistFinal,
    })),
    shapeFingerprint: sha256(JSON.stringify(closedShape)),
    entry: closedShape,
  };
}

export function inspectCanonicalLaunchdPath(path, kind) {
  try {
    const details = lstatSync(path, { bigint: true });
    const currentUid = typeof process.getuid === "function" ? BigInt(process.getuid()) : details.uid;
    const mode = Number(details.mode & 0o777n);
    if (details.uid !== currentUid || details.isSymbolicLink()) return null;
    if (kind === "directory") {
      if (!details.isDirectory() || (mode & 0o077) !== 0) return null;
    } else if (!details.isFile() || details.nlink !== 1n || mode !== 0o600) {
      return null;
    }
    return sha256(JSON.stringify({
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      mode: details.mode.toString(),
      nlink: details.nlink.toString(),
      size: details.size.toString(),
      mtimeNs: details.mtimeNs.toString(),
      ctimeNs: details.ctimeNs.toString(),
    }));
  } catch {
    return null;
  }
}

function inspectExecutablePath(path) {
  try {
    const details = lstatSync(path, { bigint: true });
    if (!details.isFile() || details.isSymbolicLink()) return null;
    const identity = {
      device: details.dev.toString(),
      inode: details.ino.toString(),
    };
    return {
      ...identity,
      fingerprint: sha256(JSON.stringify({
        ...identity,
        mode: details.mode.toString(),
        size: details.size.toString(),
        mtimeNs: details.mtimeNs.toString(),
        ctimeNs: details.ctimeNs.toString(),
      })),
    };
  } catch {
    return null;
  }
}

function isExactManagedPlist(plist, plistPath, label) {
  const paths = canonicalLaunchdPaths(plistPath, label);
  return hasExactKeys(plist, MANAGED_PLIST_KEYS)
    && paths !== null
    && hasExactLaunchdLifecycle(plist, paths);
}

function isExactLegacyPlist(plist, plistPath, label) {
  const paths = canonicalLaunchdPaths(plistPath, label);
  return hasExactKeys(plist, [...MANAGED_PLIST_KEYS, "EnvironmentVariables"])
    && paths !== null
    && hasExactLaunchdLifecycle(plist, paths);
}

function hasExactLaunchdLifecycle(plist, paths) {
  return plist.RunAtLoad === true
    && isRecord(plist.KeepAlive)
    && hasExactKeys(plist.KeepAlive, ["SuccessfulExit"])
    && plist.KeepAlive.SuccessfulExit === false
    && plist.ProcessType === "Interactive"
    && plist.ThrottleInterval === 10
    && plist.StandardOutPath === paths.stdoutPath
    && plist.StandardErrorPath === paths.stderrPath;
}

function canonicalLaunchdPaths(plistPath, label) {
  if (typeof plistPath !== "string" || !isAbsolute(plistPath)) return null;
  const launchAgentsDir = dirname(plistPath);
  const libraryDir = dirname(launchAgentsDir);
  const home = dirname(libraryDir);
  if (basename(launchAgentsDir) !== "LaunchAgents"
    || basename(libraryDir) !== "Library"
    || plistPath !== join(home, "Library", "LaunchAgents", `${label}.plist`)) return null;
  return {
    stdoutPath: join(home, ".mono-agent", "logs", `${label}.out.log`),
    stderrPath: join(home, ".mono-agent", "logs", `${label}.err.log`),
  };
}

export function deriveLaunchdLabel(configPath) {
  const resolved = resolve(configPath);
  const folder = basename(dirname(resolved))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_LABEL_FOLDER_SEGMENT)
    .replace(/-+$/gu, "");
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${LABEL_PREFIX}${folder.length === 0 ? "agent" : folder}-${hash}`;
}

// ---------------------------------------------------------------------------
// Impure layer (thin, untested-live).
// ---------------------------------------------------------------------------

function discoverInstances(launchAgentsDir, runCommand, readdir, inspectPath) {
  const byLabel = new Map();
  let invalidLabelIndex = 0;
  let entries;
  try {
    entries = readdir(launchAgentsDir);
  } catch {
    return { byLabel, topologyFingerprint: null };
  }
  const reservedLabels = new Set(entries
    .filter((entry) => typeof entry === "string" && entry.endsWith(".plist"))
    .map((entry) => entry.slice(0, -".plist".length))
    .filter((label) => LABEL_PATTERN.test(label)));
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.startsWith(LABEL_PREFIX) || !entry.endsWith(".plist")) {
      continue;
    }
    const plistPath = join(launchAgentsDir, entry);
    const filenameLabel = entry.slice(0, -".plist".length);
    if (!LABEL_PATTERN.test(filenameLabel)) {
      let closedLabel;
      do {
        invalidLabelIndex += 1;
        closedLabel = `${LABEL_PREFIX}invalid-plist-${invalidLabelIndex}`;
      } while (reservedLabels.has(closedLabel) || byLabel.has(closedLabel));
      byLabel.set(closedLabel, {
        label: closedLabel,
        dir: null,
        nodePath: null,
        cliPath: null,
        discoveryError: "plist label invalid",
      });
      continue;
    }
    const validated = readValidatedLaunchdPlist(plistPath, filenameLabel, runCommand, inspectPath);
    if (validated.timedOut === true) {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, nodePath: null, cliPath: null, discoveryError: "plist probe timed out" });
      continue;
    }
    if (validated.status !== "ok") {
      byLabel.set(filenameLabel, {
        label: filenameLabel,
        dir: null,
        nodePath: null,
        cliPath: null,
        probeArgs: [],
        discoveryError: "plist invalid",
      });
      continue;
    }
    byLabel.set(filenameLabel, {
      ...validated.entry,
      plistFingerprint: validated.fingerprint,
      plistShapeFingerprint: validated.shapeFingerprint,
    });
  }
  return { byLabel, topologyFingerprint: managedPlistTopologyFingerprint(entries) };
}

/**
 * Accept only the current hardened launchd shape emitted by buildPlistXml plus
 * legacy direct-Node plists. Unknown environment names, duplicate assignments,
 * unknown flags, relative paths, and missing values fail the instance closed.
 * Managed environment values are retained only for exact child-probe execution
 * and never rendered. Legacy direct-Node arguments remain whitespace-free;
 * managed arguments are compared structurally through launchctl print.
 */
export function parseLaunchdProgramArguments(value) {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || /[\u0000-\u001f\u007f]/u.test(entry))) return null;

  if (value[0] === ENV) {
    return parseManagedLaunchdProgramArguments(value);
  }
  if (value.some((entry) => /\s/u.test(entry))) return null;
  const parsed = parseLaunchdWorkerInvocation(value, false);
  return parsed === null || !sameOrderedStrings(value, canonicalWorkerArguments(parsed, false)) ? null : {
    ...parsed,
    managed: false,
    launchdProgramArguments: [...value],
    programArguments: [...value],
  };
}

function parseManagedLaunchdProgramArguments(value) {
  if (value[1] !== "-i") return null;
  const environment = new Map();
  const names = [];
  let index = 2;
  while (index < value.length && !isAbsolute(value[index])) {
    const assignment = value[index];
    const separator = assignment.indexOf("=");
    if (separator <= 0) return null;
    const name = assignment.slice(0, separator);
    const environmentValue = assignment.slice(separator + 1);
    if (!MANAGED_BACKGROUND_ENV_NAMES.has(name) || environment.has(name)) return null;
    environment.set(name, environmentValue);
    names.push(name);
    index += 1;
  }
  if (names.some((name, position) => position > 0 && compareCodeUnits(names[position - 1], name) > 0)) {
    return null;
  }
  const pathEnv = environment.get("PATH");
  if (typeof pathEnv !== "string" || pathEnv.length === 0
    || environment.get(MANAGED_BACKGROUND_WORKER_ENV) !== "1") return null;

  const workerArguments = value.slice(index);
  const parsed = parseLaunchdWorkerInvocation(workerArguments, true);
  const managedEnvironment = Object.fromEntries(environment);
  delete managedEnvironment[MANAGED_BACKGROUND_WORKER_ENV];
  return parsed === null
    || !sameOrderedStrings(workerArguments, canonicalWorkerArguments(parsed, true)) ? null : {
    ...parsed,
    // `/usr/bin/env` execs Node in place. ps therefore exposes the worker argv,
    // while the persisted plist fingerprint separately proves the wrapper.
    programArguments: workerArguments,
    launchdProgramArguments: [...value],
    managed: true,
    managedEnvironment,
    pathEnv,
  };
}

function canonicalWorkerArguments(parsed, managed) {
  return [
    parsed.nodePath,
    parsed.cliPath,
    "start",
    "--foreground",
    "--config",
    parsed.configPath,
    ...(parsed.envFile === undefined ? [] : ["--env-file", parsed.envFile]),
    ...(managed ? ["--expected-background-snapshot", parsed.expectedBackgroundSnapshot] : []),
  ];
}

function sameOrderedStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseLaunchdWorkerInvocation(value, managed) {
  const [nodePath, cliPath, command, ...tail] = value;
  if (typeof nodePath !== "string" || nodePath.includes("\0") || !isAbsolute(nodePath)
    || typeof cliPath !== "string" || cliPath.includes("\0")
    || !isAbsolute(cliPath) || !cliPath.endsWith("cli.js")
    || command !== "start") {
    return null;
  }

  let foreground = false;
  let configPath;
  let envFile;
  let expectedBackgroundSnapshot;
  for (let index = 0; index < tail.length; index += 1) {
    const flag = tail[index];
    if (flag === "--foreground") {
      if (foreground) return null;
      foreground = true;
      continue;
    }
    if (flag === "--expected-background-snapshot") {
      const snapshot = tail[index + 1];
      if (!managed || expectedBackgroundSnapshot !== undefined
        || typeof snapshot !== "string" || !/^[A-Za-z0-9_-]+$/u.test(snapshot)) return null;
      expectedBackgroundSnapshot = snapshot;
      index += 1;
      continue;
    }
    if (flag !== "--config" && flag !== "--env-file") return null;
    const path = tail[index + 1];
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) return null;
    index += 1;
    if (flag === "--config") {
      if (configPath !== undefined) return null;
      configPath = path;
    } else {
      if (envFile !== undefined) return null;
      envFile = path;
    }
  }
  if (managed && (!foreground || configPath === undefined || expectedBackgroundSnapshot === undefined)) {
    return null;
  }

  return {
    nodePath,
    cliPath,
    configPath,
    envFile,
    expectedBackgroundSnapshot,
    probeArgs: [
      ...(configPath === undefined ? [] : ["--config", configPath]),
      ...(envFile === undefined ? [] : ["--env-file", envFile]),
    ],
  };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Legacy direct-Node plists carry only PATH in EnvironmentVariables. */
export function parseLaunchdPathEnvironment(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["PATH"])) return null;
  return typeof value.PATH === "string" && value.PATH.length > 0 && !value.PATH.includes("\0")
    ? value.PATH
    : null;
}

function collectInstance(
  entry,
  since,
  runCommand,
  initialMarkerProbes,
  deployRepo,
  trustedNodePath,
  inspectExecutable,
) {
  if (typeof entry.discoveryError === "string") {
    const service = launchctlList(entry.label, runCommand);
    return {
      label: entry.label,
      dir: null,
      discoveryError: entry.discoveryError,
      service,
      loaded: { ran: false },
      runtime: { ran: false },
      validate: { ran: false },
      memory: { ran: false },
      metrics: { ran: false },
    };
  }
  const service = launchctlList(entry.label, runCommand);
  const repo = repoForEntry(entry, deployRepo);
  const probeEnvironment = probeEnvironmentForEntry(entry);
  let runtime = { ran: false };
  const persistedPlist = {
    plistFingerprint: entry.plistFingerprint,
    plistShapeFingerprint: entry.plistShapeFingerprint,
    managed: entry.managed === true,
  };
  let loaded = { ran: false, ...persistedPlist };
  if (typeof service.pid === "number") {
    if (repo === null || entry.nodePath === null || probeEnvironment === null) {
      loaded = { ran: true, checkoutUnavailable: true, ...persistedPlist };
    } else {
      const checkoutInitial = readDeployCheckout(repo, runCommand);
      const launchDefinitionInitial = launchctlPrint(entry, service.pid, runCommand);
      const processStart = runProcessStartProbe(service.pid, runCommand);
      const processIdentity = runProcessIdentityProbe(
        service.pid,
        entry.programArguments,
        entry.dir,
        entry.nodePath,
        entry.managed,
        inspectExecutable,
        runCommand,
      );
      const initialExecutionBoundaryApproved = isInitialExecutionBoundaryApproved(
        entry,
        checkoutInitial,
        launchDefinitionInitial,
        processIdentity,
      );
      const markerInitial = initialExecutionBoundaryApproved
        ? runCachedBuildMarkerProbe(
            initialMarkerProbes,
            trustedNodePath,
            repo,
            probeEnvironment,
            runCommand,
          )
        : { status: "unsafe" };
      if (initialExecutionBoundaryApproved
        && isDeployExecutionApproved(checkoutInitial, markerInitial)) {
        runtime = runRuntimeProbe(entry.nodePath, probeEnvironment, runCommand);
      }
      const deployExecutionApproved = initialExecutionBoundaryApproved
        && isDeployExecutionApproved(checkoutInitial, markerInitial, runtime);
      loaded = {
        ran: true,
        ...persistedPlist,
        initialExecutionBoundaryApproved,
        markerInitial,
        ...(entry.managed === true ? {
          runtimeAttestationInitial: deployExecutionApproved
            ? runManagedRuntimeAttestation(entry, repo, runtime, probeEnvironment, trustedNodePath, runCommand)
            : { status: "unsafe" },
        } : {}),
        checkoutInitial,
        launchDefinitionInitial,
        processStart,
        processIdentity,
      };
    }
  }
  let validate = { ran: false };
  let memory = { ran: false };
  let metrics = { ran: false };
  if (entry.dir !== null
    && entry.nodePath !== null
    && entry.cliPath !== null
    && probeEnvironment !== null
    && isCliExecutionApproved(entry, loaded, runtime)) {
    const probeArgs = Array.isArray(entry.probeArgs) ? entry.probeArgs : [];
    validate = runValidate(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, runCommand);
    memory = runMemoryAudit(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, runCommand);
    metrics = runMetrics(entry.nodePath, entry.cliPath, entry.dir, probeEnvironment, probeArgs, since, runCommand);
  }
  return { label: entry.label, dir: entry.dir, service, loaded, runtime, validate, memory, metrics };
}

function isCliExecutionApproved(entry, loaded, runtime) {
  return loaded.ran === true
    && loaded.initialExecutionBoundaryApproved === true
    && loaded.launchDefinitionInitial?.status === "ok"
    && isDeployExecutionApproved(loaded.checkoutInitial, loaded.markerInitial, runtime)
    && (entry.managed !== true || loaded.runtimeAttestationInitial?.status === "ok");
}

function isInitialExecutionBoundaryApproved(
  entry,
  checkout,
  launchDefinition,
  processIdentity,
) {
  return checkout?.error === null
    && checkout.clean === true
    && typeof checkout.sha === "string"
    && launchDefinition?.status === "ok"
    && processIdentity?.ran === true
    && processIdentity.cwdMatches === true
    && processIdentity.executableMatches === true
    && (entry.managed === true || processIdentity.argvMatches === true);
}

function isDeployExecutionApproved(checkout, marker, runtime) {
  return marker?.status === "ok"
    && marker.marker?.sourceState === "clean"
    && marker.outputDigest === marker.marker.outputDigest
    && marker.dependencyDigest === marker.marker.dependencyDigest
    && typeof checkout?.sha === "string"
    && checkout.error === null
    && checkout.clean === true
    && checkout.sha === marker.marker.gitSha
    && (runtime === undefined
      || (runtime.ran === true
        && runtime.node === marker.marker.nodeVersion
        && runtime.abi === marker.marker.nodeAbi));
}

function repoForEntry(entry, deployRepo) {
  return entry.managed === true ? deployRepo : deriveRepoFromCliPath(entry.cliPath);
}

function probeEnvironmentForEntry(entry) {
  if (entry.managed === true) {
    return isRecord(entry.managedEnvironment) ? { ...entry.managedEnvironment } : null;
  }
  return typeof entry.pathEnv === "string" ? buildLaunchdProbeEnvironment(entry.pathEnv) : null;
}

function launchctlList(label, runCommand) {
  const result = runCommand(LAUNCHCTL, ["list", label], {
    timeout: COMMAND_TIMEOUT_MS.service,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) {
    return { found: false, pid: null, lastExitStatus: null, timedOut: true };
  }
  return parseLaunchctlList(result.stdout ?? "", result.status);
}

export function parseLaunchctlPrint(text, exitCode, expected) {
  if (exitCode !== 0 || typeof text !== "string" || !isRecord(expected)) {
    return { status: "unavailable" };
  }
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const oneValue = (name) => {
    const prefix = `\t${name} = `;
    const matches = lines.filter((line) => line.startsWith(prefix));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(prefix.length);
    return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
  };
  const blockStarts = lines
    .map((line, index) => line === "\targuments = {" ? index : -1)
    .filter((index) => index >= 0);
  if (blockStarts.length !== 1) return { status: "unavailable" };
  const blockStart = blockStarts[0];
  const blockEnd = lines.indexOf("\t}", blockStart + 1);
  if (blockEnd <= blockStart + 1) return { status: "unavailable" };
  const args = lines.slice(blockStart + 1, blockEnd).map((line) =>
    line.startsWith("\t\t") ? line.slice(2) : null);
  if (args.some((arg) => typeof arg !== "string" || arg.length === 0 || /[\u0000-\u001f\u007f]/u.test(arg))) {
    return { status: "unavailable" };
  }
  const path = oneValue("path");
  const program = oneValue("program");
  const workingDirectory = oneValue("working directory");
  const stdoutPath = oneValue("stdout path");
  const stderrPath = oneValue("stderr path");
  const pidText = oneValue("pid");
  const pid = typeof pidText === "string" && /^\d+$/u.test(pidText) ? Number(pidText) : Number.NaN;
  if (path !== expected.plistPath
    || program !== expected.launchdProgramArguments?.[0]
    || workingDirectory !== expected.dir
    || stdoutPath !== expected.stdoutPath
    || stderrPath !== expected.stderrPath
    || !Number.isSafeInteger(pid)
    || pid !== expected.pid
    || !Array.isArray(expected.launchdProgramArguments)
    || args.length !== expected.launchdProgramArguments.length
    || args.some((arg, index) => arg !== expected.launchdProgramArguments[index])) {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    fingerprint: sha256(JSON.stringify({ path, program, args, workingDirectory, stdoutPath, stderrPath, pid })),
  };
}

function launchctlPrint(entry, pid, runCommand) {
  const result = runCommand(LAUNCHCTL, ["print", `gui/${typeof process.getuid === "function" ? process.getuid() : ""}/${entry.label}`], {
    timeout: COMMAND_TIMEOUT_MS.service,
    environment: CLOSED_SYSTEM_ENVIRONMENT,
  });
  if (result.timedOut === true) return { status: "unavailable", timedOut: true };
  return parseLaunchctlPrint(result.stdout ?? "", result.status, {
    plistPath: entry.plistPath,
    launchdProgramArguments: entry.launchdProgramArguments,
    dir: entry.dir,
    stdoutPath: entry.stdoutPath,
    stderrPath: entry.stderrPath,
    pid,
  });
}

function runBuildMarkerProbe(nodePath, repo, probeEnvironment, runCommand) {
  const result = runCommand(nodePath, [BUILD_PROVENANCE_PROBE, repo], {
    timeout: COMMAND_TIMEOUT_MS.loaded,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return Object.freeze({ status: "malformed", timedOut: true });
  }
  const parsed = parseBuildProvenanceProbe(result.stdout ?? "", result.status);
  return Object.freeze({
    ...parsed,
    ...(isRecord(parsed.marker) ? { marker: Object.freeze({ ...parsed.marker }) } : {}),
  });
}

function runCachedBuildMarkerProbe(cache, nodePath, repo, probeEnvironment, runCommand) {
  const key = JSON.stringify([nodePath, repo, sha256(JSON.stringify(probeEnvironment))]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const probe = runBuildMarkerProbe(nodePath, repo, probeEnvironment, runCommand);
  cache.set(key, probe);
  return probe;
}

function runManagedRuntimeAttestation(entry, repo, runtime, probeEnvironment, trustedNodePath, runCommand) {
  if (entry.managed !== true
    || runtime?.ran !== true
    || typeof entry.configPath !== "string"
    || typeof entry.expectedBackgroundSnapshot !== "string") {
    return { status: "unsafe" };
  }
  const result = runCommand(trustedNodePath, [
    MANAGED_RUNTIME_ATTESTATION_PROBE,
    repo,
    entry.cliPath,
    entry.dir,
    entry.configPath,
    entry.envFile ?? "",
    entry.expectedBackgroundSnapshot,
    runtime.abi,
  ], {
    cwd: repo,
    timeout: COMMAND_TIMEOUT_MS.attestation,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) return { status: "malformed", timedOut: true };
  return parseManagedRuntimeAttestationProbe(result.stdout ?? "", result.status);
}

function runProcessStartProbe(pid, runCommand) {
  const result = runCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC0" },
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  return parseProcessStart(result.stdout ?? "", result.status);
}

function runProcessIdentityProbe(
  pid,
  expectedArguments,
  expectedCwd,
  expectedNodePath,
  managed,
  inspectExecutable,
  runCommand,
) {
  if (!Array.isArray(expectedArguments) || typeof expectedCwd !== "string") {
    return { ran: false };
  }
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  const command = managed === true ? null : runCommand("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      timeout: COMMAND_TIMEOUT_MS.process,
      environment,
    });
  const cwd = runCommand("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment,
  });
  const expectedExecutableInitial = inspectExecutable(expectedNodePath);
  const executable = runCommand("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-FfDin"], {
    timeout: COMMAND_TIMEOUT_MS.process,
    environment,
  });
  if (command?.timedOut === true || cwd.timedOut === true || executable.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  const actualCwd = parseLsofCwd(cwd.stdout ?? "", cwd.status, pid);
  if (actualCwd === null) {
    return { ran: false };
  }
  const expectedExecutableFinal = inspectExecutable(expectedNodePath);
  const actualExecutable = parseLsofExecutable(
    executable.stdout ?? "",
    executable.status,
    pid,
    expectedNodePath,
  );
  if (expectedExecutableInitial === null
    || expectedExecutableFinal === null
    || expectedExecutableInitial.fingerprint !== expectedExecutableFinal.fingerprint
    || actualExecutable === null) return { ran: false };
  const executableMatches = actualExecutable.device === expectedExecutableFinal.device
    && actualExecutable.inode === expectedExecutableFinal.inode;
  if (managed === true) {
    return {
      ran: true,
      executableMatches,
      cwdMatches: actualCwd === expectedCwd,
    };
  }
  const actualCommand = parseExactSingleLine(command?.stdout ?? "", command?.status);
  if (actualCommand === null) return { ran: false };
  return {
    ran: true,
    argvMatches: actualCommand === expectedArguments.join(" "),
    executableMatches,
    cwdMatches: actualCwd === expectedCwd,
  };
}

function parseLsofExecutable(text, exitCode, pid, expectedPath) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines[0] !== `p${pid}`) return null;
  const matches = [];
  for (let index = 1; index < lines.length;) {
    if (lines[index] !== "ftxt") return null;
    const device = lines[index + 1];
    const inode = lines[index + 2];
    const name = lines[index + 3];
    if (!/^D0x[0-9a-f]+$/u.test(device ?? "")
      || !/^i\d+$/u.test(inode ?? "")
      || typeof name !== "string"
      || !name.startsWith("n")
      || /[\r\0]/u.test(name)) return null;
    if (name.slice(1) === expectedPath) {
      matches.push({
        device: BigInt(device.slice(1)).toString(),
        inode: inode.slice(1),
      });
    }
    index += 4;
  }
  return matches.length === 1 ? matches[0] : null;
}

function parseExactSingleLine(text, exitCode) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  return value.length > 0 && !/[\r\n\0]/u.test(value) ? value : null;
}

function parseLsofCwd(text, exitCode, pid) {
  if (exitCode !== 0 || typeof text !== "string") return null;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 3 || lines[0] !== `p${pid}` || lines[1] !== "fcwd"
    || !lines[2].startsWith("n") || lines[2].length < 2 || /[\r\0]/u.test(lines[2])) {
    return null;
  }
  return lines[2].slice(1);
}

function runRuntimeProbe(nodePath, probeEnvironment, runCommand) {
  const result = runCommand(nodePath, [
    "-p",
    "JSON.stringify({node:process.versions.node,abi:process.versions.modules})",
  ], { timeout: COMMAND_TIMEOUT_MS.runtime, environment: probeEnvironment });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
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

function runValidate(nodePath, cliPath, dir, probeEnvironment, probeArgs, runCommand) {
  const result = runCommand(nodePath, [cliPath, "validate", "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.validate,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  const parsed = parseJsonObject(result.stdout ?? "");
  if (parsed === null || typeof parsed.ok !== "boolean") {
    return { ran: true, exitCode: result.status, validJson: false };
  }
  return { ran: true, exitCode: result.status, validJson: true, ok: parsed.ok };
}

function runMemoryAudit(nodePath, cliPath, dir, probeEnvironment, probeArgs, runCommand) {
  const result = runCommand(nodePath, [cliPath, "memory", "audit", "--strict", "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.memory,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, timedOut: true };
  }
  return parseMemoryAudit(result.stdout ?? "", result.status);
}

function runMetrics(nodePath, cliPath, dir, probeEnvironment, probeArgs, since, runCommand) {
  const result = runCommand(nodePath, [cliPath, "metrics", "--since", since, "--json", ...probeArgs], {
    cwd: dir,
    timeout: COMMAND_TIMEOUT_MS.metrics,
    environment: probeEnvironment,
  });
  if (result.timedOut === true) {
    return { ran: false, error: "metrics command timed out" };
  }
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
  return { repo: first, warning: repos.size > 1 ? `instances span ${repos.size} deploy checkouts` : null };
}

function readDeployCheckout(repo, runCommand) {
  if (repo === null) {
    return { sha: null, clean: false, error: null };
  }
  const headInitial = runCommand("/usr/bin/git", ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  const status = runCommand("/usr/bin/git", [
    "-C",
    repo,
    "-c",
    "core.fsmonitor=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  const headFinal = runCommand("/usr/bin/git", ["-C", repo, "-c", "core.fsmonitor=false", "rev-parse", "HEAD"], {
    timeout: COMMAND_TIMEOUT_MS.git,
    environment: CLOSED_GIT_ENVIRONMENT,
  });
  if (headInitial.timedOut === true || status.timedOut === true || headFinal.timedOut === true) {
    return { sha: null, clean: false, error: "checkout probe timed out" };
  }
  const initialSha = headInitial.status === 0 ? (headInitial.stdout ?? "").trim() : "";
  const finalSha = headFinal.status === 0 ? (headFinal.stdout ?? "").trim() : "";
  if (!BUILD_MARKER_SHA_PATTERN.test(initialSha)
    || !BUILD_MARKER_SHA_PATTERN.test(finalSha)
    || status.status !== 0
    || typeof status.stdout !== "string") {
    return { sha: null, clean: false, error: "checkout probe unavailable" };
  }
  if (initialSha !== finalSha) {
    return { sha: null, clean: false, error: "checkout changed during probe" };
  }
  return { sha: finalSha, clean: status.stdout.length === 0, error: null };
}

export function runCommandSync(command, args, options = {}) {
  let result;
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: options.environment ?? (typeof options.pathEnv === "string"
        ? buildLaunchdProbeEnvironment(options.pathEnv)
        : process.env),
      timeout: options.timeout,
      killSignal: "SIGKILL",
    });
  } catch {
    // Invalid/hostile argv or cwd values must become a generic closed probe
    // failure, never a thrown diagnostic that can echo the input.
    return { status: 127, stdout: "", stderr: "" };
  }
  const timedOut = result.error?.code === "ETIMEDOUT";
  if (timedOut) {
    return { status: 124, stdout: "", stderr: "", timedOut: true };
  }
  return {
    status: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

/**
 * Recreate the legacy non-secret user-launchd baseline needed by Node and filesystem
 * probes. Current managed plists instead pass their exact parsed environment.
 * In particular, never inherit shell-only MONO_AGENT_* overrides,
 * provider credentials, NODE_OPTIONS, proxy variables, or credential-store
 * selectors that are absent from the managed plist. The CLI loads the exact
 * plist --env-file itself.
 */
export function buildLaunchdProbeEnvironment(pathEnv, ambientEnv = process.env) {
  const environment = { PATH: pathEnv };
  for (const key of LAUNCHD_PROBE_ENV_KEYS) {
    const value = ambientEnv[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      environment[key] = value;
    }
  }
  return environment;
}

export async function runFleetGreenCheck(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? runCommandSync;
  const launchAgentsDir = options.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents");
  const readdir = options.readdir ?? readdirSync;
  const inspectLaunchdPath = options.inspectLaunchdPath ?? inspectCanonicalLaunchdPath;
  const inspectExecutable = options.inspectExecutablePath ?? inspectExecutablePath;
  const trustedNodePath = options.trustedNodePath ?? process.execPath;
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

  const discovery = discoverInstances(launchAgentsDir, runCommand, readdir, inspectLaunchdPath);
  const discovered = discovery.byLabel;
  const selectedLabels = args.labels ?? args.expectLabels ?? [...discovered.keys()];
  const initialFleetLabelError = evaluateExpectedLabels(discovered.keys(), args.expectLabels);
  const { repo: deployRepo, warning: repoWarning } = resolveDeployRepo(discovered, args.repo);
  const deployed = readDeployCheckout(deployRepo, runCommand);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const date = now.toISOString().slice(0, 10);
  const initialMarkerProbes = new Map();

  const selected = selectedLabels.map((label) => {
    const entry = discovered.get(label) ?? { label, dir: null, nodePath: null, cliPath: null };
    return {
      entry,
      instance: collectInstance(
        entry,
        since,
        runCommand,
        initialMarkerProbes,
        deployRepo,
        trustedNodePath,
        inspectExecutable,
      ),
    };
  });
  const instances = selected.map(({ instance }) => instance);
  // Keep the rows that can participate in the provenance and terminal
  // launchd/process bracket. No cached worker CLI is invoked unless the
  // initial managed attestation already approved it in collectInstance.
  const provenanceSelections = [];
  for (const { entry, instance } of selected) {
    if (instance.loaded.ran !== true
      || instance.loaded.initialExecutionBoundaryApproved !== true
      || instance.loaded.checkoutUnavailable === true
      || typeof instance.service.pid !== "number"
      || entry.nodePath === null
      || probeEnvironmentForEntry(entry) === null) {
      continue;
    }
    const repo = repoForEntry(entry, deployRepo);
    if (repo === null) continue;
    const probeEnvironment = probeEnvironmentForEntry(entry);
    if (probeEnvironment === null) continue;
    provenanceSelections.push({ entry, instance, repo, probeEnvironment });
  }

  // Complete the expensive source/runtime proof before the terminal launchd
  // bracket so a deploy cannot hide inside a long attestation window.
  const finalMarkerProbes = new Map();
  for (const { entry, instance, repo, probeEnvironment } of provenanceSelections) {
    if (entry.managed === true) {
      instance.loaded.runtimeAttestationFinal = runManagedRuntimeAttestation(
        entry,
        repo,
        instance.runtime,
        probeEnvironment,
        trustedNodePath,
        runCommand,
      );
    }
    instance.loaded.markerFinal = runCachedBuildMarkerProbe(
      finalMarkerProbes,
      trustedNodePath,
      repo,
      probeEnvironment,
      runCommand,
    );
  }

  // Bind every instance to the checkout state observed after terminal build
  // provenance. Each read brackets status with HEAD to reject an internal
  // checkout switch, while remaining independent across instances.
  for (const { instance, repo } of provenanceSelections) {
    instance.loaded.checkoutFinal = readDeployCheckout(repo, runCommand);
  }

  // Terminal bracket: loaded definition A -> persisted plist/topology -> loaded
  // definition B -> actual executable/cwd -> service pid. After the final
  // service read no filesystem or process observation is allowed.
  for (const { entry, instance } of provenanceSelections) {
    instance.loaded.launchDefinitionFinal = launchctlPrint(entry, instance.service.pid, runCommand);
  }
  for (const { entry, instance } of selected) {
    if (typeof entry.plistFingerprint !== "string" || typeof entry.plistShapeFingerprint !== "string") continue;
    const rechecked = readValidatedLaunchdPlist(
      join(launchAgentsDir, `${entry.label}.plist`),
      entry.label,
      runCommand,
      inspectLaunchdPath,
    );
    instance.loaded.plistRecheck = rechecked.status === "ok"
      ? {
          status: "ok",
          fingerprint: rechecked.fingerprint,
          shapeFingerprint: rechecked.shapeFingerprint,
        }
      : { status: "unavailable", ...(rechecked.timedOut === true ? { timedOut: true } : {}) };
  }
  let finalTopologyFingerprint = null;
  try {
    finalTopologyFingerprint = managedPlistTopologyFingerprint(readdir(launchAgentsDir));
  } catch {
    // Closed below without retaining filesystem details.
  }
  const topologyError = discovery.topologyFingerprint === null || finalTopologyFingerprint === null
    ? "fleet plist topology unavailable"
    : discovery.topologyFingerprint === finalTopologyFingerprint
      ? null
      : "fleet plist topology changed during probe";
  const fleetLabelError = initialFleetLabelError ?? topologyError;

  for (const { entry, instance } of provenanceSelections) {
    instance.loaded.launchDefinitionTerminal = launchctlPrint(entry, instance.service.pid, runCommand);
    instance.loaded.processIdentity = runProcessIdentityProbe(
      instance.service.pid,
      entry.programArguments,
      entry.dir,
      entry.nodePath,
      entry.managed,
      inspectExecutable,
      runCommand,
    );
  }
  for (const instance of instances) {
    instance.loaded.serviceRecheck = launchctlList(instance.label, runCommand);
  }

  const report = buildFleetReport({
    date,
    deployedSha: deployed.sha,
    ...(deployed.error === null ? {} : { deployedShaError: deployed.error }),
    ...(fleetLabelError === null ? {} : { fleetLabelError }),
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
    const result = runCommand("gh", ["issue", "comment", ISSUE_NUMBER, "--repo", REPO, "--body", body], {
      timeout: COMMAND_TIMEOUT_MS.github,
    });
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
    "  node scripts/fleet-green-check.mjs [--dry-run] [--labels <csv>] [--expect-labels <csv>]",
    "                                     [--expect-sha <sha>]",
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
    "  --expect-labels  Require the discovered fleet and checked labels to match this",
    "                  exact duplicate-free CSV set; missing/extra labels drive RED.",
    "  --expect-sha    Require a full sha matched by every checkout and loaded build.",
    `  --expect-node   Require each plist Node to report this version (default ${DEFAULT_EXPECT_NODE}).`,
    `  --expect-abi    Require each plist Node to report this modules ABI (default ${DEFAULT_EXPECT_ABI}).`,
    "  --strict-runs   Fail runs-24h on ANY failed run, not just untolerated ones.",
    "  --min-runs <n>  Fail an instance with fewer than n runs in the window.",
    "  --repo <path>   Pin the deploy checkout used for build/sha provenance; required",
    "                  when managed plists execute a copied runtime outside Git.",
  ].join("\n");
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runFleetGreenCheck();
  process.exitCode = result.exitCode;
}
