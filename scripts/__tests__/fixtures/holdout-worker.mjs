// Synthetic IPC fixture only: no runtime/provider imports and no credentials.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fork } from "node:child_process";
import { auditCheckpoint, fixtureDatabase } from "./holdout-audit-data.mjs";
let finished = false;
process.on("disconnect", () => { if (!finished) process.kill(-process.pid, "SIGKILL"); });
process.send({ ready: true });
process.once("message", async ({ argv }) => {
  const flag = name => argv[argv.indexOf(name) + 1], output = flag("--output"), traceId = flag("--trace");
  const registration = JSON.parse(await readFile(flag("--registration"), "utf8"));
  const control = JSON.parse(await readFile(join(dirname(dirname(output)), "controller.json"), "utf8"));
  if (control.chunks.at(-1).pid !== process.pid || control.chunks.at(-1).state !== "running") process.exit(99);
  await writeFile(join(output, "write-ahead-proof.json"), JSON.stringify({ reservationDurable: true, pid: process.pid }));
  const mode = process.env.HOLDOUT_FIXTURE_MODE;
  if (["park", "auth", "budget"].includes(mode)) {
    const path = join(output, "work", `cp-${traceId}_ledger-continuity-ledger-cold-r1/work/history/tool-history`); await mkdir(path, { recursive: true });
    const db = fixtureDatabase(join(path, "tool-lifecycles.sqlite"));
    db.exec("CREATE TABLE continuity_upkeep_operations (operation_id TEXT,reservation TEXT,outcome TEXT,state TEXT)");
    db.prepare("INSERT INTO continuity_upkeep_operations VALUES (?,?,?,?)").run("synthetic-live-op", JSON.stringify({ budget: "bootstrap" }), JSON.stringify({
      status: "valid", reason: "completed", providerInvoked: true, ...(mode === "auth" ? { failureKind: "provider_auth" } : {}),
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: mode === "budget" ? 100 : 0.01,
    }), "terminal"); db.close();
    if (mode === "park") {
      const child = fork(new URL("./holdout-park.mjs", import.meta.url), [], { stdio: "ignore", execArgv: [] });
      await writeFile(join(output, "park.json"), JSON.stringify({ pid: child.pid }));
    }
    process.send({ started: true }); setInterval(() => {}, 1000); return;
  }
  process.send({ started: true });
  if (mode === "failed") process.exit(2);
  await mkdir(join(output, "units"));
  if (mode === "malformed") {
    await writeFile(join(output, "units", "invalid.json"), "{}"); finished = true; process.disconnect(); process.exit(0);
  }
  const probes = registration.conversations.find(c => c.id === traceId).probes;
  for (let repeat = 1; repeat <= 2; repeat++) for (const arm of ["native", "cold-rebuild", "continuity-pack-cold", "continuity-ledger-cold"]) {
    const steps = Array.from({ length: 3 }, (_, i) => {
      const rows = Array.from({ length: i + 1 }, (_, j) => ({ operationId: `synthetic-op-${j}`, budget: j ? "incremental" : "bootstrap", state: "terminal", selection: [`synthetic-span-${j}`] }));
      return { pid: i + 1, valid: true, preserved: true, boundary: { verified: true },
        receipt: { operationId: rows[i].operationId, status: "valid", reason: "completed", providerInvoked: true,
          inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
        journal: { rows, operations: rows.length, bootstrap: 1, reserved: 0, released: 0, operationId: rows[i].operationId, budget: rows[i].budget, state: "terminal" } };
    });
    const unit = { traceId, arm, repeat, complete: !(mode === "partial" && repeat === 1 && arm === "native"), confirmation: flag("--confirm-plan"), executionKind: "real",
      manifest: { codeRevision: registration.codeRevision, dirty: false }, checkpoint: arm === "continuity-ledger-cold" ? { upkeep: { valid: true, preparations: steps } } : {},
      trials: probes.map((probeId, index) => ({ traceId, arm, repeat, probeId, status: "completed", boundary: { verified: true },
        answer: mode === "quality_fail" ? "Fixture wrong answer." : mode === "hedged" && index === 0 && ["native", "continuity-ledger-cold"].includes(arm) ? "I do not know exactly, perhaps PARCELMALLOW." : arm === "continuity-pack-cold" ? "UNKNOWN" : "Fixture answer.",
        score: mode === "hedged" && index === 0 && ["native", "continuity-ledger-cold"].includes(arm) ? { pass: false, outcome: "abstained" } : mode === "quality_fail" ? { pass: false, outcome: "wrong" } : arm === "continuity-pack-cold" ? { pass: false, outcome: "abstained" } : { pass: true, outcome: "correct" },
        usage: { calls: 1, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.001 } })) };
    if (mode === "audit" && arm === "continuity-ledger-cold") {
      unit.checkpoint = await auditCheckpoint(output, traceId, repeat);
      for (const trial of unit.trials) trial.boundary.observed = { upkeep: [], upkeepScans: [], continuityPacks: [{ ledgerEntries: 3 }] };
    }
    if (mode === "journal_overlap" && arm === "continuity-ledger-cold") {
      const path = join(output, "work", `cp-${traceId}_ledger-continuity-ledger-cold-r${repeat}/work/history/tool-history`); await mkdir(path, { recursive: true });
      const db = fixtureDatabase(join(path, "tool-lifecycles.sqlite"));
      db.exec("CREATE TABLE continuity_upkeep_operations (operation_id TEXT,reservation TEXT,outcome TEXT,state TEXT)");
      for (const step of steps) db.prepare("INSERT INTO continuity_upkeep_operations VALUES (?,?,?,?)").run(step.receipt.operationId, JSON.stringify({ budget: step.journal.budget }), JSON.stringify(step.receipt), "terminal");
      db.close();
    }
    await writeFile(join(output, "units", `r${repeat}-${traceId}-${arm}.json`), JSON.stringify(unit));
  }
  finished = true; process.disconnect(); process.exit(0);
});
