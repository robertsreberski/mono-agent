import { lstatSync, readdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { containsVisibleSensitiveText } from '../../packages/observability/dist/redaction.js';
// Deliberately narrow offline imports: these modules depend only on node:crypto.
import { JournalValidator, validateJournalHeader } from '../../packages/turn/dist/engine/journal-schema.js';
import { APIS, PIN_BUDGET, hash, bytes, identity, exclusion, renderStub, estimate, tokens } from './tool-result-clearing-reference.mjs';
import { qualificationIdentity } from './tool-result-clearing-qualification-id.mjs';
import { validateRoutes, reportRoute, classifyBoundary, budgetBatch, admitsBatch } from './tool-result-clearing-model.mjs';

const stamp = path => {
  try { const s = lstatSync(path); return [s.dev, s.ino, s.size, s.mtimeMs, s.mode].join(':'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
};
const categoryCounts = () => Object.fromEntries(['builtin-read', 'builtin-search', 'builtin-web', 'app-declared', 'ambiguous'].map(k => [k,
  { results: 0, originalBytes: 0, eligibleBytes: 0, escapedBytes: 0, structuredScanLosses: 0, redacted: 0, truncated: 0 }]));
export function analyze(options, hooks = {}) {
  const tracked = new Map(), codes = new Set(), categories = categoryCounts(), exclusions = {}, skipped = {};
  const skip = code => { skipped[code] = (skipped[code] ?? 0) + 1; };
  const policies = new Map();
  const policyFor = physical => {
    if (!policies.has(physical)) policies.set(physical, { cleared: new Set(), completedRuns: new Set(), pinBytes: 0, activeSavings: 0, activeRetrieval: 0, lastBatch: -Infinity, runs: 0 });
    return policies.get(physical);
  };
  const track = path => {
    path = resolve(path);
    if (!tracked.has(path)) { const value = stamp(path); if (value !== null && lstatSync(path).isSymbolicLink()) throw new Error('INPUT'); tracked.set(path, value); }
    return path;
  };
  const count = reason => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  let boundaries = [], observedCompactions = 0;
  const observed = { summaryTokens: 0, drainTokens: 0, preCompactionTokens: 0 };
  const routeCategories = new Map(), seenResults = new Set(), seenJournals = new Set(), seenBoundaries = new Set();
  const finish = (routes = [], qualification, retrievalRate = 0.05) => {
    hooks.afterRead?.();
    for (const [path, before] of tracked) if (stamp(path) !== before) codes.add('SNAPSHOT_CHANGED');
    const incomplete = codes.size > 0;
    const reports = routes.map(r => ({ ...reportRoute(r, boundaries.filter(b => b.api === r.api), qualification, retrievalRate, incomplete),
      categories: routeCategories.get(r.api) ?? categoryCounts() }));
    for (const group of [categories, ...reports.map(r => r.categories)]) for (const c of Object.values(group)) c.escapedToOriginalRatio = c.eligibleBytes ? c.escapedBytes / c.eligibleBytes : null;
    const requests = boundaries.flatMap(b => b.requests);
    const fallbackRequests = requests.filter(r => r.source === 'character-heuristic').length;
    return { status: incomplete ? 'incomplete' : 'complete', codes: [...codes].sort(), skipped, piAiVersion: qualificationIdentity().piAiVersion,
      assumptions: { modeled: true, exclusionUnit: 'result-boundary-occurrences', requestCount: requests.length, fallbackRequests,
        fallbackShare: requests.length ? fallbackRequests / requests.length : 0, tokenHeuristic: 'utf16-ceil/4', imageTokens: 1200,
        pinBudgetBytes: PIN_BUDGET, protectedTurns: 3, protectedToolUses: 10, minimumBatchTokens: 20000,
        minimumRunsBetweenBatches: 5, retrievalRate, retrievalEvidence: options.retrievalRate === undefined ? 'pending lookup-pilot evidence' : 'supplied',
        summaryToolCharacterLimit: 2000, costModel: 'observed-requests-plus-modeled-delta',
        quotaUnit: 'share-of-supplied-quota-budget', priceUnit: 'per-million-tokens', warmClearing: false },
      counts: { journals: seenJournals.size, boundaries: boundaries.length, observedCompactions }, observed, categories, exclusions,
      routes: reports, verdict: incomplete || !reports.length ? 'DEFER'
        : reports.some(r => r.verdict === 'STOP') ? 'STOP' : reports.every(r => r.verdict === 'BUILD') ? 'BUILD' : 'DEFER' };
  };
  try {
    if (!Array.isArray(options.journals) || !options.journals.length || !options.sidecar || !options.routes) throw new Error('INPUT');
    const json = path => JSON.parse(readFileSync(track(path), 'utf8'));
    const routes = validateRoutes(json(options.routes));
    const retrievalRate = options.retrievalRate === undefined ? 0.05 : Number(options.retrievalRate);
    if (!Number.isFinite(retrievalRate) || retrievalRate < 0 || retrievalRate > 1) throw new Error('INPUT');
    const proofs = options.agentConfig ? json(options.agentConfig) : [];
    const allowlist = options.appAllowlist ? json(options.appAllowlist) : [];
    const validProof = p => p && Array.isArray(p.builtins) && p.builtins.every(x => typeof x === 'string')
      && (p.mcpTools === 'none' || Array.isArray(p.mcpTools) && p.mcpTools.every(x => typeof x?.exposedName === 'string'));
    if (!(Array.isArray(proofs) ? proofs.every(validProof) : validProof(proofs)) || !Array.isArray(allowlist)) throw new Error('INPUT');
    if (allowlist.some(x => !x || typeof x.server !== 'string' || typeof x.tool !== 'string' || typeof x.serverIdentityDigest !== 'string')) throw new Error('INPUT');
    const qualification = options.qualification ? json(options.qualification) : null;
    const files = new Set();
    const visit = path => {
      path = track(path);
      const s = lstatSync(path);
      if (s.isSymbolicLink()) throw new Error('INPUT');
      if (s.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
      else if (s.isFile() && path.endsWith('.jsonl')) files.add(path);
      else if (!s.isFile()) throw new Error('INPUT');
    };
    for (const root of options.journals) visit(root);
    if (!files.size) codes.add('NO_JOURNALS');
    const dbPath = track(options.sidecar);
    if (lstatSync(dbPath).isSymbolicLink()) throw new Error('INPUT');
    // A read-only SQLite WAL reader can create/write shared memory. Require an
    // offline, checkpointed snapshot instead; never checkpoint or repair inputs.
    if ([`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`].map(track).some(p => stamp(p) !== null)) {
      codes.add('SIDECAR_NOT_OFFLINE'); return finish(routes, qualification, retrievalRate);
    }
    const headerBytes = Buffer.alloc(2), handle = openSync(dbPath, 'r');
    try { readSync(handle, headerBytes, 0, 2, 18); } finally { closeSync(handle); }
    if (headerBytes.includes(2)) { codes.add('SIDECAR_NOT_OFFLINE'); return finish(routes, qualification, retrievalRate); }
    let rows;
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = database.prepare(`SELECT r.*, g.state, g.conversation_id, g.logical_id FROM continuity_records r
        JOIN continuity_generations g USING(generation_id) WHERE r.kind='tool'`).all();
    } finally { database.close(); }
    const retained = new Map(rows.map(r => [r.record_id, r]));
    for (const file of files) {
      try {
        const [header, ...records] = readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
        if (header?.format !== 'mono-harness' || header.version !== 2) { skip('LEGACY_JOURNAL'); continue; }
        if (header.import) { skip('IMPORTED_JOURNAL'); continue; }
        if (records.some(r => r.payload?.projectionBinding)) { skip('INHERITED_PROJECTION'); continue; }
        if (records.some(r => r.kind === 'interruption')) { skip('INTERRUPTION'); continue; }
        validateJournalHeader(header);
        if (seenJournals.has(header.journalId)) { skip('DUPLICATE_JOURNAL'); continue; }
        seenJournals.add(header.journalId);
        const validator = new JournalValidator();
        for (const record of records) {
          validator.apply(record);
          if (record.kind === 'message') {
            const m = record.payload.message; tokens(m);
            if (m.role === 'toolResult' && (typeof m.toolName !== 'string' || typeof m.toolCallId !== 'string')) throw new Error('INPUT');
          }
        }
        if (validator.openTurns.size || validator.openOperations.size) { skip('OPEN_TURN'); continue; }
        const promptTurns = new Set(), allEntries = new Map(), contexts = new Map([[null, []]]), calls = new Map(), turns = new Map();
        let context = [], completed = [], uses = [], pending = null, owner = header.hostAuthority;
        let lastDispatch = null, lastEstimate = null, compacted = false, observedDrain = 0, growthBeforeCompaction = 0, currentBoundary;
        const boundary = () => {
          if (!pending) return;
          const { record: start, api } = pending;
          pending = null; currentBoundary = null;
          const route = routes.find(r => r.api === api);
          if (!APIS.includes(api)) { skip('UNSUPPORTED_API'); currentBoundary = null; return; }
          if (!route) { skip('ROUTE_MISSING'); currentBoundary = null; return; }
          const physical = owner?.historyBucket, logical = owner?.ownerKey;
          if (!physical || !logical) { skip('OWNER_MISSING'); return; }
          const boundaryKey = JSON.stringify([physical, start.turnId]);
          if (seenBoundaries.has(boundaryKey)) { skip('DUPLICATE_BOUNDARY'); return; }
          seenBoundaries.add(boundaryKey);
          const measured = estimate(context.map(x => x.message));
          const gap = lastDispatch === null ? null : start.timestamp - lastDispatch;
          if (gap !== null && gap < 0) { skip('TIME_ORDER'); currentBoundary = null; return; }
          const { pressured, cold } = classifyBoundary(measured.tokens, gap, route);
          const protectedTurns = new Set(completed.filter(id => promptTurns.has(id)).slice(-3)), protectedUses = new Set(uses.slice(-10));
          const candidates = [];
          for (const entry of context) {
            const m = entry.message;
            if (m.role !== 'toolResult') continue;
            const call = calls.get(`${entry.operationId}\0${m.toolCallId}`);
            const callKey = hash(JSON.stringify([physical, entry.turnId, m.toolCallId]));
            const recordId = `chr1_${Buffer.from(hash(JSON.stringify([physical, `tool-result:${callKey}`])), 'hex').toString('base64url')}`;
            const record = retained.get(recordId);
            const proof = Array.isArray(proofs) ? proofs.find(p => p.runId === entry.turnId) : proofs;
            const classification = identity(m.toolName, call?.origin, proof, allowlist);
            const category = classification ?? 'ambiguous';
            const state = { completed: turns.get(entry.turnId) === 'completed', returned: call?.returned,
              placed: call?.placed,
              protected: protectedTurns.has(entry.turnId) || protectedUses.has(call) || entry.turnId === start.turnId };
            const scopeExcluded = classification === null || ['ConversationHistory', 'conversation_history', 'SessionHistory', 'session_history', 'RunHistory', 'run_history', 'ReadSkill']
              .some(name => m.toolName === name || m.toolName.endsWith(`__${name}`))
              || call?.origin?.kind === 'builtin' && !['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(m.toolName);
            const reason = scopeExcluded ? 'tool_scope' : record && (record.conversation_id !== physical || record.logical_id !== logical || record.run_id !== entry.turnId)
              ? 'integrity' : exclusion(m, record, state);
            const key = `${physical}\0${entry.turnId}\0${m.toolCallId}`;
            if (!routeCategories.has(api)) routeCategories.set(api, categoryCounts());
            for (const [scope, group] of [['all', categories], [api, routeCategories.get(api)]]) {
              if (seenResults.has(`${scope}\0${key}`)) continue;
              seenResults.add(`${scope}\0${key}`);
              const c = group[category]; c.results++;
              const text = m.content?.[0]?.type === 'text' ? m.content[0].text : '';
              c.originalBytes += bytes(text);
              if (record?.redacted) c.redacted++;
              if (record?.truncated) c.truncated++;
              if (category === 'builtin-web' && record?.redacted) {
                try { JSON.parse(text); if (containsVisibleSensitiveText(text)) c.structuredScanLosses++; } catch { /* not an envelope */ }
              }
              // Protection is boundary-dependent, retention yield is not.
              if (!scopeExcluded && !exclusion(m, record, { ...state, protected: false })) { c.eligibleBytes += bytes(text); c.escapedBytes += bytes(JSON.stringify(text)); }
            }
            if (reason) { count(reason); continue; }
            const net = tokens(m) - tokens({ ...m, content: [{ type: 'text', text: renderStub(m, record) }] });
            if (net <= 0) { count('nonpositive'); continue; }
            candidates.push({ key, category, net, size: record.original_bytes, retrieval: Math.ceil(JSON.stringify(m.content[0].text).length / 4) });
          }
          // Upper bound is independent of pinning/identity; never used by the gate.
          const upperTokens = budgetBatch(candidates.map(c => ({ ...c, category: 'upper' })), new Set(), 0, PIN_BUDGET).reduce((s, c) => s + c.net, 0);
          const policy = policyFor(physical);
          const effective = classifyBoundary(measured.tokens - policy.activeSavings + retrievalRate * policy.activeRetrieval, gap, route);
          let saved = 0, selected = 0, retrievalTokens = 0;
          if (effective.pressured && cold && policy.runs - policy.lastBatch >= 5) {
            const batch = budgetBatch(candidates, policy.cleared, policy.pinBytes, PIN_BUDGET);
            for (const c of candidates) {
              if (c.category === 'ambiguous') count('identity');
              else if (!policy.cleared.has(c.key) && !batch.includes(c)) count('pin_budget');
            }
            const batchBytes = batch.reduce((s, c) => s + c.size, 0);
            const net = batch.reduce((s, c) => s + c.net, 0);
            if (admitsBatch(net)) {
              for (const c of batch) { policy.cleared.add(c.key); retrievalTokens += c.retrieval; }
              policy.pinBytes += batchBytes; saved = net; selected = batch.length; policy.lastBatch = policy.runs;
              policy.activeSavings += saved; policy.activeRetrieval += retrievalTokens;
            }
          }
          const growth = lastEstimate === null ? Math.max(0, measured.tokens - route.drainTokens)
            : growthBeforeCompaction + Math.max(0, measured.tokens - (compacted ? observedDrain : lastEstimate));
          currentBoundary = { api, logical, pressured, cold, gap, source: measured.source, growth, saved, selected, retrievalTokens, upperTokens, candidates: candidates.length, provenCandidates: candidates.filter(c => c.category !== 'ambiguous').length, requests: [] };
          boundaries.push(currentBoundary);
          lastEstimate = measured.tokens; compacted = false; growthBeforeCompaction = 0;
        };
        for (const r of records) {
          const p = r.payload;
          if (r.kind === 'turn_start') { if (p.binding) owner = p.binding; }
          if (r.kind === 'owner_binding') owner = p;
          if (r.kind === 'operation_start') {
            if (p.type === 'compaction') boundary();
            if (p.type === 'prompt') promptTurns.add(r.turnId);
            if (p.type === 'prompt') {
              if (seenBoundaries.has(JSON.stringify([owner?.historyBucket, r.turnId]))) { skip('DUPLICATE_BOUNDARY'); currentBoundary = null; }
              else pending = { record: r, api: p.config.model?.api };
            }
          }
          if (r.kind === 'message') {
            if (p.message.role === 'assistant') {
              boundary();
              lastDispatch = Number.isFinite(p.message.timestamp) ? p.message.timestamp : r.timestamp;
              if (currentBoundary) {
                const u = p.message.usage, observedUsage = ['input', 'cacheRead', 'cacheWrite', 'output'].every(k => Number.isFinite(u?.[k]) && u[k] >= 0);
                const n = estimate(context.map(x => x.message)).tokens, policy = policyFor(owner?.historyBucket);
                currentBoundary.requests.push({ source: observedUsage ? 'provider-usage' : 'character-heuristic',
                  usage: observedUsage ? u : { input: n, cacheRead: 0, cacheWrite: 0, output: tokens(p.message) },
                  activeSavings: policy.activeSavings, activeRetrieval: policy.activeRetrieval });
              }
            }
            if (p.message.role !== 'assistant' || !['error', 'aborted', 'deferred'].includes(p.message.stopReason)) {
              context = [...context, { id: r.id, message: p.message, turnId: r.turnId, operationId: r.operationId }];
            }
            allEntries.set(r.id, { id: r.id, message: p.message, turnId: r.turnId, operationId: r.operationId });
            contexts.set(r.id, context);
          }
          if (r.kind === 'compaction') {
            const c = p.compaction.checkpoint;
            context = [{ message: c.summaryMessage, turnId: r.turnId },
              ...c.preservedMessageIds.map(id => allEntries.get(id)), ...c.derivedMessages.map(message => ({ message, turnId: r.turnId }))];
            contexts.set(r.id, context); observedCompactions++;
            observed.summaryTokens += tokens(c.summaryMessage);
            observed.preCompactionTokens += Number.isFinite(c.tokensBefore) ? c.tokensBefore : 0;
            growthBeforeCompaction += Math.max(0, (c.tokensBefore ?? 0) - (compacted ? observedDrain : lastEstimate ?? 0));
            compacted = true;
            observedDrain = Number.isFinite(c.tokensAfter) ? c.tokensAfter : estimate(context.map(x => x.message)).tokens;
            observed.drainTokens += observedDrain;
            Object.assign(policyFor(owner?.historyBucket), { pinBytes: 0, activeSavings: 0, activeRetrieval: 0, lastBatch: -Infinity });
          }
          if (r.kind === 'rewind') context = contexts.get(p.tipId);
          const key = `${r.operationId}\0${p.callId}`;
          if (r.kind === 'tool_call' && p.admission === 'started') {
            const call = { origin: p.origin };
            calls.set(key, call); uses.push(call);
          }
          if (r.kind === 'tool_result') {
            const call = calls.get(key);
            if (call) {
              if (p.phase === 'returned') call.returned = p.outcome === 'success';
              else call.placed = p.outcome === 'success';
            }
          }
          if (r.kind === 'operation_end') boundary();
          if (r.kind === 'turn_end') {
            turns.set(r.turnId, p.status); completed.push(r.turnId);
            if (p.status === 'completed' && promptTurns.has(r.turnId)) {
              const policy = policyFor(owner?.historyBucket);
              if (!policy.completedRuns.has(r.turnId)) { policy.completedRuns.add(r.turnId); policy.runs++; }
            }
          }
        }
      } catch { skip('JOURNAL_INVALID'); }
    }
    // Only safe aggregates leave this function, never internal boundary identities.
    const report = finish(routes, qualification, retrievalRate);
    report.modeledUpperBoundBoundaryTokens = boundaries.reduce((s, b) => s + b.upperTokens, 0);
    return report;
  } catch { codes.add('INPUT_INVALID'); return finish(); }
}
