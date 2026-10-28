#!/usr/bin/env node
import { resolve } from "node:path";
import { registerFrozenHoldout } from "./lib/continuity-holdout-registration.mjs";
import { externalDirectory, jsonBytes, parseFlags, runCli, sha256, toolingRevision, writeExclusive } from "./lib/continuity-holdout-files.mjs";
export async function main(argv) {
  const f = parseFlags(argv, ["--corpus-manifest", "--manifest-sha256", "--statistical-spec", "--seed", "--reader", "--extractor", "--alternate", "--output"]);
  const registration = await registerFrozenHoldout({ manifestPath: f["--corpus-manifest"], manifestSha256: f["--manifest-sha256"], statisticalSpecPath: f["--statistical-spec"], seed: Number(f["--seed"]),
    models: { reader: f["--reader"], extractor: f["--extractor"], alternate: f["--alternate"], readerEffort: "low", judge: null }, codeRevision: toolingRevision() });
  const bytes = jsonBytes(registration), dir = await externalDirectory(f["--output"], true);
  await writeExclusive(resolve(dir, "registration.json"), bytes);
  console.log(jsonBytes({ registrationSha256: sha256(bytes), shards: registration.shards.length }).trim());
}
await runCli(import.meta.url, main);
