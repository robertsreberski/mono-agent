#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { simulatePower, powerMarkdown } from "./lib/continuity-holdout-power.mjs";
import { jsonBytes, parseFlags, runCli, readJson } from "./lib/continuity-holdout-files.mjs";
export async function main(argv) {
  const f = parseFlags(argv, ["--seed", "--replications", "--output", ...(argv.includes("--statistical-spec") ? ["--statistical-spec"] : [])]);
  const report = simulatePower({ seed: Number(f["--seed"]), replications: Number(f["--replications"]), ...(f["--statistical-spec"] ? { statisticalSpec: await readJson(f["--statistical-spec"]) } : {}) }), dir = resolve(f["--output"]);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(dir, "power.json"), jsonBytes(report), { flag: "wx", mode: 0o600 });
  await writeFile(resolve(dir, "power.md"), powerMarkdown(report), { flag: "wx", mode: 0o600 });
  console.log(jsonBytes(report).trim());
}
await runCli(import.meta.url, main);
