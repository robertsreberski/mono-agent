// Fictional, provider-free History A/B harness evidence. All artifacts are
// generated beneath temporary roots from the fictional C1 trace.
import { afterEach, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { digest as hash } from "../lib/continuity-recorded-schema.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { productionModules } from "../lib/continuity-runner.mjs";
import { E2_AB_ARMS, E2_AB_TOOL_POLICIES, e2AbArmContract, e2AbProbeCounts, e2AbPhaseSchedule, e2AbSlotArm, e2AbFrozenCheckpoint, e2AbFrozenRecord, e2AbSizingBinding,
  assertE2AbSnapshot, assertE2HistoryAbBinding, estimateE2HistoryAb, normalizeE2AbSizing, runE2HistoryAb, runE2HistoryAbSizing,
  relocateE2AbWork, e2AbHistoryHealth, e2AbHistoryPreflight } from "../lib/continuity-e2-ab.mjs";
import { e2AbArmOfSlot, e2SlotHistorySurface } from "../lib/continuity-e2-history.mjs";
import { scoreE2HistoryAb, classifyE2AbAnswer, e2AbLookupEvidence, readE2AbReceipts } from "../lib/continuity-e2-ab-score.mjs";
import { createE2ProbeReceipts } from "../lib/continuity-e2-probe-receipts.mjs";
import { createE2Models, estimatedReply, loadE2Estimators, shippingSoul, sizeContext } from "../lib/continuity-e2-models.mjs";
import { assertE2NoContinuityPack, withoutE2ContinuityPack, e2PhaseBase } from "../lib/continuity-e2-lineage.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
import { e2ToolPolicies, e2PhaseSchedule, e2ProbeCounts, E2_PROTOCOL_FILES } from "../lib/continuity-e2-registration.mjs";
import { e2RequestPrice, loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { estimateE2SizingSet } from "../lib/continuity-e2-sizing.mjs";
import { SOL, e2ReplayArm, protocolDigest } from "../lib/continuity-e2-protocol.mjs";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { parseE2Args, main } from "../continuity-e2.mjs";
import { codexWireTools } from "./fixtures/codex-wire-tools.mjs";
import { e2ParityCases } from "./fixtures/e2-ab-parity-cases.mjs";
import { abFrozenFixture, abNativeFixture, abKeys, AB_ROWS, AB_PRIMARY } from "./fixtures/e2-ab-fixture.mjs";
import { E2_NATIVE_DEADLINES } from "./fixtures/e2-native-registration.mjs";
const build = vi.hoisted(() => ({ state: vi.fn(() => ({ head: "b".repeat(40), dirty: false })), verify: vi.fn(async () => {}) }));
vi.mock("../lib/memory-e2e-build.mjs", async original => ({ ...(await original()), BUILD_POLICY: "fresh-clean-head-agent-app-closure-v1", sourceState: build.state, verifyRealBuild: build.verify }));
const roots = [], servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-ab-"))); roots.push(root);
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, root);
  return root;
}
const TIMEOUT = 240_000;
const PACK = "### Conversation continuity pack (historical evidence)\n";
const texts = message => typeof message.content === "string" ? [message.content] : (message.content ?? []).filter(p => p.type === "text").map(p => p.text);
const offered = context => context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []);

it("restores the frozen snapshot at a new absolute root and sizes every arm pack-free with its pinned description", async () => {
  const root = await scratch(), f = await abFrozenFixture(root), contexts = [];
  await mkdir(join(root, "new-root"), { mode: 0o700 });
  const output = join(root, "new-root", "sizing");
  const report = await runE2HistoryAbSizing({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, output, onContext: c => contexts.push(c) });
  expect(report).toMatchObject({ schema: "continuity-e2-ab-sizing-v1", replayArm: "history-ab", qualification: false, semanticQualification: false, probeLookupRounds: 3, checkpoint: 2, bindingSha256: e2AbSizingBinding(f.binding) });
  expect(report.arms.map(a => a.arm)).toEqual(["A", "B", "C"]);
  const descriptions = {
    A: (await import("../../packages/app/dist/request-tools/conversation-history.js")).CONVERSATION_HISTORY_DESCRIPTION,
    B: (await import("../../packages/app/dist/request-tools/history.js")).historyDescription(["said", "tools", "runs"], { variant: "compact" }),
    C: (await import("../../packages/app/dist/request-tools/history.js")).historyDescription(["said", "tools", "runs"], { variant: "directive" }) };
  expect(new Set(Object.values(descriptions).map(hash)).size).toBe(3);
  for (const arm of report.arms) {
    const contract = await e2AbArmContract(arm.arm), own = contexts.filter(c => c.arm === arm.arm).map(c => c.context);
    // The fictional B4 checkpoint injects a continuity pack: withheld from every request.
    expect(arm).toMatchObject(contract);
    expect(arm.withheldPacks).toBe(arm.requestSizing.length);
    expect(arm.description).toEqual({ sha256: hash(descriptions[arm.arm]), bytes: Buffer.byteLength(descriptions[arm.arm]) });
    expect(arm.probes.map(p => p.requests)).toEqual([4, 4]);
    expect(arm.requestSizing.map(r => r.paidRole)).toEqual(["probe", "continuation", "continuation", "continuation", "probe", "continuation", "continuation", "continuation"]);
    expect(own).toHaveLength(8);
    for (const [i, context] of own.entries()) {
      // R=3 lookups offer exactly the arm's tool with its exact description; the fourth is tool-free.
      const tools = offered(context);
      if (i % 4 === 3) expect(tools).toEqual([]);
      else expect(tools.map(t => [t.name, t.description])).toEqual([[contract.toolName, descriptions[arm.arm]]]);
      expect(context.messages.some(m => texts(m).some(t => t.startsWith(PACK)))).toBe(false);
      // Lookups execute against the restored store at the new root.
      for (const result of context.messages.filter(m => m.role === "toolResult")) expect(result.isError).not.toBe(true);
      expect(context.messages.filter(m => m.role === "toolResult")).toHaveLength(i % 4);
    }
    // Seeded and live messages are identical across restored repeats (the current
    // prompt's host envelope carries per-run identifiers).
    expect(JSON.stringify(own[0].messages.slice(0, -1))).toBe(JSON.stringify(own[4].messages.slice(0, -1)));
    expect(arm.probes[0].initialContext).toEqual(arm.probes[1].initialContext);
    expect(own[0].messages.filter(m => m.role === "user").length).toBeGreaterThan(1);
    // The copy was relocated (sidecar root, run summaries, session header) and History stayed healthy:
    // no writer, sidecar or availability warning was latched and the store held retained evidence.
    expect(arm.relocation).toMatchObject({ relocated: true, metadata: 1, artifactRefs: 0 });
    expect(arm.relocation.files).toBeGreaterThan(0);
    expect(arm.history).toEqual({ warnings: 0, codes: {} });
    expect(arm.probes.map(p => p.continuityRecords)).toEqual([15, 15]);
  }
  // Restored copies live under the new root only; the frozen tree is untouched.
  await assertE2AbSnapshot(f.binding);
  const moved = join(output, "history-ab-B", "branch-0", "work");
  expect((await readdir(moved)).sort()).toEqual((await readdir(f.snapshot)).sort());
  const db = new DatabaseSync(join(moved, "history", "tool-history", "tool-lifecycles.sqlite"), { readOnly: true });
  try { expect(db.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get().value).toBe(join(await realpath(moved), "artifacts", "tool-output")); } finally { db.close(); }
  const sizing = JSON.parse(await readFile(join(output, "sizing.json")));
  expect(digest(sizing)).toBe(digest(report));
  expect(() => normalizeE2AbSizing(f.trace.protocol, sizing, f.binding)).not.toThrow();
  // The content-free CLI builds the same binding and sizes a selected arm subset.
  const cli = [], errors = [], io = { stdout: v => cli.push(v), stderr: v => errors.push(v) };
  expect(await main(["ab-bind", "--replay", f.replayPath, "--snapshot", f.snapshot, "--branch", "0", "--checkpoint", "2", "--rows", f.binding.rows.join(","), "--primary", f.binding.primary.join(","), "--arms", "B", "--output", join(root, "bound")], io)).toBe(0);
  const bound = JSON.parse(await readFile(join(root, "bound", "history-ab.json")));
  expect(bound).toEqual({ ...f.binding, arms: f.binding.arms.filter(a => a.arm === "B") });
  expect(JSON.parse(cli[0])).toEqual({ schema: "continuity-e2-history-ab-v1", arms: ["B"], rows: 3, primary: 1, files: f.binding.frozen.receipt.files });
  await mkdir(join(root, "source"), { mode: 0o700 });
  await writeFile(join(root, "source", "source.json"), JSON.stringify(f.trace.source), { mode: 0o600 }); await writeFile(join(root, "protocol.json"), JSON.stringify(f.trace.protocol), { mode: 0o600 });
  expect(await main(["size", "--replay-arm", "history-ab", "--history-ab", join(root, "bound", "history-ab.json"), "--source", join(root, "source"), "--protocol", join(root, "protocol.json"), "--output", join(root, "cli-sizing")], io)).toBe(0);
  expect(errors).toEqual([]); expect(JSON.parse(cli[1])).toEqual({ schema: "continuity-e2-ab-sizing-v1", arms: 1, probes: 2, requests: 8 });
  const subset = JSON.parse(await readFile(join(root, "cli-sizing", "sizing.json")));
  expect(subset.arms.map(a => a.arm)).toEqual(["B"]); expect(() => normalizeE2AbSizing(f.trace.protocol, subset, bound)).not.toThrow();
  expect(() => normalizeE2AbSizing(f.trace.protocol, subset, f.binding)).toThrow("E2_ESTIMATE_INVALID");
  // A tampered frozen tree, replay record or receipt is refused before any probe.
  const tampered = join(f.snapshot, "IDENTITY.md");
  await appendFile(tampered, "Fictional tamper.\n");
  await expect(assertE2AbSnapshot(f.binding)).rejects.toThrow("E2_SNAPSHOT_MISMATCH");
  await expect(runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "A", output: join(root, "new-root", "tampered") })).rejects.toThrow("E2_SNAPSHOT_MISMATCH");
  await expect(e2AbFrozenRecord({ ...f.binding, frozen: { ...f.binding.frozen, replay: { ...f.binding.frozen.replay, sha256: "0".repeat(64) } } })).rejects.toThrow("E2_SNAPSHOT_MISMATCH");
  expect(() => e2AbFrozenCheckpoint(f.frozen, { ...f.binding, frozen: { ...f.binding.frozen, receipt: { ...f.binding.frozen.receipt, digest: "0".repeat(64) } } })).toThrow("E2_AB_BINDING_INVALID");
  expect(() => e2AbFrozenCheckpoint(f.frozen, f.binding, { protocol: { ...f.trace.protocol, probeLookupRounds: 2 } })).toThrow("E2_AB_BINDING_INVALID");
}, TIMEOUT);

