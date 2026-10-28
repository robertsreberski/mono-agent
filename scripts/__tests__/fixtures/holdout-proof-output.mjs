// Reduced artifact-validation fixture, NOT a production-harness execution.
// The separately runnable holdout-proof-drill exercises the real replay/children.
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makePlan } from "../../lib/continuity-dataset.mjs";
import { sha256 } from "../../lib/continuity-holdout-files.mjs";
import { spanKey } from "../../../packages/conversation/dist/continuity/ledger.js";
export function fixtureProofRun(context) {
  return async argv => {
    const flag = name => argv[argv.indexOf(name) + 1], root = flag("--output"), limit = Number(flag("--probe-limit"));
    const selected = argv.flatMap((arg, i) => arg === "--trace" ? [argv[i + 1]] : []);
    const plan = makePlan({ ...context.loaded, suite: "holdout", profile: context.profile, codeRevision: context.registration.codeRevision, repeats: 1, probeLimit: limit });
    await writeFile(join(root, "plan.json"), JSON.stringify({ ...plan, executionKind: "offline" }));
    await mkdir(join(root, "units")); await mkdir(join(root, "upkeep-output"));
    for (const c of context.registration.conversations.filter(c => !selected.length || selected.includes(c.id))) for (const { id: arm } of plan.arms) {
      const ledger = arm === "continuity-ledger-cold", scope = `synthetic-${c.id}`;
      const texts = ["Synthetic owner source alpha.", "Synthetic owner source beta."];
      const spans = texts.map((text, i) => ({ id: `s${i}`, recordId: `record-${i}`, ordinal: i + 1, sha256: sha256(text),
        start: 0, end: Buffer.byteLength(text), digest: sha256(text), owner: true, kind: "owner" }));
      const steps = Array.from({ length: 3 }, (_, i) => {
        const offer = spans[i % 2], rows = Array.from({ length: i + 1 }, (_, j) => ({ operationId: `op-${j}`, state: "terminal", budget: j ? "incremental" : "bootstrap", selection: [spanKey(spans[j % 2])] }));
        return { pid: 100 + context.registration.conversations.findIndex(row => row.id === c.id) * 3 + i, valid: true, preserved: true, boundary: { verified: true },
          receipt: { operationId: `op-${i}`, status: "valid", reason: "completed", providerInvoked: true },
          observed: { upkeepScans: [{ complete: true, rows: 2, bytes: 100, windows: 1, limits: { rows: 10, bytes: 1000, windows: 10 } }], upkeepSelections: [{ fitted: 1, deltaCap: 8, projectionAttempts: 1 }] },
          journal: { rows, operationId: `op-${i}`, state: "terminal", budget: i ? "incremental" : "bootstrap", databaseId: "synthetic-db",
            operations: i + 1, bootstrap: 1, reserved: 0, released: 0, frontier: '{"ordinal":2}', offerCounts: [{ offer_count: 2 }], compact: { identities: 0 },
            offered: [{ key: spanKey(offer), digest: offer.sha256, ordinal: offer.ordinal, start: 0, end: offer.end }] } };
      });
      const unit = { executionKind: "offline", confirmation: plan.confirmation, manifest: { codeRevision: plan.codeRevision }, traceId: c.id, repeat: 1, arm, complete: true,
        checkpoint: { conversationId: scope, ...(ledger ? { upkeep: { valid: true, expectedEntries: 2, preparations: steps } } : {}) },
        trials: c.probes.slice(0, limit).map(probeId => ({ traceId: c.id, repeat: 1, arm, probeId, status: "completed", boundary: { verified: true,
          observed: { continuityPacks: [{ ledgerEntries: 2, evidenceEntries: 1 }], upkeep: [], upkeepScans: [] } } })) };
      if (ledger) {
        const directory = join(root, "work", `cp-${c.id}_ledger-continuity-ledger-cold-r1/work/history/tool-history`); await mkdir(directory, { recursive: true });
        const db = new DatabaseSync(join(directory, "tool-lifecycles.sqlite"));
        db.exec("CREATE TABLE continuity_generations(generation_id TEXT,conversation_id TEXT); CREATE TABLE tool_calls(run_id TEXT,tool_call_id TEXT,tool_name TEXT,conversation_id TEXT); CREATE TABLE continuity_records(record_id TEXT,generation_id TEXT,run_id TEXT,input_id TEXT,kind TEXT,provenance TEXT,source_json TEXT,ordinal INTEGER,seq INTEGER,retained_text TEXT,text_sha256 TEXT,original_bytes INTEGER,retained_bytes INTEGER,redacted INTEGER,truncated INTEGER)");
        db.prepare("INSERT INTO continuity_generations VALUES (?,?)").run("g", scope);
        for (let i = 0; i < 2; i++) db.prepare("INSERT INTO continuity_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(`record-${i}`, "g", "run", `input-${i}`, "owner", "host-owner", JSON.stringify({ attestation: { inputId: `input-${i}` } }), i + 1, i + 1, texts[i], sha256(texts[i]), Buffer.byteLength(texts[i]), Buffer.byteLength(texts[i]), 0, 0);
        db.close();
        // Reverse storage order proves rendering uses host ordinals, without mutation.
        const generation = { id: "g", conversationId: scope, logicalId: scope, spans, coveredSpans: [], coveredOwners: [], uncovered: 0,
          entries: [1, 0].map(i => ({ id: `e${i}`, kind: "open_work", value: `Synthetic work ${i}`, status: "unknown", sources: [`s${i}`] })) };
        for (let i = 1; i <= 3; i++) await writeFile(join(root, "upkeep-output", `r1-${c.id}-p${i}.json`), JSON.stringify({ status: "valid", ledger: generation }));
      }
      await writeFile(join(root, "units", `r1-${c.id}-${arm}.json`), JSON.stringify(unit));
    }
    return 0;
  };
}
