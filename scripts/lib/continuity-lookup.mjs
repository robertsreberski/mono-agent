// Benchmark-only lookup protocol. No provider calls; production owns retention and tools.
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

export const LOOKUP_MODE = "lookup-allowed-v1";
export const HISTORY_SERVER = "mono-agent-conversation-history";
export const LOOKUP_DEFAULT_ARMS = Object.freeze(["native-lookup", "continuity-pack-cold"]);
export const LOOKUP_TIMING = Object.freeze({ deadlineMs: 600000, cleanupAllowanceMs: 60000, turnTimeoutMs: 690000, childWatchdogMs: 720000 });
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const soulFile = new URL("../fixtures/continuity-soul-v1.md", import.meta.url);
const soulBytes = readFileSync(soulFile);
export const SOUL_BINDING = Object.freeze({ file: "continuity-soul-v1.md", rawSha256: sha256(soulBytes), coreSha256: sha256(soulBytes.toString("utf8").replace(/\r\n?/gu, "\n").trim()) });
export const LOOKUP_BUDGET = Object.freeze(JSON.parse(readFileSync(new URL("../fixtures/continuity-lookup-budget-v1.json", import.meta.url), "utf8")));

// Opt-in cross-checkout contract; ordinary A1 plans keep their original shape.
export const LOOKUP_ROLE_PROTOCOL = "continuity-lookup-role-v1";
const soul1Bytes = readFileSync(new URL("../fixtures/continuity-soul-v2.md", import.meta.url));
export const LOOKUP_SOULS = Object.freeze({ S0: SOUL_BINDING, S1: Object.freeze({ file: "continuity-soul-v2.md",
  rawSha256: "e625bc0ddb256f336ec66bf94335d260396fa2c5139e37d44f8e0370fef808a9",
  coreSha256: "e625bc0ddb256f336ec66bf94335d260396fa2c5139e37d44f8e0370fef808a9" }) });
assertSoul(soul1Bytes, LOOKUP_SOULS.S1);
export const LOOKUP_ROLES = Object.freeze([
  { id: "native", arm: "native-lookup", code: "R0", soul: "S0" },
  { id: "pack", arm: "continuity-pack-cold", code: "R0", soul: "S0" },
  { id: "pack-only", arm: "continuity-pack-cold", code: "Rpack", soul: "S0" },
  { id: "soul-only", arm: "continuity-pack-cold", code: "R0", soul: "S1" },
  { id: "shipping", arm: "continuity-pack-cold", code: "Rpack", soul: "S1" },
  { id: "native-soul", arm: "native-lookup", code: "R0", soul: "S1" },
].map(Object.freeze));
export function assertLookupRole(role) {
  const def = LOOKUP_ROLES.find(row => row.id === role?.id);
  const soul = def && LOOKUP_SOULS[def.soul];
  if (!def || role.protocol !== LOOKUP_ROLE_PROTOCOL || role.arm !== def.arm || role.code !== def.code
    || !/^[a-f0-9]{40}$/u.test(role.revision ?? "")
    || ![role.buildHash, role.commonSha256, role.registrationSha256].every(hash => /^[a-f0-9]{64}$/u.test(hash ?? ""))
    || !role.scope || !["original", "hard", "hard-distractors", "holdout"].includes(role.scope.suite)
    || !Array.isArray(role.scope.traces) || !role.scope.traces.length || new Set(role.scope.traces).size !== role.scope.traces.length
    || role.soul?.file !== soul.file || role.soul?.rawSha256 !== soul.rawSha256 || role.soul?.coreSha256 !== soul.coreSha256) {
    throw Object.assign(new Error("lookup_role_binding_mismatch"), { code: "lookup_role_binding_mismatch" });
  }
}