it("relocates the restored copy, refuses what it cannot relocate and latches History degradation before any request", async () => {
  const root = await scratch(), f = await abFrozenFixture(root), modules = await productionModules(ROOT);
  const { restoreCheckpoint } = await import("../lib/continuity-e2-replay.mjs");
  const copy = async name => { const work = join(root, name, "work"); await mkdir(work, { recursive: true, mode: 0o700 }); await restoreCheckpoint(work, f.snapshot, f.binding.frozen.receipt); return work; };
  const open = (work, options = {}) => new DatabaseSync(join(work, "history", "tool-history", "tool-lifecycles.sqlite"), options);
  const frozenRoot = (() => { const db = open(f.snapshot, { readOnly: true }); try { return db.prepare("SELECT value FROM metadata WHERE key='artifact_root'").get().value.slice(0, -"/artifacts/tool-output".length); } finally { db.close(); } })();
  // An unrelocated copy is exactly the silent failure: the shipping writer refuses its pinned root.
  const plain = await copy("plain"), unrelocated = e2AbHistoryHealth();
  await expect(e2AbHistoryPreflight(modules, plain, unrelocated)).rejects.toThrow("E2_HISTORY_DEGRADED");
  expect(unrelocated.report()).toEqual({ warnings: 1, codes: { history_artifact_root_mismatch: 1 } });
  // Relocated, the same copy names only its own root and History opens healthy with retained evidence.
  const relocation = await relocateE2AbWork(plain), healthy = e2AbHistoryHealth();
  expect(relocation).toMatchObject({ relocated: true, metadata: 1, artifactRefs: 0 });
  await expect(e2AbHistoryPreflight(modules, plain, healthy)).resolves.toMatchObject({ records: 15 });
  expect(healthy.report()).toEqual({ warnings: 0, codes: {} });
  const journals = await readdir(join(plain, "sessions", "journals"));
  for (const name of journals) expect(JSON.parse((await readFile(join(plain, "sessions", "journals", name), "utf8")).split("\n", 1)[0]).cwd).toBe(plain);
  expect(await relocateE2AbWork(plain)).toEqual({ relocated: false, metadata: 0, artifactRefs: 0, files: 0 });
  // Persisted artifact references move with the tree.
  const refs = await copy("refs"), db = open(refs, { enableForeignKeyConstraints: false });
  try { db.prepare("INSERT INTO artifact_refs VALUES (?,?,?,?,?,?,?)").run("fictional-artifact", "fictional-conversation", "fictional-run", "fictional-call", join(frozenRoot, "artifacts", "tool-output", "fictional-run", "out.txt"), "available", 1); } finally { db.close(); }
  expect(await relocateE2AbWork(refs)).toMatchObject({ relocated: true, artifactRefs: 1 });
  const moved = open(refs, { readOnly: true });
  try { expect(moved.prepare("SELECT host_path FROM artifact_refs").get().host_path).toBe(join(refs, "artifacts", "tool-output", "fictional-run", "out.txt")); } finally { moved.close(); }
  // Unrelocatable pointers refuse: an artifact outside the frozen tree, a non-JSON carrier, a partial path string.
  const outside = await copy("outside"), odb = open(outside, { enableForeignKeyConstraints: false });
  try { odb.prepare("INSERT INTO artifact_refs VALUES (?,?,?,?,?,?,?)").run("fictional-artifact", "fictional-conversation", "fictional-run", "fictional-call", "/fictional/elsewhere/out.txt", "available", 1); } finally { odb.close(); }
  await expect(relocateE2AbWork(outside)).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
  const prose = await copy("prose"); await appendFile(join(prose, "IDENTITY.md"), `Fictional workspace ${frozenRoot}\n`);
  await expect(relocateE2AbWork(prose)).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
  const partial = await copy("partial"); await writeFile(join(partial, "artifacts", "fictional.json"), JSON.stringify({ note: `see ${frozenRoot}/artifacts` }), { mode: 0o600 });
  await expect(relocateE2AbWork(partial)).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
  // The latch: warning dispatch swallows callback errors, so a degradation must refuse on its own.
  const warning = "Continuity is degraded (sidecar_unavailable); fictional coverage gap.";
  const wrap = onOpen => ({ ...modules, app: { ...modules.app, createConfiguredConversationHarness: async options => { onOpen(options.onToolHistoryWarning); return modules.app.createConfiguredConversationHarness(options); } } });
  const run = async (name, onOpen, onFirst = () => {}) => {
    const contexts = [], error = await runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "B", output: join(root, name), modules: wrap(onOpen),
      onContext: c => { contexts.push(c); if (contexts.length === 1) onFirst(); } }).catch(e => e);
    return { error, contexts };
  };
  // Degraded before the first request: nothing is sized, guarded or sent.
  const early = await run("early", warn => warn(warning));
  expect(early.error?.code).toBe("E2_HISTORY_DEGRADED"); expect(early.contexts).toHaveLength(0);
  // Degraded after the first request: the next request refuses and the probe is void (no report).
  let later; const midway = await run("midway", warn => { later = () => warn(warning); }, () => later());
  expect(midway.error?.code).toBe("E2_HISTORY_DEGRADED"); expect(midway.contexts).toHaveLength(1);
  await assertE2AbSnapshot(f.binding);
}, TIMEOUT);

