import { afterEach, expect, it } from 'vitest';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { analyze as rawAnalyze } from '../lib/tool-result-clearing-analysis.mjs';
import { validVersion } from '../lib/tool-result-clearing-qualification-id.mjs';
import { model, reportRoute } from '../lib/tool-result-clearing-model.mjs';
import { makeFixture, route } from './tool-result-clearing-fixture.mjs';
import { createDurableHistoryStore } from '../../packages/conversation/dist/history/canonical/store.js';
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
  expect(report.status).toBe('complete'); expect(report.codes).toEqual([]); expect((report.skippedJournals[code] ?? report.skippedBoundaries[code])).toBeGreaterThan(0);
});
it('keeps supported evidence when a legacy neighbor is skipped, and detects duplicate boundaries', () => {
  const f = fixture(), duplicate = join(f.root, 'duplicate.jsonl');
  writeFileSync(duplicate, [JSON.stringify({ ...f.header, journalId: 'fictional_duplicate' }), ...f.records.map(r => JSON.stringify(r))].join('\n'));
  writeFileSync(join(f.root, 'legacy.jsonl'), JSON.stringify({ type: 'session' }));
  const report = analyze({ ...f.options, journals: [f.root] });
  expect(report.counts.boundaries).toBe(14); expect(report.skippedBoundaries.DUPLICATE_BOUNDARY).toBe(14);
  expect(report.skippedJournals.LEGACY_JOURNAL).toBe(1); expect(report.status).toBe('complete');
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
  const f = fixture({ observedUsage: false }); const r = f.records.find(r => r.payload.message?.role === 'assistant'); r.payload.message.usage = request.usage; rewrite(f);
  expect(analyze(f.options).assumptions).toMatchObject({ requestCount: 26, fallbackRequests: 25, fallbackShare: 25 / 26 });
});

