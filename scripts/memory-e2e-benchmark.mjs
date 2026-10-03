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
  const boolean = new Set(["dry-run", "real", "help", "allow-hosted-locomo-transfer", "allow-measured-output"]);
  const valued = new Set(["corpus", "dataset", "split", "reader", "extractor", "embedding-provider", "embedding-model", "dimension", "confirm-plan", "pi-auth-path", "locomo-experiment", "locomo-arm", "reuse-artifact"]);
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
    stdout("memory-e2e-benchmark [--dry-run] [--corpus fictional-v1|bujo-learning-v1|capture-fidelity-v1|locomo-v1] [--dataset PATH] [--split development|evaluation] [--pi-auth-path PATH] [--allow-hosted-locomo-transfer] [--allow-measured-output] [--locomo-experiment locomo-bujo-eval-v1-rank5-development-30|locomo-bujo-eval-v1-rank6-confirmation-20] [--locomo-arm full-history|bujo|both] [--reuse-artifact PATH]\nDefault: scripted offline production-path contract, NOT model quality. LoCoMo requires a separately downloaded, pinned --dataset file and is CC BY-NC 4.0 noncommercial-only input.\nReal execution: --real --reader provider:model --extractor provider:model --embedding-provider ollama|lmstudio|openai --embedding-model model --dimension N [--pi-auth-path PATH] [--allow-measured-output] --confirm-plan SHA256\n--allow-measured-output is an explicit plan-bound opt-in for a provider whose output is measured but not wire-capped; ordinary strict execution keeps refusing that route. Within one successful LoCoMo invocation, capture runs once and questions use independent histories. --reuse-artifact reuses only an exact completed result; it cannot resume capture or readers from an incomplete run. A dry-plan confirmation is not execution authorization. Hosted LoCoMo is rejected unless --allow-hosted-locomo-transfer affirmatively selects the documented Luna chat/local bge-m3 profile.\nFirst obtain SHA256 with the same profile and flags in --dry-run. Outputs stay under .worklab-tmp/memory-e2e. The benchmark never downloads datasets or changes consumer configuration.");
    return 0;
  }
  const { head } = sourceState(ROOT);
  const corpusName = flags.corpus ?? "fictional-v1";
  const locomo = corpusName === "locomo-v1";
  if (!locomo && !CORPORA.includes(corpusName)) throw new Error("invalid_corpus_name");
  if (!locomo && flags.dataset !== undefined) throw new Error("dataset_requires_external_corpus");
  if (!locomo && flags["locomo-experiment"] !== undefined) throw new Error("locomo_experiment_requires_locomo");
  if (!locomo && flags["locomo-arm"] !== undefined) throw new Error("locomo_arm_requires_locomo");
  if (!locomo && flags["reuse-artifact"] !== undefined) throw new Error("reuse_artifact_requires_locomo");
  const split = flags.split ?? (locomo ? "evaluation" : "development");
  const profile = profileFrom(flags);
  if (flags["allow-measured-output"] && profile === null) throw new Error("measured_output_requires_profile");
  const selectedProfile = profile === null || !flags["allow-measured-output"]
    ? profile : { ...profile, outputBudgetMode: "measured" };
  if (!locomo && flags["allow-hosted-locomo-transfer"]) throw new Error("hosted_locomo_transfer_ack_requires_locomo");
  const locomoAdapter = locomo ? await import("./lib/memory-e2e-locomo.mjs") : null;
  const executionProfile = locomo
    ? locomoAdapter.locomoExecutionProfile(selectedProfile, { allowHostedTransfer: flags["allow-hosted-locomo-transfer"] === true })
    : selectedProfile;
  const experiment = locomo ? flags["locomo-experiment"] ?? locomoAdapter.LOCOMO_DEVELOPMENT_EXPERIMENT : null;
  const loaded = locomo
    ? await locomoAdapter.loadLocomo(flags.dataset, { experiment })
    : await loadCorpus(corpusName);
  const plan = locomo
    ? locomoAdapter.makeLocomoPlan({ ...loaded, split, profile: executionProfile, codeRevision: head, arm: flags["locomo-arm"] ?? "both" })
    : makePlan({ ...loaded, split, profile: executionProfile, codeRevision: head });
  if (flags["dry-run"]) {
    if (flags["reuse-artifact"] !== undefined) throw new Error("reuse_artifact_requires_real_mode");
    stdout(JSON.stringify(plan, null, 2)); return 0;
  }
  if (flags.real && (!profile || flags["confirm-plan"] !== plan.confirmation)) throw new Error("real_execution_requires_confirmed_profile");
  if (!flags.real && (profile || flags["confirm-plan"] || flags["reuse-artifact"])) throw new Error("profile_requires_explicit_real_mode");
  if (flags["reuse-artifact"] !== undefined) {
    const { loadReusableArtifact } = await import("./lib/memory-e2e-checkpoint.mjs");
    const reused = await loadReusableArtifact(flags["reuse-artifact"], plan);
    stdout(JSON.stringify(reused, null, 2));
    return 0;
  }
  // A confirmed plan is not permission to pretend a reservation is a hard cap.
  // Refuse known-unsupported strict providers before build, credentials, or any
  // provider construction; the dry-run manifest carries the same limitation.
  if (flags.real && plan.budgetEnforcement?.outputTokens?.strictRealExecutionSupported === false
    && plan.budgetEnforcement.outputTokens.executionMode !== "measured_output_explicit_opt_in") {
    throw new Error("strict_output_budget_unsupported");
  }
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
      return realProviders(executionProfile, input);
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