async function abRoute({ arm = "B", context, position = { probe: true }, description, ...options } = {}) {
  const modules = await productionModules(ROOT), estimators = await loadE2Estimators(), contract = await e2AbArmContract(arm), soul = await shippingSoul(contract.historySurface);
  const model = { provider: "openai-codex", id: "gpt-6.1-sol", contextWindow: 500_000, maxTokens: 128_000, reasoning: true }, seen = [];
  const route = createE2Models({ pi: modules.pi, estimators, models: [{ model: SOL }], limits: { sourceRequests: 4, summaryRequests: 0, summaryRequestsPerCompaction: 1, probeRequests: 8, compactions: 0, timeoutMs: 30_000 },
    soul, probeLookupRounds: 3, replayArm: "history-ab", historySurface: contract.historySurface, abArm: arm, abDescriptionSha256: description ?? contract.description.sha256,
    sourceContext: c => seen.push(structuredClone(c)), sourceReply: c => estimatedReply(modules.pi, "Fictional answer.", c, estimators), ...options });
  route.setPosition({ model: SOL, turn: 7, message: 15, ...position });
  const models = route.decorator({ getModel: () => model });
  return { route, models, model, seen, soul, estimators, contract };
}
async function abContext(arm, { messages } = {}) {
  const contract = await e2AbArmContract(arm), soul = await shippingSoul(contract.historySurface);
  const unified = contract.historySurface === "unified", h = await import("../../packages/app/dist/request-tools/history.js");
  const description = unified ? h.historyDescription(["said", "tools", "runs"], { variant: contract.descriptionVariant }) : (await import("../../packages/app/dist/request-tools/conversation-history.js")).CONVERSATION_HISTORY_DESCRIPTION;
  return { systemPrompt: `## Core Guardrails\n\n${soul.text}\n\n## Identity\n\nFictional`, tools: [{ name: contract.toolName, description, parameters: { type: "object", properties: {} } }],
    messages: messages ?? [
      { role: "user", content: "Historical user (untrusted context): fictional seeded request", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Historical assistant (untrusted context): fictional seeded response" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: `${PACK}Coverage: fictional.\nGenerated summary evidence id="chr1_${"a".repeat(43)}" sha256="${"b".repeat(64)}": "Fictional summary"` }], timestamp: 3 },
      { role: "user", content: [{ type: "text", text: "Fictional live request" }], timestamp: 4 },
      { role: "assistant", content: [{ type: "text", text: "Fictional live response" }], timestamp: 5 },
      { role: "user", content: [{ type: "text", text: "Fictional current probe question" }], timestamp: 6 },
    ] };
}
const send = async (route, context) => { const stream = route.models.streamSimple(route.model, context, { maxTokens: 128_000 }); return stream.result(); };
it.each(E2_AB_ARMS)("withholds only the injected pack for arm %s and keeps seeded and live messages", async arm => {
  const r = await abRoute({ arm }), context = await abContext(arm);
  const reply = await send(r, context);
  expect(reply.stopReason).toBe("stop");
  const kept = context.messages.filter((_, i) => i !== 2);
  expect(r.seen).toHaveLength(1); expect(r.seen[0].messages).toEqual(kept);
  expect(r.route.report()).toMatchObject({ withheldPacks: 1, probeRequests: 1 });
  expect(r.route.report().requestSizing[0].size).toEqual(sizeContext({ ...context, messages: kept }, r.estimators));
  expect(() => assertE2NoContinuityPack(r.seen[0])).not.toThrow();
  expect(withoutE2ContinuityPack(context).messages).toEqual(kept);
});
it.each([
  ["an assistant-authored pack", m => [...m.slice(0, 2), { role: "assistant", content: [{ type: "text", text: `${PACK}Fictional` }] }, ...m.slice(3)]],
  ["a pack as the current prompt", m => [...m.slice(0, 5), { role: "user", content: [{ type: "text", text: `${PACK}Fictional` }] }]],
  ["a role-framed serialized pack", m => [...m.slice(0, 2), { role: "user", content: `<conversation>\n[User]: ${PACK}Generated summary evidence id="chr1_${"a".repeat(43)}" sha256="${"b".repeat(64)}": "Fictional"\n</conversation>\n\n` }, ...m.slice(3)]],
  ["a second pack part inside a kept message", m => [...m.slice(0, 3), { role: "user", content: [{ type: "text", text: "Fictional live request" }, { type: "text", text: `${PACK}Fictional` }] }, ...m.slice(4)]],
])("fails closed when %s slips past the filter", async (_, mutate) => {
  const r = await abRoute(), context = await abContext("B");
  context.messages = mutate(context.messages);
  await expect(send(r, context)).rejects.toThrow("E2_AB_PACK_PRESENT");
  expect(r.seen).toHaveLength(0);
  expect(r.route.refusalCode()).toBe("E2_AB_PACK_PRESENT");
});
it("pins offered description bytes, tool, probe position, summaries and arm binding", async () => {
  for (const [arm, other] of [["A", "B"], ["B", "C"], ["C", "B"]]) {
    const r = await abRoute({ arm }), context = await abContext(arm);
    context.tools = (await abContext(other)).tools.map(t => ({ ...t, name: (context.tools[0]).name }));
    await expect(send(r, context)).rejects.toThrow("E2_AB_DESCRIPTION_MISMATCH");
  }
  const wrongTool = await abRoute({ arm: "B" }), named = await abContext("B"); named.tools = (await abContext("A")).tools;
  await expect(send(wrongTool, named)).rejects.toThrow("E2_PROBE_TOOLS_REFUSED");
  const source = await abRoute({ position: { probe: false } });
  await expect(send(source, await abContext("B"))).rejects.toThrow("E2_SOURCE_REQUEST_LIMIT");
  const summary = await abRoute();
  await expect(summary.models.completeSimple(summary.model, { messages: [] }, { maxTokens: 10, transport: "sse", maxRetries: 0 })).rejects.toThrow("E2_PROBE_SUMMARY_FORBIDDEN");
  const claimed = await abRoute(), withSummary = await abContext("B");
  withSummary.messages.splice(1, 0, { role: "compactionSummary", summary: "Fictional summary", tokensBefore: 1, timestamp: 1 });
  await expect(send(claimed, withSummary)).rejects.toThrow("E2_AB_SUMMARY_CLAIM");
  const nested = await abRoute(), previous = await abContext("B");
  previous.messages.splice(1, 0, { role: "user", content: "<previous-summary>\nFictional unverified summary\n</previous-summary>" });
  await expect(send(nested, previous)).rejects.toThrow("E2_AB_SUMMARY_CLAIM");
  // Arm, surface and description digest are bound together at construction.
  const modules = await productionModules(ROOT), estimators = await loadE2Estimators(), unified = await shippingSoul("unified"), split = await shippingSoul();
  const base = { pi: modules.pi, estimators, models: [{ model: SOL }], limits: {}, probeLookupRounds: 3 }, sha = (await e2AbArmContract("B")).description.sha256;
  for (const bad of [{ replayArm: "history-ab", historySurface: "unified", soul: unified }, { replayArm: "history-ab", abArm: "A", historySurface: "unified", soul: unified, abDescriptionSha256: sha },
    { replayArm: "history-ab", abArm: "B", historySurface: "split", soul: split, abDescriptionSha256: sha }, { abArm: "B", historySurface: "unified", soul: unified, abDescriptionSha256: sha },
    { replayArm: "history-ab", abArm: "D", historySurface: "unified", soul: unified, abDescriptionSha256: sha }, { replayArm: "history-ab", abArm: "B", historySurface: "unified", soul: unified },
    { historySurface: "unified", soul: unified, abDescriptionSha256: sha }])
    expect(() => createE2Models({ ...base, ...bad })).toThrow("E2_AB_BINDING_INVALID");
  // Legacy routes keep their exact report shape.
  expect(createE2Models({ ...base, soul: split }).report()).toEqual({ sourceRequests: 0, probeRequests: 0, summaryRequests: [], compactions: [], requestSizing: [] });
}, TIMEOUT);
it("applies the controller's own pack-withheld body and description boundary only to A/B holds", async () => {
  const contracts = Object.fromEntries(await Promise.all(E2_AB_ARMS.map(async arm => [arm, await e2AbArmContract(arm)])));
  const described = Object.fromEntries(await Promise.all(E2_AB_ARMS.map(async arm => [arm, (await abContext(arm)).tools[0].description])));
  const body = (input, arm = "B", description = described[arm]) => Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", stream: true, store: false,
    tools: [{ type: "function", name: contracts[arm].toolName, ...(description === null ? {} : { description }) }], input }));
  const current = { role: "user", content: [{ type: "input_text", text: "Fictional current probe question" }] };
  const pack = { role: "user", content: [{ type: "input_text", text: `${PACK}Fictional` }] };
  const hold = (arm = "B") => ({ model: SOL, tools: [contracts[arm].toolName], probeRequest: 1, abArm: arm, abDescriptionSha256: contracts[arm].description.sha256 });
  for (const arm of E2_AB_ARMS) expect(() => e2ExecutionPolicy.assertBody(body([current], arm), hold(arm))).not.toThrow();
  expect(() => e2ExecutionPolicy.assertBody(body([pack, current]), hold("B"))).toThrow("e2_payload_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(body([{ ...pack, role: "assistant", content: [{ type: "output_text", text: `${PACK}Fictional` }] }, current], "C"), hold("C"))).toThrow("e2_payload_forbidden");
  // A C hold offering the compact (B) description, or any other bytes, is refused by the controller itself.
  expect(() => e2ExecutionPolicy.assertBody(body([current], "C", described.B), hold("C"))).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(body([current], "B", described.C), hold("B"))).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(body([current], "B", `${described.B} `), hold("B"))).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(body([current], "B", null), hold("B"))).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertBody(body([current], "C"), { ...hold("C"), abDescriptionSha256: undefined })).toThrow("e2_tools_forbidden");
  // Continuity probes legitimately carry their pack; that path is unchanged.
  expect(() => e2ExecutionPolicy.assertBody(body([pack, current]), { model: SOL, tools: ["History"], probeRequest: 1 })).not.toThrow();
}, TIMEOUT);

