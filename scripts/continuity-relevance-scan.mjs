#!/usr/bin/env node
// Fictional, provider-free local capacity measurement. Build conversation first.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContinuitySchema, continuityRecordId } from "../packages/conversation/dist/tool-history/continuity-storage.js";
import { getContinuity } from "../packages/conversation/dist/tool-history/continuity-reader.js";
import { searchRelevantContinuity } from "../packages/conversation/dist/tool-history/relevance-scan.js";
if (typeof global.gc !== "function") throw new Error("Run this measurement with node --expose-gc.");
const manyAbsentTerms = Array.from({ length: 16 }, (_, index) => `${String.fromCharCode(97 + index)}quartz-velvet-prairie`).join(" ");
const sha = text => createHash("sha256").update(text).digest("hex");
const scope = { logicalConversationId: "fictional-scan", currentConversationId: "fictional-scan", currentRunId: "reader" };
const parent = join(process.cwd(), ".mono-agent");
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, "relevance-measure-"));
try {
  const results = [];
  for (const [count, capacity, longCount] of [[10_000, 32 * 1024 * 1024, 8], [100_000, 256 * 1024 * 1024, 64]]) {
    for (const workload of ["qualified", "evidence"]) {
      const path = join(root, `${count}-${workload}.sqlite`), db = new DatabaseSync(path); createContinuitySchema(db); db.exec("PRAGMA journal_mode=WAL; BEGIN");
      const generation = db.prepare("INSERT INTO continuity_generations(generation_id,conversation_id,logical_id,action,preparation_digest,state,created_at_ms) VALUES(?,?,?,'publish','fixture','committed',0)");
      const record = db.prepare("INSERT INTO continuity_records(record_id,generation_id,run_id,kind,seq,finalized,retained_text,text_sha256,original_bytes,retained_bytes,redacted,truncated,provenance,source_json,created_at_ms) VALUES(?,?,'old',?,?,1,?,?,?,?,0,0,?,'{}',0)");
      const shortCount = workload === "evidence" ? 64 : 0;
      const remaining = capacity - longCount * 1024 * 1024 - shortCount * 128, regularCount = count - longCount - shortCount;
      const small = Math.floor(remaining / regularCount); let remainder = remaining % regularCount;
      for (let index = 0; index < count; index++) {
        const gen = `generation-${Math.floor(index / 128)}`;
        if (index % 128 === 0) generation.run(gen, scope.logicalConversationId, scope.logicalConversationId);
        const size = index < longCount ? 1024 * 1024 : index < longCount + shortCount ? 128 : small + (remainder-- > 0 ? 1 : 0);
        const kind = workload === "qualified" ? "assistant" : ["user", "assistant", "summary"][index % 3];
        const suffix = workload === "qualified" ? "\nNot approved: cobalt observatory ŻÓŁTY remains hypothetical." : "\nActually, cobalt observatory ŻÓŁTY moved to revised day 18.";
        const prefixBytes = size - Buffer.byteLength(suffix);
        const text = "🔷".repeat(Math.floor(prefixBytes / 4)) + "x".repeat(prefixBytes % 4) + suffix;
        record.run(continuityRecordId(scope.logicalConversationId, `record-${index}`), gen, kind, index % 128, text, sha(text), size, size, kind === "user" ? "unknown" : kind === "summary" ? "generated" : "assistant");
      }
      db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
      for (const query of (process.argv.includes("--leak-only") ? [] : ["cobalt observatory", "absent-unmatched", "żółty", "historical cobalt observatory correction", "historical absent-unmatched missing-component correction", manyAbsentTerms])) {
        let continuation;
        for (const phase of ["cold-connection", "warm", "continuation"]) {
          if (phase === "continuation" && !continuation) continue;
          global.gc();
          const connection = new DatabaseSync(path, { readOnly: true });
          const baseline = process.memoryUsage(); let heap = baseline.heapUsed, rss = baseline.rss;
          const sample = () => { const m = process.memoryUsage(); heap = Math.max(heap, m.heapUsed); rss = Math.max(rss, m.rss); };
          const reader = {
            text(row) { if (typeof row.retained_text !== "string" || sha(row.retained_text) !== row.text_sha256) throw Error("digest_mismatch"); return row.retained_text; },
            metadata(row) { return getContinuity(connection, { ...scope, recordId: row.record_id, chunkBytes: 4 }).record; },
          };
          const page = searchRelevantContinuity(connection, { ...scope, query, mode: "relevance", limit: 5, ...(phase === "continuation" ? { continuation } : {}) }, reader, { afterBatch: sample, afterMetadataPage: sample });
          sample(); connection.close();
          if (phase === "warm") continuation = page.continuation;
          if (workload === "evidence" && query === "historical cobalt observatory correction" && page.scan.complete
            && !page.items.some(item => item.kind === "user" && item.retainedBytes === 128)) throw Error("short_user_bonus_branch_not_selected");
          const result = { workload, selectedKinds: page.items.map(item => item.kind), rankingVersion: page.rankingVersion, count, retainedMiB: capacity / 1024 ** 2, longRecords: longCount, query, phase, ...page.scan,
            degradedReason: page.degradedReason ?? null, heapDeltaMiB: (heap - baseline.heapUsed) / 1024 ** 2, rssDeltaMiB: (rss - baseline.rss) / 1024 ** 2 };
          result.targetMet = result.complete && result.elapsedMs <= 5000 && result.heapDeltaMiB <= 64 && result.rssDeltaMiB <= 128;
          result.acceptedEnvelopeMet = result.complete && result.elapsedMs <= 5000 && result.heapDeltaMiB <= 100 && result.rssDeltaMiB <= 128;
          results.push(result); console.log(JSON.stringify(result));
        }
      }
      if (count === 100_000 && workload === "evidence") {
        const connection = new DatabaseSync(path, { readOnly: true });
        const reader = {
          text(row) { if (sha(row.retained_text) !== row.text_sha256) throw Error("digest_mismatch"); return row.retained_text; },
          metadata(row) { return getContinuity(connection, { ...scope, recordId: row.record_id, chunkBytes: 4 }).record; },
        };
        const runWorstCase = () => {
          const page = searchRelevantContinuity(connection, { ...scope, query: "żółty", mode: "relevance", limit: 5 }, reader);
          return [page.scan.complete, page.scan.elapsedMs];
        };
        runWorstCase(); // Warm JIT/SQLite before checking persistent accumulation.
        await new Promise(resolve => setImmediate(resolve)); global.gc();
        const before = process.memoryUsage().heapUsed / 1024 ** 2, samples = new Float64Array(15);
        for (let run = 0; run < 5; run++) {
          const [complete, elapsed] = runWorstCase();
          // Flush instrumentation I/O before GC. Printing inside this loop itself
          // retains queued stdout strings and creates spurious monotonic growth.
          await new Promise(resolve => setImmediate(resolve)); global.gc();
          samples[run * 3] = process.memoryUsage().heapUsed / 1024 ** 2;
          samples[run * 3 + 1] = Number(complete); samples[run * 3 + 2] = elapsed;
        }
        console.log(JSON.stringify({ leakCheck: "before", heapMiB: before }));
        for (let run = 0; run < 5; run++) console.log(JSON.stringify({ leakCheck: run + 1, heapMiB: samples[run * 3], complete: Boolean(samples[run * 3 + 1]), elapsedMs: samples[run * 3 + 2] }));
        connection.close();
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cores: cpus().length, memoryGiB: totalmem() / 1024 ** 3,
    cacheNote: "cold-connection closes/reopens SQLite; OS filesystem cache is not flushed; warm is an immediate repeat; GC before each sample", allTargetsMet: results.length ? results.every(r => r.targetMet) : null, acceptedEnvelopeMet: results.length ? results.every(r => r.acceptedEnvelopeMet) : null }));
  if (results.some(r => !r.acceptedEnvelopeMet)) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
