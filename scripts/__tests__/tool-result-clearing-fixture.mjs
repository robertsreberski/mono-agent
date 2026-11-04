import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { retainContinuityText } from '../../packages/conversation/dist/tool-history/continuity-payload.js';
import { qualificationIdentity } from '../lib/tool-result-clearing-qualification-id.mjs';
import { createContinuitySchema, continuityRecordId } from '../../packages/conversation/dist/tool-history/continuity-storage.js';
import { hash } from '../lib/tool-result-clearing-reference.mjs';
export const SENTINEL = 'FICTIONAL-CONTENT-NEVER-OUTPUT-🧭';
export const route = { api: 'anthropic-messages', triggerTokens: 200000, drainTokens: 40000,
  summaryInputTokens: 40000, summaryOutputTokens: 2000, cacheLifetimeMs: 300000, cacheMarginMs: 30000,
  prices: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  quota: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }, quotaBudget: 1e8 };
export function makeFixture({ tool = 'Read', origin = true, resultText, runs = 14, toolCount = 12, configureRecord, incomplete = false, compactAt, scope = 'fictional', api = route.api, longLoop = false, administrativeTurns = 0 } = {}) {
  // Independent scratch directory, never a workspace or a node_modules link.
  const root = mkdtempSync(join(tmpdir(), 'clearing-fictional-'));
  const paths = Object.fromEntries(['journal.jsonl', 'sidecar.db', 'routes.json', 'proof.json', 'qualification.json'].map(n => [n, join(root, n)]));
  const db = new DatabaseSync(paths['sidecar.db']); createContinuitySchema(db);
  const physical = `physical-${scope}-${SENTINEL}`, logical = `logical-${scope}-${SENTINEL}`;
  const header = { format: 'mono-harness', version: 2, journalId: `fictional_journal_${scope}`, ownershipSchemaVersion: 1,
    ownership: { kind: 'unbound' }, initialHandle: { id: `handle-${SENTINEL}` }, id: `handle-${SENTINEL}`, cwd: root, createdAt: 0 };
  const records = [], proofs = [], secrets = [];
  let seq = 0, parentId = null, tip = null, now = 0;
  const add = (kind, payload, turnId, operationId) => {
    const r = { schemaVersion: 2, id: `record-${++seq}-${SENTINEL}`, parentId, seq, timestamp: now++, turnId,
      ...(operationId ? { operationId } : {}), kind, payload };
    records.push(r); parentId = r.id;
    if (['message', 'compaction'].includes(kind)) tip = r.id;
    return r;
  };
  for (let turn = 0; turn < runs; turn++) {
    now = turn * 1000000;
    const runId = `run-${turn}-${SENTINEL}`, op = `operation-${turn}-${SENTINEL}`;
    const config = { model: { provider: 'fictional', id: `model-${SENTINEL}`, api } };
    add('turn_start', { identitySource: 'synthetic', config, baselineTipId: tip }, runId);
    if (turn === 0) add('owner_binding', { kind: 'host', ownerKey: logical, historyBucket: physical }, runId);
    add('operation_start', { type: 'prompt', cause: SENTINEL, baselineTipId: tip, config }, runId, op);
    const message = m => add('message', { contextParentId: tip, message: { ...m, timestamp: m.timestamp ?? now }, input: { id: null, complete: true },
      provenance: { provider: 'fictional', api, model: SENTINEL } }, runId, op);
    message({ role: 'user', content: SENTINEL, timestamp: now });
    if (turn === compactAt) {
      const compactOp = `compact-${SENTINEL}`, userId = tip;
      add('operation_start', { type: 'compaction', cause: SENTINEL, parentOperationId: op, baselineTipId: tip, config }, runId, compactOp);
      const summaryMessage = { role: 'compactionSummary', summary: SENTINEL, tokensBefore: 200000, timestamp: now };
      const checkpoint = { version: 1, projectionVersion: 1, summaryMessage, preservedMessageIds: [userId], derivedMessages: [],
        coverage: { version: 1, sourceTipId: tip, sourceEntryCount: seq }, tokensBefore: 200000, tokensAfter: 40000, model: null };
      add('compaction', { contextParentId: tip, compaction: { summary: SENTINEL, tokensBefore: 200000, checkpoint },
        preservedMessageIds: [userId], derivedMessages: [], coverageVersion: 1 }, runId, compactOp);
      add('operation_end', { status: 'completed', tipId: tip }, runId, compactOp);
    }
    proofs.push({ runId, builtins: [tool], mcpTools: [] });
    if (turn === 0) for (let n = 0; n < toolCount; n++) {
      if (longLoop) now = Math.max(now, n * 70000);
      const callId = `call-${n}-${SENTINEL}`, text = resultText ?? `${SENTINEL}\n${'x'.repeat(n < 2 ? 50000 : 8000)}`;
      const m = { role: 'toolResult', toolCallId: callId, toolName: tool, isError: false, content: [{ type: 'text', text }], timestamp: now };
      const assistant = message({ role: 'assistant', content: [{ type: 'thinking', thinking: SENTINEL, thinkingSignature: SENTINEL },
        { type: 'toolCall', id: callId, name: tool, arguments: { query: SENTINEL, url: `https://fictional.invalid/${SENTINEL}` } }], stopReason: 'toolUse' });
      for (const admission of ['observed', 'admitted', 'started']) add('tool_call', { callId, name: tool, messageId: assistant.id, admission,
        ...(origin ? { origin: typeof origin === 'object' ? origin : { kind: 'builtin', tool } } : {}) }, runId, op);
      add('tool_result', { callId, name: tool, phase: 'returned', messageId: null, message: m, outcome: 'success' }, runId, op);
      const placed = message(m);
      add('tool_result', { callId, name: tool, phase: 'placed', messageId: placed.id, outcome: 'success' }, runId, op);
      const callKey = hash(JSON.stringify([physical, runId, callId]));
      const recordId = continuityRecordId(physical, `tool-result:${callKey}`);
      secrets.push(callKey, recordId, hash(text));
      const g = `generation-${n}-${SENTINEL}`;
      db.prepare(`INSERT INTO continuity_generations(generation_id,conversation_id,logical_id,action,preparation_digest,state,created_at_ms)
        VALUES(?,?,?,'publish',?,'committed',0)`).run(g, physical, logical, SENTINEL);
      const t = retainContinuityText(text);
      const r = { text: t.text, sha: t.sha256, original: t.originalBytes, retained: t.retainedBytes, redacted: Number(t.redacted), truncated: Number(t.truncated), finalized: 1 };
      configureRecord?.(r, n);
      db.prepare(`INSERT INTO continuity_records(record_id,generation_id,run_id,kind,seq,finalized,retained_text,text_sha256,
        original_bytes,retained_bytes,redacted,truncated,provenance,source_json,created_at_ms)
        VALUES(?,?,?,'tool',0,?,?,?,?,?,?,?,'tool',?,0)`).run(recordId, g, runId, r.finalized, r.text, r.sha, r.original, r.retained, r.redacted, r.truncated,
        JSON.stringify({ operationId: `tool:${callKey}`, note: SENTINEL }));
    }
    if (longLoop && turn === 0) now = 950000;
    message({ role: 'assistant', content: [{ type: 'text', text: SENTINEL }], stopReason: 'stop', usage: { totalTokens: 160000 } });
    add('operation_end', { status: 'completed', tipId: tip }, runId, op);
    if (!incomplete || turn < runs - 1) add('turn_end', { status: 'completed', consumedInputIds: [], finalOperationId: op, tipId: tip }, runId);
    if (turn === 0) for (let n = 0; n < administrativeTurns; n++) {
      const id = `administrative-${n}`;
      add('turn_start', { identitySource: 'synthetic', config, baselineTipId: tip }, id);
      add('turn_end', { status: 'completed', consumedInputIds: [], finalOperationId: null, tipId: tip }, id);
    }
  }
  db.close();
  writeFileSync(paths['journal.jsonl'], [header, ...records].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(paths['routes.json'], JSON.stringify([{ ...route, api, privateLabel: SENTINEL }]));
  writeFileSync(paths['proof.json'], JSON.stringify(proofs));
  writeFileSync(paths['qualification.json'], JSON.stringify({ ...qualificationIdentity(), routes: [{ api, status: 'payload-preserving', unintendedDifferences: 0 }] }));
  return { root, paths, records, header, secrets, physical, logical, options: { journals: [paths['journal.jsonl']], sidecar: paths['sidecar.db'], routes: paths['routes.json'],
    qualification: paths['qualification.json'], ...(origin === true ? { agentConfig: paths['proof.json'] } : {}) }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
