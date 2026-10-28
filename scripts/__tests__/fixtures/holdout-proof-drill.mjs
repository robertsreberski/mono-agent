// Explicit, provider-free production-harness drill; intentionally not a CI test.
import { appendFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { CHECKOUT } from "../../lib/continuity-holdout-files.mjs";
import { syntheticContext } from "./holdout-synthetic.mjs";
await mkdir(join(CHECKOUT, ".worklab-tmp"), { recursive: true });
const root = await realpath(await mkdtemp(join(CHECKOUT, ".worklab-tmp/holdout-proof-drill-")));
const { context, workflow, proof } = await syntheticContext(root);
const start = Date.now(), scope = process.argv[2] ?? "both";
const onPhase = event => appendFileSync(join(root, "timings.jsonl"), JSON.stringify({ elapsedMs: Date.now() - start, ...event }) + "\n");
const plans = await workflow.preparePlans(context, join(root, "plans"));
const result = await proof.offlineProof(context, join(root, "offline"), { scope, onPhase });
console.log(JSON.stringify({ root, elapsedMs: Date.now() - start, plans, proof: result }, null, 2));
