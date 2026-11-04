import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureFinalizedToolText } from '../../packages/conversation/dist/tool-history/continuity-lifecycle.js';
import { qualificationIdentity } from '../lib/tool-result-clearing-qualification-id.mjs';
import { createContinuitySchema } from '../../packages/conversation/dist/tool-history/continuity-storage.js';
import { JournalValidator, validateJournalHeader } from '../../packages/turn/dist/engine/journal-schema.js';
import { hash } from '../lib/tool-result-clearing-reference.mjs';
export const SENTINEL = 'FICTIONAL-CONTENT-NEVER-OUTPUT-🧭';
export const route = { api: 'anthropic-messages', triggerTokens: 200000, drainTokens: 40000,
  summaryInputTokens: 40000, summaryOutputTokens: 2000, cacheLifetimeMs: 300000, cacheMarginMs: 30000,
  prices: { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
  quota: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 }, quotaBudget: 1e8 };
export function makeFixture({ tool = 'Read', origin = true, resultText, runs = 14, toolCount = 12, configureRecord, incomplete = false, compactAt, scope = 'fictional', api = route.api, longLoop = false, administrativeTurns = 0, observedUsage = true } = {}) {
  // Independent scratch directory, never a workspace or a node_modules link.
  const root = mkdtempSync(join(tmpdir(), 'clearing-fictional-'));
  const paths = Object.fromEntries(['journal.jsonl', 'sidecar.db', 'routes.json', 'proof.json', 'qualification.json'].map(n => [n, join(root, n)]));
  const db = new DatabaseSync(paths['sidecar.db']); createContinuitySchema(db);
  // Empty ancillary accounting tables; production capture creates the retained rows.
  db.exec('CREATE TABLE metadata(key TEXT, value TEXT); CREATE TABLE tool_records(retained_bytes INTEGER)');
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
    const message = m => add('message', { contextParentId: tip, message: { ...(m.role === 'assistant' && observedUsage ? { usage: { input: 2000, cacheRead: 156000, cacheWrite: 1000, output: 1000, totalTokens: 160000 } } : {}), ...m, timestamp: m.timestamp ?? now }, input: { id: null, complete: true },
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
      add('tool_result', { callId, name: tool, messageId: placed.id, outcome: 'success' }, runId, op);
      captureFinalizedToolText(db, { conversationId: physical, logicalConversationId: logical, runId, isolated: false,
        continuityEnabled: true, finalizedContinuity: true }, { phase: 'result', toolCallId: callId, toolName: tool, state: 'success', content: m.content }, tool,
        { maxBytes: 1e8, maxCompletedCalls: 10000 }, () => {});
      const row = db.prepare('SELECT * FROM continuity_records ORDER BY ordinal DESC LIMIT 1').get();
      const callKey = JSON.parse(row.source_json).operationId.slice('tool:'.length);
      secrets.push(callKey, row.record_id, hash(text));
      const r = { text: row.retained_text, sha: row.text_sha256, original: row.original_bytes, retained: row.retained_bytes,
        redacted: row.redacted, truncated: row.truncated, finalized: row.finalized };
      configureRecord?.(r, n);
      db.prepare(`UPDATE continuity_records SET finalized=?,retained_text=?,text_sha256=?,original_bytes=?,retained_bytes=?,redacted=?,truncated=? WHERE record_id=?`)
        .run(r.finalized, r.text, r.sha, r.original, r.retained, r.redacted, r.truncated, row.record_id);
    }
    if (longLoop && turn === 0) now = 950000;
    message({ role: 'assistant', content: [{ type: 'text', text: SENTINEL }], stopReason: 'stop', ...(observedUsage ? {} : { usage: { totalTokens: 160000 } }) });
    add('operation_end', { status: 'completed', tipId: tip }, runId, op);
    if (!incomplete || turn < runs - 1) add('turn_end', { status: 'completed', consumedInputIds: [], finalOperationId: op, tipId: tip }, runId);
    if (turn === 0) for (let n = 0; n < administrativeTurns; n++) {
      const id = `administrative-${n}`;
      add('turn_start', { identitySource: 'synthetic', config, baselineTipId: tip }, id);
      add('turn_end', { status: 'completed', consumedInputIds: [], finalOperationId: null, tipId: tip }, id);
    }
  }
  db.close();
  validateJournalHeader(header);
  const validator = new JournalValidator();
  for (const record of records) validator.apply(record);
  writeFileSync(paths['journal.jsonl'], [header, ...records].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeFileSync(paths['routes.json'], JSON.stringify([{ ...route, api, privateLabel: SENTINEL }]));
  writeFileSync(paths['proof.json'], JSON.stringify(proofs));
  writeFileSync(paths['qualification.json'], JSON.stringify({ ...qualificationIdentity(), routes: [{ api, status: 'payload-preserving', unintendedDifferences: 0 }] }));
  return { root, paths, records, header, secrets, physical, logical, options: { journals: [paths['journal.jsonl']], sidecar: paths['sidecar.db'], routes: paths['routes.json'],
    qualification: paths['qualification.json'], ...(origin === true ? { agentConfig: paths['proof.json'] } : {}) }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
