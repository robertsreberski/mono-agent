#!/usr/bin/env node
// Offline launcher: registration and checkout ownership are explicit, never latest-main fallbacks.
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./lib/continuity-lookup.mjs";
import { digest } from "./lib/continuity-dataset.mjs";
import { registerLookup, readRegistration, runLookupRoles, aggregateRoleFiles, requireLookup } from "./lib/continuity-lookup-roles.mjs";

export function parseLookupOptions(argv, valued) {
  // Refuse before reading a registration, build, catalog or credentials.
  requireLookup(!argv.some(arg => arg === "--real" || arg.startsWith("--real=")), "lookup_real_not_authorized");
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    requireLookup(valued.includes(flag) && !Object.hasOwn(flags, flag) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--"), "lookup_invalid_arguments");
    flags[flag] = argv[++i];
  }
  return flags;
}
export function workloadOptions(flags) {
  const number = (key, fallback) => {
    if (flags[key] === undefined) return fallback;
    const value = Number(flags[key]); requireLookup(Number.isSafeInteger(value), "lookup_invalid_arguments"); return value;
  };
  for (const key of ["--reader", "--reader-effort"]) requireLookup(flags[key] === undefined || flags[key].trim().length > 0, "lookup_empty_reader_option");
  const present = key => flags[key] !== undefined;
  const nonempty = (keys, code) => { for (const key of keys) requireLookup(!present(key) || typeof flags[key] === "string" && flags[key].trim().length > 0, code); };
  const sourceKeys = ["--corpus-manifest", "--manifest-sha256", "--statistical-spec"];
  nonempty(sourceKeys, "lookup_empty_source_option");
  nonempty(["--lookup-policy", "--lookup-policy-sha256"], "lookup_empty_policy_option");
  nonempty(["--output-limit", "--output-limit-source"], "lookup_empty_output_limit_option");
  nonempty(["--selection-seed", "--per-group"], "lookup_empty_selection_option");
  nonempty(["--r0", "--rpack"], "lookup_empty_input_root_option");
  nonempty(["--catalog-cap-usd"], "lookup_empty_catalog_cap_option");
  requireLookup(present("--r0") === present("--rpack"), "lookup_input_roots_required");
  requireLookup(present("--lookup-policy") === present("--lookup-policy-sha256"), "lookup_policy_hash_required");
  requireLookup(present("--output-limit") === present("--output-limit-source"), "lookup_output_limit_required");
  requireLookup(!sourceKeys.some(present) || sourceKeys.every(present), "lookup_source_required");
  return { ...(present("--corpus-manifest") ? { lookupSource: { manifestPath: flags["--corpus-manifest"], manifestSha256: flags["--manifest-sha256"], statisticalSpecPath: flags["--statistical-spec"] } } : {}),
    ...(present("--lookup-policy") ? { policyPath: flags["--lookup-policy"], policySha256: flags["--lookup-policy-sha256"] } : {}),
    ...(present("--output-limit") ? { outputLimit: { tokens: number("--output-limit"), source: flags["--output-limit-source"] } } : {}),
    ...(present("--catalog-cap-usd") ? { catalogCapUSD: Number(flags["--catalog-cap-usd"]) } : {}),
    suites: flags["--suites"]?.split(",") ?? (present("--corpus-manifest") ? ["holdout"] : ["original", "hard", "hard-distractors"]),
    ...(flags["--selection-seed"] !== undefined ? { selectionSeed: number("--selection-seed"), perGroup: number("--per-group", 2) } : {}),
    ...(present("--r0") && present("--rpack") ? { inputRoots: [flags["--r0"], flags["--rpack"]] } : {}),
    traceIds: flags["--traces"]?.split(",") ?? null, repeats: number("--repeats", 1), probeLimit: number("--probe-limit", null),
    ...(flags["--reader"] !== undefined ? { reader: flags["--reader"] } : {}), ...(flags["--reader-effort"] !== undefined ? { readerEffort: flags["--reader-effort"] } : {}) };
}
/** Resolve the nearest existing ancestor, including symlink aliases, before writing. */
export async function lookupOutputPath(output, roots) {
  requireLookup(isAbsolute(output ?? ""), "lookup_output_must_be_absolute");
  let ancestor = output; const missing = [];
  for (;;) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  }
  const canonical = join(ancestor, ...missing);
  for (const root of roots) {
    requireLookup(isAbsolute(root ?? ""), "lookup_invalid_checkout_binding");
    const path = relative(await realpath(root), canonical);
    requireLookup(path !== "" && (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)), "lookup_output_inside_checkout");
  }
  // Use this resolved path for writes too; do not re-traverse the original alias.
  return canonical;
}
export const WORKLOAD_FLAGS = ["--selection-seed", "--per-group", "--r0", "--rpack","--suites", "--traces", "--repeats", "--probe-limit", "--reader", "--reader-effort", "--corpus-manifest", "--manifest-sha256", "--statistical-spec", "--lookup-policy", "--lookup-policy-sha256", "--output-limit", "--output-limit-source", "--catalog-cap-usd"];
const HELP = `continuity-lookup-compare (offline only)
  register --r0 PATH --r0-revision FULL_SHA --rpack PATH --rpack-revision FULL_SHA --output NEW_DIR
           [--suites original,hard,hard-distractors] [--traces ID,...] [--probe-limit N] [--repeats N]
           [--reader REF] [--reader-effort low]
  run --registration FILE --sha256 FILE_SHA256 --output NEW_ABSOLUTE_DIR
  aggregate --registration FILE --sha256 FILE_SHA256 --output EXISTING_ABSOLUTE_DIR
External workload: --suites holdout --corpus-manifest FILE --manifest-sha256 SHA --statistical-spec FILE
  --selection-seed N [--per-group 2] --lookup-policy FILE --lookup-policy-sha256 SHA
  --output-limit N --output-limit-source enforced|catalog_max --catalog-cap-usd C (register)
  External registration uses one repeat, fixed-policy feasibility and a run-wide proposed cap; no legacy gates.
Both checkouts must implement continuity-lookup-role-v1. Registration always builds the app closure.
Registration/run output directories must be outside both checkouts (symlinks resolved).
No provider calls, fetch, checkout, cherry-pick, significance claims or spending authorization.`;
export async function main(argv = process.argv.slice(2), { stdout = console.log } = {}) {
  if (!argv.length || argv.length === 1 && argv[0] === "--help") { stdout(HELP); return 0; }
  requireLookup(!argv.includes("--real"), "lookup_real_not_authorized");
  const [command, ...args] = argv;
  requireLookup(["register", "run", "aggregate"].includes(command), "lookup_invalid_command");
  const flags = parseLookupOptions(args, command === "register" ? ["--r0", "--r0-revision", "--rpack", "--rpack-revision", "--output", ...WORKLOAD_FLAGS]
    : ["--registration", "--sha256", "--output"]);
  requireLookup(isAbsolute(flags["--output"] ?? ""), "lookup_output_must_be_absolute");
  if (command === "register") {
    const workload = workloadOptions(flags);
    const output = await lookupOutputPath(flags["--output"], [flags["--r0"], flags["--rpack"]]);
    // Exclusively reserve before either checkout can build, not after expensive work.
    try { await mkdir(output, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") requireLookup(false, "lookup_output_exists"); throw error; }
    const registration = await registerLookup({ checkouts: {
      R0: { path: flags["--r0"], revision: flags["--r0-revision"] }, Rpack: { path: flags["--rpack"], revision: flags["--rpack-revision"] },
    }, ...workload });
    const path = join(output, "registration.json");
    await writeFile(path, `${JSON.stringify(registration, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    stdout(JSON.stringify({ registration: path, sha256: sha256(await readFile(path)), registrationDigest: digest(registration) })); return 0;
  }
  const registration = await readRegistration(flags["--registration"], flags["--sha256"]);
  const output = command === "run" ? await lookupOutputPath(flags["--output"], Object.values(registration.codes).map(code => code.path)) : flags["--output"];
  const result = command === "run" ? await runLookupRoles(registration, output, { onProgress: stage => process.stderr.write(`lookup role: ${stage}\n`) })
    : await aggregateRoleFiles(registration, output);
  stdout(JSON.stringify({ output, coverage: result.coverage, qualityMeasured: false }));
  return result.coverage.completed === result.coverage.planned && result.coverage.duplicate === 0 ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`continuity-lookup-compare: ${typeof error?.code === "string" ? error.code : "failed"}`); process.exitCode = 1; });
}
