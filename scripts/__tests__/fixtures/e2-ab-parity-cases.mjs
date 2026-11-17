// Fictional, deterministic E2 outputs with the A/B mode omitted. The pinned
// fixture was produced by running this exact capture against an extraction of the
// base revision's `scripts/` (see continuity-e2-ab-parity-base.json `revision`):
// `git archive <revision> scripts | tar -x -C BASE`, with BASE/node_modules and
// BASE/packages linked to a built checkout, then `e2ParityCases(rel => import(
// new URL(rel, "file://BASE/scripts/lib/")))`. The test reruns it against the
// current tree and compares the serialized bytes (SHA-256 per case).
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const sha = value => createHash("sha256").update(JSON.stringify(value, (_, v) => typeof v === "bigint" ? `${v}n` : v)).digest("hex");
const capture = fn => { try { return { value: fn() }; } catch (error) { return { refused: error?.code ?? error?.message }; } };
export async function e2ParityCases(load, { raw = false } = {}) {
  const [registration, authorization, execution, sizing, protocol, lineage, pricing, cli] = await Promise.all(["continuity-e2-registration.mjs", "continuity-e2-authorization.mjs",
    "continuity-e2-execution-policy.mjs", "continuity-e2-sizing.mjs", "continuity-e2-protocol.mjs", "continuity-e2-lineage.mjs", "continuity-e2-pricing.mjs", "../continuity-e2.mjs"].map(load));
  const cap = JSON.parse(await readFile(new URL("./continuity-e2-cap-sizing.json", import.meta.url)));
  const catalog = await pricing.loadE2Catalog(), SOL = protocol.SOL, cases = {};
  for (const arm of [undefined, "continuity", "baseline"]) for (const surface of [undefined, "split", "unified"])
    cases[`toolPolicies:${arm}:${surface}`] = capture(() => registration.e2ToolPolicies(arm, surface));
  const descriptor = { schema: "continuity-e2-guarded-plan-v3", capUnits: "1000", deadlines: { requestDeadlineMs: 1000, phaseDeadlineMs: 2000, childWatchdogMs: 2000, runDeadlineMs: 3000 } };
  const bound = name => ({ path: `/fictional/${name}.json`, sha256: name.length.toString(16).padStart(64, "a") });
  const base = { code: { path: "/fictional/root", revision: "b".repeat(40), sha256: "c".repeat(64) }, build: { policy: "fictional" }, catalog,
    source: bound("source"), protocol: bound("protocol"), probes: bound("probes"), keys: bound("keys"), soul: { rawDigest: "d".repeat(64), normalizedDigest: "e".repeat(64) },
    roles: cap.roles, schedule: [], toolPolicies: registration.e2ToolPolicies(), sizing: [bound("sizing")], probeCounts: [] };
  for (const [name, extra] of [["continuity", {}], ["baseline", { replayArm: "baseline" }], ["unified", { historySurface: "unified" }], ["unified-baseline", { historySurface: "unified", replayArm: "baseline" }]]) {
    const pilot = { schema: "continuity-e2-guarded-registration-v1", registration: { ...extra, ...base }, descriptor };
    cases[`bindings:${name}`] = capture(() => authorization.e2AuthorizationBindings(pilot, "f".repeat(64), { outputRoot: "/fictional/output", credentialPath: "/fictional/credential.json", salt: "1".repeat(64), accountCommitment: "2".repeat(64) }));
  }
  const probeCounts = cap.protocol.branches.flatMap(b => b.checkpoints).map((_, checkpoint) => ({ checkpoint, questions: checkpoint === 0 ? 2 : 0, lookupRounds: cap.protocol.probeLookupRounds }));
  for (const arm of ["switch", "cancel", "pressure"]) {
    const record = { ...cap.sizing, arm };
    cases[`schedule:${arm}`] = capture(() => registration.e2PhaseSchedule(cap.protocol, [record], [], undefined));
    cases[`estimate:${arm}`] = capture(() => sizing.estimateE2SizingSet({ protocol: cap.protocol, roles: cap.roles, records: [record], catalog, probeCounts: [] }));
    cases[`estimate:${arm}:unified`] = capture(() => sizing.estimateE2SizingSet({ protocol: cap.protocol, roles: cap.roles, records: [{ ...record, historySurface: "unified" }], catalog, probeCounts: [], historySurface: "unified" }));
  }
  const sol = catalog.find(c => c.model === SOL), role = cap.roles.find(r => r.role === "probe"), price = n => pricing.e2RequestPrice(sol, { inputTokens: n, maxOutputTokens: role.maxOutputTokens }).reservationUnits;
  const p = (paidRole, inputTokens = 100) => ({ requestId: "fictional:1", slotId: "9".repeat(64), round: 1, payloadDigest: "8".repeat(64), reservationUnits: price(inputTokens), inputTokens, model: SOL, paidRole, checkpoint: 0 });
  const replay = { kind: "replay", arm: "replay", budgets: [{ checkpoint: 0, paidRole: "probe", model: SOL, maxRequests: 2 }, { checkpoint: 0, paidRole: "continuation", model: SOL, maxRequests: 2 }] };
  for (const [name, extra] of [["continuity", {}], ["unified", { historySurface: "unified" }], ["baseline", { replayArm: "baseline" }]]) {
    const pilot = { registration: { ...base, ...extra, toolPolicies: registration.e2ToolPolicies(extra.replayArm, extra.historySurface), probeCounts } };
    const planned = extra.replayArm ? { ...replay, arm: "baseline" } : replay;
    cases[`admission:probe:${name}`] = capture(() => execution.e2ExecutionPolicy.admission(pilot, planned, { holds: [] }, p("probe")));
    cases[`admission:continuation:${name}`] = capture(() => execution.e2ExecutionPolicy.admission(pilot, planned, { holds: [{ checkpoint: 0, probeRequest: 1, paidRole: "probe", model: SOL }] }, p("continuation")));
    cases[`admission:proof:${name}`] = capture(() => execution.e2ExecutionPolicy.admission(pilot, { kind: "proof", arm: "switch", budgets: [{ checkpoint: 0, paidRole: "probe", model: SOL, maxRequests: 1 }] }, { holds: [] }, p("probe")));
    const policy = { policy: { SLOT_TERMINALS: ["completed", "wrong"], REAL_CONTROLLER: "fictional-controller", PILOT_STOPS: ["completed"], USD_UNITS: 1000n }, schemas: { slotReceipt: "fictional-slot", report: "fictional-report" } };
    const account = () => ({ completeUnits: "0", retainedUnits: "0", activeUnits: "0", totalUnits: "0", knownPartialUnits: "0" });
    const state = { schema: "fictional-controller", historySurface: extra.historySurface, cursor: 1, stop: "completed", capUnits: "1000", schedule: [{ ...planned, slotId: "7".repeat(64) }],
      slots: [{ slotId: "7".repeat(64), terminal: "completed", score: 1, holds: [] }] };
    cases[`receipt:${name}`] = capture(() => { const r = execution.e2ExecutionPolicy.slotReceipt(state, 0, account, policy); return { slot: r, run: execution.e2ExecutionPolicy.aggregateRun(state, [r], account, policy) }; });
  }
  const pack = { model: "gpt-6.1-sol", stream: true, store: false, tools: [{ type: "function", name: "ConversationHistory" }],
    input: [{ role: "user", content: [{ type: "input_text", text: "### Conversation continuity pack (historical evidence)\nFictional" }] }, { role: "user", content: [{ type: "input_text", text: "Fictional prompt" }] }] };
  cases["body:continuity-pack"] = capture(() => execution.e2ExecutionPolicy.assertBody(Buffer.from(JSON.stringify(pack)), { model: SOL, tools: ["ConversationHistory"], probeRequest: 1 }) ?? "accepted");
  for (const slot of [{ kind: "replay", arm: "replay" }, { kind: "replay", arm: "baseline" }, { kind: "proof", arm: "cancel", variant: "ceiling" }])
    cases[`phaseBase:${slot.arm}`] = capture(() => [lineage.e2PhaseBase("/fictional/root", slot), lineage.e2PhaseWork("/fictional/root", slot, 0)]);
  for (const arm of [undefined, "continuity", "baseline"]) cases[`replayArm:${arm}`] = capture(() => [protocol.e2ReplayArm(arm), protocol.e2ProbeRequestCount({ probeLookupRounds: 3 }, arm)]);
  for (const [r, v] of [[{}, {}], [{ replayArm: "baseline" }, { replayArm: "baseline", qualification: false }], [{ replayArm: "baseline" }, { replayArm: "baseline" }], [{}, { replayArm: "baseline" }], [{ historySurface: "unified" }, {}]])
    cases[`replayBinding:${JSON.stringify([r, v])}`] = capture(() => protocol.assertE2ReplayBinding(r, v) ?? "accepted");
  const argv = [["size", "--source", "s", "--protocol", "p", "--output", "o"], ["size", "--source", "s", "--protocol", "p", "--output", "o", "--replay-arm", "baseline", "--summary", "faux-max"],
    ["size", "--source", "s", "--protocol", "p", "--output", "o", "--history-surface", "unified"], ["--estimate", "--protocol", "p", "--limits", "l", "--sizing", "a", "--sizing", "b", "--output", "o"],
    ["run", "--summary", "real", "--registration", "r", "--sha256", "h", "--authorization", "a", "--credentials", "c", "--output", "o"],
    ["run", "--summary", "real", "--replay-arm", "baseline", "--registration", "r", "--sha256", "h", "--authorization", "a", "--credentials", "c", "--output", "o"],
    ["proofs", "--output", "o", "--arm", "cancel"], ["proofs", "--real", "--registration", "r", "--sha256", "h", "--authorization", "a", "--credentials", "c", "--output", "o"],
    ["score", "--answers", "a", "--keys", "k", "--output", "o"], ["reconcile", "--output", "o"], ["size", "--source", "s"], ["run", "--summary", "faux"]];
  for (const args of argv) cases[`cli:${args.join(" ")}`] = capture(() => cli.parseE2Args(args));
  return raw ? cases : Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, sha(value)]));
}
