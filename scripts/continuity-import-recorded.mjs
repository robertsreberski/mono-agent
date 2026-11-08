#!/usr/bin/env node
// Private, explicit-snapshot import only. No replay or provider capability.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { fail } from "./lib/continuity-observation-input.mjs";
import { importRecorded } from "./lib/continuity-recorded-import.mjs";

export function parseArgs(argv) {
  const flags = { "--manifest": "manifest", "--conversation": "conversation", "--output": "output" }, result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!Object.hasOwn(flags, argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--") || Object.hasOwn(result, flags[argv[i]])) fail("INVALID_RECORDED_ARGUMENTS");
    result[flags[argv[i]]] = argv[i + 1];
  }
  if (!result.manifest || !result.conversation || !result.output) fail("INVALID_RECORDED_ARGUMENTS");
  return result;
}
export const USAGE = "Usage: node scripts/continuity-import-recorded.mjs --manifest FILE --conversation ID --output NEW_DIRECTORY";
// Fixed codes only: never echo parser/SQLite/filesystem messages, paths or args.
const REFUSAL_CODES = new Set([
  "RECORDED_REDACTION_BUILD_REQUIRED", "RECORDED_MANIFEST_TOO_LARGE", "INVALID_RECORDED_MANIFEST",
  "INVALID_RECORDED_JOURNAL_BINDING", "RECORDED_OUTPUT_REFUSED", "EEXIST", "UNSUPPORTED_RECORDED_SCHEMA",
  "RECORDED_ROW_TOO_LARGE", "INVALID_RECORDED_CONVERSATION", "RECORDED_JOURNAL_BINDING_MISMATCH",
  "RECORDED_CAPACITY_EXCEEDED", "RECORDED_CONVERSATION_NOT_FOUND", "RECORDED_AGENT_AMBIGUOUS",
  "UNSUPPORTED_JOURNAL_SCHEMA", "INVALID_JOURNAL_RECORD", "INVALID_RECORDED_SOURCE", "INVALID_RECORDED_TOOL",
  "INVALID_RECORDED_STEP", "INVALID_RECORDED_GAP", "INVALID_RECORDED_INVENTORY", "INVALID_INPUT_PATH",
  "INPUT_NOT_FILE", "INVALID_SQLITE_HEADER", "NON_STANDALONE_SNAPSHOT", "UNSUPPORTED_WEB_SCHEMA",
  "UNSUPPORTED_SIDECAR_SCHEMA", "UNSUPPORTED_TABLE_SCHEMA", "INPUT_LINE_TOO_LARGE", "INVALID_JSON_LINE",
  "INCOMPLETE_JSON_LINE", "SNAPSHOT_CHANGED",
]);
export async function main(argv, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  if (argv.length === 1 && argv[0] === "--help") { stdout(`${USAGE}\n`); return 0; }
  try { stdout(`${JSON.stringify(await importRecorded(parseArgs(argv)))}\n`); return 0; }
  catch (error) {
    if (error?.code === "INVALID_RECORDED_ARGUMENTS") stderr(`${USAGE}\n`);
    else stderr(`${REFUSAL_CODES.has(error?.code) ? error.code : "RECORDED_IMPORT_REFUSED"}\n`);
    return 1;
  }
}
let entry = false;
try { entry = realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* imported module */ }
if (entry) process.exitCode = await main(process.argv.slice(2));