it("binds arms, variants, rows and the frozen tree into one registration and refuses every mismatch", async () => {
  const root = await scratch(), f = await abNativeFixture(root); vi.stubEnv("CI", undefined);
  const r = f.pilot.registration, auth = guardedAuthorization("e2-validation");
  expect(Object.keys(r).sort()).toEqual(["build", "catalog", "code", "historyAb", "keys", "probeCounts", "probes", "protocol", "replayArm", "roles", "schedule", "sizing", "source", "toolPolicies"]);
  expect(r).not.toHaveProperty("historySurface"); expect(r).not.toHaveProperty("soul");
  expect(r.schedule.map(p => [p.kind, p.arm, p.budgets.map(b => [b.checkpoint, b.paidRole, b.maxRequests])])).toEqual(E2_AB_ARMS.map(arm => ["replay", `history-ab-${arm}`, [[2, "continuation", 18], [2, "probe", 6]]]));
  expect(r.probeCounts).toEqual([0, 1, 2, 3].map(checkpoint => ({ checkpoint, questions: checkpoint === 2 ? 3 : 0, lookupRounds: 3 })));
  expect(r.toolPolicies).toEqual({ summary: [], replayFinal: [], abReplay: { A: ["ConversationHistory"], B: ["History"], C: ["History"] } });
  const handle = await auth.validate(f.args); expect(auth.bindsRegistration(handle, f.pilot)).toBe(true);
  expect(f.artifact.bindings).toMatchObject({ replayArm: "history-ab", historyAb: r.historyAb }); expect(f.artifact.bindings).not.toHaveProperty("soul");
  const saved = structuredClone(f.pilot);
  const refuse = async (mutate, code = "e2_registration_invalid") => {
    mutate(f.pilot); await f.persist();
    await expect(auth.validate(f.args)).rejects.toMatchObject({ code });
    f.pilot.registration = structuredClone(saved.registration); f.pilot.descriptor = structuredClone(saved.descriptor); await f.persist();
  };
  const contract = letter => structuredClone(r.historyAb.arms.find(a => a.arm === letter));
  await refuse(p => { p.registration.historyAb.arms[1] = { ...contract("C"), arm: "B" }; });
  await refuse(p => { p.registration.historyAb.arms[1].descriptionVariant = "directive"; });
  await refuse(p => { p.registration.historyAb.arms[0].historySurface = "unified"; });
  await refuse(p => { p.registration.historyAb.arms[2].description.sha256 = "0".repeat(64); });
  await refuse(p => { p.registration.historyAb.arms = [contract("B"), contract("A"), contract("C")]; });
  await refuse(p => { p.registration.historyAb.arms.pop(); });
  await refuse(p => { p.registration.schedule[1].arm = "history-ab-C"; });
  await refuse(p => { p.registration.toolPolicies.abReplay.B = ["ConversationHistory"]; });
  await refuse(p => { p.registration.historySurface = "unified"; });
  await refuse(p => { p.registration.soul = { rawDigest: "0".repeat(64), normalizedDigest: "0".repeat(64) }; });
  // Row selection: unknown, other-checkpoint, duplicate or count-changing rows refuse.
  await refuse(p => { p.registration.historyAb.rows.push("fictional-not-a-question"); });
  await refuse(p => { p.registration.historyAb.rows[0] = "fictional-unselected"; });
  await refuse(p => { p.registration.historyAb.rows.push(p.registration.historyAb.rows[0]); });
  await refuse(p => { p.registration.historyAb.primary = ["fictional-unselected"]; });
  await refuse(p => { p.registration.historyAb.rows.pop(); });
  await refuse(p => { p.registration.probeCounts[2].questions = 4; });
  await refuse(p => { p.registration.roles.push({ role: "summary", model: SOL, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 }); });
  await refuse(p => { p.descriptor.capUnits = (BigInt(f.estimate.minimumCapUnits) - 1n).toString(); });
  await refuse(p => { p.registration.historyAb.frozen.checkpoint = 1; });
  await refuse(p => { p.registration.historyAb.frozen.snapshot = join(root, "frozen", "replay", "branch-0", "snapshots", "checkpoint-1"); });
  // Rows are inside the registration digest: a post-authorization reselection is a binding mismatch.
  const reselected = structuredClone(saved); reselected.registration.historyAb.rows.reverse();
  const raw = JSON.stringify(reselected); await writeFile(f.args.registrationPath, raw, { mode: 0o600 });
  await expect(auth.validate({ ...f.args, registrationSha256: hash(raw) })).rejects.toMatchObject({ code: "e2_authorization_binding_mismatch" });
  expect(digest(reselected)).not.toBe(digest(saved));
  await f.persist();
  // A stale sizing draw (other code/build identity or other arm set) refuses.
  const stale = structuredClone(f.record); stale.sizingIdentity.codeSha256 = "0".repeat(64);
  const staleBinding = await f.bind("stale", stale);
  await refuse(p => { p.registration.sizing = [staleBinding]; });
  const other = structuredClone(f.record); other.arms.pop();
  expect(() => normalizeE2AbSizing(f.ab.trace.protocol, other, f.ab.binding)).toThrow("E2_ESTIMATE_INVALID");
  // Paid entry must explicitly select the A/B mode; no surface selector applies.
  const out = [], err = [], io = { stdout: v => out.push(v), stderr: v => err.push(v) };
  const run = ["run", "--summary", "real", "--registration", f.args.registrationPath, "--sha256", f.args.registrationSha256, "--authorization", f.args.authorizationPath, "--credentials", f.args.credentialPath, "--output", f.args.outputRoot];
  expect(await main(run, io)).toBe(1); expect(err.pop()).toBe("e2_authorization_binding_mismatch\n");
  expect(await main([...run, "--replay-arm", "history-ab", "--history-surface", "unified"], io)).toBe(1); expect(err.pop()).toContain("Usage:");
  expect(out).toEqual([]);
  // Slot surfaces and admitted tools are per arm; the final round is tool-free.
  const catalog = r.catalog, sol = catalog.find(c => c.model === SOL), role = r.roles.find(x => x.role === "probe");
  const permit = (paidRole, slot) => ({ requestId: "fictional:1", slotId: slot.slotId, round: 1, payloadDigest: "a".repeat(64), reservationUnits: e2RequestPrice(sol, { inputTokens: 10, maxOutputTokens: role.maxOutputTokens }).reservationUnits, inputTokens: 10, model: SOL, paidRole, checkpoint: 2 });
  for (const slot of r.schedule) {
    const arm = e2AbArmOfSlot(slot.arm);
    expect(e2SlotHistorySurface(r, slot)).toBe(arm === "A" ? "split" : "unified");
    expect(e2PhaseBase("/fictional/root", slot)).toBe(`/fictional/root/work/${slot.arm}`);
    const first = e2ExecutionPolicy.admission(f.pilot, slot, { holds: [] }, permit("probe", slot)).metadata;
    expect(first).toMatchObject({ replayArm: "history-ab", abArm: arm, abDescriptionSha256: (await e2AbArmContract(arm)).description.sha256, probeRequest: 1, tools: [arm === "A" ? "ConversationHistory" : "History"] });
    expect(first).not.toHaveProperty("historySurface");
    const last = e2ExecutionPolicy.admission(f.pilot, slot, { holds: [1, 2, 3].map(n => ({ checkpoint: 2, probeRequest: n, paidRole: n === 1 ? "probe" : "continuation", model: SOL })) }, permit("continuation", slot)).metadata;
    expect(last).toMatchObject({ probeRequest: 4, tools: [] });
    expect(() => e2ExecutionPolicy.admission(f.pilot, slot, { holds: [] }, { ...permit("summary", slot) })).toThrow();
  }
  expect(() => e2ExecutionPolicy.admission({ registration: { ...r, replayArm: undefined } }, r.schedule[0], { holds: [] }, permit("probe", r.schedule[0]))).toThrow("e2_registration_invalid");
  // The payload guard derives the expected description from the registered arm, not from the request.
  const [compact, directive] = [(await abContext("B")).tools[0].description, (await abContext("C")).tools[0].description];
  const payload = description => ({ model: "gpt-6.1-sol", stream: true, store: false, reasoning: { effort: "high" }, input: [{ role: "user", content: [{ type: "input_text", text: "Fictional current probe question" }] }],
    tools: [{ type: "function", name: "History", description, parameters: { type: "object", properties: {} }, strict: false }] });
  const paid = slot => ({ effort: "high", e2: { pilot: f.pilot, planned: slot, paidRole: "probe", model: SOL, checkpoint: 2, probeRequest: 1 } });
  expect(() => e2ExecutionPolicy.assertPayload(payload(directive), 1, paid(r.schedule[2]))).not.toThrow();
  expect(() => e2ExecutionPolicy.assertPayload(payload(compact), 1, paid(r.schedule[1]))).not.toThrow();
  expect(() => e2ExecutionPolicy.assertPayload(payload(compact), 1, paid(r.schedule[2]))).toThrow("e2_tools_forbidden");
  expect(() => e2ExecutionPolicy.assertPayload(payload(directive), 1, paid(r.schedule[1]))).toThrow("e2_tools_forbidden");
  expect(() => e2SlotHistorySurface({ ...r, historySurface: "unified" }, r.schedule[0])).toThrow("e2_registration_invalid");
}, TIMEOUT);

