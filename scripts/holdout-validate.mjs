#!/usr/bin/env node
import { loadHoldoutSpec } from "./lib/continuity-holdout-generator.mjs";
import { externalFile, parseFlags, runCli, sha256 } from "./lib/continuity-holdout-files.mjs";

export async function main(argv) {
  const flags = parseFlags(argv, ["--spec-dir", "--schema-only"], ["--statistical-spec"]);
  if (!flags["--schema-only"]) throw new Error("schema_only_required");
  const bytes = flags["--statistical-spec"] !== undefined ? await externalFile(flags["--statistical-spec"]) : null;
  const spec = await loadHoldoutSpec(flags["--spec-dir"], bytes ? JSON.parse(bytes) : undefined);
  console.log(JSON.stringify({ pass: true, families: spec.families.length, scope: "schema-only", design: bytes ? { statisticalSpecSha256: sha256(bytes) } : "checked-in" }));
}
await runCli(import.meta.url, main);
