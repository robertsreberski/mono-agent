#!/usr/bin/env node
import { loadContext, preparePlans, joinShards, need } from "../lib/continuity-holdout-workflow.mjs";
import { runController } from "../lib/continuity-holdout-controller.mjs";
import { offlineProof } from "../lib/continuity-holdout-proof.mjs";
import { runCli, readJson } from "../lib/continuity-holdout-files.mjs";

const names = { "corpus-manifest": "manifestPath", "manifest-sha256": "manifestSha256", registration: "registrationPath",
  "registration-sha256": "registrationSha256", "statistical-spec": "statisticalSpecPath", "pi-auth-path": "piAuthPath",
  output: "output", shard: "shard", authorization: "authorizationPath", "deadline-seconds": "deadlineSeconds",
  concurrency: "concurrency", "shard-roots": "shardRoots", audit: "auditPath" };
export async function main(argv) {
  const [command, ...args] = argv;
  need(["plan", "run", "join", "proof"].includes(command), "expected_plan_run_join_or_proof");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i].replace(/^--/u, "")];
    need(args[i].startsWith("--") && key && !Object.hasOwn(options, key) && args[i + 1] && !args[i + 1].startsWith("--"), "invalid_arguments");
    options[key] = args[i + 1];
  }
  need(["manifestPath", "manifestSha256", "registrationPath", "registrationSha256", "statisticalSpecPath", "piAuthPath", "output"].every(k => options[k]), "missing_argument");
  need(command !== "run" || options.shard && options.authorizationPath, "missing_argument");
  need(command !== "join" || options.shardRoots, "missing_argument");
  const context = await loadContext(options);
  let result;
  if (command === "plan") result = await preparePlans(context, options.output);
  if (command === "run") result = await runController(context, { ...options, shard: Number(options.shard),
    deadlineMs: Number(options.deadlineSeconds ?? 1500) * 1000, concurrency: Number(options.concurrency ?? 4) });
  if (command === "join") {
    const roots = await readJson(options.shardRoots); need(Array.isArray(roots) && roots.every(r => typeof r === "string"), "invalid_shard_roots");
    result = await joinShards(context, roots, options.output, options.auditPath);
  }
  if (command === "proof") result = await offlineProof(context, options.output);
  console.log(JSON.stringify(command === "plan" ? result : { output: options.output,
    ...(command === "run" ? { stop: result.stop, spend: result.spend } : {}),
    ...(command === "join" ? { decision: result.statistics.decision } : {}), ...(command === "proof" ? { qualityMeasured: false, passed: true } : {}) }, null, 2));
  return result;
}
await runCli(import.meta.url, main);