it("estimates the A/B minimum as the no-cache aggregate plus the largest reservation, with retries separate", async () => {
  const catalog = await loadE2Catalog(), protocol = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url))).protocol;
  protocol.probeLookupRounds = 3;
  const contracts = await Promise.all(E2_AB_ARMS.map(e2AbArmContract));
  const binding = { schema: "continuity-e2-history-ab-v1", frozen: { replay: { path: "/fictional/replay.json", sha256: "a".repeat(64) }, snapshot: "/fictional/snapshot", branch: 0, checkpoint: 2,
    receipt: { digest: "b".repeat(64), files: 3 } }, arms: contracts, rows: ["fictional-1", "fictional-2", "fictional-3", "fictional-4"], primary: ["fictional-1"] };
  const size = tokens => ({ method: "intercepted-full-models-context", serializedBytes: 3, serializedBytesOver3: 1, engineFullRequest: tokens, maximum: tokens, usage: "engine-estimate-not-provider-measurement" });
  const row = (paidRole, tokens) => ({ turn: 7, message: 15, role: paidRole, paidRole, model: SOL, maxOutputTokens: 128000, size: size(tokens) });
  const record = scale => ({ schema: "continuity-e2-ab-sizing-v1", replayArm: "history-ab", qualification: false, semanticQualification: false, usage: "estimated-not-measured",
    sourceDigest: "c".repeat(64), protocolDigest: protocolDigest(protocol), bindingSha256: e2AbSizingBinding(binding), probeLookupRounds: 3, checkpoint: 2,
    arms: contracts.map((c, i) => ({ ...c, withheldPacks: 1, probes: [1, 2].map(repeat => ({ repeat, requests: 4, initialContext: size(1000) })),
      requestSizing: [1, 2].flatMap(() => [row("probe", (10_000 + i * 100) * scale), ...[1, 2, 3].map(k => row("continuation", (11_000 + i * 100 + k) * scale))]) })) });
  const roles = ["probe", "continuation"].map(role => ({ role, model: SOL, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 3000 }));
  const one = estimateE2HistoryAb({ protocol, roles, historyAb: binding, records: [record(1)], catalog });
  const requests = 3 * binding.rows.length * 2 * 4;
  expect(one.fundedSchedule.totals.requests).toBe(requests);
  expect(one).toMatchObject({ replayArm: "history-ab", qualification: false, minimumCapRule: "no-cache-aggregate-plus-largest-reservation" });
  expect(BigInt(one.minimumCapUnits)).toBe(BigInt(one.fundedSchedule.totals.noCacheUnits) + BigInt(one.largestReservationUnits));
  expect(one.minimumCapUnits).toBe(one.forecastNoCacheMinimumCapUnits);
  expect(one.arms.map(a => a.requests)).toEqual([requests / 3, requests / 3, requests / 3]);
  expect(one.arms.reduce((n, a) => n + BigInt(a.noCacheUnits), 0n)).toBe(BigInt(one.fundedSchedule.totals.noCacheUnits));
  expect(one.retryExposure).toMatchObject({ maximumAdditionalRequests: 8, includedInMinimum: false, maximumAdditionalUnits: (BigInt(one.largestReservationUnits) * 8n).toString() });
  // Hand-computed no-cache arithmetic: input * rate + expected output * rate, per request.
  const rates = { input: 2000n, output: 10000n }, rows = binding.rows.length;
  // Every continuation is funded at the largest observed continuation size (k = 3).
  const expected = contracts.reduce((n, _, i) => n + BigInt(rows) * 2n * ((BigInt(10_000 + i * 100) + 3n * BigInt(11_000 + i * 100 + 3)) * rates.input + 4n * 3000n * rates.output), 0n);
  expect(BigInt(one.fundedSchedule.totals.noCacheUnits)).toBe(expected);
  // Alternative draws fund the largest observed size, never their sum.
  const two = estimateE2HistoryAb({ protocol, roles, historyAb: binding, records: [record(1), record(2)], catalog });
  expect(two.fundedSchedule.totals.requests).toBe(requests);
  expect(two.minimumCapUnits).toBe(estimateE2HistoryAb({ protocol, roles, historyAb: binding, records: [record(2)], catalog }).minimumCapUnits);
  // The schedule budgets are exactly the funded counts, one slot per arm.
  expect(e2AbPhaseSchedule(protocol, binding, [record(1)]).map(p => p.budgets.map(b => b.maxRequests))).toEqual([[24, 8], [24, 8], [24, 8]]);
  // Only Sol probe/continuation roles, and only A/B records, are accepted.
  expect(() => estimateE2HistoryAb({ protocol, roles: [...roles, { ...roles[0], role: "summary" }], historyAb: binding, records: [record(1)], catalog })).toThrow("E2_ESTIMATE_INVALID");
  expect(() => estimateE2HistoryAb({ protocol, roles: roles.map(r => ({ ...r, model: "openai-codex:gpt-6-luna" })), historyAb: binding, records: [record(1)], catalog })).toThrow("E2_ESTIMATE_INVALID");
  expect(() => estimateE2HistoryAb({ protocol, roles, historyAb: { ...binding, rows: ["fictional-1"] }, records: [record(1)], catalog })).not.toThrow();
  expect(() => estimateE2HistoryAb({ protocol, roles, historyAb: { ...binding, arms: contracts.slice(0, 2) }, records: [record(1)], catalog })).toThrow("E2_ESTIMATE_INVALID");
  expect(() => estimateE2SizingSet({ protocol, roles, records: [record(1)], catalog, replayArm: "history-ab" })).toThrow("E2_ESTIMATE_INVALID");
  expect(() => e2PhaseSchedule(protocol, [record(1)], [], "history-ab")).toThrow("e2_registration_invalid");
  expect(() => e2ProbeCounts(protocol, { schema: "continuity-recorded-questions-v1", questions: [] }, { schema: "continuity-recorded-evaluator-keys-v1", keys: [] }, {}, "history-ab")).toThrow("e2_registration_invalid");
  // The CLI estimator agrees and refuses limits that disagree with the bound rows.
  const root = await scratch(), files = {};
  for (const [name, value] of [["protocol", protocol], ["binding", binding], ["sizing", record(1)], ["limits", { schema: "continuity-e2-estimate-limits-v1", roles, probeCounts: e2AbProbeCounts(protocol, binding) }],
    ["wrong-limits", { schema: "continuity-e2-estimate-limits-v1", roles, probeCounts: e2AbProbeCounts(protocol, { ...binding, rows: ["fictional-1"] }) }]]) {
    files[name] = join(root, `${name}.json`); await writeFile(files[name], JSON.stringify(value), { mode: 0o600 });
  }
  const out = [], err = [], io = { stdout: v => out.push(v), stderr: v => err.push(v) };
  const args = limits => ["--estimate", "--replay-arm", "history-ab", "--history-ab", files.binding, "--protocol", files.protocol, "--limits", limits, "--sizing", files.sizing, "--output", join(root, `estimate-${out.length}-${err.length}`)];
  expect(await main(args(files.limits), io)).toBe(0); expect(err).toEqual([]);
  expect(JSON.parse(out[0]).minimumCapUnits).toBe(one.minimumCapUnits);
  expect(await main(args(files["wrong-limits"]), io)).toBe(1); expect(err.pop()).toBe("E2_PROBE_COUNTS_REQUIRED\n");
});

