#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/u, "").split("="); return [key, rest.length ? rest.join("=") : true]; }));
const scenarios = new Set(["multi-turn", "durable-reopen", "stateless", "concurrent", "recall-changing", "capability-change"]);
const scenario = String(args.scenario ?? "multi-turn");
if (!scenarios.has(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
if (args["dry-run"] !== true) throw new Error("Live measurement requires explicit provider authorization and is intentionally unavailable in this build; use --dry-run.");
const root = process.cwd();
const output = resolve(root, String(args.output ?? ".mono-agent/cache-measurement.json"));
if (relative(root, output).startsWith("..")) throw new Error("--output must stay inside the worktree");
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const requests = Array.from({ length: scenario === "concurrent" ? 4 : 3 }, (_, index) => {
  const input = 100 + index * 25;
  const cacheRead = index === 0 ? 0 : 80;
  const cacheWrite = index === 0 ? 80 : 0;
  const inputTotal = input + cacheRead + cacheWrite;
  return { requestOrdinal: index + 1, input, cacheRead, cacheWrite, output: 20, cacheHitRatio: cacheRead / inputTotal,
    costUsd: 0, costSource: "fixture", systemFingerprint: hash(`system:${scenario}`), toolDefinitionsFingerprint: hash(index > 0 && scenario === "capability-change" ? "tools:none" : "tools:Read"), messageFingerprints: [hash(`message:${index}`)], historyMode: scenario, compaction: false, reseed: scenario === "durable-reopen" && index === 2, inputInterpretation: "full" };
});
const totals = requests.reduce((sum, item) => ({ input: sum.input + item.input, cacheRead: sum.cacheRead + item.cacheRead, cacheWrite: sum.cacheWrite + item.cacheWrite, output: sum.output + item.output }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
const report = { schema: 1, mode: "dry-run", scenario, requests, contextUsageSnapshots: [], cumulativeTotals: { ...totals, cacheHitRatio: denominator === 0 ? null : totals.cacheRead / denominator } };
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output: relative(root, output), scenario, requests: requests.length, cacheHitRatio: report.cumulativeTotals.cacheHitRatio })}\n`);
