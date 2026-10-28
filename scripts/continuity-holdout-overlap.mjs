#!/usr/bin/env node
import { resolve } from "node:path";
import { loadHoldoutSpec } from "./lib/continuity-holdout-generator.mjs";
import { checkHoldoutOverlap } from "./lib/continuity-holdout-overlap.mjs";
import { externalDirectory, jsonBytes, parseFlags, readJson, runCli, writeExclusive } from "./lib/continuity-holdout-files.mjs";

export async function main(argv) {
  const f = parseFlags(argv, ["--spec-dir", "--seeds", "--allowlist", "--output"]);
  const report = await checkHoldoutOverlap(await loadHoldoutSpec(f["--spec-dir"]), await readJson(f["--seeds"]), await readJson(f["--allowlist"]));
  const dir = await externalDirectory(f["--output"], true);
  await writeExclusive(resolve(dir, "overlap.json"), jsonBytes(report));
  console.log(jsonBytes({ pass: report.pass, overlaps: report.overlaps.length }).trim());
  if (!report.pass) process.exitCode = 1;
}
await runCli(import.meta.url, main);
