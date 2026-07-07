#!/usr/bin/env node
// Daily fleet green-check tracker for the v1 window (goal #168, epic #119).
//
// Read-only health probe of the live launchd mono-agent fleet. Its ONLY side
// effect is one dated checkpoint comment on issue #119 (skipped with --dry-run).
// It never restarts an instance, writes a config, or touches an artifact dir.
//
// Per instance it checks three things and surfaces a compact markdown table:
//   service   — `launchctl list <label>`: a running pid OR last exit 0 = pass.
//   validate  — deployed `cli.js validate` (cwd = instance dir), exit 0 = pass.
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
// The deployed sha and the cli.js used for validate/metrics come from the plist
// ProgramArguments — i.e. the checkout the fleet actually execs — NOT from
// whatever checkout this script happens to run in. With --expect-sha it fails on
// a mismatch (window mode); without it the sha is informational only.
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
  const parsed = { dryRun: false, strictRuns: false, help: false };
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
  const overall = report?.overall ?? {};
  const failureKinds = Array.isArray(overall.failureKindRates)
    ? overall.failureKindRates.map((entry) => ({ kind: String(entry.failureKind), count: Number(entry.count) }))
    : [];
  return {
    ran: true,
    totalRuns: Number(overall.totalRuns ?? 0),
    failedRuns: Number(overall.statusCounts?.failed ?? 0),
    failureKinds,
  };
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
    return { status: "skip", note: "not run" };
  }
  if (validate.exitCode === 0) {
    return { status: "pass", note: "" };
  }
  const tail = typeof validate.tail === "string" && validate.tail.length > 0 ? validate.tail : "non-zero exit";
  return { status: "fail", note: `validate failed — ${tail}` };
}

const CELL = { pass: "ok", warn: "warn", fail: "FAIL", skip: "—" };

// The verdict + table. Pure: takes already-collected structured data.
export function buildFleetReport(input) {
  const { date, deployedSha, expectSha, strictRuns, minRuns } = input;
  const rows = input.instances.map((instance) => {
    const name = instanceName(instance.label);
    // A plist that matched the prefix but could not be read is an unknown
    // config the fleet may be running blind — RED, never silently dropped.
    if (typeof instance.discoveryError === "string") {
      const service = { status: "fail", note: `plist unreadable — ${instance.discoveryError}` };
      const skipped = { status: "skip", note: "" };
      return { name, label: instance.label, service, validate: skipped, runs: skipped, notes: service.note };
    }
    const service = evaluateService(instance.service);
    const validate = evaluateValidate(instance.validate);
    const runs = evaluateRuns(instance.metrics, { strictRuns, minRuns });
    const notes = [service.status !== "pass" ? service.note : null, validate.note || null, runs.note || null]
      .filter((note) => note !== null && note !== "")
      .join("; ");
    return { name, label: instance.label, service, validate, runs, notes };
  });

  let reason = null;
  for (const row of rows) {
    if (row.service.status === "fail") {
      reason = `${row.name}: ${row.service.note}`;
      break;
    }
    if (row.validate.status === "fail") {
      reason = `${row.name}: ${row.validate.note}`;
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
  const header = "| instance | service | validate | runs-24h | notes |";
  const divider = "| --- | --- | --- | --- | --- |";
  const lines = rows.map((row) => {
    const notes = row.notes.length > 0 ? row.notes.replace(/\|/gu, "\\|") : "";
    return `| ${row.name} | ${CELL[row.service.status]} | ${CELL[row.validate.status]} | ${CELL[row.runs.status]} | ${notes} |`;
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
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, cliPath: null, discoveryError: `plutil failed (${(result.stderr ?? "").trim().split("\n").pop() ?? `exit ${result.status}`})` });
      continue;
    }
    let plist;
    try {
      plist = JSON.parse(result.stdout);
    } catch (error) {
      byLabel.set(filenameLabel, { label: filenameLabel, dir: null, cliPath: null, discoveryError: `unparseable plist json (${error instanceof Error ? error.message : String(error)})` });
      continue;
    }
    const label = typeof plist.Label === "string" ? plist.Label : filenameLabel;
    const dir = typeof plist.WorkingDirectory === "string" ? plist.WorkingDirectory : null;
    const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
    const cliPath = args.find((arg) => typeof arg === "string" && arg.endsWith("cli.js")) ?? null;
    byLabel.set(label, { label, dir, cliPath });
  }
  return byLabel;
}

function collectInstance(entry, cliPath, since, runCommand) {
  if (typeof entry.discoveryError === "string") {
    return { label: entry.label, dir: null, discoveryError: entry.discoveryError, service: { found: false, pid: null, lastExitStatus: null }, validate: { ran: false }, metrics: { ran: false } };
  }
  const service = parseLaunchctlList(...launchctlList(entry.label, runCommand));
  let validate = { ran: false };
  let metrics = { ran: false };
  if (entry.dir !== null && cliPath !== null) {
    validate = runValidate(cliPath, entry.dir, runCommand);
    metrics = runMetrics(cliPath, entry.dir, since, runCommand);
  }
  return { label: entry.label, dir: entry.dir, service, validate, metrics };
}

function launchctlList(label, runCommand) {
  const result = runCommand("launchctl", ["list", label]);
  return [result.stdout ?? "", result.status];
}

function runValidate(cliPath, dir, runCommand) {
  const result = runCommand("node", [cliPath, "validate"], { cwd: dir });
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const lines = combined.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  return { ran: true, exitCode: result.status, tail: lines.length > 0 ? lines[lines.length - 1] : "" };
}

function runMetrics(cliPath, dir, since, runCommand) {
  const result = runCommand("node", [cliPath, "metrics", "--since", since, "--json"], { cwd: dir });
  if (result.status !== 0) {
    const err = (result.stderr ?? "").trim().split("\n").pop() ?? "non-zero exit";
    return { ran: false, error: err.length > 0 ? err : "non-zero exit" };
  }
  try {
    return reduceMetrics(JSON.parse(result.stdout));
  } catch (error) {
    return { ran: false, error: `unparseable metrics json (${error instanceof Error ? error.message : String(error)})` };
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
  return result.status === 0 ? (result.stdout ?? "").trim() : null;
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
    const entry = discovered.get(label) ?? { label, dir: null, cliPath: null };
    const cliPath = entry.cliPath ?? (deployRepo !== null ? join(deployRepo, "packages", "agent-app", "dist", "cli.js") : null);
    return collectInstance(entry, cliPath, since, runCommand);
  });

  const report = buildFleetReport({
    date,
    deployedSha,
    expectSha: args.expectSha,
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
      stderr.write(`Failed to post comment to #${ISSUE_NUMBER}: ${(result.stderr ?? "").trim()}\n`);
      return { exitCode: report.exitCode === 0 ? 1 : report.exitCode };
    }
    stdout.write(`Posted checkpoint to #${ISSUE_NUMBER}: ${(result.stdout ?? "").trim()}\n`);
  }

  return { exitCode: report.exitCode };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/fleet-green-check.mjs [--dry-run] [--labels <csv>] [--expect-sha <sha>]",
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
    "  --strict-runs   Fail runs-24h on ANY failed run, not just untolerated ones.",
    "  --min-runs <n>  Fail an instance with fewer than n runs in the window.",
    "  --repo <path>   Override the deploy checkout used for sha + validate/metrics.",
  ].join("\n");
}

const isCli = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) {
  const result = await runFleetGreenCheck();
  process.exitCode = result.exitCode;
}
