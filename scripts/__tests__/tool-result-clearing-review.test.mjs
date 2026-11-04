import { afterEach, expect, it } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyze as rawAnalyze } from '../lib/tool-result-clearing-analysis.mjs';
import { model, reportRoute } from '../lib/tool-result-clearing-model.mjs';
import { makeFixture, route } from './tool-result-clearing-fixture.mjs';
import { ToolHistoryWriter } from '../../packages/conversation/dist/tool-history/writer.js';
import { ToolHistoryReader } from '../../packages/conversation/dist/tool-history/reader.js';
import { createStreamSubscriber } from '../../packages/turn/dist/execution/pi/events.js';
import { createToolLifecycleEventGate } from '../../packages/turn/dist/runtime/tool-lifecycle.js';
import { assertContentFree } from './tool-result-clearing-privacy.mjs';
const fixtures = [];
const fixture = options => { const f = makeFixture(options); fixtures.push(f); return f; };
const analyze = options => { const report = rawAnalyze(options); assertContentFree(report, fixtures); return report; };
const rewrite = f => writeFileSync(f.options.journals[0], [f.header, ...f.records].map(x => JSON.stringify(x)).join('\n'));
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
it('measures idle gaps after the last tool-loop request, including failed assistant dispatches', () => {
  const warm = fixture({ longLoop: true, runs: 2 });
  expect(analyze(warm.options).routes[0].counts.cold).toBe(0);
  warm.records.findLast(r => r.kind === 'message' && r.turnId.startsWith('run-0') && r.payload.message.role === 'assistant').payload.message.stopReason = 'error';
  rewrite(warm);
  expect(analyze(warm.options).routes[0].gaps.underMinute).toBe(1);
  expect(analyze(fixture({ runs: 2 }).options).routes[0].counts.cold).toBe(1);
});
it('defers missing identity or qualification evidence; agent-period proof needs no run IDs', () => {
  const fs = ['one', 'two', 'three'].map(scope => fixture({ scope, origin: false }));
  const options = { ...fs[0].options, journals: fs.map(f => f.options.journals[0]) };
  expect(analyze(options).routes[0]).toMatchObject({ verdict: 'DEFER', codes: ['IDENTITY_UNPROVEN'] });
  writeFileSync(fs[0].paths['proof.json'], JSON.stringify({ builtins: ['Read'], mcpTools: 'none' }));
  expect(analyze({ ...options, agentConfig: fs[0].paths['proof.json'] }).routes[0].codes).not.toContain('IDENTITY_UNPROVEN');
  writeFileSync(fs[0].paths['proof.json'], JSON.stringify({ builtins: ['Read'], mcpTools: [{ exposedName: 'Read' }] }));
  expect(analyze({ ...options, agentConfig: fs[0].paths['proof.json'] }).routes[0].codes).toContain('IDENTITY_UNPROVEN');
  expect(analyze({ ...options, qualification: undefined }).routes[0].codes).toContain('PAYLOAD_UNQUALIFIED');
});
it('counts each cleared result once, not every later independently admissible boundary', () => {
  const report = analyze(fixture().options).routes[0];
  expect(report.counts).toMatchObject({ cold: 13, opportunities: 1 });
  expect(report.upperBoundBoundaryTokens).toBeGreaterThan(report.modeled.savedTokens);
  expect(report.savingsHistogram.under50k).toBe(1);
});
it('protects the last three prompt turns even after administrative turns', () => {
  const report = analyze(fixture({ runs: 2, administrativeTurns: 5 }).options);
  expect(report.counts.boundaries).toBe(2); expect(report.modeledUpperBoundBoundaryTokens).toBe(0);
});
it.each(['Bash', 'Exec', 'Edit', 'Write', 'NodeRepl', 'Agent', 'AgentManage', 'AskParent', 'FinishSilently', 'StructuredOutput', 'ReadSkill'])('excludes known noneligible %s from both bounds without proof', tool => {
  const report = analyze(fixture({ tool, origin: false }).options);
  expect(report.modeledUpperBoundBoundaryTokens).toBe(0); expect(report.routes[0].modeled.savedTokens).toBe(0);
});
it('refuses WAL-mode headers without opening or creating companions', () => {
  const f = fixture(), db = new DatabaseSync(f.options.sidecar); db.exec('PRAGMA journal_mode=WAL'); db.close();
  const before = readFileSync(f.options.sidecar);
  expect([...before.subarray(18, 20)]).toEqual([2, 2]);
  expect(analyze(f.options).codes).toEqual(['SIDECAR_NOT_OFFLINE']);
  expect(readFileSync(f.options.sidecar)).toEqual(before);
  expect(() => readFileSync(f.options.sidecar + '-wal')).toThrow(); expect(() => readFileSync(f.options.sidecar + '-shm')).toThrow();
});
it.each(['LEGACY_JOURNAL', 'IMPORTED_JOURNAL', 'INHERITED_PROJECTION', 'INTERRUPTION', 'OWNER_MISSING', 'UNSUPPORTED_API', 'ROUTE_MISSING', 'TIME_ORDER'])('publishes %s as a skip, not snapshot-global incompleteness', code => {
  const f = fixture();
  if (code === 'LEGACY_JOURNAL') f.header.format = 'fictional-legacy';
  if (code === 'IMPORTED_JOURNAL') f.header.import = {};
  if (code === 'INHERITED_PROJECTION') f.records[0].payload.projectionBinding = {};
  if (code === 'INTERRUPTION') f.records.push({ kind: 'interruption', payload: {} });
  if (code === 'OWNER_MISSING') f.records.find(r => r.kind === 'owner_binding').payload = { kind: 'unbound' };
  if (['UNSUPPORTED_API', 'ROUTE_MISSING'].includes(code)) for (const r of f.records) if (r.payload.config) r.payload.config.model.api = code === 'UNSUPPORTED_API' ? 'unsupported-fictional-api' : 'openai-responses';
  if (code === 'TIME_ORDER') f.records.find(r => r.kind === 'operation_start' && r.turnId.startsWith('run-1-')).timestamp = 0;
  rewrite(f); const report = analyze(f.options);
  expect(report.status).toBe('complete'); expect(report.codes).toEqual([]); expect(report.skipped[code]).toBeGreaterThan(0);
});
it('keeps supported evidence when a legacy neighbor is skipped, and detects duplicate boundaries', () => {
  const f = fixture(), duplicate = join(f.root, 'duplicate.jsonl');
  writeFileSync(duplicate, [JSON.stringify({ ...f.header, journalId: 'fictional_duplicate' }), ...f.records.map(r => JSON.stringify(r))].join('\n'));
  writeFileSync(join(f.root, 'legacy.jsonl'), JSON.stringify({ type: 'session' }));
  const report = analyze({ ...f.options, journals: [f.root] });
  expect(report.counts.boundaries).toBe(14); expect(report.skipped.DUPLICATE_BOUNDARY).toBe(14);
  expect(report.skipped.LEGACY_JOURNAL).toBe(1); expect(report.status).toBe('complete');
});
it('structurally validates missing-journal and invalid-route errors', () => {
  const f = fixture(), empty = join(f.root, 'empty'); mkdirSync(empty);
  expect(analyze({ ...f.options, journals: [empty] }).codes).toContain('NO_JOURNALS');
  writeFileSync(f.options.routes, '{"private":"fictional"}'); expect(analyze(f.options).codes).toContain('INPUT_INVALID');
});
it('rejects stale or unversioned qualification and gates exact cold and new-savings edges', () => {
  const f = fixture();
  const original = JSON.parse(readFileSync(f.options.qualification, 'utf8'));
  for (const field of ['piAiVersion', 'fixtureDigest']) {
    const q = structuredClone(original); q[field] = 'fictional-stale';
    writeFileSync(f.options.qualification, JSON.stringify(q)); expect(analyze(f.options).routes[0].codes).toContain('PAYLOAD_UNQUALIFIED');
  }
  const q = JSON.parse(readFileSync(fixture().options.qualification, 'utf8'));
  const boundaries = Array.from({ length: 10 }, (_, i) => ({ pressured: true, cold: true, logical: i % 3, growth: 1, saved: 20000, selected: 1, retrievalTokens: 0, requests: [] }));
  expect(reportRoute(route, boundaries, q, 0, false).counts.opportunities).toBe(10);
  boundaries[0].saved = 19999; expect(reportRoute(route, boundaries, q, 0, false).counts.opportunities).toBe(9);
  expect(reportRoute(route, boundaries.slice(0, 9), q, 0, false).verdict).toBe('DEFER');
  expect(reportRoute(route, boundaries.map(b => ({ ...b, logical: 0 })), q, 0, false).verdict).toBe('DEFER');
});
it('charges every observed request off-arm and labels heuristic fallback usage', () => {
  const request = { usage: { input: 100000, cacheRead: 50000, cacheWrite: 10000, output: 1000 }, activeSavings: 0, activeRetrieval: 0 };
  const boundary = { growth: 0, saved: 0, selected: 0, retrievalTokens: 0, requests: [request] };
  const one = model(route, [boundary], 0).costs[0], three = model(route, [{ ...boundary, requests: [request, request, request] }], 0).costs[0];
  expect(one.listOff).toBeCloseTo(0.3675); expect(three.listOff).toBeCloseTo(one.listOff * 3); expect(three.listRatio).toBe(1);
  const f = fixture(); const r = f.records.find(r => r.payload.message?.role === 'assistant'); r.payload.message.usage = request.usage; rewrite(f);
  expect(analyze(f.options).assumptions).toMatchObject({ requestCount: 26, fallbackRequests: 25, fallbackShare: 25 / 26 });
});

