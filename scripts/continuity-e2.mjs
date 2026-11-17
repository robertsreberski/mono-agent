#!/usr/bin/env node
// Offline preparation only. Paid authority is not an argument this CLI accepts.
// Capture the fork binding before evaluating any other framework/user module.
import { runE2SizingProcess, e2SizingErrorDiagnostic } from "./lib/continuity-e2-sizing-process.mjs";
import { e2HistorySurface, historySurfaceBinding } from "./lib/continuity-e2-history.mjs";
import { realpathSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { fail, inputPath } from "./lib/continuity-observation-input.mjs";
import { privateOutput } from "./lib/continuity-recorded-import.mjs";
import { MAX_SOURCE_BYTES } from "./lib/continuity-recorded-schema.mjs";
import { diagnosticRecord, knownRefusalCode } from "./lib/continuity-e2-diagnostics.mjs";
import { proofRefusalCode } from "./lib/continuity-e2-checks.mjs";
import { scoreE2 } from "./lib/continuity-e2-score.mjs";
import { estimateE2SizingSet, E2_MAX_SIZING_RECORDS } from "./lib/continuity-e2-sizing.mjs";
import { guardedProtocol } from "./lib/continuity-guarded-protocols.mjs";
import { loadE2Catalog } from "./lib/continuity-e2-pricing.mjs";
import { E2_REPLAY_SCENARIOS } from "./lib/continuity-e2-protected.mjs";
import { e2ReplayArm } from "./lib/continuity-e2-protocol.mjs";
export const USAGE = "Usage: node scripts/continuity-e2.mjs size --source DIR --protocol FILE --output NEW_DIR [--summary faux-short|faux-max|protected-exact|protected-refusal] [--history-surface split|unified] [--replay-arm continuity|baseline] [--diagnostics NEW_FILE]\n       node scripts/continuity-e2.mjs size --replay-arm history-ab --history-ab FILE --source DIR --protocol FILE --output NEW_DIR\n       node scripts/continuity-e2.mjs ab-bind --replay FILE --snapshot DIR --branch N --checkpoint N --rows ID[,ID...] [--primary ID[,ID...]] [--arms A,B,C] --output NEW_DIR\n       node scripts/continuity-e2.mjs ab-score --registration FILE --sha256 HASH --run DIR --keys FILE --output NEW_DIR\n       node scripts/continuity-e2.mjs score --answers FILE --keys FILE --output NEW_DIR\n       node scripts/continuity-e2.mjs proofs --output NEW_DIR [--history-surface split|unified] [--arm switch|cancel|idle|pressure|all] [--diagnostics NEW_FILE]\n       node scripts/continuity-e2.mjs --estimate --protocol FILE --limits FILE --sizing FILE [--sizing FILE...] [--history-surface split|unified] [--replay-arm continuity|baseline|history-ab] [--history-ab FILE] --output NEW_DIR\n       node scripts/continuity-e2.mjs run --summary real [--history-surface split|unified] [--replay-arm continuity|baseline|history-ab] --registration FILE --sha256 HASH --authorization FILE --credentials FILE --output EMPTY_DIR\n       node scripts/continuity-e2.mjs proofs --real [--history-surface split|unified] --registration FILE --sha256 HASH --authorization FILE --credentials FILE --output EMPTY_DIR\n       node scripts/continuity-e2.mjs reconcile --output DIR";
export function parseE2Args(argv) {
  const [selected, ...tail] = argv, command = selected === "--estimate" ? "estimate" : selected;
  const real = command === "run" || command === "proofs" && tail.includes("--real");
  if (command === "proofs" && real && tail.filter(value => value === "--real").length !== 1) fail("E2_ARGUMENTS_INVALID");
  const rest = command === "proofs" && real ? tail.filter(value => value !== "--real") : tail;
  const paid = ["registration", "sha256", "authorization", "credentials", "output"];
  const required = real ? [...paid, ...(command === "run" ? ["summary"] : [])] : command === "reconcile" ? ["output"]
    : command === "size" ? ["source", "protocol", "output"] : command === "score" ? ["answers", "keys", "output"]
    : command === "proofs" ? ["output"] : command === "estimate" ? ["protocol", "limits", "sizing", "output"]
    : command === "ab-bind" ? ["replay", "snapshot", "branch", "checkpoint", "rows", "output"] : command === "ab-score" ? ["registration", "sha256", "run", "keys", "output"] : null;
  if (!required) fail("E2_ARGUMENTS_INVALID");
  const result = { command, ...(real ? { real: true } : {}) }, allowed = [...required, ...(["size", "run", "proofs", "estimate"].includes(command) ? ["history-surface"] : []), ...(["size", "run", "estimate"].includes(command) ? ["replay-arm"] : []), ...(["size", "estimate"].includes(command) ? ["history-ab"] : []), ...(command === "ab-bind" ? ["primary", "arms"] : []), ...(!real && command === "size" ? ["summary", "diagnostics"] : !real && command === "proofs" ? ["arm", "diagnostics"] : [])];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !allowed.includes(key) || !rest[i + 1] || rest[i + 1].startsWith("--") || Object.hasOwn(result, key) && !(command === "estimate" && key === "sizing")) fail("E2_ARGUMENTS_INVALID");
    if (command === "estimate" && key === "sizing") (result.sizing ??= []).push(rest[i + 1]); else result[key] = rest[i + 1];
  }
  if (result["history-surface"] !== undefined) e2HistorySurface(result["history-surface"]);
  if (required.some(k => !result[k]) || command === "run" && result.summary !== "real"
    || command === "size" && result.summary !== undefined && !E2_REPLAY_SCENARIOS.includes(result.summary)) fail("E2_ARGUMENTS_INVALID");
  if (command === "estimate" && result.sizing.length > E2_MAX_SIZING_RECORDS) fail("E2_ARGUMENTS_INVALID");
  if (result["replay-arm"] !== undefined) e2ReplayArm(result["replay-arm"]);
  if (result.arm !== undefined && !["switch", "cancel", "idle", "pressure", "all"].includes(result.arm)) fail("E2_ARGUMENTS_INVALID");
  // The pack-withheld A/B is explicit: its binding file selects arms; no surface or summary selector applies.
  const ab = result["replay-arm"] === "history-ab";
  if (ab !== (result["history-ab"] !== undefined) && command !== "run" || command === "run" && result["history-ab"] !== undefined
    || ab && (result["history-surface"] !== undefined || command === "size" && result.summary !== undefined)) fail("E2_ARGUMENTS_INVALID");
  if (command === "ab-bind") {
    const list = value => value === undefined ? undefined : value.split(",");
    if (![result.branch, result.checkpoint].every(v => /^(0|[1-9][0-9]?)$/u.test(v))) fail("E2_ARGUMENTS_INVALID");
    Object.assign(result, { branch: Number(result.branch), checkpoint: Number(result.checkpoint), rows: list(result.rows), primary: list(result.primary) ?? [], arms: list(result.arms) });
  }
  return result;
}

