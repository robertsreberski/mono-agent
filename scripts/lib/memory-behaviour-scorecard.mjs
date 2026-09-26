import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBujoMemoryStore, resolveActiveMemoryDbPath, safeRebuildMemoryIndex, selectPossiblyRelevantRecallHits } from "../../packages/memory/dist/bujo/index.js";
import { openMemoryDb } from "../../packages/memory/dist/store/index.js";

// Entirely fictional, scripted model outputs still pass through the production
// completed-turn intake, strict extraction, reconciliation, labels and index.
const fact = (entityId, key, value) => ({ v: 1, kind: "fact", entityId, key,
  value: { type: "text", text: value }, attribution: "user-stated" });
// `entityIds` and `source` stand in for the extraction model's association and
// source judgement; the host only bounds them.
const candidate = (text, labels = [], entityIds = [], source = "user") => ({ type: "note", text, salience: 0.8,
  isInsight: false, entityIds, source, labels });
const OWNER = ["person:owner"];
export const TURNS = [
  { user: "I live in Thistlemoor.", memories: [candidate("The user lives in Thistlemoor.", [fact("person:owner", "home_location", "Thistlemoor")], OWNER)], kind: "owner" },
  { user: "My colleague Taylor lives in Fernhollow.", memories: [candidate("The user's colleague Taylor lives in Fernhollow.", [fact("person:taylor", "home_location", "Fernhollow")], ["person:taylor"])], kind: "other-person" },
  { user: "My favorite animal is an otter.", memories: [candidate("The user favors an otter as a favorite animal.", [fact("person:owner", "other:favorite-animal", "otter")], OWNER)], kind: "owner-custom" },
  { user: "I prefer concise fictional project notes.", memories: [candidate("The user prefers concise fictional project notes.", [{ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" }])], kind: "preference" },
  { user: "I moved to Glimmerton, not Thistlemoor.", memories: [candidate("The user lives in Glimmerton.", [fact("person:owner", "home_location", "Glimmerton")], OWNER)], decision: "supersede", target: "The user lives in Thistlemoor.", kind: "state-change" },
  { user: "Correction: Taylor lives in Wrenfield, not Fernhollow.", memories: [candidate("The user's colleague Taylor lives in Wrenfield.", [fact("person:taylor", "home_location", "Wrenfield")], ["person:taylor"])], decision: "supersede", target: "The user's colleague Taylor lives in Fernhollow.", kind: "correction" },
  { user: "My appointment is tomorrow, October 12.", memories: [candidate("The user's appointment is on 2026-10-12.")], kind: "relative-date" },
  { user: "My access token is fake-secret-123. The build finished and I said thanks.", memories: [], kind: "chatter-credentials" },
  { user: "My colleague doubts that I live in Oakspire.", memories: [candidate("The user's colleague doubts that the user lives in Oakspire.", [fact("person:owner", "home_location", "Oakspire")])], kind: "doubt" },
  { user: "I was born May 17, 1990.", memories: [candidate("The user was born May 17, 1990.", [{ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date", value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" }], OWNER)], kind: "owner-date" },
  { user: "Morgan says their home is in Duskwater.", memories: [candidate("Morgan's home is in Duskwater.", [fact("person:owner", "home_location", "Duskwater")], OWNER)], ownerTurn: false, kind: "non-owner" },
  { user: "scheduled-demo", captureText: "Scheduled task trigger (not a user message; trigger text omitted):\nAssistant: The Maple build completed on 2026-10-11.",
    memories: [candidate("The Maple build completed on 2026-10-11.", [], [], "assistant")], kind: "trigger-outcome" },
];
export const QUESTIONS = [
  { kind: "owner-positive", query: "Where does the user live?", expected: "The user lives in Glimmerton." },
  { kind: "first-person", query: "Where do I live?", expected: "The user lives in Glimmerton." },
  { kind: "other-person-positive", query: "Where does Taylor live?", expected: "The user's colleague Taylor lives in Wrenfield." },
  { kind: "negative", query: "What is the user's phone number?" },
  { kind: "negative", query: "When was Morgan born?" },
  { kind: "non-owner", query: "Where do I live?", ownerTurn: false },
];

// Deterministic provider, never calls a network. Hybrid FTS remains in use.
const embeddings = { id: "fixture:behaviour-v1", async embed(texts) {
  return texts.map((text) => {
    const vector = Array(64).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
      let hash = 2166136261;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      vector[(hash >>> 0) % vector.length] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  });
} };

const LABELLED_SCENARIOS = [
  { kind: "owner", label: "fact", entityId: "person:owner" },
  { kind: "owner-custom", label: "fact", entityId: "person:owner" },
  { kind: "preference", label: "preference" },
  { kind: "owner-date", label: "fact", entityId: "person:owner" },
];

export function scoreBehaviour({ records, labels, questions, pending, before, after, cpuMs }) {
  const active = records.filter((r) => r.status !== "invalidated");
  const ownerBindingOfOthers = labels.filter((row) => row.active && row.label.kind === "fact"
    && row.label.entityId === "person:owner" && /(?:colleague Taylor|Morgan's home)/iu.test(records.find((r) => r.id === row.memoryId)?.text ?? "")).length;
  const credentialStored = records.filter((r) => /fake-secret-123/iu.test(r.text)).length;
  const triggerText = TURNS.find((turn) => turn.kind === "trigger-outcome")?.memories[0]?.text;
  const triggerOutcomeStored = triggerText !== undefined && active.some((row) => row.text === triggerText);
  // Automatic recall is a "possibly relevant" block the main model judges, so
  // negatives may show lines. Gates: non-owner turns get none, and negatives
  // average at most two lines. Answer presence is reported, not gated, because
  // the deterministic hash embeddings are not a semantic model.
  const negatives = questions.filter((q) => q.kind === "negative");
  const negativeLinesAvg = negatives.length === 0 ? 0 : negatives.reduce((sum, q) => sum + q.automaticHits, 0) / negatives.length;
  const nonOwnerAutomaticLines = questions.filter((q) => q.kind === "non-owner").reduce((sum, q) => sum + q.automaticHits, 0);
  const expected = questions.filter((q) => q.kind.endsWith("positive") || q.kind === "first-person");
  const answerPresence = expected.length === 0 ? 0 : expected.filter((q) => q.hit).length / expected.length;
  const parity = JSON.stringify(before) === JSON.stringify(after);
  const gates = {
    nonOwnerAutomaticLines: nonOwnerAutomaticLines === 0,
    negativeLinesAvg: negativeLinesAvg <= 2,
    ownerBindingOfOthers: ownerBindingOfOthers === 0,
    credentialStored: credentialStored === 0,
    pendingTurns: pending === 0,
    rebuildParity: parity,
    fixtureNonVacuous: records.length >= 5 && questions.length === QUESTIONS.length,
    // Each scenario needs the right label kind on the right subject, not just any label.
    labelledScenarios: LABELLED_SCENARIOS.every(({ kind, label, entityId }) => {
      const text = TURNS.find((turn) => turn.kind === kind)?.memories[0]?.text;
      return labels.some((row) => row.label.kind === label && (entityId === undefined || row.label.entityId === entityId)
        && records.some((record) => record.id === row.memoryId && record.text === text));
    }),
  };
  return { schema: 1, turns: TURNS.length, records: records.length, activeRecords: active.length,
    labels: labels.length, questions: questions.map(({ kind, hit, explicitHit, automaticHits }) => ({ kind, hit, explicitHit, automaticHits })),
    labelKinds: Object.fromEntries(["fact", "preference", "lesson"].map((kind) => [kind, labels.filter((row) => row.label.kind === kind && row.active).length])),
    superseded: records.filter((row) => row.status === "invalidated").length,
    categories: Object.fromEntries([...new Set(TURNS.map((t) => t.kind))].map((kind) => [kind, 1])),
    cpuMs: { total: cpuMs.reduce((a, b) => a + b, 0), perTurn: cpuMs },
    answerPresence, negativeLinesAvg, nonOwnerAutomaticLines, ownerBindingOfOthers, credentialStored, triggerOutcomeStored, pendingTurns: pending,
    rebuildParity: parity, gates, passed: Object.values(gates).every(Boolean) };
}

export async function runMemoryBehaviourScorecard({ turns = TURNS, questions = QUESTIONS } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mono-agent-memory-behaviour-"));
  let store;
  try {
    let turnIndex = 0;
    const llm = { id: "fixture:behaviour-script", async complete(prompt, options = {}) {
      if (options.label === "capture:extract") {
        const turn = turns.find((item) => prompt.includes(item.captureText ?? `User: ${item.user}\nAssistant: Noted.`));
        if (!turn) throw new Error("scripted extraction turn missing");
        const ids = [...new Set(turn.memories.flatMap((memory) => memory.entityIds))];
        const entities = ids.map((id) => ({ id, name: id === "person:owner" ? "Owner" : id.slice(7).replace(/^./u, (c) => c.toUpperCase()), type: "person" }));
        return JSON.stringify({ memories: turn.memories, entities, relations: [] });
      }
      if (options.label === "capture:reconcile-batch") {
        const offered = JSON.parse(prompt.slice(prompt.lastIndexOf("INPUT:\n") + 7));
        return JSON.stringify(offered.map(({ index, candidate: item, existing }) => {
          const turn = turns.find((entry) => entry.memories.some((memory) => memory.text === item.text));
          const target = existing.find((hit) => hit.text === turn?.target);
          return target && turn.decision
            ? { index, action: turn.decision, targetId: target.id, text: item.text }
            : { index, action: "add" };
        }));
      }
      throw new Error(`unexpected scripted call: ${String(options.label)}`);
    } };
    let now = new Date("2026-10-11T09:00:00.000Z");
    store = createBujoMemoryStore({ root, tier: "bujo", embeddings, dim: 64, llm, clock: () => now });
    const cpuMs = [];
    for (const turn of turns) {
      now = new Date(now.getTime() + 60_000);
      const start = process.cpuUsage();
      const user = turn.user;
      await store.persistCompletedTurn({ runId: `fixture-${turnIndex}`, conversationId: "acp:fictional",
        summary: "A fictional conversation turn completed.", captureText: turn.captureText ?? `User: ${user}\nAssistant: Noted.`,
        captureSpeakerKind: turn.captureText ? "trigger" : "human-turn",
        captureEvidence: turn.captureText ? { userText: "", toolOutcomes: [] } : { userText: user, ...(turn.ownerTurn === false ? {} : { ownerTurn: true }), toolOutcomes: [] } });
      await store.flush();
      const cpu = process.cpuUsage(start);
      cpuMs.push((cpu.user + cpu.system) / 1000);
      turnIndex += 1;
    }
    const pending = (store.queueSnapshot().intake?.pending ?? 0) + (store.queueSnapshot().intake?.dead ?? 0);
    const read = () => {
      const db = openMemoryDb({ path: resolveActiveMemoryDbPath(root), readOnly: true, embeddings, dim: 64 });
      try { return { records: db.allMemories(), labels: db.listLabels({}, 200).hits }; }
      finally { db.close(); }
    };
    const { records, labels } = read();
    const results = [];
    for (const question of questions) {
      const hits = await store.recall(question.query, { topK: 8, trackAccess: false });
      // Selector-only simulation of the app service (non-owner turns get no
      // automatic block); the service itself is covered by memory-retrieval tests.
      const automatic = question.ownerTurn === false ? [] : selectPossiblyRelevantRecallHits(hits);
      const texts = automatic.map((hit) => hit.record.text);
      results.push({ kind: question.kind, hit: question.expected ? texts.includes(question.expected) : false,
        explicitHit: question.expected ? hits.some((item) => item.record.text === question.expected) : false,
        automaticHits: texts.length });
    }
    await store.close();
    store = undefined;
    const before = read();
    await safeRebuildMemoryIndex({ root, tier: "bujo", embeddings, dim: 64 });
    const after = read();
    // Stable logical projection; SQLite telemetry, source and generations are not parity contracts.
    const projection = ({ records: rows, labels: entries }) => ({
      records: rows.map(({ id, text, status, supersededBy }) => ({ id, text, status, supersededBy })).sort((a, b) => a.id.localeCompare(b.id)),
      labels: entries.map(({ memoryId, active, label }) => ({ memoryId, active, label })).sort((a, b) => a.memoryId.localeCompare(b.memoryId)),
    });
    return scoreBehaviour({ records, labels, questions: results, pending, before: projection(before), after: projection(after), cpuMs });
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = await runMemoryBehaviourScorecard();
  console.log(JSON.stringify(report));
  console.error(`memory behaviour: ${report.passed ? "PASS" : "FAIL"}; turns=${report.turns} records=${report.records} answers=${report.answerPresence.toFixed(2)} negLines=${report.negativeLinesAvg.toFixed(2)} nonOwner=${report.nonOwnerAutomaticLines} pending=${report.pendingTurns} parity=${report.rebuildParity}`);
  if (!report.passed) process.exitCode = 1;
}