it('replays a native tool result through the production lifecycle adapter and writer without identity/content drift', async () => {
  const f = fixture(), root = join(f.root, 'writer');
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
  const native = f.records.find(r => r.kind === 'tool_result' && r.payload.phase === 'returned');
  const m = native.payload.message, persisted = [];
  const gate = createToolLifecycleEventGate({ onEvent() {}, sink: async event => {
    persisted.push(event); return writer.persist({ conversationId: f.physical, logicalConversationId: f.logical,
      runId: native.turnId, isolated: false, continuityEnabled: true, finalizedContinuity: true }, event);
  } });
  try {
    const state = { assistantTexts: [], assistantThinking: [], textDeltaIndexes: new Set(), thinkingDeltaIndexes: new Set(),
      toolStartTimes: new Map(), toolApprovals: new Map(), turnCount: 0, toolResultsSeen: 0, lastToolName: null,
      maxTurnsHit: false, toolExecutionsThisTurn: 0, toolFailureThisTurn: false, structuredOutputCompletedThisTurn: false, structuredResult: null };
    const handler = createStreamSubscriber(state, { onEvent: gate.emit, options: { cwd: f.root }, toolLimits: {},
      harness: { abort() {}, getModel: () => ({ contextWindow: 200000 }) }, sdk: 'pi', model: 'fictional' });
    handler({ type: 'tool_execution_start', toolName: m.toolName, toolCallId: m.toolCallId, args: {} });
    handler({ type: 'tool_execution_end', toolName: m.toolName, toolCallId: m.toolCallId, result: { content: m.content }, isError: false });
    await gate.flush();
    const event = persisted.find(e => e.phase === 'result');
    expect(event.toolCallId).toBe(m.toolCallId);
    const eventText = typeof event.content === 'string' ? event.content : event.content.map(b => b.text).join('\n');
    expect(eventText === m.content[0].text).toBe(true);
  } finally { await writer.close(); }
  const sidecar = new ToolHistoryReader(root).databasePath, db = new DatabaseSync(sidecar, { readOnly: true });
  try { expect(db.prepare('SELECT retained_text FROM continuity_records').get().retained_text).toBe(m.content[0].text); }
  finally { db.close(); }
  const report = analyze({ ...f.options, sidecar });
  expect(report.categories['builtin-read'].eligibleBytes).toBe(Buffer.byteLength(m.content[0].text));
  expect(report.exclusions.integrity).toBeUndefined();
});
