#!/usr/bin/env node
// Offline preparation only. Paid authority is not an argument this CLI accepts.
import { realpathSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { fail, inputPath } from "./lib/continuity-observation-input.mjs";
import { privateOutput } from "./lib/continuity-recorded-import.mjs";
import { MAX_SOURCE_BYTES } from "./lib/continuity-recorded-schema.mjs";
import { diagnosticRecord, errorDiagnostic, knownRefusalCode } from "./lib/continuity-e2-diagnostics.mjs";
import { proofRefusalCode } from "./lib/continuity-e2-checks.mjs";
import { scoreE2 } from "./lib/continuity-e2-score.mjs";
import { estimateE2SizingSet } from "./lib/continuity-e2-sizing.mjs";
import { loadE2Catalog } from "./lib/continuity-e2-pricing.mjs";
export const USAGE = "Usage: node scripts/continuity-e2.mjs size --source DIR --protocol FILE --output NEW_DIR [--summary faux-short|faux-max] [--diagnostics NEW_FILE]\n       node scripts/continuity-e2.mjs score --answers FILE --keys FILE --output NEW_DIR\n       node scripts/continuity-e2.mjs proofs --output NEW_DIR [--arm switch|cancel|idle|pressure|all] [--diagnostics NEW_FILE]\n       node scripts/continuity-e2.mjs --estimate --protocol FILE --limits FILE --sizing FILE [--sizing FILE...] --output NEW_DIR\n       node scripts/continuity-e2.mjs run (unavailable)";
export function parseE2Args(argv) {
  const [selected, ...rest] = argv;
  const command = selected === "--estimate" ? "estimate" : selected;
  if (command === "run" || command === "proofs" && rest.includes("--real")) fail("E2_PAID_ENTRY_UNAVAILABLE");
  const required = command === "size" ? ["source", "protocol", "output"] : command === "score" ? ["answers", "keys", "output"] : command === "proofs" ? ["output"] : command === "estimate" ? ["protocol", "limits", "sizing", "output"] : null;
  if (!required) fail("E2_ARGUMENTS_INVALID");
  const result = { command }, allowed = [...required, ...(command === "size" ? ["summary", "diagnostics"] : command === "proofs" ? ["arm", "diagnostics"] : [])];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !allowed.includes(key) || !rest[i + 1] || rest[i + 1].startsWith("--") || Object.hasOwn(result, key) && !(command === "estimate" && key === "sizing")) fail("E2_ARGUMENTS_INVALID");
    if (command === "estimate" && key === "sizing") (result.sizing ??= []).push(rest[i + 1]);
    else result[key] = rest[i + 1];
  }
  if (required.some(k => !result[k]) || result.summary !== undefined && !["faux-short", "faux-max"].includes(result.summary)) fail("E2_ARGUMENTS_INVALID");
  if (command === "estimate" && result.sizing.length > 8) fail("E2_ARGUMENTS_INVALID");
  if (result.arm !== undefined && !["switch", "cancel", "idle", "pressure", "all"].includes(result.arm)) fail("E2_ARGUMENTS_INVALID");
  return result;
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
    if (args.command === "estimate") {
      const protocol = inputPath(process.cwd(), args.protocol), limits = inputPath(process.cwd(), args.limits);
      const sizing = args.sizing.map(path => inputPath(process.cwd(), path));
      const output = privateOutput(args.output, [protocol, limits, ...sizing]);
      const registered = readJSON(limits);
      if (registered?.schema !== "continuity-e2-estimate-limits-v1" || Object.keys(registered).sort().join() !== "probeCounts,roles,schema") fail("E2_ESTIMATE_INVALID");
      const report = estimateE2SizingSet({ protocol: readJSON(protocol), roles: registered.roles, probeCounts: registered.probeCounts, records: sizing.map(readJSON), catalog: await loadE2Catalog() });
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
      const records = await runE2Proofs({ output, arm: args.arm });
      stdout(`${JSON.stringify({ arms: records.length, variants: records.reduce((n, r) => n + r.report.variants.length, 0), requests: records.reduce((n, r) => n + r.sizing.variants.reduce((m, v) => m + v.requests.length, 0), 0) })}\n`);
    } else if (args.command === "size") {
      const sourceFile = inputPath(process.cwd(), join(args.source, "source.json")), protocolFile = inputPath(process.cwd(), args.protocol);
      const output = privateOutput(args.output, [sourceFile, protocolFile]);
      if (args.diagnostics) {
        diagnosticPath = privateOutput(args.diagnostics, [sourceFile, protocolFile]);
        if (diagnosticPath === output) { diagnosticPath = undefined; fail("E2_DIAGNOSTICS_REFUSED"); }
      }
      const { runE2Sizing } = await import("./lib/continuity-e2-replay.mjs");
      const report = await runE2Sizing({ source: readJSON(sourceFile), protocol: readJSON(protocolFile), output, summary: args.summary, onDiagnostic: value => { diagnostic = diagnosticRecord(value); } });
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
      try { const record = diagnosticRecord({ ...diagnostic, ...errorDiagnostic(error) }); record.errorCode ??= proofRefusalCode(error?.code); writeFileSync(diagnosticPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); }
      catch { stderr("E2_DIAGNOSTICS_REFUSED\n"); return 1; }
    }
    stderr(error?.code === "E2_ARGUMENTS_INVALID" ? `${USAGE}\n` : `${knownRefusalCode(error?.code) ?? proofRefusalCode(error?.code) ?? "E2_REFUSED"}\n`);
    return 1;
  }
}
let entry = false;
try { entry = realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* module import */ }
if (entry) process.exitCode = await main(process.argv.slice(2));
