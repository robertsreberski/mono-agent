import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const load = name => import(pathToFileURL(join(config.repo, "scripts/lib", `continuity-lookup-${name}.mjs`)).href);
const {runLookupPilot, reconcileLookupPilot} = await load("controller"), {digest} = await import(pathToFileURL(join(config.repo, "scripts/lib/continuity-dataset.mjs")).href);
const {lookupPilotDescriptor, LOOKUP_FAUX_AUTHORIZATION_DOMAIN} = await load("pilot");
const pilot = config.pilot;
if (config.case === "cap") pilot.descriptor = lookupPilotDescriptor({workload: pilot.registration.common, catalog: pilot.registration.common.catalog, capUSD: 3.92, scheduleSeed: pilot.descriptor.schedule.seed, runDeadlineMs: pilot.descriptor.deadlines.runDeadlineMs});
const sha = data => createHash("sha256").update(data).digest("hex");
const statePath = join(config.outputRoot, "lookup-pilot-controller.json"), readState = async () => JSON.parse(await fs.readFile(statePath));
const authorization = {schema: "continuity-lookup-faux-authorization-v1", authorizationId: randomUUID(), pilotSha256: digest(pilot), outputRoot: config.outputRoot, scenarios: ["settled"], timeoutMs: config.case === "late" ? pilot.descriptor.deadlines.childWatchdogMs : 120000};
const arrivals = [], errors = [], partials = [];
let lateAvailable = 0, lateAcceptedSettles = 0, killedAt = null, resolveLate;
const late = new Promise(resolve => {resolveLate = resolve;});
function sse(payload, number, tool) {
  const id = `fictional-${number}`;
  const item = tool ? {type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: config.case === "limit" ? "FictionalUnknownTool" : tool.name, arguments: JSON.stringify({action: "search", query: `FXEARLY ${number}`, limit: 1}), status: "completed"}
    : {type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{type: "output_text", text: config.case === "empty" ? "" : "Fictional answer.", annotations: []}]};
  const events = [{type: "response.output_item.added", output_index: 0, item: {...item, ...(tool ? {arguments: ""} : {content: []})}},
    ...(tool ? [{type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments}] : [{type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: {type: "output_text", text: "", annotations: []}}, {type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text}]),
    {type: "response.output_item.done", output_index: 0, item},
    {type: "response.completed", response: {id, status: "completed", output: [item], service_tier: config.case === "tier" ? "invented" : "default", usage: {input_tokens: 100, output_tokens: 50, output_tokens_details: {reasoning_tokens: 0}}}}];
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
}
async function arrival(request, response) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const wire = Buffer.concat(chunks), bytes = request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(wire) : wire, payload = JSON.parse(bytes);
  const state = await readState(), slot = state.slots[state.cursor], planned = state.schedule[state.cursor], hold = slot.holds.at(-1);
  const claim = JSON.parse(await fs.readFile(join(config.outputRoot, "authorization-consumed.json")));
  const twin = JSON.parse(await fs.readFile(join(dirname(config.outputRoot), ".lookup-faux-consumed-v1", sha(LOOKUP_FAUX_AUTHORIZATION_DOMAIN + authorization.authorizationId), "claim.json")));
  assert.deepEqual(claim, twin); assert.equal(claim.runId, state.runId); assert.equal(claim.controllerEpoch, state.epoch); assert.equal(claim.binding, digest(pilot));
  assert.equal(hold.consumed, true); assert.equal(hold.revoked, false); assert.equal(hold.settlement, null); assert.equal(hold.payloadDigest, sha(bytes));
  assert.equal(payload.prompt_cache_key, slot.cacheKey); assert.equal(request.headers["session-id"], slot.cacheKey); assert.equal(request.headers["x-client-request-id"], slot.cacheKey);
  assert.equal(request.method, "POST"); assert.ok(slot.preparation.exited); assert.ok(slot.preparation.treeDigest); assert.ok(payload.tools.length);
  const number = arrivals.filter(a => a.slotId === slot.slotId).length + 1;
  arrivals.push({at: Date.now(), slotId: slot.slotId, worker: slot.worker, preparation: slot.preparation, bodySha256: sha(bytes), bytes: bytes.length, number, holdConsumed: true, bothMarkers: true, tools: payload.tools.map(t => t.name), priorToolOutputs: payload.input.filter(i => i.type === "function_call_output").length});
  if (number === 1) partials.push(await reconcileLookupPilot(config.outputRoot));
  if (config.case === "kill") {
    // Crash the controller exactly after independent persisted-arrival validation.
    // No terminal usage. The outer proof reconciles, then separately cleans only
    // fresh PID/start/pgid-proven owned groups (never by reconciliation itself).
    globalThis[Symbol.for("lookup.proof.scope")].save({crashAtArrival: true});
    await fs.writeFile(config.result, JSON.stringify({case: config.case, arrivals, partials, pilotSha256: digest(pilot), controllerKilledAt: Date.now()}));
    process.kill(process.pid, "SIGKILL"); return;
  }
  if (config.case === "late") {
    const target = slot.startedAt + pilot.descriptor.deadlines.deadlineMs + 500;
    setTimeout(async () => {
      try {killedAt = Date.now(); lateAvailable++; const current = await readState(); lateAcceptedSettles = current.slots[state.cursor].holds.filter(h => h.settlement).length; response.end(sse(payload, number)); resolveLate();}
      catch (error) {errors.push(error.message); resolveLate();}
    }, Math.max(0, target - Date.now()));
    return;
  }
  if (config.case === "sdk") {response.writeHead(503, {"content-type": "application/json"}).end('{"error":{"message":"fictional provider unavailable"}}'); return;}
  const tool = (config.case === "rounds" && number <= 2 || config.case === "cap" || config.case === "limit") ? payload.tools[0] : null;
  response.writeHead(200, {"content-type": "text/event-stream"}).end(sse(payload, number, tool));
}
const server = createServer((request, response) => {void arrival(request, response).catch(error => {errors.push(error.stack); response.writeHead(500).end("fictional proof assertion failed");});});
server.listen(0, "127.0.0.1"); await once(server, "listening");
authorization.fixtureEndpoint = `http://127.0.0.1:${server.address().port}/codex/responses`;
try {
  const report = await runLookupPilot({pilot, outputRoot: config.outputRoot, authorization});
  if (config.case === "late" && arrivals.length) await late;
  const state = await readState();
  const result = {case: config.case, pilotSha256: digest(pilot), report, state, arrivals, partials, errors, lateAvailable, lateAcceptedSettles, providerLateAvailableAt: killedAt};
  await fs.writeFile(config.result, JSON.stringify(result));
  assert.deepEqual(errors, []);
} finally {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