// Fictional receipt streams written by the shipping all-scope receipt writer.
const AB_TOOL = { A: "mcp__mono-agent-conversation-history__ConversationHistory", B: "mcp__mono-agent-history__History", C: "mcp__mono-agent-history__History" };
async function abReceipts(root, arm, items, { allScopes = true, name = `receipts-${arm}` } = {}) {
  const output = join(root, name); await mkdir(output, { mode: 0o700 });
  const receipts = createE2ProbeReceipts({ output, slotId: `fictional-slot-${arm}`, allScopes });
  let n = 0;
  for (const { id, repeat, scopes = [], settle = true } of items) {
    receipts.begin({ branch: 0, checkpoint: 2, repeat, itemOrdinal: AB_ROWS.indexOf(id) + 1, arm, rowId: id });
    for (const scope of scopes) {
      const callId = `fictional-call-${++n}`;
      receipts.observeRequest({ messages: [{ role: "user", content: "Fictional request" }] });
      receipts.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: AB_TOOL[arm], input: { ...(arm === "A" ? {} : { scope }), action: "search", query: "Fictional", limit: 1 } }] } });
      receipts.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: [{ type: "text", text: '{"action":"search","status":"available","count":1,"items":[]}' }] }] } });
    }
    if (settle) receipts.settle();
  }
  await receipts.flush();
  return readE2AbReceipts(join(output, "probe-receipts"));
}
it("scores each answer with the frozen scorer and crosses it with receipt-derived lookups per arm, overall and primary", async () => {
  const root = await scratch();
  const binding = { schema: "continuity-e2-history-ab-v1", frozen: { replay: { path: "/fictional/replay.json", sha256: "a".repeat(64) }, snapshot: "/fictional/snapshot", branch: 0, checkpoint: 2,
    receipt: { digest: "b".repeat(64), files: 3 } }, arms: E2_AB_ARMS.map(arm => ({ arm })), rows: AB_ROWS, primary: AB_PRIMARY };
  const evaluator = abKeys(), answer = (id, repeat, text, witness = true) => ({ id, repeat, text, witness, excludedSteps: [], excludedCoverage: [] });
  const [exact, referent, control] = AB_ROWS, answers = list => ({ schema: "continuity-e2-answers-v1", answers: list });
  const arms = {
    // A: correct after lookup, contaminated correct without lookup, wrong without lookup, abstain after lookup, wrong after lookup, missing.
    A: { answers: answers([answer(exact, 1, "Fictional response"), answer(exact, 2, "**Fictional response.**"), answer(referent, 1, "Fictional other"), answer(referent, 2, "I don't know"), answer(control, 1, "Fictional other")]),
      receipts: await abReceipts(root, "A", [{ id: exact, repeat: 1, scopes: ["said", "said"] }, { id: exact, repeat: 2 }, { id: referent, repeat: 1 }, { id: referent, repeat: 2, scopes: ["said"] }, { id: control, repeat: 1, scopes: ["said"] }]) },
    // B: every scope of the unified tool is attributed from its own call receipt.
    B: { answers: answers(AB_ROWS.flatMap(id => [1, 2].map(repeat => answer(id, repeat, "Fictional response")))),
      receipts: await abReceipts(root, "B", AB_ROWS.flatMap((id, i) => [1, 2].map(repeat => ({ id, repeat, scopes: [["said", "tools", "runs"][i]] })))) },
    // C: an inconclusive answer after a runs lookup, and an answer whose probe never settled.
    C: { answers: answers([answer(exact, 1, "Fictional response", false), answer(exact, 2, "Fictional response")]),
      receipts: await abReceipts(root, "C", [{ id: exact, repeat: 1, scopes: ["runs"] }, { id: exact, repeat: 2, scopes: [], settle: false }]) },
  };
  const report = scoreE2HistoryAb({ historyAb: binding, evaluator, arms });
  expect(report).toMatchObject({ schema: "continuity-e2-ab-score-v1", qualification: false, gate: "not-applicable-observational", lookupSource: "validated-probe-receipts", rows: 3, primaryRows: 1, mapping: { ratePass: "correct", blocking: "wrong", rateMiss: "abstain" } });
  const [a, b, c] = report.arms;
  expect(a.overall).toMatchObject({ answers: 5, lookups: 3, lookupRate: 0.6, lookupEvidence: { verified: 5, missing: 0, inconsistent: 0 }, correct: 2, correctWithoutLookup: 1, wrongWithoutLookup: 1, wrongAfterLookup: 1, abstain: 1, missing: 1, byScope: { said: 3, tools: 0, runs: 0 } });
  expect(a.primary).toMatchObject({ answers: 2, lookups: 1, correct: 2, correctWithoutLookup: 1, wrongWithoutLookup: 0, missing: 0 });
  expect(a.items.find(i => i.id === exact && i.repeat === 1)).toMatchObject({ classification: "ratePass", outcome: "correct", lookupEvidence: "verified", lookup: true, scopes: { said: 2, tools: 0, runs: 0 } });
  expect(b.overall).toMatchObject({ answers: 6, lookups: 6, lookupRate: 1, correct: 6, correctWithoutLookup: 0, byScope: { said: 2, tools: 2, runs: 2 } });
  // Without a witness the frozen scorer is inconclusive; an unsettled probe is unverified, never "no lookup".
  expect(c.overall).toMatchObject({ answers: 2, correct: 1, correctWithoutLookup: 0, correctLookupUnverified: 1, missing: 4, other: { inconclusive: 1 }, byScope: { runs: 1 },
    lookups: 1, lookupRate: 1, lookupEvidence: { verified: 1, missing: 1, inconsistent: 0 } });
  expect(c.items.find(i => i.id === exact && i.repeat === 2)).toMatchObject({ outcome: "correct", lookupEvidence: "missing", lookup: null, scopes: null });
  expect(classifyE2AbAnswer(answer(exact, 2, "Fictional response"), evaluator.keys.find(k => k.id === exact))).toBe("ratePass");
  expect(JSON.stringify(report)).not.toContain("Fictional other");
  // Inconsistent receipts: a call whose recorded scope contradicts its arguments, a lost entry, another arm's stream,
  // a response without its call, or no receipts at all. None of them can read as "no lookup".
  const evidence = (arm, receipts) => [...e2AbLookupEvidence(binding, arm, receipts).values()].map(e => e.status);
  const relabeled = structuredClone(arms.B.receipts); relabeled.find(r => r.value.phase === "call").value.scope = "tools";
  expect(evidence("B", relabeled)).toEqual(["inconsistent", "verified", "verified", "verified", "verified", "verified"]);
  expect(evidence("B", arms.B.receipts.filter((_, i) => i !== 1))).toEqual(Array(6).fill("inconsistent"));
  expect(evidence("A", arms.B.receipts)).toEqual(Array(6).fill("inconsistent"));
  const orphan = structuredClone(arms.B.receipts); orphan.find(r => r.value.phase === "call").value.callId.sha256 = "0".repeat(64);
  expect(evidence("B", orphan)[0]).toBe("inconsistent");
  const unsettled = scoreE2HistoryAb({ historyAb: binding, evaluator, arms: { ...arms, A: { ...arms.A, receipts: [] } } }).arms[0];
  expect(unsettled.overall).toMatchObject({ answers: 5, lookups: 0, lookupRate: null, lookupEvidence: { verified: 0, missing: 5 }, correctWithoutLookup: 0, correctLookupUnverified: 2, wrongWithoutLookup: 0, wrongLookupUnverified: 2 });
  expect(readE2AbReceipts(join(root, "absent"))).toEqual([]);
  // Omitted, the legacy receipt stream stays said-only and unsettled, byte for byte.
  const legacy = await abReceipts(root, "B", [{ id: exact, repeat: 1, scopes: ["said", "tools", "runs"] }], { allScopes: false, name: "legacy" });
  expect(legacy.map(r => [r.value.phase, Object.hasOwn(r.value, "scope"), Object.hasOwn(r.value, "tool")])).toEqual([["call", false, false], ["response", false, false]]);
  for (const bad of [{ ...arms, D: arms.A }, { A: arms.A, B: arms.B }, { ...arms, A: { ...arms.A, receipts: undefined } },
    { ...arms, B: { ...arms.B, answers: { ...arms.B.answers, answers: [...arms.B.answers.answers, answer(exact, 1, "x")] } } }])
    expect(() => scoreE2HistoryAb({ historyAb: binding, evaluator, arms: bad })).toThrow("E2_SCORING_INVALID");
  expect(() => scoreE2HistoryAb({ historyAb: { ...binding, rows: ["fictional-missing-key"], primary: [] }, evaluator, arms })).toThrow("E2_SCORING_INVALID");
});

