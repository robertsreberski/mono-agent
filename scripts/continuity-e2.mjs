#!/usr/bin/env node
// Offline preparation only. Paid authority is not an argument this CLI accepts.
import { realpathSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { fail, inputPath } from "./lib/continuity-observation-input.mjs";
import { privateOutput } from "./lib/continuity-recorded-import.mjs";
import { MAX_SOURCE_BYTES } from "./lib/continuity-recorded-schema.mjs";
import { diagnosticRecord } from "./lib/continuity-e2-diagnostics.mjs";
import { scoreE2 } from "./lib/continuity-e2-score.mjs";
export const USAGE = "Usage: node scripts/continuity-e2.mjs size --source DIR --protocol FILE --output NEW_DIR [--summary faux-short|faux-max] [--diagnostics NEW_FILE]\n       node scripts/continuity-e2.mjs score --answers FILE --keys FILE --output NEW_DIR\n       node scripts/continuity-e2.mjs run (unavailable)";
export function parseE2Args(argv) {
  const [command, ...rest] = argv;
  if (command === "run") fail("E2_PAID_ENTRY_UNAVAILABLE");
  const required = command === "size" ? ["source", "protocol", "output"] : command === "score" ? ["answers", "keys", "output"] : null;
  if (!required) fail("E2_ARGUMENTS_INVALID");
  const result = { command }, allowed = [...required, ...(command === "size" ? ["summary", "diagnostics"] : [])];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith("--") || !allowed.includes(key) || !rest[i + 1] || rest[i + 1].startsWith("--") || Object.hasOwn(result, key)) fail("E2_ARGUMENTS_INVALID");
    result[key] = rest[i + 1];
  }
  if (required.some(k => !result[k]) || result.summary !== undefined && !["faux-short", "faux-max"].includes(result.summary)) fail("E2_ARGUMENTS_INVALID");
  return result;
}
function readJSON(path) {
  if (statSync(path).size > MAX_SOURCE_BYTES) fail("E2_INPUT_TOO_LARGE");
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { fail("E2_INPUT_INVALID"); }
}
const CODES = new Set(["E2_SOURCE_REIMPORT_REQUIRED", "E2_SOURCE_REPLY_REFUSED", "E2_DIAGNOSTICS_REFUSED", "E2_STEER_INVALID", "E2_STEER_REFUSED", "E2_STEER_NOT_DELIVERED", "E2_PAID_ENTRY_UNAVAILABLE", "E2_ESTIMATOR_BUILD_REQUIRED", "E2_PROTOCOL_INVALID", "E2_SOURCE_PARTS_INVALID", "E2_SOUL_MISMATCH", "E2_SUMMARY_ROUTE_INVALID", "E2_MODEL_UNREGISTERED", "E2_COMPACTION_LIMIT", "E2_COMPACTION_LIFECYCLE_INVALID", "E2_COMPACTION_NOT_DURABLE", "E2_SOURCE_REQUEST_LIMIT", "E2_SUMMARY_NOT_AUTHORIZED", "E2_SUMMARY_OPTIONS_INVALID", "E2_SUMMARY_REQUEST_LIMIT", "E2_MODELS_METHOD_REFUSED", "E2_SNAPSHOT_PATH_REFUSED", "E2_SNAPSHOT_MISMATCH", "E2_ASSISTANT_SOURCE_UNAVAILABLE", "E2_OWNER_SOURCE_UNAVAILABLE", "E2_RECORDED_ARGUMENTS_UNAVAILABLE", "E2_TOOL_CALL_MISMATCH", "E2_PROBE_REQUEST_LIMIT", "E2_PROBE_TOOLS_REFUSED", "E2_PROBE_SUMMARY_FORBIDDEN", "E2_HISTORY_DEGRADED", "E2_MODELS_SEAM_REFUSED", "E2_BOUNDARY_MISMATCH", "E2_REPLAY_FAILED", "E2_CHECKPOINT_MODEL_INVALID", "E2_CHECKPOINT_POSITION_INVALID", "E2_PROBE_FAILED", "E2_SCORING_INVALID", "E2_INPUT_TOO_LARGE", "E2_INPUT_INVALID", "RECORDED_OUTPUT_REFUSED", "RECORDED_REPLAY_COVERAGE_GAP", "RECORDED_TOOL_COVERAGE_GAP", "RECORDED_AMBIGUOUS_PARALLEL_GROUP", "RECORDED_TOOL_COLLISION", "EEXIST"]);
export async function main(argv, { stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout(`${USAGE}\n`); return 0; }
  let diagnosticPath, diagnostic = diagnosticRecord();
  try {
    const args = parseE2Args(argv);
    if (args.command === "size") {
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
      try { writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic)}\n`, { flag: "wx", mode: 0o600 }); }
      catch { stderr("E2_DIAGNOSTICS_REFUSED\n"); return 1; }
    }
    stderr(error?.code === "E2_ARGUMENTS_INVALID" ? `${USAGE}\n` : `${CODES.has(error?.code) ? error.code : "E2_REFUSED"}\n`);
    return 1;
  }
}
let entry = false;
try { entry = realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* module import */ }
if (entry) process.exitCode = await main(process.argv.slice(2));
