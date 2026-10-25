#!/usr/bin/env node
// Conversation-continuity benchmark. See docs/runtime/continuity-benchmark.md.
//
//   --dry-run   print the confirmed workload plan (no build, provider, credentials or network)
//   (default)   offline contract run through the built production harness with scripted
//               providers; NOT model quality
//   --real      paid run on the real provider; refused when CI is set
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ARMS, AVAILABLE_ARM_IDS, DEFAULT_ARMS, armById, checkpointKey } from "./lib/continuity-arms.mjs";
import { estimateCost, inventory, loadTraces, makePlan, parseSeeds } from "./lib/continuity-dataset.mjs";
import { HARD_SEEDS } from "./lib/continuity-generator.mjs";
import { addUsage, emptyUsage, renderMarkdown, summarize } from "./lib/continuity-score.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const BOOLEAN = new Set(["dry-run", "real", "help", "no-judge", "keep-work", "aggregate-only"]);
const VALUED = new Set(["suite", "seeds", "reader", "alternate", "judge", "reader-effort", "judge-effort", "repeats", "arms", "probe-limit", "confirm-plan", "pi-auth-path", "output", "concurrency"]);
const REPEATABLE = new Set(["trace", "repeat"]);
const EFFORTS = ["none", "minimal", "low", "medium", "high"];

export class CliError extends Error { constructor(code) { super(code); this.code = code; } }

export function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const key = raw.replace(/^--/u, "");
    if (raw !== `--${key}` || (!BOOLEAN.has(key) && !VALUED.has(key) && !REPEATABLE.has(key))) throw new CliError("invalid_arguments");
    if (BOOLEAN.has(key)) { if (flags[key]) throw new CliError("invalid_arguments"); flags[key] = true; continue; }
    const value = argv[index + 1];
    index += 1;
    if (value === undefined || value.startsWith("--")) throw new CliError("missing_argument");
    if (REPEATABLE.has(key)) { flags[key] ??= []; flags[key].push(value); continue; }
    if (Object.hasOwn(flags, key)) throw new CliError("invalid_arguments");
    flags[key] = value;
  }
  if (flags["dry-run"] && flags.real) throw new CliError("dry_run_and_real_are_exclusive");
  return flags;
}

function integer(value, { min, max }, code) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new CliError(code);
  return parsed;
}

export function profileFrom(flags) {
  for (const key of ["reader-effort", "judge-effort"]) if (flags[key] !== undefined && !EFFORTS.includes(flags[key])) throw new CliError("invalid_effort");
  if (flags["no-judge"] && flags.judge !== undefined) throw new CliError("judge_conflict");
  const suite = flags.suite ?? "original";
  if (!["original", "hard"].includes(suite)) throw new CliError("invalid_suite");
  if (flags.seeds !== undefined && suite !== "hard") throw new CliError("seeds_require_hard_suite");
  const arms = flags.arms === undefined ? [...DEFAULT_ARMS[suite]] : flags.arms.split(",").map((value) => value.trim());
  return {
    suite,
    seeds: flags.seeds === undefined ? [...HARD_SEEDS] : parseSeeds(flags.seeds),
    profile: {
      ...(flags.reader === undefined ? {} : { reader: flags.reader }),
      ...(flags.alternate === undefined ? {} : { alternate: flags.alternate }),
      ...(flags["no-judge"] ? { judge: null } : flags.judge === undefined ? {} : { judge: flags.judge }),
      ...(flags["reader-effort"] === undefined ? {} : { readerEffort: flags["reader-effort"] }),
      ...(flags["judge-effort"] === undefined ? {} : { judgeEffort: flags["judge-effort"] }),
    },
    repeats: integer(flags.repeats, { min: 1, max: 5 }, "invalid_repeats") ?? 1,
    arms,
    probeLimit: integer(flags["probe-limit"], { min: 1, max: 15 }, "invalid_probe_limit") ?? null,
  };
}