it("keeps every legacy digest, policy, schedule, estimate, receipt and CLI path byte-identical to base when the mode is omitted", async () => {
  const base = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-ab-parity-base.json", import.meta.url)));
  const current = await e2ParityCases(rel => import(new URL(rel, pathToFileURL(join(ROOT, "scripts/lib/")).href).href));
  expect(Object.keys(current)).toEqual(Object.keys(base.cases));
  expect(current).toEqual(base.cases);
  expect(e2ReplayArm()).toBe("continuity");
  // The new modules are bound into the E2 code digest (future runs only).
  for (const file of ["scripts/lib/continuity-e2-ab.mjs", "scripts/lib/continuity-e2-ab-score.mjs", "packages/app/src/request-tools/conversation-history.ts", "scripts/lib/continuity-runner.mjs"])
    expect(E2_PROTOCOL_FILES).toContain(file);
  expect(e2ToolPolicies("history-ab")).toEqual(E2_AB_TOOL_POLICIES);
  expect(() => e2ToolPolicies("history-ab", "unified")).toThrow("e2_registration_invalid");
});
it("parses the explicit A/B selectors and refuses mixed or implicit ones", () => {
  const size = ["size", "--source", "s", "--protocol", "p", "--output", "o"];
  expect(parseE2Args([...size, "--replay-arm", "history-ab", "--history-ab", "b"])).toEqual({ command: "size", source: "s", protocol: "p", output: "o", "replay-arm": "history-ab", "history-ab": "b" });
  for (const bad of [[...size, "--replay-arm", "history-ab"], [...size, "--history-ab", "b"], [...size, "--replay-arm", "history-ab", "--history-ab", "b", "--summary", "faux-max"],
    [...size, "--replay-arm", "history-ab", "--history-ab", "b", "--history-surface", "unified"], [...size, "--replay-arm", "baseline", "--history-ab", "b"],
    ["ab-bind", "--replay", "r", "--snapshot", "s", "--branch", "x", "--checkpoint", "2", "--rows", "a", "--output", "o"], ["ab-score", "--binding", "b", "--run", "r", "--output", "o"]])
    expect(() => parseE2Args(bad)).toThrow("E2_ARGUMENTS_INVALID");
  expect(parseE2Args(["ab-bind", "--replay", "r", "--snapshot", "s", "--branch", "0", "--checkpoint", "2", "--rows", "a,b", "--primary", "a", "--output", "o"]))
    .toMatchObject({ branch: 0, checkpoint: 2, rows: ["a", "b"], primary: ["a"], arms: undefined });
  expect(parseE2Args(["run", "--summary", "real", "--replay-arm", "history-ab", "--registration", "r", "--sha256", "h", "--authorization", "a", "--credentials", "c", "--output", "o"])["replay-arm"]).toBe("history-ab");
  expect(e2AbSlotArm("B")).toBe("history-ab-B"); expect(e2AbArmOfSlot("history-ab-D")).toBeUndefined(); expect(e2AbArmOfSlot("replay")).toBeUndefined();
  expect(() => assertE2HistoryAbBinding({ schema: "continuity-e2-history-ab-v1" })).toThrow("E2_AB_BINDING_INVALID");
});

