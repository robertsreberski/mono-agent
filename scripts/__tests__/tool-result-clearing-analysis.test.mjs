import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync, readdirSync, lstatSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyze } from '../lib/tool-result-clearing-analysis.mjs';
import { gate, model, classifyBoundary, budgetBatch, validateRoutes, reportRoute, admitsBatch } from '../lib/tool-result-clearing-model.mjs';
import { PIN_BUDGET, identity, exclusion, hash, bytes, estimate, tokens } from '../lib/tool-result-clearing-reference.mjs';
import { makeFixture, route, SENTINEL } from './tool-result-clearing-fixture.mjs';
const fixtures = [];
const fixture = options => { const f = makeFixture(options); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const snapshot = root => readdirSync(root).sort().map(n => {
  const p = join(root, n), s = lstatSync(p);
  return [n, s.ino, s.size, s.mtimeMs, hash(readFileSync(p))];
});
const cli = (args, env = {}) => spawnSync(process.execPath, [resolve('scripts/tool-result-clearing-analyze.mjs'), ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });
const args = f => ['--journals', f.options.journals[0], '--sidecar', f.options.sidecar, '--routes', f.options.routes, '--qualification', f.options.qualification];

it('reads real native envelopes and schema read-only; stdout is aggregate and sentinel-free', () => {
  const f = fixture(), before = snapshot(f.root);
  const report = analyze(f.options);
  expect(report.status).toBe('complete');
  expect(report.codes).toEqual([]);
  expect(report.counts).toEqual({ journals: 1, boundaries: 14, observedCompactions: 0 });
  expect(report.categories['builtin-read'].results).toBe(12);
  expect(report.routes[0].counts).toMatchObject({ pressured: 13, conversations: 1, cold: 13, opportunities: 10 });
  expect(report.routes[0].modeled.savedTokens).toBeGreaterThan(20000);
  expect(report.exclusions.protected).toBeGreaterThan(0);
  const output = cli(args(f));
  expect(output.status).toBe(0);
  expect(JSON.parse(output.stdout)).toEqual(report);
  for (const sentinel of [SENTINEL, f.root, ...Object.values(f.paths), hash(SENTINEL), 'fictional.invalid']) {
    expect(output.stdout + output.stderr).not.toContain(sentinel);
  }
  expect(report.assumptions.retrievalEvidence).toBe('pending lookup-pilot evidence');
  expect(report.routes[0].modeled.costs.map(c => c.retrievalRate)).toEqual([0, 0.05, 0.2]);
  expect(snapshot(f.root)).toEqual(before);
});
it('keeps representativeness and opportunity denominators separate per API', () => {
  const fs = ['one', 'two', 'three'].map(scope => fixture({ scope }));
  const codex = fixture({ scope: 'four', api: 'openai-codex-responses' });
  writeFileSync(fs[0].options.routes, JSON.stringify([route, { ...route, api: 'openai-codex-responses', cacheLifetimeMs: 'unknown' }]));
  const report = analyze({ ...fs[0].options, journals: [...fs, codex].map(f => f.options.journals[0]) });
  // Only the first conversation has matching retained records in this sidecar.
  expect(report.routes[0].counts).toEqual({ pressured: 39, conversations: 3, cold: 39, opportunities: 10 });
  expect(report.routes[1].counts.conversations).toBe(1);
  expect(report.routes[1].verdict).toBe('DEFER');
  expect(report.verdict).not.toBe('BUILD');
});
it('never discovers inputs from the environment; sanitizes every failure and explicit output', () => {
  const f = fixture();
  const result = cli([], { HOME: f.root, MONO_AGENT_HOME: f.root });
  expect(result.status).toBe(2); expect(JSON.parse(result.stdout).verdict).toBe('DEFER');
  const bad = cli(['--journals', join(f.root, SENTINEL), '--sidecar', f.options.sidecar, '--routes', f.options.routes]);
  expect(bad.status).toBe(2); expect(bad.stdout + bad.stderr).not.toContain(SENTINEL);
  const out = join(f.root, 'explicit-report.json');
  expect(cli([...args(f), '--out', out]).status).toBe(0);
  expect(JSON.parse(readFileSync(out, 'utf8')).status).toBe('complete');
  // Exclusive creation prevents overwriting any input, report or symlink target.
  expect(cli([...args(f), '--out', out]).status).toBe(2);
  expect(cli([...args(f), '--out', f.options.sidecar]).status).toBe(2);
  expect(cli([...args(f), '--out', f.options.sidecar + '-wal']).status).toBe(2);
});
it.each(['size', 'inode', 'wal'])('marks a changed-during-read %s snapshot incomplete', change => {
  const f = fixture();
  const report = analyze(f.options, { afterRead() {
    const p = f.options.journals[0];
    if (change === 'size') writeFileSync(p, '\n', { flag: 'a' });
    if (change === 'inode') { writeFileSync(p + '.new', readFileSync(p)); renameSync(p + '.new', p); }
    if (change === 'wal') writeFileSync(f.options.sidecar + '-wal', SENTINEL);
  } });
  expect(report.status).toBe('incomplete'); expect(report.verdict).toBe('DEFER');
  expect(report.codes).toContain('SNAPSHOT_CHANGED');
});
it('refuses live SQLite sidecars without creating shared memory or checkpointing', () => {
  const f = fixture(); writeFileSync(f.options.sidecar + '-wal', SENTINEL);
  const before = snapshot(f.root), report = analyze(f.options);
  expect(report.codes).toContain('SIDECAR_NOT_OFFLINE'); expect(snapshot(f.root)).toEqual(before);
});
it('defers open turns, corrupt chains, duplicated journals and unavailable inherited projections', () => {
  const f = fixture({ incomplete: true }); expect(analyze(f.options).codes).toContain('OPEN_TURN');
  const g = fixture(); g.records[0].parentId = SENTINEL;
  writeFileSync(g.options.journals[0], [g.header, ...g.records].map(x => JSON.stringify(x)).join('\n'));
  expect(analyze(g.options).codes).toContain('JOURNAL_INVALID');
  const h = fixture(); writeFileSync(join(h.root, 'duplicate.jsonl'), readFileSync(h.options.journals[0]));
  expect(analyze({ ...h.options, journals: [h.root] }).codes).toContain('DUPLICATE_JOURNAL');
  h.header.import = { note: SENTINEL };
  writeFileSync(h.options.journals[0], JSON.stringify(h.header) + '\n');
  expect(analyze(h.options).status).toBe('incomplete');
});
it('keeps exposed-name ambiguity outside the lower bound; accepts exact run proof only', () => {
  const f = fixture({ origin: false });
  const unknown = analyze(f.options);
  expect(unknown.categories.ambiguous.results).toBe(12);
  expect(unknown.routes[0].modeled.savedTokens).toBe(0);
  expect(unknown.modeledUpperBoundBoundaryTokens).toBeGreaterThan(20000);
  expect(analyze({ ...f.options, agentConfig: f.paths['proof.json'] }).routes[0].modeled.savedTokens).toBeGreaterThan(20000);
  const proof = JSON.parse(readFileSync(f.paths['proof.json'], 'utf8'));
  proof[0].mcpTools = [{ exposedName: 'Read', server: SENTINEL }];
  writeFileSync(f.paths['proof.json'], JSON.stringify(proof));
  expect(analyze({ ...f.options, agentConfig: f.paths['proof.json'] }).routes[0].modeled.savedTokens).toBe(0);
  expect(identity('Bash', null, { builtins: ['Bash'], mcpTools: [] })).toBeNull();
  expect(identity('Read', { kind: 'mcp', server: 'fictional', tool: 'Read', serverIdentityDigest: hash('fictional') }, proof[0])).toBe('ambiguous');
});
it('measures native compaction checkpoints and resets their effective context', () => {
  const f = fixture({ compactAt: 6 });
  const report = analyze(f.options);
  expect(report.codes).toEqual([]);
  expect(report.counts.observedCompactions).toBe(1);
  expect(report.observed).toMatchObject({ drainTokens: 40000, preCompactionTokens: 200000 });
  expect(report.observed.summaryTokens).toBeGreaterThan(0);
});
it('requires exact reviewed server/tool/digest for app eligibility', () => {
  const origin = { kind: 'mcp', server: 'fictional-server', tool: 'lookup', serverIdentityDigest: hash('fictional-identity'), readOnlyHint: true, destructiveHint: false };
  const f = fixture({ tool: 'lookup', origin });
  expect(analyze(f.options).routes[0].modeled.savedTokens).toBe(0);
  const allow = join(f.root, 'allow.json'); writeFileSync(allow, JSON.stringify([{ ...origin, readOnly: true }]));
  expect(analyze({ ...f.options, appAllowlist: allow }).categories['app-declared'].results).toBe(12);
  expect(identity('lookup', { ...origin, destructiveHint: true }, null, [{ ...origin, readOnly: true }])).toBe('ambiguous');
  expect(identity('lookup', { ...origin, serverIdentityDigest: hash('other') }, null, [{ ...origin, readOnly: true }])).toBe('ambiguous');
});
it('reports JSON web yield, structured guard losses and escaped retrieval sizes separately', () => {
  const text = JSON.stringify({ status: 'ok', content: `${SENTINEL}\n\"quoted\"` });
  const f = fixture({ tool: 'WebFetch', resultText: text });
  const web = analyze(f.options).categories['builtin-web'];
  expect(web.eligibleBytes).toBe(bytes(text) * 12);
  expect(web.escapedBytes).toBe(bytes(JSON.stringify(text)) * 12);
  expect(web.escapedToOriginalRatio).toBeGreaterThan(1);
  const g = fixture({ tool: 'WebSearch', resultText: JSON.stringify({ content: { password: SENTINEL } }),
    configureRecord(r) { r.redacted = 1; r.text = '[omitted]'; } });
  expect(analyze(g.options).categories['builtin-web']).toMatchObject({ redacted: 12, structuredScanLosses: 12, eligibleBytes: 0 });
});
it.each(['redacted', 'truncated', 'finalized', 'sha', 'original', 'retained', 'text'])('excludes non-exact retained %s evidence', field => {
  const f = fixture({ configureRecord(r) { r[field] = ['redacted', 'truncated'].includes(field) ? 1 : field === 'finalized' ? 0 : typeof r[field] === 'number' ? 1 : SENTINEL; } });
  expect(analyze(f.options).routes[0].modeled.savedTokens).toBe(0);
});

const eligible = { pressured: 10, conversations: 3, cold: 4, opportunities: 1, pressureReduction: 0.15,
  costs: [0, 0.05, 0.2].map(retrievalRate => ({ retrievalRate, listRatio: 1.05, quotaRatio: 1.05 })), payload: 'payload-preserving' };
it('builds exactly at all gate thresholds without pooling route denominators', () => {
  expect(gate(eligible)).toBe('BUILD');
  expect(gate({ ...eligible, costs: eligible.costs.slice(0, 2) })).toBe('STOP');
  expect(admitsBatch(20000)).toBe(true); expect(admitsBatch(19999)).toBe(false);
  expect(gate({ ...eligible, pressured: 9 })).toBe('DEFER');
  expect(gate({ ...eligible, conversations: 2 })).toBe('DEFER');
  expect(gate({ ...eligible, cold: 0 })).toBe('DEFER');
  expect(gate({ ...eligible, incomplete: true })).toBe('DEFER');
  expect(gate({ ...eligible, codex: true })).toBe('DEFER');
  expect(gate({ ...eligible, cold: 5 })).toBe('STOP');
  expect(gate({ ...eligible, pressureReduction: 0.15 - 1e-10 })).toBe('STOP');
  expect(gate({ ...eligible, payload: 'fails' })).toBe('STOP');
  for (let i = 0; i < 3; i++) for (const view of ['listRatio', 'quotaRatio']) {
    const costs = structuredClone(eligible.costs); costs[i][view] += 1e-10;
    expect(gate({ ...eligible, costs })).toBe('STOP');
  }
  expect(reportRoute({ ...route, api: 'openai-codex-responses' }, [], null, 0.05, false)).toMatchObject({ verdict: 'DEFER', wire: 'wire-unproven (transport)' });
});
it('classifies exact pressure and cold thresholds; unknown cache lifetime is never cold', () => {
  expect(classifyBoundary(150000, 330000, route)).toEqual({ pressured: true, cold: false });
  expect(classifyBoundary(149999, 330001, route)).toEqual({ pressured: false, cold: true });
  expect(classifyBoundary(199999, null, route)).toEqual({ pressured: true, cold: false });
  expect(classifyBoundary(200000, 330001, route).pressured).toBe(false);
  expect(classifyBoundary(160000, 1e9, { ...route, cacheLifetimeMs: 'unknown' }).cold).toBe(false);
});
it('honors exact pin-budget boundaries, prior pins, ambiguity and continuous cost arithmetic', () => {
  const a = { key: 'a', category: 'builtin-read', size: PIN_BUDGET, net: 20000 };
  expect(budgetBatch([a], new Set(), 0, PIN_BUDGET)).toEqual([a]);
  expect(budgetBatch([a], new Set(), 1, PIN_BUDGET)).toEqual([]);
  expect(budgetBatch([a], new Set(['a']), 0, PIN_BUDGET)).toEqual([]);
  expect(budgetBatch([{ ...a, category: 'ambiguous' }], new Set(), 0, PIN_BUDGET)).toEqual([]);
  const modeled = model(route, [{ growth: 160000, saved: 40000, selected: 2, retrievalTokens: 41000, cold: true }], 0.1);
  expect(model({ ...route, summaryInputTokens: 300000 }, [{ growth: 160000, saved: 40000, selected: 2, retrievalTokens: 41000, cold: true }], 0.1).pressureReduction).toBe(0);
  expect(modeled.offPressure).toBe(1); expect(modeled.onPressure).toBeCloseTo(0.8205);
  expect(modeled.pressureReduction).toBeCloseTo(0.1795);
  expect(modeled.costs.map(c => c.retrievalRate)).toEqual([0, 0.05, 0.1, 0.2]);
  expect(modeled.costs[3].listOn).toBeGreaterThan(modeled.costs[0].listOn);
  expect(modeled.costs[3].quotaShareOn).toBeGreaterThan(modeled.costs[0].quotaShareOn);
  expect(validateRoutes([{ ...route, extra: SENTINEL }])[0]).not.toHaveProperty('extra');
  expect(() => validateRoutes([{ ...route, prices: {} }])).toThrow();
});
it('matches the usage-plus-trailing character heuristic including images and Unicode', () => {
  expect(tokens({ role: 'toolResult', content: [{ type: 'text', text: '🧭🧭' }] })).toBe(1);
  expect(tokens({ role: 'user', content: [{ type: 'image' }] })).toBe(1200);
  expect(estimate([{ role: 'assistant', stopReason: 'stop', content: [], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 } },
    { role: 'user', content: 'abcd' }])).toEqual({ tokens: 20, source: 'provider-usage-plus-heuristic' });
  expect(estimate([{ role: 'user', content: 'abcd' }])).toEqual({ tokens: 1, source: 'character-heuristic' });
});
it('protects lifecycle, approvals, unresolved effects, errors, mixed, image and opaque results', () => {
  const m = { isError: false, content: [{ type: 'text', text: SENTINEL }] };
  const r = { finalized: 1, state: 'committed', tombstone_reason: null, redacted: 0, truncated: 0,
    original_bytes: bytes(SENTINEL), retained_bytes: bytes(SENTINEL), text_sha256: hash(SENTINEL), retained_text: SENTINEL };
  const state = { completed: true, returned: true, placed: true };
  expect(exclusion(m, r, state)).toBeNull();
  for (const k of ['completed', 'returned', 'placed']) expect(exclusion(m, r, { ...state, [k]: false })).toBe('lifecycle');
  for (const k of ['approval', 'unresolved']) expect(exclusion(m, r, { ...state, [k]: true })).toBe('lifecycle');
  expect(exclusion(m, r, { ...state, protected: true })).toBe('protected');
  expect(exclusion({ ...m, isError: true }, r, state)).toBe('error');
  for (const content of [[{ type: 'image' }], [...m.content, { type: 'image' }], [{ type: 'opaque' }], [{ ...m.content[0], extension: true }]]) {
    expect(exclusion({ ...m, content }, r, state)).toBe('blocks');
  }
});
