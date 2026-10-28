#!/usr/bin/env node
import { loadHoldoutSpec } from "./lib/continuity-holdout-generator.mjs";
import { parseFlags, runCli } from "./lib/continuity-holdout-files.mjs";

export async function main(argv) {
  const flags = parseFlags(argv, ["--spec-dir", "--schema-only"]);
  if (!flags["--schema-only"]) throw new Error("schema_only_required");
  const spec = await loadHoldoutSpec(flags["--spec-dir"]);
  console.log(JSON.stringify({ pass: true, families: spec.families.length, scope: "schema-only" }));
}
await runCli(import.meta.url, main);