export const FIXED_BUDGET_SHA256 = sha256(readFileSync(new URL("../fixtures/continuity-lookup-budget-v1.json", import.meta.url)));
export function assertFixedBudget(hash) {
  if (hash !== FIXED_BUDGET_SHA256) throw Object.assign(new Error("lookup_fixed_budget_hash_mismatch"), { code: "lookup_fixed_budget_hash_mismatch" });
}
export function assertLookupContract({ suite, sha256: corpusSha256, source, lookupSource, lookupPolicy }) {
  if (suite === "holdout" && lookupSource) {
    if (source?.kind !== "lookup-frozen-holdout" || source.manifestSha256 !== corpusSha256 || lookupSource.manifestSha256 !== corpusSha256)
      throw Object.assign(new Error("lookup_invalid_source"), { code: "lookup_invalid_source" });
    if (lookupPolicy) assertExternalPolicy(lookupPolicy, { source });
    return;
  }
  if (LOOKUP_BUDGET.status !== "frozen" || LOOKUP_BUDGET.corpus[suite] !== corpusSha256) throw Object.assign(new Error("lookup_requires_frozen_corpus_and_budget"), { code: "lookup_requires_frozen_corpus_and_budget" });
  if (!Number.isSafeInteger(LOOKUP_BUDGET.callBudget) || LOOKUP_BUDGET.callBudget < 1 || LOOKUP_BUDGET.callBudget > 96 || LOOKUP_BUDGET.callBudget + 2 > 100
    || !Number.isSafeInteger(LOOKUP_BUDGET.byteBudget) || LOOKUP_BUDGET.byteBudget < 1 || LOOKUP_BUDGET.byteBudget > 8 * 1024 * 1024) throw Object.assign(new Error("lookup_invalid_frozen_budget"), { code: "lookup_invalid_frozen_budget" });
  assertSoul(soulBytes, LOOKUP_BUDGET.soul);
}

export function assertSoul(bytes, binding) {
  if (!binding || typeof binding.rawSha256 !== "string" || typeof binding.coreSha256 !== "string") {
    throw Object.assign(new Error("lookup_soul_binding_missing"), { code: "lookup_soul_binding_missing" });
  }
  if (sha256(bytes) !== binding.rawSha256 || sha256(bytes.toString("utf8").replace(/\r\n?/gu, "\n").trim()) !== binding.coreSha256) throw Object.assign(new Error("lookup_soul_digest_mismatch"), { code: "lookup_soul_digest_mismatch" });
}
export async function installSoul(work, binding) {
  const { readFile, writeFile } = await import("node:fs/promises");
  // Never let a caller select an arbitrary path; only the two frozen fixtures.
  if (!binding || typeof binding.rawSha256 !== "string" || typeof binding.coreSha256 !== "string") assertSoul(Buffer.alloc(0), binding);
  const selected = Object.values(LOOKUP_SOULS).find(soul => soul.file === binding.file && soul.rawSha256 === binding.rawSha256 && soul.coreSha256 === binding.coreSha256);
  if (!selected) throw Object.assign(new Error("lookup_soul_digest_mismatch"), { code: "lookup_soul_digest_mismatch" });
  const bytes = await readFile(new URL(`../fixtures/${selected.file}`, import.meta.url)); assertSoul(bytes, binding);
  await writeFile(join(work, "BENCHMARK-SOUL.md"), bytes, { mode: 0o600 });
}
export function lookupPrompt(probe) {
  return ["Quick check about this conversation so far, including tool results. You may use ConversationHistory to retrieve retained evidence before answering:",
    probe.question, probe.format, probe.abstainOption ? "If the value is not available, reply exactly UNKNOWN." : null].filter(Boolean).join(" ");
}

// Parse only model-visible blocks, never structuredContent. Multi-block prefixes are transport framing.
export function historyBody(result) {
  const text = (result?.content ?? []).slice(1).map(part => String(part.text ?? "").replace(/^\[continued section \d+ of \d+\]\n/u, "")).join("");
  const offset = text.indexOf("\n{");
  if (offset < 0) return null;
  try { return JSON.parse(text.slice(offset + 1)); } catch { return null; }
}
export function witnessedRecovery(lookup, correct) {
  return correct === true && lookup.initiallyPresent === false && lookup.source?.availability === "retained" && lookup.sourceReturned === true;
}
export const contentBytes = result => Buffer.byteLength(JSON.stringify(result.content), "utf8");
const compact = text => String(text).normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/gu, "");

/** Evaluator-only annotations: unique literal tool identifiers; other provenance remains unknown.
 * The sizing query is the source line, not an unfiltered scan. Never give these annotations to a reader.
 */