it("executes all three arms in one guarded run from the frozen snapshot through the shipping SDK, controller and A/B scorer", async () => {
  const root = await scratch(), rows = [AB_ROWS[0], AB_ROWS[2]];
  const deadlines = { ...E2_NATIVE_DEADLINES, phaseDeadlineMs: 120_000, childWatchdogMs: 120_000, runDeadlineMs: 360_000 };
  const f = await abNativeFixture(root, { rows, primary: [AB_ROWS[0]], deadlines });
  const received = []; let listenerError;
  const stream = events => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
  const text = value => { const item = { type: "message", id: "msg_fictional", role: "assistant", status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] };
    return stream([{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: value },
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: "fictional-response", status: "completed", output: [item], service_tier: "default", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } }]); };
  const call = (name, args, n) => { const item = { type: "function_call", id: `fc_fictional_${n}`, call_id: `call_fictional_${n}`, name, arguments: JSON.stringify(args), status: "completed" };
    return stream([{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }, { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item }, { type: "response.completed", response: { id: `fictional-response-${n}`, status: "completed", output: [item], service_tier: "default", usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } }]); };
  const prompt = body => { const user = body.input.filter(i => i.role === "user").at(-1); return typeof user.content === "string" ? user.content : user.content.map(p => p.text).join("\n"); };
  const server = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(Buffer.concat(chunks)) : Buffer.concat(chunks)); received.push(body);
      const tools = codexWireTools(body), exact = prompt(body).includes(AB_ROWS[0]), answered = body.input.some(i => i.type === "function_call_output");
      response.writeHead(200, { "content-type": "text/event-stream" });
      // The exact row looks up once and answers; the control row answers from context alone.
      response.end(exact && !answered && tools.length ? call(tools[0].name, { ...(tools[0].name.endsWith("ConversationHistory") ? {} : { scope: "said" }), action: "search", query: "Fictional", limit: 5 }, received.length)
        : text(exact ? "Fictional response" : "Fictional other"));
    } catch (error) { listenerError = error; response.writeHead(500).end(); }
  }); servers.push(server); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const preload = join(root, "preload.mjs"), profile = { root: ROOT, home: f.home, args: f.args, production: true, preload,
    endpoint: `http://127.0.0.1:${server.address().port}/codex/responses`, result: join(root, "result.json") };
  const profilePath = join(root, "profile.json"); await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(preload, `import{installE2NativeRealm}from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/__tests__/fixtures/e2-native-realm.mjs")).href)};await installE2NativeRealm(${JSON.stringify(profile)});`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(ROOT, "scripts/__tests__/fixtures/e2-native-supervisor.mjs"), profilePath], { cwd: ROOT, env: { HOME: f.home, PATH: "/usr/bin:/bin", LANG: "C", NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", data => { stderr += data; }); const [code] = await once(child, "close");
  const result = JSON.parse(await readFile(profile.result)); expect({ code, stderr, error: result.error }).toEqual({ code: 0, stderr: "", error: undefined });
  expect(listenerError).toBeUndefined();
  expect(result.report).toMatchObject({ replayArm: "history-ab", qualification: false, stop: "completed", schedule: { planned: 3, visited: 3, missing: 0, remaining: 0 } });
  expect(result.report.phases.map(p => [p.abArm, p.replayArm, p.qualification, p.terminal, p.score])).toEqual(E2_AB_ARMS.map(arm => [arm, "history-ab", false, "completed", null]));
  for (const phase of result.report.phases) expect(phase.summaryPresence).toMatchObject({ checked: 6, none: 6, pack: 0, native: 0 });
  // Six requests per arm, in A, B, C order; each offers its arm's exact tool description and no pack.
  expect(received).toHaveLength(18);
  for (const [i, body] of received.entries()) {
    const contract = f.pilot.registration.historyAb.arms[Math.floor(i / 6)], tools = codexWireTools(body);
    expect(JSON.stringify(body)).not.toContain("### Conversation continuity pack");
    expect(tools.map(t => [t.name.endsWith(contract.toolName), hash(t.description)])).toEqual([[true, contract.description.sha256]]);
    const output = body.input.find(item => item.type === "function_call_output");
    // Lookups read retained evidence from the relocated copy of the frozen store.
    if (output) { expect(output.output).toContain('"action":"search"'); expect(output.output).toMatch(/"count":[1-9]/u); }
  }
  for (const arm of E2_AB_ARMS) {
    const phase = JSON.parse(await readFile(join(f.args.outputRoot, "work", `history-ab-${arm}`, "history-ab.json")));
    expect(phase.relocation).toMatchObject({ relocated: true, metadata: 1 }); expect(phase.history).toEqual({ warnings: 0, codes: {} });
    await expect(readFile(join(f.args.outputRoot, "work", `history-ab-${arm}`, "lookups.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  // The frozen tree is unchanged and each arm restored its own copy under the run's output root.
  await assertE2AbSnapshot(f.ab.binding);
  for (const arm of E2_AB_ARMS) expect((await readdir(join(f.args.outputRoot, "work", `history-ab-${arm}`, "branch-0", "work"))).sort()).toEqual((await readdir(f.ab.snapshot)).sort());
  // Observational scoring over the three phase outputs.
  const bindingFile = join(root, "history-ab.json"); await writeFile(bindingFile, JSON.stringify(f.pilot.registration.historyAb), { mode: 0o600 });
  const out = [], err = [], scoreOutput = join(root, "ab-score");
  expect(await main(["ab-score", "--binding", bindingFile, "--run", f.args.outputRoot, "--keys", f.artifacts.keys.path, "--output", scoreOutput], { stdout: v => out.push(v), stderr: v => err.push(v) })).toBe(0);
  expect(err).toEqual([]);
  const score = JSON.parse(await readFile(join(scoreOutput, "ab-score.json")));
  for (const arm of score.arms) {
    expect(arm.overall).toMatchObject({ answers: 4, lookups: 2, lookupRate: 0.5, lookupEvidence: { verified: 4, missing: 0, inconsistent: 0 }, correct: 2, correctWithoutLookup: 0, wrongWithoutLookup: 2, wrongAfterLookup: 0, abstain: 0, missing: 0, byScope: { said: 2 } });
    expect(arm.primary).toMatchObject({ answers: 2, lookups: 2, correct: 2 });
  }
  expect(JSON.stringify(score)).not.toContain("Fictional other");
}, 400_000);
