#!/usr/bin/env node
import { loadContext, preparePlans, joinShards, need } from "../lib/continuity-holdout-workflow.mjs";
import { runController } from "../lib/continuity-holdout-controller.mjs";
import { exportAudit } from "../lib/continuity-holdout-audit.mjs";
import { importAudit } from "../lib/continuity-holdout-auditors.mjs";
import { finalReport } from "../lib/continuity-holdout-report.mjs";
import { offlineProof } from "../lib/continuity-holdout-proof.mjs";
import { runCli, readJson } from "../lib/continuity-holdout-files.mjs";

const names = { "corpus-manifest": "manifestPath", "manifest-sha256": "manifestSha256", registration: "registrationPath",
  "registration-sha256": "registrationSha256", "statistical-spec": "statisticalSpecPath", "pi-auth-path": "piAuthPath",
  output: "output", shard: "shard", authorization: "authorizationPath", "deadline-seconds": "deadlineSeconds",
  concurrency: "concurrency", "shard-roots": "shardRoots", audit: "auditPath", joined: "joinedPath", "audit-directory": "directory", "auditor-a": "auditorA", "auditor-b": "auditorB",
  adjudication: "adjudication", certificate: "certificate", seed: "seed" };
export async function main(argv) {
  const [command, ...args] = argv;
  need(["plan", "run", "join", "proof", "audit-export", "audit-import", "report"].includes(command), "expected_workflow_command");
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names[args[i].replace(/^--/u, "")];
    need(args[i].startsWith("--") && key && !Object.hasOwn(options, key) && args[i + 1] && !args[i + 1].startsWith("--"), "invalid_arguments");
    options[key] = args[i + 1];
  }
  need(["manifestPath", "manifestSha256", "registrationPath", "registrationSha256", "statisticalSpecPath", "piAuthPath", "output"].every(k => options[k]), "missing_argument");
  need(command !== "run" || options.shard && options.authorizationPath, "missing_argument");
  const needsRoots = ["join", "audit-export", "audit-import", "report"].includes(command);
  need(!needsRoots || options.shardRoots, "missing_argument");
  need(!["audit-export", "audit-import", "report"].includes(command) || options.joinedPath, "missing_argument");
  need(command !== "audit-import" || options.directory && options.auditorA && options.auditorB, "missing_argument");
  const context = await loadContext(options);
  let result, roots;
  if (needsRoots) { roots = await readJson(options.shardRoots); need(Array.isArray(roots) && roots.every(r => typeof r === "string"), "invalid_shard_roots"); }
  if (command === "plan") result = await preparePlans(context, options.output);
  if (command === "run") result = await runController(context, { ...options, shard: Number(options.shard),
    deadlineMs: Number(options.deadlineSeconds ?? 1500) * 1000, concurrency: Number(options.concurrency ?? 4) });
  if (command === "join") result = await joinShards(context, roots, options.output, options.auditPath);
  if (command === "audit-export") result = await exportAudit(context, roots, options.joinedPath, options.output, options.seed);
  if (command === "audit-import") result = await importAudit(context, roots, options.joinedPath, options.directory, options, options.output);
  if (command === "report") result = await finalReport(context, roots, options.joinedPath, options, options.output);
  if (command === "proof") result = await offlineProof(context, options.output);
  console.log(JSON.stringify(command === "plan" ? result : { output: options.output,
    ...(command === "run" ? { stop: result.stop, spend: result.spend } : {}),
    ...(["audit-export", "audit-import", "report"].includes(command) ? result : {}),
    ...(command === "join" ? { decision: result.statistics.decision } : {}), ...(command === "proof" ? { qualityMeasured: false, passed: true } : {}) }, null, 2));
  return result;
}
await runCli(import.meta.url, main);
