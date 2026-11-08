import { existsSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { readManifest, openSnapshot, privateWriter, sourceStamps, assertUnchanged, jsonLines, fail, keys, time, within } from "./continuity-observation-input.mjs";
import { REASONS, CONTEXTS, COMPACTION_STATUSES, TRIGGERS, PACK_REASONS, PACK_GAP_REASONS, PACK_BOUNDED_REASONS, enumValue, statements, scanTurn, scanRows, stratumAt, retrieval, reviewWindow, journalInventory } from "./continuity-observation-events.mjs";
import { EXPORT_ALLOWLIST, RECORD_FIELDS, OUTCOME_FIELDS, PACK_FIELDS, WINDOW_STATUSES, assertAllowed, renderReport } from "./continuity-observation-report.mjs";

const zeros = (fields) => Object.fromEntries(fields.map(k => [k, 0]));
const cells = (field, values) => values.map(value => ({ [field]: value, count: 0 }));
const increment = (rows, field, value) => { rows.find(r => r[field] === value).count++; };
const distribution = () => ({ samples: 0, sum: 0, min: 0, max: 0, missing: 0 });
function group(closure, soul, entry) {
  const strata = { entry, closure, soul };
  return {
    complete: true,
    inventory: { ...strata, ...zeros(["conversations", "excludedConversations", "turns", "excludedTurns", "cancelledTurns", "windows", "eligibleWindows", "excludedWindows"]) },
    outcomes: { ...strata, coverage: "unknown", ...zeros(OUTCOME_FIELDS) },
    metrics: { ...strata,
      boundaries: { coverage: "unknown", total: 0, kinds: cells("kind", ["rollover", "isolated", "resume_replay", "unknown"]), reasons: cells("reason", REASONS), contexts: cells("context", CONTEXTS) },
      compactions: { coverage: "unknown", total: 0, statuses: cells("status", COMPACTION_STATUSES), triggers: cells("trigger", TRIGGERS) },
      packs: { coverage: "unknown", injected: 0, skipped: 0, degraded: 0, gap: 0, boundedSelection: 0, unknownDegradation: 0, reasons: cells("reason", PACK_REASONS), distributions: Object.fromEntries(PACK_FIELDS.map(k => [k, distribution()])) },
      retrieval: { coverage: "unknown", total: 0, actions: cells("action", ["search", "get", "unknown"]), outcomes: cells("outcome", ["success", "error", "unavailable", "unknown"]), reconciliation: cells("status", ["not_supplied", "matched", "unmatched", "ambiguous", "conflict"]) },
      followup: { ...zeros(["windows", "observedRetrieval", "noObservedRetrieval", "unknownRetrieval"]), statuses: cells("status", WINDOW_STATUSES) },
    },
  };
}
function observeEvent(g, e, sidecar, conversationId, interval) {
  const m = g.metrics, d = e.data;
  if (e.kind === "session_boundary") {
    m.boundaries.total++; increment(m.boundaries.kinds, "kind", enumValue(d.kind, ["rollover", "isolated", "resume_replay"]));
    increment(m.boundaries.reasons, "reason", enumValue(d.reason, REASONS)); increment(m.boundaries.contexts, "context", enumValue(d.context, CONTEXTS));
  } else if (e.kind === "context_compaction") {
    m.compactions.total++; increment(m.compactions.statuses, "status", enumValue(d.status, COMPACTION_STATUSES)); increment(m.compactions.triggers, "trigger", enumValue(d.trigger, TRIGGERS));
  } else if (e.kind.startsWith("continuity_pack_")) {
    m.packs[e.kind === "continuity_pack_injected" ? "injected" : "skipped"]++;
    increment(m.packs.reasons, "reason", d.degradedReason);
    if (d.degradedReason === "unknown") m.packs.unknownDegradation++;
    else if (!["none", "empty"].includes(d.degradedReason)) m.packs.degraded++;
    if (PACK_GAP_REASONS.includes(d.degradedReason)) m.packs.gap++;
    if (PACK_BOUNDED_REASONS.includes(d.degradedReason)) m.packs.boundedSelection++;
    for (const k of PACK_FIELDS) {
      const s = m.packs.distributions[k], v = d[k];
      if (!Number.isSafeInteger(v) || v < 0 || !Number.isSafeInteger(s.sum + v)) { s.missing++; continue; }
      s.min = s.samples ? Math.min(s.min, v) : v; s.max = Math.max(s.max, v); s.sum += v; s.samples++;
    }
  } else if (e.kind === "retrieval") {
    const r = retrieval(d, sidecar, conversationId, interval);
    m.retrieval.total++; increment(m.retrieval.actions, "action", r.action); increment(m.retrieval.outcomes, "outcome", r.outcome); increment(m.retrieval.reconciliation, "status", r.reconciliation);
  }
}
function unknownCounts(value) {
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number") value[k] = "unknown";
    else if (v && typeof v === "object") unknownCounts(v);
  }
}
async function reviewsReader(path) {
  const iterator = path ? jsonLines(path)[Symbol.asyncIterator]() : undefined;
  let next = iterator ? await iterator.next() : { done: true }, previous = 0;
  const validate = r => {
    if (!keys(r, ["window", "reask", "correction", "repeatedEffectCandidate", "confirmed"])
      || !Number.isSafeInteger(r.window) || r.window <= previous
      || ![r.reask, r.correction, r.repeatedEffectCandidate, r.confirmed].every(v => ["yes", "no", "ambiguous"].includes(v))
      || (r.confirmed === "yes" && ![r.reask, r.correction, r.repeatedEffectCandidate].includes("yes"))) fail("INVALID_REVIEW");
  };
  return {
    async take(window, eligible) {
      if (next.done) return undefined;
      validate(next.value);
      if (next.value.window < window) fail("UNMATCHED_REVIEW");
      if (next.value.window !== window) return undefined;
      if (!eligible) fail("REVIEW_WINDOW_EXCLUDED");
      const r = next.value; previous = r.window; next = await iterator.next(); return r;
    },
    finish() { if (!next.done) fail("UNMATCHED_REVIEW"); },
    async close() { await iterator?.return?.(); },
  };
}
export async function observe({ manifest: manifestPath, output, privateWorklist }) {
  const manifest = readManifest(manifestPath);
  const sources = [...new Set([manifest.manifestPath, manifest.reviews, ...manifest.snapshots.flatMap(s => [s.web, s.sidecar, s.journal])].filter(Boolean))];
  const tracked = [...sources];
  for (const s of manifest.snapshots) for (const p of [s.web, s.sidecar].filter(Boolean)) for (const suffix of ["-wal", "-shm"]) if (existsSync(p + suffix)) tracked.push(p + suffix);
  const stamps = sourceStamps(tracked);
  const parent = realpathSync(dirname(resolve(output))), out = join(parent, basename(resolve(output)));
  if (sources.some(p => within(out, p)) || existsSync(out)) fail("OUTPUT_PATH_REFUSED");
  // No pre-existing export directory or files are ever overwritten.
  const writer = privateWriter(privateWorklist, sources, out);
  let reviews;
  try {
    reviews = await reviewsReader(manifest.reviews);
    const groups = new Map();
    const getGroup = (p, entry) => {
      const key = `${entry}/${p.closure}/${p.soul}`;
      if (!groups.has(key)) groups.set(key, group(p.closure, p.soul, entry));
      return groups.get(key);
    };
    const inventory = { schema: "continuity-observation-inventory-v2", sources: { web: new Set(manifest.snapshots.map(s => s.web)).size, sidecar: 0, journal: 0 },
      entries: manifest.snapshots.map((_, i) => ({ entry: i + 1, excludedAgentThreads: 0 })), records: zeros(RECORD_FIELDS),
      auxiliary: { sidecarCoverage: "unknown", journalCoverage: "unknown", ...zeros(["sidecarCalls", "sidecarRecords", "continuityRecords", "continuityGenerations", "journalRecords", "journalCompactions", "journalToolCalls", "journalToolResults"]) }, strata: [] };
    const countedSidecars = new Set(), countedJournals = new Set();
    let continuityCoverage = true;
    let ordinal = 0;
    for (let sourceIndex = 0; sourceIndex < manifest.snapshots.length; sourceIndex++) {
      const snapshot = { ...manifest.snapshots[sourceIndex], interval: manifest.interval }, entry = sourceIndex + 1;
      for (const p of snapshot.strata) getGroup(p, entry).complete &&= snapshot.telemetry === "complete";
      const db = openSnapshot(snapshot.web, "web"); let sidecar;
      try {
        sidecar = snapshot.sidecar ? openSnapshot(snapshot.sidecar, "sidecar") : undefined;
        if (sidecar && !countedSidecars.has(snapshot.sidecar)) {
          countedSidecars.add(snapshot.sidecar); inventory.sources.sidecar++; inventory.auxiliary.sidecarCoverage = "supplied";
          const a = Date.parse(manifest.interval.start), b = Date.parse(manifest.interval.end), aux = inventory.auxiliary;
          aux.sidecarCalls += sidecar.prepare("SELECT count(*) AS n FROM tool_calls WHERE started_at_ms>=? AND started_at_ms<?").get(a, b).n;
          aux.sidecarRecords += sidecar.prepare("SELECT count(*) AS n FROM tool_records r JOIN tool_calls c ON c.conversation_id=r.conversation_id AND c.run_id=r.run_id AND c.tool_call_id=r.tool_call_id WHERE c.started_at_ms>=? AND c.started_at_ms<?").get(a, b).n;
          if (sidecar.prepare("PRAGMA user_version").get().user_version === 3) {
            aux.continuityRecords += sidecar.prepare("SELECT count(*) AS n FROM continuity_records WHERE created_at_ms>=? AND created_at_ms<?").get(a, b).n;
            aux.continuityGenerations += sidecar.prepare("SELECT count(*) AS n FROM continuity_generations WHERE created_at_ms>=? AND created_at_ms<?").get(a, b).n;
          } else continuityCoverage = false;
        }
        if (snapshot.journal && !countedJournals.has(snapshot.journal)) {
          countedJournals.add(snapshot.journal); inventory.sources.journal++; inventory.auxiliary.journalCoverage = "supplied";
          const j = await journalInventory(snapshot.journal, manifest.interval);
          for (const [k, v] of Object.entries(j)) inventory.auxiliary[`journal${k[0].toUpperCase()}${k.slice(1)}`] += v;
        }
        // Agent-selected conversations must be disjoint across different web
        // snapshots. Same-file entries were already checked for disjoint agents.
        // Query each prior snapshot rather than retaining all private identities.
        for (const previous of manifest.snapshots.slice(0, sourceIndex)) {
          if (previous.web === snapshot.web) continue;
          const prior = openSnapshot(previous.web, "web");
          try {
            const selected = snapshot.agents ? `h.source_id IN (${snapshot.agents.map(() => "?").join(",")})` : "1";
            const priorSelected = previous.agents ? `h.source_id IN (${previous.agents.map(() => "?").join(",")})` : "1";
            const overlapping = db.prepare(`SELECT 1 FROM threads h WHERE h.conversation_id=? AND ${selected} AND EXISTS (SELECT 1 FROM turns t WHERE t.thread_id=h.id AND t.started_at>=? AND t.started_at<?) LIMIT 1`);
            for (const t of prior.prepare(`SELECT h.conversation_id FROM threads h WHERE ${priorSelected} AND EXISTS (SELECT 1 FROM turns t WHERE t.thread_id=h.id AND t.started_at>=? AND t.started_at<?)`).iterate(...(previous.agents ?? []), manifest.interval.start, manifest.interval.end)) {
              if (overlapping.get(t.conversation_id, ...(snapshot.agents ?? []), manifest.interval.start, manifest.interval.end)) fail("OVERLAPPING_SNAPSHOTS");
            }
          } finally { prior.close(); }
        }
        const sql = statements(db);
        for (const thread of sql.threads.iterate()) {
          if (snapshot.agents && !snapshot.agents.includes(thread.source_id)) { inventory.entries[sourceIndex].excludedAgentThreads++; continue; }
          const countedGroups = new Map(); // At most the nine declared strata.
          for (const row of sql.unassigned.iterate(thread.id, manifest.interval.start, manifest.interval.end)) {
            if (!time(row.created_at)) fail("INVALID_TURN_TIMESTAMP");
            const g = getGroup(stratumAt(snapshot, row.created_at), entry), scanned = scanRows(sql, [row]);
            countedGroups.set(g, false); inventory.records.unassignedMessages++;
            if (row.turn_id !== null) scanned.stats.missingRecords++;
            for (const [k, v] of Object.entries(scanned.stats)) inventory.records[k] += v;
            if (scanned.stats.invalidRecords || scanned.stats.missingRecords || scanned.events.length) g.complete = false;
            for (const e of scanned.events) observeEvent(g, e, sidecar, thread.conversation_id, manifest.interval);
          }
          for (const turn of sql.turns.iterate(thread.id, manifest.interval.start, manifest.interval.end)) {
            if (!time(turn.started_at)) fail("INVALID_TURN_TIMESTAMP");
            const p = stratumAt(snapshot, turn.started_at), g = getGroup(p, entry);
            const excluded = thread.trigger_kind !== null || !sql.owner.get(turn.id);
            countedGroups.set(g, (countedGroups.get(g) ?? false) || !excluded);
            g.inventory[excluded ? "excludedTurns" : "turns"]++;
            if (turn.status === "cancelled") g.inventory.cancelledTurns++;
            const scanned = scanTurn(sql, turn);
            for (const [k, v] of Object.entries(scanned.stats)) inventory.records[k] += v;
            if (scanned.stats.invalidRecords || scanned.stats.missingRecords) g.complete = false;
            for (const e of scanned.events) {
              observeEvent(g, e, sidecar, thread.conversation_id, manifest.interval);
              if (excluded || !(e.kind === "session_boundary" || (e.kind === "context_compaction" && e.data.status === "succeeded"))) continue;
              const w = reviewWindow(sql, snapshot, thread, turn, e, scanned), eligible = w.status === "eligible";
              ordinal++; g.inventory.windows++; g.inventory[eligible ? "eligibleWindows" : "excludedWindows"]++;
              const f = g.metrics.followup; f.windows++; increment(f.statuses, "status", w.status);
              f[w.retrieved ? "observedRetrieval" : eligible && snapshot.telemetry === "complete" ? "noObservedRetrieval" : "unknownRetrieval"]++;
              const o = g.outcomes; o.windows++; o[eligible ? "eligible" : "excluded"]++;
              const r = await reviews.take(ordinal, eligible);
              if (!r) o.unreviewed++;
              else {
                o.reviewed++; if (r.reask === "yes") o.reasks++; if (r.correction === "yes") o.corrections++;
                if (r.repeatedEffectCandidate === "yes") o.repeatedEffectCandidates++; if (r.confirmed === "yes") o.confirmedCases++;
                if ([r.reask, r.correction, r.repeatedEffectCandidate, r.confirmed].includes("ambiguous")) o.ambiguousCases++;
              }
              writer.write({ schema: "continuity-observation-private-worklist-v1", window: ordinal, sourceIndex, web: snapshot.web,
                threadId: thread.id, turnId: turn.id, messageId: e.messageId, partIndex: e.partIndex, boundary: e.kind,
                status: w.status, ownerTurns: w.ownerTurns, review: r ?? { reask: "unreviewed", correction: "unreviewed", repeatedEffectCandidate: "unreviewed", confirmed: "unreviewed" } });
            }
          }
          for (const [g, eligible] of countedGroups) g.inventory[eligible ? "conversations" : "excludedConversations"]++;
        }
      } finally { sidecar?.close(); db.close(); }
    }
    reviews.finish();
    if (!inventory.sources.sidecar) for (const k of ["sidecarCalls", "sidecarRecords", "continuityRecords", "continuityGenerations"]) inventory.auxiliary[k] = "unknown";
    if (!continuityCoverage) for (const k of ["continuityRecords", "continuityGenerations"]) inventory.auxiliary[k] = "unknown";
    if (!inventory.sources.journal) for (const k of ["journalRecords", "journalCompactions", "journalToolCalls", "journalToolResults"]) inventory.auxiliary[k] = "unknown";
    const all = [...groups.values()].sort((a, b) => a.inventory.entry - b.inventory.entry || `${a.inventory.closure}/${a.inventory.soul}`.localeCompare(`${b.inventory.closure}/${b.inventory.soul}`));
    for (const g of all) {
      g.outcomes.coverage = g.outcomes.reviewed ? (g.outcomes.reviewed === g.outcomes.eligible ? "complete" : "partial") : "unknown";
      if (!g.outcomes.reviewed) for (const k of ["reasks", "corrections", "repeatedEffectCandidates", "confirmedCases", "ambiguousCases"]) g.outcomes[k] = "unknown";
      for (const family of ["boundaries", "compactions", "packs", "retrieval"]) {
        const f = g.metrics[family], total = family === "packs" ? f.injected + f.skipped : f.total;
        f.coverage = g.complete ? "complete" : total ? "partial" : "unknown";
        if (!g.complete && !total) unknownCounts(f);
      }
      for (const d of Object.values(g.metrics.packs.distributions)) if (d.samples === 0) { d.min = "unknown"; d.max = "unknown"; }
    }
    inventory.strata = all.map(g => g.inventory);
    const reports = { inventory, metrics: { schema: "continuity-observation-metrics-v2", strata: all.map(g => g.metrics) }, outcomes: { schema: "continuity-observation-outcomes-v2", strata: all.map(g => g.outcomes) } };
    for (const [k, contract] of Object.entries(EXPORT_ALLOWLIST)) assertAllowed(reports[k], contract);
    const markdown = renderReport(reports);
    assertUnchanged(stamps);
    for (const s of manifest.snapshots) for (const path of [s.web, s.sidecar].filter(Boolean)) {
      if (["-wal", "-shm", "-journal"].some(suffix => existsSync(path + suffix))) fail("SNAPSHOT_CHANGED");
    }
    mkdirSync(out, { mode: 0o700 });
    for (const [name, value] of Object.entries(reports)) writeFileSync(join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    writeFileSync(join(out, "report.md"), markdown, { flag: "wx", mode: 0o600 });
    return reports;
  } finally { writer.close(); await reviews?.close(); }
}
