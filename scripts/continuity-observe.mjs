#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { observe } from "./lib/continuity-observation-aggregate.mjs";

export { observe };
export async function main(argv = process.argv.slice(2)) {
  const usage = "Usage: node scripts/continuity-observe.mjs --manifest FILE --output NEW_DIRECTORY [--private-worklist FILE]";
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(`${usage}\n`); return 0; }
  const options = {}, names = { "--manifest": "manifest", "--output": "output", "--private-worklist": "privateWorklist" };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (!name || options[name] || !argv[i + 1] || argv[i + 1].startsWith("--")) { process.stderr.write(`${usage}\n`); return 1; }
    options[name] = argv[i + 1];
  }
  if (!options.manifest || !options.output) { process.stderr.write(`${usage}\n`); return 1; }
  try { await observe(options); process.stdout.write("Continuity observation written.\n"); return 0; }
  catch (e) {
    // Never echo database/parser errors, paths, arguments or source text.
    const codes = ["INVALID_MANIFEST", "INVALID_SNAPSHOT", "INVALID_STRATA", "DUPLICATE_SNAPSHOT", "UNSUPPORTED_WEB_SCHEMA", "UNSUPPORTED_SIDECAR_SCHEMA", "UNSUPPORTED_TABLE_SCHEMA", "UNSUPPORTED_JOURNAL_SCHEMA", "INVALID_JOURNAL_RECORD", "INVALID_REVIEW", "UNMATCHED_REVIEW", "REVIEW_WINDOW_EXCLUDED", "PRIVATE_WORKLIST_PATH_REFUSED", "OUTPUT_PATH_REFUSED", "SNAPSHOT_CHANGED", "TURN_EVENT_LIMIT", "INPUT_LINE_TOO_LARGE", "INCOMPLETE_JSON_LINE", "INVALID_JSON_LINE", "INVALID_JSON", "INPUT_TOO_LARGE", "INVALID_TURN_TIMESTAMP", "INVALID_EXPORT", "INPUT_NOT_FILE", "INVALID_INPUT_PATH", "INVALID_SOURCE_ID", "INVALID_SQLITE_HEADER", "NON_STANDALONE_SNAPSHOT", "OVERLAPPING_SNAPSHOTS", "INVALID_AGENT_BINDING", "SIDECAR_AGENT_BINDING_REQUIRED", "SIDECAR_AGENT_BINDING_MISMATCH", "PRIVATE_WORKLIST_DIRECTORY_REFUSED"];
    const code = codes.includes(e.code) ? e.code : "OBSERVATION_REFUSED";
    process.stderr.write(`Continuity observation refused: ${code}.\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
