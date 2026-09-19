#!/usr/bin/env node
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import { CORPORA, loadCorpus, makePlan } from "./lib/memory-e2e-dataset.mjs";
import { ownedParent, writeArtifacts } from "./lib/memory-e2e-report.mjs";

import { prepareRealBuild, sourceState, verifyRealBuild } from "./lib/memory-e2e-build.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
export function parseArguments(argv) {
  const flags = {};
  const boolean = new Set(["dry-run", "real", "help"]);
  const valued = new Set(["corpus", "split", "reader", "extractor", "embedding-provider", "embedding-model", "dimension", "confirm-plan", "pi-auth-path"]);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/u, "");
    if (argv[i] !== `--${key}` || Object.hasOwn(flags, key) || (!boolean.has(key) && !valued.has(key))) throw new Error("invalid_arguments");
    flags[key] = boolean.has(key) ? true : argv[++i];
    if (flags[key] === undefined || (valued.has(key) && flags[key].startsWith("--"))) throw new Error("missing_argument");
  }
  return flags;
}
export function profileFrom(flags) {
  const keys = ["reader", "extractor", "embedding-provider", "embedding-model", "dimension"];
  if (![...keys, "pi-auth-path"].some((key) => flags[key] !== undefined)) return null;
  if (!keys.every((key) => typeof flags[key] === "string")) throw new Error("incomplete_profile");
  for (const key of ["reader", "extractor", "embedding-model"]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,159}$/u.test(flags[key]) || flags[key].includes("..")) throw new Error("invalid_model_reference");
  }
  if (!["reader", "extractor"].every((key) => flags[key].includes(":"))) throw new Error("invalid_model_reference");
  if (!["ollama", "lmstudio", "openai"].includes(flags["embedding-provider"])) throw new Error("invalid_embedding_provider");
  const dimension = Number(flags.dimension);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 8192) throw new Error("invalid_dimension");
  // Execution-only credential-file selection: validated here, fingerprinted
  // into the plan by makePlan, and consumed only by realProviders after real-
  // run confirmation. Never serialized into plans or reports.
  let piAuthPath;
  if (flags["pi-auth-path"] !== undefined) {
    if (typeof flags["pi-auth-path"] !== "string") throw new Error("incomplete_profile");
    piAuthPath = flags["pi-auth-path"].trim();
    if (piAuthPath.length === 0 || /[\0-\x1f\x7f]/u.test(flags["pi-auth-path"])) throw new Error("invalid_pi_auth_path");
  }
  return { reader: flags.reader, extractor: flags.extractor, embeddingProvider: flags["embedding-provider"], embeddingModel: flags["embedding-model"], dimension, ...(piAuthPath === undefined ? {} : { piAuthPath }) };
}

export async function main(argv = process.argv.slice(2), { stdout = console.log, prepareBuild = prepareRealBuild } = {}) {
  const flags = parseArguments(argv);
  if (flags.help) {
    stdout("memory-e2e-benchmark [--dry-run] [--corpus fictional-v1|bujo-learning-v1] [--split development|evaluation] [--pi-auth-path PATH]\nDefault: scripted offline production-path contract, NOT model quality.\nReal execution: --real --reader provider:model --extractor provider:model --embedding-provider ollama|lmstudio|openai --embedding-model model --dimension N [--pi-auth-path PATH] --confirm-plan SHA256\nOAuth chat routes need --pi-auth-path pointing at an existing Pi auth file (for example the standard Pi auth file; consumers may use different paths). Without it the runtimes keep ambient environment auth. The raw path never enters plans or reports; only its fingerprint binds the confirmation.\nFirst obtain SHA256 with the same profile and --dry-run. Outputs stay under .worklab-tmp/memory-e2e. No dataset downloads or consumer configuration.");
    return 0;
  }
  const { head } = sourceState(ROOT);
  const corpusName = flags.corpus ?? "fictional-v1";
  if (!CORPORA.includes(corpusName)) throw new Error("invalid_corpus_name");
  const loaded = await loadCorpus(corpusName);
  const profile = profileFrom(flags);
  const plan = makePlan({ ...loaded, split: flags.split ?? "development", profile, codeRevision: head });
  if (flags["dry-run"]) { stdout(JSON.stringify(plan, null, 2)); return 0; }
  if (flags.real && (!profile || flags["confirm-plan"] !== plan.confirmation)) throw new Error("real_execution_requires_confirmed_profile");
  if (!flags.real && (profile || flags["confirm-plan"])) throw new Error("profile_requires_explicit_real_mode");
  // Fresh source-pinned build precedes ALL production imports and provider construction.
  const build = flags.real ? await prepareBuild(ROOT, head) : { policy: "unverified-existing-dist", sourceHead: null, outputSha256: null };
  if (flags.real) await verifyRealBuild(ROOT, build);
  // Confirmation and source validation precede importing any runtime/provider module.
  const { productionModules, runBenchmark } = await import("./lib/memory-e2e-runner.mjs");
  const { realProviders, scriptedProviders } = await import("./lib/memory-e2e-providers.mjs");
  const modules = await productionModules();
  if (flags.real) await verifyRealBuild(ROOT, build);
  const { dirty } = sourceState(ROOT);
  const directory = await mkdtemp(join(await ownedParent(ROOT), "run-"));
  const kind = flags.real ? "real" : "scripted";
  const bundle = await runBenchmark({ ...loaded, plan, directory, modules, kind,
    providerFactory: flags.real ? async (input) => {
      await verifyRealBuild(ROOT, build);
      return realProviders(profile, input);
    } : scriptedProviders,
  });
  bundle.manifest.code = { head, dirty, node: process.version, build };
  await writeArtifacts(directory, bundle);
  stdout(JSON.stringify({ output: relative(ROOT, directory), summary: bundle.summary }, null, 2));
  return bundle.trials.some((trial) => !["completed", "not_applicable"].includes(trial.status)) ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
    // The report is durable before ending this standalone CLI. Even successful
    // transports can retain handles; process exit is not provider cancellation.
    process.stdout.write("", () => process.exit(code));
  }).catch(() => {
    // Raw runtime/config failures can contain credentials and paths.
    console.error("memory-e2e: failed; check flags, built dependency closure, and the owned report if present. No quality result is implied.");
    process.exitCode = 1;
    process.stderr.write("", () => process.exit(1));
  });
}
