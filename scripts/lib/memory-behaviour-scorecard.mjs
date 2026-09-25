import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createBujoMemoryStore, resolveActiveMemoryDbPath, safeRebuildMemoryIndex, selectAutomaticRecallHits } from "../../packages/memory/dist/bujo/index.js";
import { openMemoryDb } from "../../packages/memory/dist/store/index.js";

// Entirely fictional, scripted model outputs still pass through the production
// completed-turn intake, strict extraction, reconciliation, labels and index.
const fact = (entityId, key, value) => ({ v: 1, kind: "fact", entityId, key,
  value: { type: "text", text: value }, attribution: "user-stated" });
const candidate = (text, labels = []) => ({ type: "note", text, salience: 0.8,
  isInsight: false, entityIds: [], labels });
export const TURNS = [
  { user: "I live in Lisbon.", memories: [candidate("The user lives in Lisbon.", [fact("person:owner", "home_location", "Lisbon")])], kind: "owner" },
  { user: "My colleague Taylor lives in Porto.", memories: [candidate("The user's colleague Taylor lives in Porto.", [fact("person:taylor", "home_location", "Porto")])], kind: "other-person" },
  { user: "I prefer concise fictional project notes.", memories: [candidate("The user prefers concise fictional project notes.", [{ v: 1, kind: "preference", scope: "agent", attribution: "user-stated" }])], kind: "preference" },
  { user: "I moved to Braga, not Lisbon.", memories: [candidate("The user lives in Braga.", [fact("person:owner", "home_location", "Braga")])], decision: "supersede", target: "The user lives in Lisbon.", kind: "state-change" },
  { user: "Correction: Taylor lives in Coimbra, not Porto.", memories: [candidate("The user's colleague Taylor lives in Coimbra.", [fact("person:taylor", "home_location", "Coimbra")])], decision: "supersede", target: "The user's colleague Taylor lives in Porto.", kind: "correction" },
  { user: "My appointment is tomorrow, October 12.", memories: [candidate("The user's appointment is on 2026-10-12.")], kind: "relative-date" },
  { user: "My access token is fake-secret-123. The build finished and I said thanks.", memories: [], kind: "chatter-credentials" },
  { user: "My colleague doubts that I live in Madrid.", memories: [candidate("The user's colleague doubts that the user lives in Madrid.", [fact("person:owner", "home_location", "Madrid")])], kind: "doubt" },
  { user: "I was born May 17, 1990.", memories: [candidate("The user was born May 17, 1990.", [{ v: 1, kind: "fact", entityId: "person:owner", key: "birth_date", value: { type: "date", date: "1990-05-17" }, attribution: "user-stated" }])], kind: "owner-date" },
  { user: "Morgan says their home is in Naples.", memories: [candidate("Morgan's home is in Naples.", [fact("person:owner", "home_location", "Naples")])], ownerTurn: false, kind: "non-owner" },
  { user: "scheduled-demo", captureText: "Scheduled task trigger (not a user message; trigger text omitted):\nAssistant: The Maple build completed on 2026-10-11.",
    memories: [candidate("The Maple build completed on 2026-10-11.")], kind: "trigger-outcome" },
];
export const QUESTIONS = [
  { kind: "owner-positive", query: "Where does the user live?", expected: "The user lives in Braga." },
  { kind: "first-person", query: "Where do I live?", expected: "The user lives in Braga." },
  { kind: "other-person-positive", query: "Where does Taylor live?", expected: "The user's colleague Taylor lives in Coimbra." },
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

export function scoreBehaviour({ records, labels, questions, pending, before, after, cpuMs }) {
  const active = records.filter((r) => r.status !== "invalidated");
  const ownerBindingOfOthers = labels.filter((row) => row.active && row.label.kind === "fact"
    && row.label.entityId === "person:owner" && /(?:colleague Taylor|Morgan's home)/iu.test(records.find((r) => r.id === row.memoryId)?.text ?? "")).length;
  const credentialStored = records.filter((r) => /fake-secret-123/iu.test(r.text)).length;
  const triggerText = TURNS.find((turn) => turn.kind === "trigger-outcome")?.memories[0]?.text;
  const triggerOutcomeStored = triggerText !== undefined && active.some((row) => row.text === triggerText);
  const falseAutomaticRecall = questions.reduce((sum, q) => sum + q.falseHits, 0);
  const parity = JSON.stringify(before) === JSON.stringify(after);
  const gates = {
    falseAutomaticRecall: falseAutomaticRecall === 0,
    ownerBindingOfOthers: ownerBindingOfOthers === 0,
    credentialStored: credentialStored === 0,
    pendingTurns: pending === 0,
    rebuildParity: parity,
    fixtureNonVacuous: records.length >= 5 && questions.length === QUESTIONS.length,
  };
  return { schema: 1, turns: TURNS.length, records: records.length, activeRecords: active.length,
    labels: labels.length, questions: questions.map(({ kind, hit, explicitHit, automaticHits, falseHits }) => ({ kind, hit, explicitHit, automaticHits, falseHits })),
    labelKinds: Object.fromEntries(["fact", "preference", "lesson"].map((kind) => [kind, labels.filter((row) => row.label.kind === kind && row.active).length])),
    superseded: records.filter((row) => row.status === "invalidated").length,
    categories: Object.fromEntries([...new Set(TURNS.map((t) => t.kind))].map((kind) => [kind, 1])),
    cpuMs: { total: cpuMs.reduce((a, b) => a + b, 0), perTurn: cpuMs },
    falseAutomaticRecall, ownerBindingOfOthers, credentialStored, triggerOutcomeStored, pendingTurns: pending,
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
        return JSON.stringify({ memories: turn.memories, entities: [], relations: [] });
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
      // A non-owner turn is not authorized to use owner direct recall. Count
      // any owner hit as a leak; never silently claim this is a built-in ACL.
      const automatic = selectAutomaticRecallHits(hits, { query: question.query,
        ...(question.ownerTurn === false ? {} : { ownerTurn: true }) });
      const texts = automatic.map((hit) => hit.record.text);
      const falseHits = question.expected
        ? texts.filter((text) => text !== question.expected).length
        : texts.length;
      results.push({ kind: question.kind, hit: question.expected ? texts.includes(question.expected) : false,
        explicitHit: question.expected ? hits.some((item) => item.record.text === question.expected) : false,
        automaticHits: texts.length, falseHits });
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
  console.error(`memory behaviour: ${report.passed ? "PASS" : "FAIL"}; turns=${report.turns} records=${report.records} false=${report.falseAutomaticRecall} pending=${report.pendingTurns} parity=${report.rebuildParity}`);
  if (!report.passed) process.exitCode = 1;
}