export function sourceAnnotation(trace, probe) {
  if (probe.category === "redaction") return { availability: "protected" };
  if (probe.score?.kind !== "identifier") return { availability: "unknown" };
  const value = probe.score.accept[0];
  const calls = trace.turns.filter(turn => !probe.sourceTurn || turn.id === probe.sourceTurn)
    .flatMap(turn => turn.steps.filter(step => step.call).map(step => step.call));
  const found = calls.filter(call => compact(call.result).includes(compact(value)));
  if (found.length !== 1) return { availability: "unknown" };
  const line = found[0].result.split("\n").find(text => compact(text).includes(compact(value)));
  if (!line) return { availability: "unknown" };
  // Source-derived oracle navigation is only the registered offline sizing path, not a quality reader.
  return { availability: "annotated", value, query: line.trim().slice(0, 120), sourceSha256: sha256(found[0].result) };
}

/** Resolve annotations against this arm's sanitized store, never another arm's raw transcript. */
export function resolveSource(modules, work, conversationId, annotation) {
  if (annotation.availability !== "annotated") return { availability: annotation.availability };
  const reader = new modules.conversation.ToolHistoryReader(join(work, "history"));
  const scope = { logicalConversationId: conversationId, currentConversationId: conversationId, currentRunId: "lookup-evaluator" };
  let before; const matches = [];
  do {
    const page = reader.searchContinuity({ ...scope, limit: 10, ...(before === undefined ? {} : { before }) });
    if (!page.available) return { availability: "unavailable" };
    for (const record of page.items.filter(row => row.kind === "tool")) {
      let text = "", offset = 0, next;
      do {
        const result = reader.getContinuity({ ...scope, recordId: record.recordId, chunkOffset: offset, chunkBytes: 8192 });
        text += result.chunk ?? ""; next = result.nextOffset; offset = next;
      } while (next !== undefined);
      if (compact(text).includes(compact(annotation.value))) matches.push(record);
    }
    before = page.next;
  } while (before !== undefined);
  if (matches.length !== 1) return { availability: matches.length ? "unknown" : "unavailable" };
  const record = matches[0];
  if (record.provenance !== "tool") return { availability: "unknown", recordId: record.recordId, sha256: record.sha256 };
  if (record.redacted || record.truncated) return { availability: "protected", recordId: record.recordId, sha256: record.sha256 };
  return { availability: "retained", recordId: record.recordId, sha256: record.sha256, retainedBytes: record.retainedBytes };
}

/** A content-free witness accumulator. Incremental hashing never retains retrieved text. */
export function lookupWitness(source = { availability: "unknown" }, annotation = {}) {
  let initial = null, initialContextBytes = null;
  const traversals = new Map(), returned = new Map();
  return {
    initial(context) {
      if (initial !== null) return;
      initialContextBytes = Buffer.byteLength(JSON.stringify(context), "utf8");
      initial = annotation.value ? compact(JSON.stringify(context)).includes(compact(annotation.value)) : "unknown";
    },
    delivered(result) {
      const body = historyBody(result);
      if (body?.action !== "get" || body.status !== "available" || !body.record || typeof body.chunk !== "string") return;
      const { recordId, sha256: digest } = body.record;
      if (body.chunkOffset === 0) traversals.set(recordId, { hash: createHash("sha256"), offset: 0, chunks: 0, digest });
      const row = traversals.get(recordId);
      if (!row || row.offset !== body.chunkOffset || row.digest !== digest) return;
      row.hash.update(body.chunk); row.offset += Buffer.byteLength(body.chunk); row.chunks += 1;
      if (!body.nextCursor) {
        const verified = row.hash.digest("hex") === digest && row.offset === body.record.retainedBytes;
        returned.set(recordId, { recordId, sha256: digest, bytes: row.offset, chunks: row.chunks, verified });
        traversals.delete(recordId);
      }
    },
    snapshot() {
      const records = [...returned.values()];
      return { source: { ...source }, initialContextBytes, initiallyPresent: initial ?? "unknown", records,
        sourceReturned: source.availability === "retained" && records.some(row => row.recordId === source.recordId && row.sha256 === source.sha256 && row.verified) };
    },
  };
}

/** Frozen reference-path feasibility, conservative 1 token/UTF-8 byte plus per-round overhead.
 * Repeated input (including native history) counts on EVERY round, not just the first.
 */