/** List prices (USD per million tokens) from the runtime's exact Pi model catalog; unknown stays absent. */
export async function listPrices(refs) {
  const prices = {};
  for (const ref of new Set(refs)) {
    const [provider, model] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
    try {
      const catalog = JSON.parse(await readFile(join(ROOT, "packages/turn/node_modules/@earendil-works/pi-ai/dist/providers/data", `${provider}.json`), "utf8"));
      for (const models of Object.values(catalog)) {
        const entry = Object.values(models).find((row) => row?.id === model);
        if (entry?.cost) { prices[ref] = { input: entry.cost.input, output: entry.cost.output, cacheRead: entry.cost.cacheRead ?? entry.cost.input }; break; }
      }
    } catch { /* unknown price stays unknown */ }
  }
  return prices;
}

function gitState() {
  // Lazy import keeps --help free of child processes.
  return import("./lib/memory-e2e-build.mjs").then(({ sourceState }) => sourceState(ROOT));
}

function insideRoot(path) {
  const rel = relative(ROOT, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function validatePiAuthPath(value) {
  if (value === undefined) return undefined;
  if (!isAbsolute(value) || /[\0-\x1f\x7f]/u.test(value) || insideRoot(resolve(value))) throw new CliError("invalid_pi_auth_path");
  let info;
  try { info = await lstat(value); } catch { throw new CliError("pi_auth_path_unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new CliError("pi_auth_path_unsafe");
  return resolve(value);
}

const HELP = `continuity-benchmark [--dry-run | --real] [options]
Default: offline contract run through the built production harness with scripted providers (NOT model quality).
--dry-run                 Print the workload plan and its confirmation digest; no build, credentials or network.
--real                    Paid run. Requires --confirm-plan SHA256 from the identical --dry-run, --pi-auth-path ABS,
                          --output ABS (outside the checkout) and a clean checkout. Refused whenever CI is set.
Plan (bound into the digest): --suite original|hard (default original) --seeds 101-108 (hard only)
  --reader REF (default openai-codex:gpt-6-luna) --alternate REF --judge REF | --no-judge
  --reader-effort LEVEL --judge-effort LEVEL --repeats N --arms ${AVAILABLE_ARM_IDS.join(",")} --probe-limit N
Execution only: --trace ID (repeatable) --repeat N (repeatable) --concurrency N --output DIR --keep-work --aggregate-only
See docs/runtime/continuity-benchmark.md.`;

export async function main(argv = process.argv.slice(2), { stdout = console.log, env = process.env, modulesLoader } = {}) {
  const flags = parseArguments(argv);
  if (flags.help) { stdout(HELP); return 0; }
  if (flags.real && Object.hasOwn(env, "CI")) throw new CliError("paid_mode_refused_in_ci");
  const { suite, seeds, profile, repeats, arms, probeLimit } = profileFrom(flags);
  const piAuthPath = await validatePiAuthPath(flags["pi-auth-path"]);
  const { traces, sha256, source } = await loadTraces({ suite, seeds });
  const { head, dirty } = await gitState();
  const plan = makePlan({ traces, sha256, suite, source, codeRevision: head, profile, repeats, arms, probeLimit,
    piAuthFingerprint: piAuthPath === undefined ? null : createHash("sha256").update(piAuthPath).digest("hex") });
  if (flags["dry-run"]) {
    const prices = await listPrices([plan.reader.model, ...(plan.judge ? [plan.judge.model] : [])]);
    stdout(JSON.stringify({ ...plan, inventory: inventory(traces), estimate: estimateCost(plan, traces, prices) }, null, 2));
    return 0;
  }
  const mode = flags.real ? "real" : "offline";
  if (mode === "real") {
    if (flags["confirm-plan"] !== plan.confirmation) throw new CliError("real_mode_requires_confirmed_plan");
    if (piAuthPath === undefined) throw new CliError("real_mode_requires_pi_auth_path");
    if (dirty) throw new CliError("real_mode_requires_clean_checkout");
    if (flags.output === undefined) throw new CliError("real_mode_requires_output");
  } else if (flags["confirm-plan"] !== undefined || piAuthPath !== undefined) {
    throw new CliError("credentials_require_real_mode");
  }
  const output = flags.output === undefined
    ? join(ROOT, ".worklab-tmp", "continuity", `run-${new Date().toISOString().replace(/[:.]/gu, "-")}`)
    : resolve(flags.output);
  if (flags.output !== undefined && (!isAbsolute(flags.output) || (mode === "real" && insideRoot(output)))) throw new CliError("invalid_output");
  await mkdir(join(output, "units"), { recursive: true, mode: 0o700 });
  const planPath = join(output, "plan.json");
  try {
    const existing = JSON.parse(await readFile(planPath, "utf8"));
    if (existing.confirmation !== plan.confirmation || existing.executionKind !== mode) throw new CliError("output_belongs_to_another_plan");
  } catch (error) {
    if (error instanceof CliError) throw error;
    await writeFile(planPath, `${JSON.stringify({ ...plan, executionKind: mode }, null, 2)}\n`, { mode: 0o600 });
  }
  if (!flags["aggregate-only"]) {
    await execute({ flags, plan, traces, mode, output, piAuthPath, head, dirty, modulesLoader });
  }
  const results = await aggregate({ plan, traces, output, mode });
  stdout(JSON.stringify({ output, executionKind: mode, qualityMeasured: mode === "real", coverage: results.coverage,
    overall: Object.fromEntries(Object.entries(results.summary.arms).map(([arm, row]) => [arm, { n: row.overall.n, accuracy: row.overall.accuracy, delta: row.deltaVsBaseline.overall, excluded: row.excluded }])) }, null, 2));
  return results.coverage.unitsComplete === results.coverage.unitsExpected ? 0 : 1;
}

function unitName({ repeat, traceId, armId }) { return `r${repeat}-${traceId}-${armId}.json`; }

async function execute({ flags, plan, traces, mode, output, piAuthPath, head, dirty, modulesLoader }) {
  const selectedTraces = flags.trace === undefined ? traces : traces.filter((trace) => flags.trace.includes(trace.id));
  if (flags.trace !== undefined && selectedTraces.length !== new Set(flags.trace).size) throw new CliError("unknown_trace");
  const repeatList = flags.repeat === undefined ? Array.from({ length: plan.repeats }, (_, index) => index + 1)
    : [...new Set(flags.repeat.map((value) => integer(value, { min: 1, max: plan.repeats }, "invalid_repeat_selection")))];
  const concurrency = integer(flags.concurrency, { min: 1, max: 8 }, "invalid_concurrency") ?? (mode === "real" ? 4 : 2);
  const armList = plan.arms.map((row) => armById(row.id));
  const units = [];
  for (const repeat of repeatList) for (const trace of selectedTraces) for (const arm of armList) {
    const name = unitName({ repeat, traceId: trace.id, armId: arm.id });
    try {
      const existing = JSON.parse(await readFile(join(output, "units", name), "utf8"));
      if (existing.confirmation === plan.confirmation && existing.complete === true) continue;
    } catch { /* not yet run */ }
    units.push({ repeat, trace, arm, name });
  }
  if (units.length === 0) return;
  const { productionModules, buildCheckpoint, runProbe, createJudge, pool, isFatalFailure } = await import("./lib/continuity-runner.mjs");
  const modules = await (modulesLoader ?? productionModules)(ROOT);
  const scratch = join(output, "work");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const authPath = piAuthPath ?? join(scratch, "no-credentials.json");
  const state = { liveTurns: 0, observedInput: 0, stop: null };
  const admit = () => state.stop === null && state.liveTurns < plan.limits.maxLiveTurns
    && state.observedInput < plan.limits.maxObservedInputTokensPerInvocation;
  const account = (usage) => {
    state.observedInput += (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  };
  // Checkpoints (shared when scripted-only).
  const checkpoints = new Map();
  const needed = [];
  for (const unit of units) {
    const key = `${unit.trace.id}:${checkpointKey(unit.arm, unit.repeat)}`;
    if (!checkpoints.has(key)) { checkpoints.set(key, null); needed.push({ key, unit }); }
  }
  await pool(needed, concurrency, async ({ key, unit }) => {
    if (!admit()) { checkpoints.set(key, { error: "admission_stopped" }); return; }
    const dir = join(scratch, `cp-${key.replace(/[^a-z0-9-]/giu, "_")}`);
    await rm(dir, { recursive: true, force: true });
    try {
      if (unit.arm.midCheckpoint !== null) state.liveTurns += 1;
      const built = await buildCheckpoint({ modules, trace: unit.trace, arm: unit.arm, repeat: unit.repeat, dir, plan, mode, authPath });
      if (built.record.mid) account(built.record.mid.usage);
      checkpoints.set(key, built);
      if (built.record.mid?.boundary && !built.record.mid.boundary.verified) checkpoints.set(key, { ...built, error: "mid_checkpoint_boundary_unverified" });
    } catch (error) {
      checkpoints.set(key, { error: error?.code ?? "checkpoint_failed" });
    }
  });
  const judge = createJudge({ modules, plan, mode, workspace: join(scratch, "judge"), authPath: piAuthPath });
  if (judge) await mkdir(join(scratch, "judge"), { recursive: true, mode: 0o700 });
  const jobs = units.flatMap((unit) => {
    const probes = unit.trace.probes.filter((probe) => plan.corpus.traces.find((row) => row.id === unit.trace.id).probes.includes(probe.id));
    return probes.map((probe) => ({ unit, probe }));
  });
  const results = await pool(jobs, concurrency, async ({ unit, probe }, index) => {
    const checkpoint = checkpoints.get(`${unit.trace.id}:${checkpointKey(unit.arm, unit.repeat)}`);
    if (!checkpoint || checkpoint.error) {
      return { traceId: unit.trace.id, arm: unit.arm.id, repeat: unit.repeat, probeId: probe.id, category: probe.category, status: "failed", failure: checkpoint?.error ?? "checkpoint_missing", score: null };
    }
    state.liveTurns += 1;
    const trial = await runProbe({ modules, trace: unit.trace, arm: unit.arm, repeat: unit.repeat, probe, checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot ?? null, checkpointContinuity: checkpoint.record.continuity ?? null,
      checkpointConversationId: checkpoint.record.conversationId, mid: checkpoint.record.mid, root: ROOT,
      forkDir: join(scratch, `probe-${index}`), plan, mode, authPath, keepWork: flags["keep-work"] === true });
    account(trial.usage);
    if (isFatalFailure(trial)) state.stop = trial.failure;
    if (judge && probe.category === "next_action" && trial.answer !== null && trial.answer !== undefined) {
      trial.judge = await judge.judge(probe, trial.answer);
    }
    return trial;
  }, admit, ({ unit }) => `${unit.trace.id}:${checkpointKey(unit.arm, unit.repeat)}`);
  await judge?.close();
  const finishedAt = new Date().toISOString();
  for (const unit of units) {
    const trials = jobs.map((job, index) => (job.unit === unit ? results[index] : null)).filter((row) => row !== null);
    const complete = trials.length > 0 && trials.every((trial) => trial !== undefined);
    const checkpoint = checkpoints.get(`${unit.trace.id}:${checkpointKey(unit.arm, unit.repeat)}`);
    const body = {
      confirmation: plan.confirmation, executionKind: mode, complete,
      repeat: unit.repeat, traceId: unit.trace.id, arm: unit.arm.id,
      checkpoint: checkpoint && !checkpoint.error ? checkpoint.record : { error: checkpoint?.error ?? "checkpoint_missing" },
      trials: trials.map((trial) => trial ?? { status: "not_started" }),
      manifest: { codeRevision: head, dirty, node: process.version, finishedAt, buildPolicy: "existing-dist-unverified", admissionStop: state.stop },
    };
    await writeFile(join(output, "units", unit.name), `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  }
  if (flags["keep-work"] !== true) await rm(scratch, { recursive: true, force: true });
}

export async function aggregate({ plan, traces, output, mode }) {
  const files = (await readdir(join(output, "units"))).filter((name) => name.endsWith(".json")).sort();
  const units = [];
  for (const name of files) {
    const unit = JSON.parse(await readFile(join(output, "units", name), "utf8"));
    if (unit.confirmation === plan.confirmation && unit.executionKind === mode && unit.complete === true) units.push(unit);
  }
  const trials = units.flatMap((unit) => unit.trials);
  const extraUsage = units.filter((unit) => unit.checkpoint?.mid).map((unit) => ({ arm: unit.arm, usage: unit.checkpoint.mid.usage, compactionUsage: unit.checkpoint.mid.compactionUsage }));
  const armIds = plan.arms.map((row) => row.id);
  const summary = summarize(trials, { arms: armIds, baselineArm: plan.baselineArm, repeats: Array.from({ length: plan.repeats }, (_, index) => index + 1), extraUsage });
  const judgeUsage = emptyUsage();
  for (const trial of trials) if (trial.judge?.usage) addUsage(judgeUsage, trial.judge.usage);
  const midCheckpoints = units.filter((unit) => unit.checkpoint?.mid).map((unit) => ({ traceId: unit.traceId, arm: unit.arm, repeat: unit.repeat,
    kind: unit.checkpoint.mid.kind ?? null, status: unit.checkpoint.mid.status ?? null, tokensBefore: unit.checkpoint.mid.tokensBefore ?? null, tokensAfter: unit.checkpoint.mid.tokensAfter ?? null,
    verified: unit.checkpoint.mid.boundary.verified, reasons: unit.checkpoint.mid.boundary.reasons }));
  const pressure = units.flatMap((unit) => unit.trials.filter((trial) => trial.pressure?.applicable).map((trial) => ({ arm: unit.arm, ...trial.pressure.metrics, verified: trial.pressure.verified })));
  const pressureSummary = Object.fromEntries(plan.arms.map(({ id }) => {
    const rows = pressure.filter((row) => row.arm === id);
    const stat = (key) => { const values = rows.map((row) => row[key]).filter((value) => typeof value === "number"); return values.length ? { min: Math.min(...values), max: Math.max(...values), n: values.length } : null; };
    return [id, { samples: rows.length, verified: rows.filter((row) => row.verified).length, probeInputTokens: stat("probeInputTokens"), compactionTokensBefore: stat("compactionTokensBefore"),
      midCompactionTokensBefore: stat("midCompactionTokensBefore"), replayedMessages: stat("replayedMessages"), projectionDroppedRecords: stat("projectionDroppedRecords") }];
  }));
  const coverage = { unitsComplete: units.length, unitsExpected: plan.repeats * plan.corpus.traces.length * armIds.length };
  const armLabels = Object.fromEntries(ARMS.map((arm) => [arm.id, arm.label]));
  const results = { plan, executionKind: mode, qualityMeasured: mode === "real", inventory: inventory(traces), coverage, summary, judgeUsage, midCheckpoints, pressure: pressureSummary };
  await writeFile(join(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  const header = `Coverage: ${coverage.unitsComplete}/${coverage.unitsExpected} trace×arm×repeat units. Code revision ${plan.codeRevision ?? "unknown"}. Plan ${plan.confirmation}.\n\n`;
  await writeFile(join(output, "summary.md"), `${header}${renderMarkdown(summary, { qualityMeasured: mode === "real", armLabels, judgeUsage: plan.judge ? judgeUsage : null })}`, { mode: 0o600 });
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
  }).catch((error) => {
    // Codes only: raw runtime errors can contain paths or credentials.
    console.error(`continuity-benchmark: ${error instanceof CliError || typeof error?.code === "string" ? error.code : "failed"}`);
    process.exitCode = 1;
    process.stderr.write("", () => process.exit(1));
  });
}
