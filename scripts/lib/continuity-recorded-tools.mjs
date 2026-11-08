// Inert loopback MCP only. No built-ins, skills, executable adapters or children.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { MAX_ROW_BYTES, fail, object } from "./continuity-observation-input.mjs";
import { validateSource, ambiguousSteps, callKey, bytes, digest, resultEnvelope, gapTier } from "./continuity-recorded-schema.mjs";

export const RECORDED_SERVER_NAME = "continuity-recorded";
export function recordedDefinitions(source, definitions, reservedNames = []) {
  validateSource(source);
  const names = new Set(source.tools.map(t => t.name)), reserved = new Set(reservedNames);
  if ([...names].some(n => reserved.has(n) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(n))) fail("RECORDED_TOOL_COLLISION");
  const result = definitions ?? [...names].map(name => ({ name, description: "Inert recorded result; no action is performed.", inputSchema: { type: "object", additionalProperties: true } }));
  const seen = new Set();
  for (const d of result) {
    if (!object(d) || !names.has(d.name) || seen.has(d.name) || !object(d.inputSchema) || d.inputSchema.type !== "object"
      || Object.keys(d).some(k => !["name", "description", "inputSchema", "outputSchema", "annotations", "title"].includes(k))) fail("RECORDED_TOOL_DEFINITIONS_REFUSED");
    seen.add(d.name);
  }
  if (seen.size !== names.size) fail("RECORDED_TOOL_DEFINITIONS_REFUSED");
  return structuredClone(result);
}
export function createRecordedQueue(source, { excludedSteps = [], excludedCoverage = [] } = {}) {
  source = structuredClone(validateSource(source));
  if (!Array.isArray(excludedSteps) || excludedSteps.some(i => !Number.isInteger(i) || !source.steps[i]) || new Set(excludedSteps).size !== excludedSteps.length) fail("RECORDED_EXCLUSIONS_INVALID");
  const excluded = new Set(excludedSteps), ambiguous = new Set(ambiguousSteps(source));
  // Recompute, rather than trusting an editable coverage flag.
  for (let i = 0; i < source.steps.length; i++) if (!excluded.has(i) && ambiguous.has(source.steps[i])) fail("RECORDED_AMBIGUOUS_PARALLEL_GROUP");
  if (!Array.isArray(excludedCoverage) || excludedCoverage.some(i => !Number.isInteger(i) || !source.coverage[i])) fail("RECORDED_EXCLUSIONS_INVALID");
  const skippedCoverage = new Set(excludedCoverage);
  // Index whether each scope has any included step. Do not materialize every
  // affected-step list for every gap: excluded branches can carry many gaps.
  const scopes = { messageId: new Map(), turnId: new Map(), toolCallId: new Map() };
  const add = (key, value, included) => {
    if (value !== null && value !== undefined) scopes[key].set(value, scopes[key].get(value) === true || included);
  };
  for (const [index, step] of source.steps.entries()) {
    const included = !excluded.has(index);
    add("messageId", step.messageId, included); add("turnId", step.turnId, included);
    for (const call of step.calls) {
      const tool = source.tools[call]; add("toolCallId", tool.id, included);
      for (const p of tool.provenance) { add("messageId", p.messageId, included); add("turnId", p.turnId, included); }
    }
  }
  for (const [index, gap] of source.coverage.entries()) if (gap.tier === "replay" && !skippedCoverage.has(index)) {
    const location = gap.location;
    if (Object.hasOwn(location, "stepIndex")) {
      if (!Number.isInteger(location.stepIndex) || !source.steps[location.stepIndex] || !excluded.has(location.stepIndex)) fail("RECORDED_REPLAY_COVERAGE_GAP");
      continue;
    }
    let found = false;
    for (const key of Object.keys(scopes)) if (Object.hasOwn(location, key) && scopes[key].has(location[key])) {
      found = true;
      if (scopes[key].get(location[key])) fail("RECORDED_REPLAY_COVERAGE_GAP");
    }
    if (!found) fail("RECORDED_REPLAY_COVERAGE_GAP");
  }
  const queues = new Map(), groups = [], served = [], servedSet = new Set(), observations = [];
  for (const [stepIndex, step] of source.steps.entries()) {
    if (excluded.has(stepIndex) || !step.calls.length) continue;
    const group = groups.length; groups.push(step.calls.length);
    for (const index of step.calls) {
      const tool = source.tools[index];
      if (step.gaps.some(code => gapTier(code) === "replay")) fail("RECORDED_REPLAY_COVERAGE_GAP");
      if (!Object.hasOwn(tool, "args") || tool.argsTruncated === true || !Object.hasOwn(tool, "result") || tool.gaps.some(code => gapTier(code) === "replay")) fail("RECORDED_TOOL_COVERAGE_GAP");
      const key = callKey(tool.name, tool.args);
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push({ index, group });
    }
  }
  let current = 0, refused = 0;
  return {
    dispatch(name, args) {
      const queue = queues.get(callKey(name, args)), next = queue?.[0];
      if (!next || next.group !== current) { refused++; fail("RECORDED_UNEXPECTED_CALL"); }
      queue.shift(); served.push(next.index); servedSet.add(next.index);
      if (--groups[current] === 0) current++;
      return structuredClone(resultEnvelope(source.tools[next.index]));
    },
    observe(index, observedContent) {
      const tool = source.tools[index];
      if (!tool || !servedSet.has(index)) fail("RECORDED_OBSERVATION_REFUSED");
      const expected = bytes(resultEnvelope(tool).content), observed = bytes(observedContent);
      const row = { toolIndex: index, expectedBytes: Buffer.byteLength(expected), observedBytes: Buffer.byteLength(observed),
        exact: digest(expected) === digest(observed), representationDifference: digest(expected) !== digest(observed),
        possiblyClipped: Buffer.byteLength(observed) < Buffer.byteLength(expected) };
      observations.push(row); return { ...row };
    },
    report() { return { identity: "name-canonical-arguments-fifo", schemas: "caller-supplied-or-generic-not-original", served: [...served], refused,
      pending: groups.reduce((a, b) => a + b, 0), observations: structuredClone(observations) }; },
  };
}
export async function startRecordedTools({ source, definitions, reservedNames, excludedSteps, excludedCoverage, dispatch } = {}) {
  // Validate all replay data before opening even a loopback listener.
  const tools = recordedDefinitions(source, definitions, reservedNames), queue = createRecordedQueue(source, { excludedSteps, excludedCoverage });
  const [{ Server }, { StreamableHTTPServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"), import("@modelcontextprotocol/sdk/server/streamableHttp.js"), import("@modelcontextprotocol/sdk/types.js"),
  ]);
  // A loopback port alone is not a private capability: other local users can
  // connect. Keep the unguessable endpoint private and reject browser origins.
  const endpoint = `/mcp/${randomBytes(24).toString("hex")}`;
  const http = createServer(async (request, response) => {
    const server = new Server({ name: RECORDED_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void server.close(); });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    // E2's explicit excluded-result path may wrap dispatch; ordinary PR-B
    // callers always use the unchanged queue. Validation still precedes listen.
    server.setRequestHandler(CallToolRequestSchema, async call => dispatch
      ? dispatch(call.params.name, call.params.arguments, queue)
      : queue.dispatch(call.params.name, call.params.arguments));
    try {
      if (request.url !== endpoint) { response.writeHead(404); response.end(); return; }
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${http.address()?.port}`) { response.writeHead(403); response.end(); return; }
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > MAX_ROW_BYTES) fail("RECORDED_REQUEST_TOO_LARGE"); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString("utf8");
      await server.connect(transport);
      await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${http.address().port}${endpoint}`, address: () => http.address(), queue,
    close: () => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }) };
}