export function referenceFeasibility(path, { callBudget, byteBudget, contextWindowTokens, contextMarginTokens }, { initialTokens, admissionCap }) {
  const reasons = [];
  const rounds = path.calls + 1;
  if (path.calls > callBudget) reasons.push("calls");
  if (path.bytes > byteBudget) reasons.push("bytes");
  if (initialTokens + path.bytes + rounds * 300 + contextMarginTokens > contextWindowTokens) reasons.push("reader_context");
  const observedInput = rounds * initialTokens + path.cumulativeBytes + rounds * rounds * 300;
  if (observedInput > admissionCap) reasons.push("observed_input_admission");
  if (path.discovered === false) reasons.push("reference_source_not_discovered");
  return { classification: reasons.length ? "budget-infeasible" : "feasible", reasons, estimatedRepeatedInputTokens: observedInput };
}

/** Atomic pre-dispatch call admission / pre-delivery byte admission. No response is clipped. */
export function lookupMeter({ callBudget, byteBudget, deadlineMs = LOOKUP_TIMING.deadlineMs, now = performance.now.bind(performance), onExhaustion = () => {} }) {
  const started = now();
  const state = { calls: 0, bytes: 0, responses: 0, largestResponse: 0, responseBytes: [], responseSha256: [], searchPages: 0, getChunks: 0, cumulativeBytes: 0, exhausted: null };
  const fail = cause => {
    state.exhausted ??= cause; onExhaustion(state.exhausted);
    throw Object.assign(new Error(`lookup_budget_${state.exhausted}`), { code: `lookup_budget_${state.exhausted}` });
  };
  const deadline = () => { if (now() - started >= deadlineMs) fail("latency"); if (state.exhausted) fail(state.exhausted); };
  return {
    state,
    dispatch() { deadline(); if (state.calls >= callBudget) fail("calls"); state.calls += 1; },
    deliver(result) {
      deadline(); const bytes = contentBytes(result);
      state.largestResponse = Math.max(state.largestResponse, bytes);
      if (state.bytes + bytes > byteBudget) fail("bytes");
      state.bytes += bytes; state.responses += 1; state.responseBytes.push(bytes); state.responseSha256.push(sha256(JSON.stringify(result.content))); state.cumulativeBytes += state.bytes;
      const body = historyBody(result); if (body?.action === "search") state.searchPages += 1; if (body?.action === "get") state.getChunks += 1;
      return result;
    },
    expire() { if (!state.exhausted) { state.exhausted = "latency"; onExhaustion("latency"); } },
  };
}

/** Probe-only allowlist: an alias or unexpected MCP endpoint could bypass the meter.
 * Replay's fictional tools are separate and never pass through this probe guard.
 */
export function assertLookupServers(options) {
  if (Object.keys(options.mcpServers ?? {}).some(key => key !== HISTORY_SERVER)) {
    throw Object.assign(new Error("lookup_unmetered_mcp_server"), { code: "lookup_unmetered_mcp_server" });
  }
}

