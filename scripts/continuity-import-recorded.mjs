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
export async function main(argv, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  try { stdout(`${JSON.stringify(await importRecorded(parseArgs(argv)))}\n`); return 0; }
  catch (error) { stderr(error.code === "RECORDED_REDACTION_BUILD_REQUIRED" ? "RECORDED_REDACTION_BUILD_REQUIRED\n" : "RECORDED_IMPORT_REFUSED\n"); return 1; }
}
let entry = false;
try { entry = realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url); } catch { /* imported module */ }
if (entry) process.exitCode = await main(process.argv.slice(2));