it('replays a native tool result through the production lifecycle adapter and writer without identity/content drift', async () => {
  const f = fixture(), root = join(f.root, 'writer');
  const writer = await ToolHistoryWriter.open({ root, continuityEnabled: true });
  const native = f.records.find(r => r.kind === 'tool_result' && r.payload.phase === 'returned');
  const m = native.payload.message, persisted = [];
  const history = createDurableHistoryStore({ root, continuity: {} });
  const turn = await history.contextImport.beginExclusiveTurn(f.physical, AbortSignal.timeout(5000));
  const gate = createToolLifecycleEventGate({ onEvent() {}, sink: async event => {
    persisted.push(event); return turn.withContinuityOwner(async () => writer.persist({ conversationId: f.physical, logicalConversationId: f.logical,
      runId: native.turnId, isolated: false, continuityEnabled: true, finalizedContinuity: true }, event));
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
    await writer.persist({ conversationId: f.physical, logicalConversationId: f.logical, runId: native.turnId, isolated: false, continuityEnabled: true },
      { phase: 'result', toolCallId: 'fictional-unowned', toolName: 'Read', state: 'success', content: 'fictional unowned output' });
    await turn.abort();
    await expect(turn.withContinuityOwner(async () => {})).rejects.toThrow();
  } finally { await turn.abort(); await writer.close(); }
  const sidecar = new ToolHistoryReader(root).databasePath, db = new DatabaseSync(sidecar, { readOnly: true });
  try { expect(db.prepare('SELECT retained_text FROM continuity_records').all().map(r => r.retained_text)).toEqual([m.content[0].text]); }
  finally { db.close(); }
  const report = analyze({ ...f.options, sidecar });
  expect(report.categories['builtin-read'].eligibleBytes).toBe(Buffer.byteLength(m.content[0].text));
  expect(report.exclusions.integrity).toBeUndefined();
});

it('prices cached prefix deltas symmetrically at exactly fifteen percent pressure reduction', () => {
  const savings = (route.triggerTokens - route.drainTokens) * 0.15 / 0.85;
  const usage = { input: 2000, cacheRead: 147000, cacheWrite: 1000, output: 1000 };
  const request = { usage, source: 'provider-usage', activeSavings: savings, activeRetrieval: savings };
  const boundaries = Array.from({ length: 12 }, (_, i) => ({ pressured: true, cold: true, logical: i % 3,
    growth: 160000 / 12, saved: i ? 0 : savings, selected: i ? 0 : 1, retrievalTokens: i ? 0 : savings, requests: Array(10).fill(request) }));
  const result = model(route, boundaries, 0), c = result.costs[0];
  const prefixRate = (2000 * 3 + 147000 * 0.3 + 1000 * 3.75) / 150000;
  expect(result.pressureReduction).toBeCloseTo(0.15, 12);
  expect(c.listDelta.retained).toBeCloseTo(120 * savings / 2 * prefixRate / 1e6);
  expect(c.listDelta.removed).toBeCloseTo(-120 * savings * prefixRate / 1e6);
  for (const cost of result.costs) {
    expect(cost.listOn - cost.listOff).toBeCloseTo(Object.values(cost.listDelta).reduce((a, b) => a + b, 0));
    expect(cost.quotaShareOn - cost.quotaShareOff).toBeCloseTo(Object.values(cost.quotaShareDelta).reduce((a, b) => a + b, 0));
    expect(cost.listRatio).toBeLessThanOrEqual(1.05); expect(cost.quotaRatio).toBeLessThanOrEqual(1.05);
    expect(cost.allUncachedInformational.listOn).toBeGreaterThan(cost.listOff * 1.05);
    expect(cost.allUncachedInformational.gating).toBe(false);
  }
  // A genuinely expensive retrieval workload must still fail the cost criterion.
  const expensive = model(route, boundaries.map(b => ({ ...b, requests: b.requests.map(r => ({ ...r, activeRetrieval: 1e7 })) })), 0.2);
  expect(expensive.costs.at(-1).listRatio).toBeGreaterThan(1.05);
  expect(analyze(fixture().options).assumptions.fallbackRequests).toBe(0);
});
it('defers absent and under-half retention coverage, counting unique proven plain-text results', () => {
  const f = fixture(), db = new DatabaseSync(f.options.sidecar);
  try { db.exec('DELETE FROM continuity_records WHERE ordinal NOT IN (SELECT ordinal FROM continuity_records ORDER BY ordinal LIMIT 6)'); }
  finally { db.close(); }
  let report = analyze(f.options).routes[0];
  expect(report.retention).toEqual({ provenResults: 12, matchedResults: 6, unmatchedResults: 6, matchedShare: 0.5 });
  expect(report.codes).not.toContain('RETENTION_COVERAGE_LOW');
  const next = new DatabaseSync(f.options.sidecar); next.exec('DELETE FROM continuity_records WHERE ordinal=(SELECT MIN(ordinal) FROM continuity_records)'); next.close();
  report = analyze(f.options).routes[0]; expect(report.codes).toContain('RETENTION_COVERAGE_LOW'); expect(report.verdict).toBe('DEFER');
  const empty = new DatabaseSync(f.options.sidecar); empty.exec('DELETE FROM continuity_records'); empty.close();
  report = analyze(f.options).routes[0]; expect(report.codes).toContain('RETENTION_UNMATCHED'); expect(report.retention.matchedShare).toBe(0);
  const q = JSON.parse(readFileSync(f.options.qualification, 'utf8'));
  const boundaries = Array.from({ length: 12 }, (_, i) => ({ pressured: true, cold: true, logical: i % 3, growth: 1, saved: 0, selected: 0, retrievalTokens: 0, retention: [{ key: i, matched: false }] }));
  expect(reportRoute(route, boundaries, q, 0, false).verdict).toBe('DEFER');
});
it('continues same-journal re-prompts but skips cross-journal duplicates', () => {
  const f = fixture({ runs: 2, toolCount: 0 }), index = f.records.findIndex(r => r.kind === 'turn_end');
  const original = f.records[index - 2], op = 'fictional-retry', start = structuredClone(f.records.find(r => r.kind === 'operation_start'));
  Object.assign(start, { id: 'fictional-retry-start', operationId: op }); start.payload.baselineTipId = original.id;
  const message = structuredClone(original); Object.assign(message, { id: 'fictional-retry-message', operationId: op }); message.payload.contextParentId = original.id;
  const end = structuredClone(f.records[index - 1]); Object.assign(end, { id: 'fictional-retry-end', operationId: op }); end.payload.tipId = message.id;
  const suffix = JSON.parse(JSON.stringify(f.records.slice(index)).replaceAll(original.id, message.id)); suffix[0].payload.finalOperationId = op;
  f.records.splice(index, f.records.length - index, start, message, end, ...suffix);
  f.records.forEach((r, i) => { r.seq = i + 1; r.parentId = i ? f.records[i - 1].id : null; }); rewrite(f);
  let report = analyze(f.options); expect(report.skippedJournals).toEqual({}); expect(report.skippedBoundaries).toEqual({});
  expect(report.counts.boundaries).toBe(2); expect(report.assumptions.requestCount).toBe(3);
  const copy = join(f.root, 'copy.jsonl'); writeFileSync(copy, [JSON.stringify({ ...f.header, journalId: 'fictional-copy' }), ...f.records.map(r => JSON.stringify(r))].join('\n'));
  report = analyze({ ...f.options, journals: [f.options.journals[0], copy] });
  expect(report.skippedBoundaries.DUPLICATE_BOUNDARY).toBe(2); expect(report.assumptions.requestCount).toBe(3);
});
it('defers usage fallback above five percent, but not at the exact floor', () => {
  const f = fixture({ observedUsage: false }); expect(analyze(f.options).routes[0].codes).toContain('USAGE_FALLBACK_EXCESSIVE');
  const q = JSON.parse(readFileSync(f.options.qualification, 'utf8'));
  const requests = Array.from({ length: 20 }, (_, i) => ({ usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 1 }, source: i ? 'provider-usage' : 'character-heuristic', activeSavings: 0, activeRetrieval: 0 }));
  const boundary = { growth: 0, saved: 0, selected: 0, retrievalTokens: 0, requests };
  expect(reportRoute(route, [boundary], q, 0, false).codes).not.toContain('USAGE_FALLBACK_EXCESSIVE');
  requests[1].source = 'character-heuristic'; expect(reportRoute(route, [boundary], q, 0, false).codes).toContain('USAGE_FALLBACK_EXCESSIVE');
});
it('discards every partial contribution of a journal that fails during checkpoint replay', () => {
  const f = fixture({ compactAt: 6 }), baseline = analyze(f.options), good = join(f.root, 'good.jsonl');
  writeFileSync(good, readFileSync(f.options.journals[0]));
  const p = f.records.find(r => r.kind === 'compaction').payload;
  p.derivedMessages = p.compaction.checkpoint.derivedMessages = [{ role: 'toolResult', content: [{ type: 'text', text: null }] }]; rewrite(f);
  const report = analyze({ ...f.options, journals: [f.options.journals[0], good] });
  expect(report.skippedJournals).toEqual({ JOURNAL_INVALID: 1 }); expect(report.skippedBoundaries).toEqual({});
  for (const key of ['counts', 'observed', 'categories', 'exclusions', 'routes']) expect(report[key]).toEqual(baseline[key]);
});
it('accepts prerelease and build-qualified dependency versions without relaxing output privacy', () => {
  for (const version of ['1.2.0', '1.2.0-rc.1', '1.2.0-dev.3+build.7']) expect(validVersion(version)).toBe(true);
  for (const version of ['private', '1.2.0-', '1.2.0+']) expect(validVersion(version)).toBe(false);
});