/** A URL-only forwarding seam: preserve server identity, listing/schema and production handlers. */
export async function lookupForwarder({ meter, witness }) {
  const [{ Server }, { StreamableHTTPServerTransport }, { Client }, { StreamableHTTPClientTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/index.js"), import("@modelcontextprotocol/sdk/client/streamableHttp.js"), import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const routes = new Map(), clients = new Set(), servers = new Set();
  let host;
  const http = createServer(async (request, response) => {
    let server, transport;
    try {
      if (request.headers.host !== host) { response.writeHead(403).end(); return; }
      const route = routes.get(request.url);
      if (!route) { response.writeHead(404).end(); return; }
      const client = await route.client;
      server = new Server({ name: HISTORY_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } }); servers.add(server);
      server.setRequestHandler(ListToolsRequestSchema, () => client.listTools());
      server.setRequestHandler(CallToolRequestSchema, async call => {
        meter.dispatch();
        const result = await client.callTool(call.params);
        meter.deliver(result); witness?.delivered(result);
        return result;
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, allowedHosts: [host], enableDnsRebindingProtection: true });
      response.on("close", () => { void transport.close(); void server.close(); servers.delete(server); });
      let body = ""; for await (const chunk of request) body += chunk;
      await server.connect(transport);
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
    } catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  host = `127.0.0.1:${http.address().port}`;
  return {
    async rewrite(options) {
      const upstream = options.mcpServers?.[HISTORY_SERVER];
      if (!upstream) return options;
      const url = new URL(upstream.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("lookup_requires_real_loopback_history");
      let route = [...routes.values()].find(row => row.upstream === upstream.url);
      if (!route) {
        const path = `/mcp/${randomUUID()}`;
        const client = new Client({ name: "continuity-lookup-forwarder", version: "1.0.0" }); clients.add(client);
        try {
          await client.connect(new StreamableHTTPClientTransport(url, upstream.headers ? { requestInit: { headers: upstream.headers } } : {}));
        } catch (error) {
          clients.delete(client);
          await client.close().catch(() => {});
          throw error;
        }
        // Publish only connected routes; a failed handshake must not poison later retries.
        route = { upstream: upstream.url, url: `http://127.0.0.1:${http.address().port}${path}`, client }; routes.set(path, route);
      }
      return { ...options, mcpServers: { ...options.mcpServers, [HISTORY_SERVER]: { ...upstream, url: route.url } } };
    },
    async close() {
      await Promise.all([...clients].map(client => client.close()));
      await Promise.all([...servers].map(server => server.close()));
      await new Promise(resolve => { http.closeAllConnections(); http.close(resolve); });
    },
  };
}

/** Offline reference reader: packed-id get, otherwise ONE query-first search, then full get. */
export function referenceReader({ source, query, witness, onFinish = () => {} }) {
  let next, started = false, discovered = false;
  return {
    next(context, body) {
      witness?.initial(context);
      if (!started) {
        started = true;
        const pack = (context.messages ?? []).map(message => JSON.stringify(message.content)).filter(text => text.includes("### Conversation continuity pack")).join("\n");
        next = pack.includes(source.recordId) ? { action: "get", recordId: source.recordId, chunkBytes: 8192 } : { action: "search", query, limit: 10 };
      } else if (body?.action === "search") {
        discovered = body.items?.some(item => item.recordId === source.recordId) === true;
        next = discovered ? { action: "get", recordId: source.recordId, chunkBytes: 8192 } : null;
      } else if (body?.action === "get") {
        discovered = body.record?.recordId === source.recordId;
        next = body.nextCursor ? { action: "get", cursor: body.nextCursor } : null;
      } else next = null;
      if (!next) onFinish({ discovered });
      return next;
    },
  };
}

/** Multi-round mechanics reader, without evaluator annotations or expected answers.
 * One packed-id traversal, then query, pagination and a second full cursor traversal.
 */
export function scriptedLookupReader({ minRounds = 8, callBudget = LOOKUP_BUDGET.callBudget } = {}) {
  let round = 0, phase = "pack", page = null, recordId = null;
  return {
    next(context, body) {
      // Stop voluntarily with room for the final answer; do not manufacture meter exhaustion.
      if (round >= callBudget) return null;
      round += 1;
      if (phase === "pack") {
        phase = "pack-get";
        const text = (context.messages ?? []).map(message => JSON.stringify(message.content)).filter(text => text.includes("### Conversation continuity pack")).join("\n");
        const id = /chr1_[A-Za-z0-9_-]{43}/u.exec(text)?.[0];
        if (id) return { action: "get", recordId: id, chunkBytes: 8192 };
      }
      if (phase === "pack-get") {
        if (body?.action === "get" && body.nextCursor) return { action: "get", cursor: body.nextCursor };
        phase = "search";
        return { action: "search", query: "order", limit: 1 };
      }
      if (phase === "search") {
        recordId = body?.items?.[0]?.recordId; page = body?.navigation?.nextActions?.find(action => action.kind === "next_search_page")?.arguments;
        phase = "page";
        if (page) return page;
      }
      if (phase === "page") {
        phase = "get";
        recordId = body?.items?.[0]?.recordId ?? recordId;
        if (recordId) return { action: "get", recordId, chunkBytes: 8192 };
      }
      if (phase === "get" && body?.action === "get" && body.nextCursor) return { action: "get", cursor: body.nextCursor };
      if (round <= minRounds) return { action: "search", query: "order", limit: 1 };
      return null;
    },
  };
}

/** Population selection is fixed before retrieval; IDs here are family IDs. */
export function selectLookupFamilies(groups, seed, perGroup = 2) {
  const fail = () => { throw Object.assign(new Error("lookup_invalid_selection"), { code: "lookup_invalid_selection" }); };
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(perGroup) || perGroup < 1
    || !groups || Object.keys(groups).sort().join(",") !== "distractor,ordinary") fail();
  const all = Object.values(groups).flat();
  if (new Set(all).size !== all.length || all.some(id => typeof id !== "string" || !id.length)) fail();
  const selectedIds = Object.keys(groups).sort().flatMap(group => {
    const ids = groups[group];
    if (!Array.isArray(ids) || ids.length < perGroup) fail();
    return [...ids].sort().map(id => ({ id, rank: sha256(`${seed}:${id}`) }))
      .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1).slice(0, perGroup).map(r => r.id);
  }).sort();
  return { algorithm: "seeded-sha256-rank-v1", seed, perGroup, selectedIds };
}
export function selectLookupTraces(traces, seed, perGroup = 2) {
  const groups = { ordinary: [], distractor: [] };
  for (const trace of traces) {
    const { group, scenario } = trace.generated ?? {};
    if (!groups[group] || typeof scenario !== "string") throw Object.assign(new Error("lookup_invalid_selection"), { code: "lookup_invalid_selection" });
    groups[group].push(scenario);
  }
  // One independently authored conversation per family; repeated families fail closed.
  const lookupSelection = selectLookupFamilies(groups, seed, perGroup);
  return { lookupSelection, traces: traces.filter(t => lookupSelection.selectedIds.includes(t.generated.scenario)) };
}
/** Recompute geometry and measured failure evidence, never trust a classification. */
export function externalPathFeasibility(path, budget) {
  if (path.exhausted && !["calls", "bytes"].includes(path.exhausted))
    return { classification: "unknown", reasons: [`reference_${path.exhausted}`] };
  if (path.method === "conservative-full-budget")
    return referenceFeasibility({ ...path, calls: 9, bytes: budget.byteBudget, cumulativeBytes: 9 * budget.byteBudget, discovered: true }, { ...budget, callBudget: 9 }, path);
  const computed = referenceFeasibility(path, budget, path);
  if (path.exhausted) return { ...computed, classification: "budget-infeasible", reasons: [...computed.reasons, `reference_${path.exhausted}`] };
  if (path.referenceFailure || path.sourceAvailability !== "retained" || !path.sourceReturned) {
    const initial = referenceFeasibility({ calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true }, budget, path);
    return initial.classification === "budget-infeasible" ? initial : { classification: "unknown", reasons: ["reference_not_verified"] };
  }
  return computed;
}
/** Fixed-budget artifact, not a derived budget or a legacy holdout gate. */
export function assertExternalPolicy(policy, { source, selection, lookupSelection, codes, protocol } = {}) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (policy?.schema !== "continuity-lookup-feasibility-v1" || policy.mode !== "fixed-budget-feasibility-only" || policy.maxTurns !== 10) fail("lookup_invalid_policy");
  assertFixedBudget(policy.fixedBudgetSha256);
  const b = policy.budget;
  for (const key of Object.keys(LOOKUP_BUDGET).filter(key => key !== "paths")) {
    if (!isDeepStrictEqual(b?.[key], LOOKUP_BUDGET[key])) fail("lookup_fixed_budget_changed");
  }
  if (!source || !isDeepStrictEqual(policy.source, source)) fail("lookup_policy_source_mismatch");
  if (selection && !isDeepStrictEqual(policy.selection, selection)) fail("lookup_policy_selection_mismatch");
  if (lookupSelection && !isDeepStrictEqual(policy.lookupSelection, lookupSelection)) fail("lookup_policy_selection_mismatch");
  if (codes && !isDeepStrictEqual(policy.codes, codes)) fail("lookup_policy_code_mismatch");
  if (protocol && !isDeepStrictEqual(policy.protocol, protocol)) fail("lookup_policy_protocol_mismatch");
  if (!Array.isArray(b.paths) || !b.paths.length || new Set(b.paths.map(p => `${p.role}/${p.traceId}/${p.probeId}`)).size !== b.paths.length) fail("lookup_invalid_inventory");
  for (const p of b.paths) {
    const role = LOOKUP_ROLES.find(r => r.id === p.role);
    if (!role || role.arm !== p.arm || !Number.isSafeInteger(p.initialTokens) || p.initialTokens < 1 || !Number.isSafeInteger(p.initialContextBytes) || p.initialContextBytes < 1
      || !["feasible", "budget-infeasible", "unknown"].includes(p.feasibility?.classification)
      || !["identifier-reference", "conservative-full-budget"].includes(p.method)
      || ![p.calls, p.bytes, p.cumulativeBytes].every(n => Number.isSafeInteger(n) && n >= 0)
      || !Number.isSafeInteger(p.admissionCap) || p.admissionCap < 1 || typeof p.discovered !== "boolean"
      || typeof p.referenceFailure !== "boolean" || p.method === "identifier-reference" && typeof p.sourceReturned !== "boolean"
      || !(p.exhausted === null || typeof p.exhausted === "string" && /^[a-z_]+$/u.test(p.exhausted))) fail("lookup_invalid_inventory");
    if (p.method === "conservative-full-budget" && (p.calls !== b.callBudget || p.bytes !== b.byteBudget
      || p.cumulativeBytes !== 9 * b.byteBudget || !p.discovered)) fail("lookup_policy_feasibility_mismatch");
    if (p.feasibility.classification === "budget-infeasible" && !p.feasibility.reasons?.length) fail("lookup_policy_feasibility_mismatch");
    if (!isDeepStrictEqual(p.feasibility, externalPathFeasibility(p, b))) fail("lookup_policy_feasibility_mismatch");
    if (!isDeepStrictEqual(p.initialAdmission, referenceFeasibility({ calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true }, b, p))) fail("lookup_policy_feasibility_mismatch");
  }
  if (selection) {
    const expected = LOOKUP_ROLES.flatMap(r => selection.flatMap(t => t.probes.map(id => `${r.id}/${t.id}/${id}`))).sort();
    if (JSON.stringify(expected) !== JSON.stringify(b.paths.map(p => `${p.role}/${p.traceId}/${p.probeId}`).sort())) fail("lookup_inventory_scope_mismatch");
  }
  return policy;
}

// Reserved independently: inventory skips must never masquerade as later admission refusals.
export const LOOKUP_SLOT_CODES = Object.freeze({
  inventoryInfeasible: "inventory_infeasible", unknownFeasibility: "lookup_unknown_feasibility",
  inputEnvelope: "not_admitted_input_envelope", cap: "not_admitted_cap",
});
/** Recompute role-specific inventory geometry; never trust its cached label.
 * An eligible inventory path is NOT a proved backend input envelope.
 */
export function lookupSlotDisposition(plan, { traceId, probeId, arm }) {
  const budget = plan.lookup?.budget;
  const role = plan.lookup?.role?.id;
  const paths = (budget?.paths ?? []).filter(path => path.traceId === traceId && path.probeId === probeId && path.arm === arm
    && (!role || path.role === role || path.role === undefined && !plan.lookup.source));
  const path = paths.length === 1 ? paths[0] : null;
  const natural = value => Number.isSafeInteger(value) && value >= 0;
  const geometry = path && (path.method === undefined || ["identifier-reference", "conservative-full-budget"].includes(path.method))
    && [path.calls, path.bytes, path.cumulativeBytes].every(natural)
    && Number.isSafeInteger(path.initialTokens) && path.initialTokens > 0
    && Number.isSafeInteger(path.admissionCap) && path.admissionCap > 0 && typeof path.discovered === "boolean"
    && [budget.callBudget, budget.byteBudget, budget.contextWindowTokens, budget.contextMarginTokens].every(natural);
  const feasibility = !geometry ? { classification: "unknown", reasons: ["inventory_not_verified"] }
    : path.method ? externalPathFeasibility(path, budget) : referenceFeasibility(path, budget, path);
  if (feasibility.classification === "budget-infeasible")
    return { status: "infeasible", code: LOOKUP_SLOT_CODES.inventoryInfeasible, feasibility };
  if (feasibility.classification !== "feasible")
    return { status: "blocked", code: LOOKUP_SLOT_CODES.unknownFeasibility, feasibility };
  return { status: "eligible", code: null, feasibility };
}