function writePrivate(output, name, value) {
  mkdirSync(output, { mode: 0o700 });
  try { writeFileSync(join(output, name), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}
function readJSON(path) {
  if (statSync(path).size > MAX_SOURCE_BYTES) fail("E2_INPUT_TOO_LARGE");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail("E2_INPUT_INVALID"); }
}

export async function main(argv, { stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout(`${USAGE}\n`); return 0; }
  let diagnosticPath, diagnostic = diagnosticRecord();
  try {
    const args = parseE2Args(argv);
    if (args.real) {
      const { runE2Paid } = await import("./lib/continuity-e2-paid-entry.mjs");
      const report = await runE2Paid({ ...historySurfaceBinding(args["history-surface"]), ...(args["replay-arm"] === undefined ? {} : { replayArm: args["replay-arm"] }), command: args.command, registrationPath: resolve(args.registration), registrationSha256: args.sha256,
        authorizationPath: resolve(args.authorization), credentialPath: resolve(args.credentials), outputRoot: resolve(args.output) });
      stdout(`${JSON.stringify(report)}\n`); return report.stop === "completed" ? 0 : 1;
    } else if (args.command === "reconcile") {
      const { reconcileE2Paid } = await import("./lib/continuity-e2-paid-entry.mjs");
      stdout(`${JSON.stringify(await reconcileE2Paid(resolve(args.output)))}\n`);
    } else if (args.command === "ab-bind") {
      const replay = inputPath(process.cwd(), args.replay), snapshot = realpathSync(resolve(args.snapshot)), output = privateOutput(args.output, [replay, snapshot]);
      const { buildE2HistoryAbBinding } = await import("./lib/continuity-e2-ab.mjs");
      const historyAb = await buildE2HistoryAbBinding({ replayPath: replay, snapshot, branch: args.branch, checkpoint: args.checkpoint, rows: args.rows, primary: args.primary, ...(args.arms ? { arms: args.arms } : {}) });
      writePrivate(output, "history-ab.json", historyAb);
      stdout(`${JSON.stringify({ schema: historyAb.schema, arms: historyAb.arms.map(a => a.arm), rows: historyAb.rows.length, primary: historyAb.primary.length, files: historyAb.frozen.receipt.files })}\n`);
    } else if (args.command === "ab-score") {
      const registration = inputPath(process.cwd(), args.registration), keys = inputPath(process.cwd(), args.keys), run = realpathSync(resolve(args.run));
      const output = privateOutput(args.output, [registration, keys, run]);
      const [{ scoreE2HistoryAb, readE2AbReceipts, e2AbScoringInputs }, { e2AbArmLetters, e2AbSlotArm, assertE2HistoryAbBinding }] = await Promise.all([import("./lib/continuity-e2-ab-score.mjs"), import("./lib/continuity-e2-ab.mjs")]);
      // Provenance: the registration by its sha256, the keys by the registration's own binding.
      if (statSync(registration).size > MAX_SOURCE_BYTES || statSync(keys).size > MAX_SOURCE_BYTES) fail("E2_INPUT_TOO_LARGE");
      const { pilot, evaluator } = e2AbScoringInputs({ registrationBytes: readFileSync(registration), registrationSha256: args.sha256, keysBytes: readFileSync(keys) });
      const historyAb = assertE2HistoryAbBinding(pilot.registration.historyAb);
      // Lookups are derived from each phase's probe receipts, never a separate counter file.
      const arms = Object.fromEntries(e2AbArmLetters(historyAb).map(arm => [arm, { answers: readJSON(inputPath(run, join("work", e2AbSlotArm(arm), "answers.json"))),
        receipts: readE2AbReceipts(join(run, "work", e2AbSlotArm(arm), "probe-receipts")) }]));
      const report = scoreE2HistoryAb({ pilot, evaluator, arms });
      writePrivate(output, "ab-score.json", report);
      stdout(`${JSON.stringify(report.arms.map(a => ({ arm: a.arm, answers: a.overall.answers, lookups: a.overall.lookups, lookupUnverified: a.overall.lookupEvidence.missing + a.overall.lookupEvidence.inconsistent, correct: a.overall.correct })))}\n`);
    } else if (args.command === "estimate" && args["replay-arm"] === "history-ab") {
      const protocol = inputPath(process.cwd(), args.protocol), limits = inputPath(process.cwd(), args.limits), bindingFile = inputPath(process.cwd(), args["history-ab"]);
      const sizing = args.sizing.map(path => inputPath(process.cwd(), path)), output = privateOutput(args.output, [protocol, limits, bindingFile, ...sizing]);
      const registered = readJSON(limits), historyAb = readJSON(bindingFile), protocolValue = readJSON(protocol);
      if (registered?.schema !== "continuity-e2-estimate-limits-v1" || Object.keys(registered).sort().join() !== "probeCounts,roles,schema") fail("E2_ESTIMATE_INVALID");
      const { estimateE2HistoryAb, e2AbProbeCounts } = await import("./lib/continuity-e2-ab.mjs");
      // Row counts come from the A/B binding; the limits file must agree, never override.
      if (JSON.stringify(registered.probeCounts) !== JSON.stringify(e2AbProbeCounts(protocolValue, historyAb))) fail("E2_PROBE_COUNTS_REQUIRED");
      const report = estimateE2HistoryAb({ protocol: protocolValue, roles: registered.roles, historyAb, records: sizing.map(readJSON), catalog: await loadE2Catalog() });
      writePrivate(output, "estimate.json", report);
      stdout(`${JSON.stringify(report)}\n`);
    } else if (args.command === "estimate") {
      const protocol = inputPath(process.cwd(), args.protocol), limits = inputPath(process.cwd(), args.limits);
      const sizing = args.sizing.map(path => inputPath(process.cwd(), path));
      const output = privateOutput(args.output, [protocol, limits, ...sizing]);
      const registered = readJSON(limits);
      if (registered?.schema !== "continuity-e2-estimate-limits-v1" || Object.keys(registered).sort().join() !== "probeCounts,roles,schema") fail("E2_ESTIMATE_INVALID");
      // Limits contain role/count envelopes, not a surface. Every sizing record
      // is independently bound to the CLI selector by estimateE2SizingSet.
      const report = estimateE2SizingSet({ protocol: readJSON(protocol), roles: registered.roles, probeCounts: registered.probeCounts, records: sizing.map(readJSON), replayArm: args["replay-arm"], historySurface: args["history-surface"], catalog: await loadE2Catalog() });
      mkdirSync(output, { mode: 0o700 });
      try { writeFileSync(join(output, "estimate.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 }); }
      catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
      stdout(`${JSON.stringify(report)}\n`);
    } else if (args.command === "proofs") {
      const output = privateOutput(args.output);
      if (args.diagnostics) {
        diagnosticPath = privateOutput(args.diagnostics);
        if (diagnosticPath === output) { diagnosticPath = undefined; fail("E2_DIAGNOSTICS_REFUSED"); }
      }
      const { runE2Proofs } = await import("./lib/continuity-e2-proofs.mjs");
      const records = await runE2Proofs({ ...historySurfaceBinding(args["history-surface"]), output, arm: args.arm });
      stdout(`${JSON.stringify({ arms: records.length, variants: records.reduce((n, r) => n + r.report.variants.length, 0), requests: records.reduce((n, r) => n + r.sizing.variants.reduce((m, v) => m + v.requests.length, 0), 0) })}\n`);
    } else if (args.command === "size") {
      const sourceFile = inputPath(process.cwd(), join(args.source, "source.json")), protocolFile = inputPath(process.cwd(), args.protocol);
      const output = privateOutput(args.output, [sourceFile, protocolFile]);
      if (args.diagnostics) {
        diagnosticPath = privateOutput(args.diagnostics, [sourceFile, protocolFile]);
        if (diagnosticPath === output) { diagnosticPath = undefined; fail("E2_DIAGNOSTICS_REFUSED"); }
      }
      if (args["replay-arm"] === "history-ab") {
        const bindingFile = inputPath(process.cwd(), args["history-ab"]), historyAb = readJSON(bindingFile);
        const { runE2HistoryAbSizing, e2AbFrozenRecord, assertE2HistoryAbBinding } = await import("./lib/continuity-e2-ab.mjs");
        assertE2HistoryAbBinding(historyAb);
        const report = await runE2HistoryAbSizing({ source: readJSON(sourceFile), protocol: readJSON(protocolFile), historyAb, frozen: await e2AbFrozenRecord(historyAb), output });
        stdout(`${JSON.stringify({ schema: report.schema, arms: report.arms.length, probes: report.arms.reduce((n, a) => n + a.probes.length, 0), requests: report.arms.reduce((n, a) => n + a.requestSizing.length, 0) })}\n`);
        return 0;
      }
      const input = { ...historySurfaceBinding(args["history-surface"]), source: readJSON(sourceFile), protocol: readJSON(protocolFile), output, summary: args.summary ?? "faux-short", replayArm: e2ReplayArm(args["replay-arm"]) };
      const onDiagnostic = value => { diagnostic = diagnosticRecord(value); };
      const report = input.replayArm === "baseline"
        ? await (await import("./lib/continuity-e2-replay.mjs")).runE2Sizing({ ...input, onDiagnostic })
        : await runE2SizingProcess(input, onDiagnostic);
      stdout(`${JSON.stringify({ schema: report.schema, branches: report.branches.length, checkpoints: report.branches.reduce((n, b) => n + b.checkpoints.length, 0), summaryRequests: report.branches.reduce((n, b) => n + b.summaryRequests.length, 0) })}\n`);
    } else {
      const answers = inputPath(process.cwd(), args.answers), keys = inputPath(process.cwd(), args.keys), output = privateOutput(args.output, [answers, keys]);
      const result = scoreE2(readJSON(answers), readJSON(keys));
      mkdirSync(output, { mode: 0o700 });
      try {
        for (const [name, value] of [["score.json", result.report], ["custodian-adjudication.json", result.adjudication]]) writeFileSync(join(output, name), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
      } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
      stdout(`${JSON.stringify(result.report.totals)}\n`);
    }
    return 0;
  } catch (error) {
    if (diagnosticPath) {
      try { const record = diagnosticRecord({ ...diagnostic, ...e2SizingErrorDiagnostic(error) }); record.errorCode ??= proofRefusalCode(error?.code); writeFileSync(diagnosticPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); }
      catch { stderr("E2_DIAGNOSTICS_REFUSED\n"); return 1; }
    }
    const protocol = guardedProtocol("e2-validation"), paidCode = [...Object.values(protocol.codes), ...protocol.policy.PILOT_STOPS, "paid_mode_refused_in_ci"].includes(error?.code) ? error.code : null;
    stderr(error?.code === "E2_ARGUMENTS_INVALID" ? `${USAGE}\n` : `${paidCode ?? knownRefusalCode(error?.code) ?? proofRefusalCode(error?.code) ?? "E2_REFUSED"}\n`);
    return 1;
  }
}
let entry = false;
try { entry = realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* module import */ }
if (entry) process.exitCode = await main(process.argv.slice(2));
