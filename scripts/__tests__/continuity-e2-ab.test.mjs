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
import { renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { digest as hash } from "../lib/continuity-recorded-schema.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { productionModules } from "../lib/continuity-runner.mjs";
import { E2_AB_ARMS, E2_AB_TOOL_POLICIES, e2AbArmContract, e2AbProbeCounts, e2AbPhaseSchedule, e2AbSlotArm, e2AbFrozenCheckpoint, e2AbFrozenRecord, e2AbSizingBinding,
  assertE2AbSnapshot, assertE2HistoryAbBinding, estimateE2HistoryAb, normalizeE2AbSizing, runE2HistoryAb, runE2HistoryAbSizing,
  relocateE2AbWork, e2AbHistoryHealth, e2AbHistoryPreflight, e2AbCarriesRoot, assertE2AbRootAbsent, e2AbHistoryResultClass, E2_AB_STORE_UNAVAILABLE_CODES } from "../lib/continuity-e2-ab.mjs";
import { e2AbArmOfSlot, e2SlotHistorySurface } from "../lib/continuity-e2-history.mjs";
import { scoreE2HistoryAb, classifyE2AbAnswer, e2AbLookupEvidence, readE2AbReceipts, e2AbReceiptExpectations } from "../lib/continuity-e2-ab-score.mjs";
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
    expect(arm.history).toEqual({ warnings: 0, codes: {}, lookupErrors: {} });
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
  expect(unrelocated.report()).toEqual({ warnings: 1, codes: { history_artifact_root_mismatch: 1 }, lookupErrors: {} });
  // Relocated, the same copy names only its own root and History opens healthy with retained evidence.
  const relocation = await relocateE2AbWork(plain), healthy = e2AbHistoryHealth();
  expect(relocation).toMatchObject({ relocated: true, metadata: 1, artifactRefs: 0 });
  await expect(e2AbHistoryPreflight(modules, plain, healthy)).resolves.toMatchObject({ records: 15 });
  expect(healthy.report()).toEqual({ warnings: 0, codes: {}, lookupErrors: {} });
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
  // Escaped carriers: raw bytes no longer show the old root, but every JSON carrier is parsed and its
  // decoded whole-path strings are remapped. The decoded copy names only the new root.
  const encodings = [["escaped slashes", v => v.replaceAll("/", "\\/")], ["unicode escapes", v => v.replaceAll("/", "\\u002f")],
    ["upper-case unicode escapes", v => v.replaceAll("/", "\\u002F")], ["fully escaped", v => [...v].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")]];
  for (const [label, encode] of encodings) {
    const work = await copy(`escaped-${label.replaceAll(" ", "-")}`), summaries = (await readdir(join(work, "artifacts"))).filter(n => n.endsWith(".summary.json"));
    for (const name of summaries) {
      const path = join(work, "artifacts", name), original = await readFile(path, "utf8");
      expect(original).toContain(`"${frozenRoot}/`);
      await writeFile(path, original.replaceAll(`"${frozenRoot}`, `"${encode(frozenRoot)}`), { mode: 0o600 });
      expect(await readFile(path)).not.toContain(Buffer.from(frozenRoot));
      expect(JSON.stringify(JSON.parse(await readFile(path, "utf8")))).toContain(frozenRoot);
    }
    expect(await relocateE2AbWork(work)).toMatchObject({ relocated: true, metadata: 1 });
    for (const name of summaries) {
      const decoded = JSON.parse(await readFile(join(work, "artifacts", name), "utf8"));
      expect(JSON.stringify(decoded)).not.toContain(frozenRoot);
      expect(decoded.artifactPaths.length).toBeGreaterThan(0);
      for (const path of decoded.artifactPaths) expect(path.startsWith(`${work}/`)).toBe(true);
    }
    await expect(assertE2AbRootAbsent(work, frozenRoot)).resolves.toBeUndefined();
  }
  // Decoded occurrences that are not whole JSON path strings refuse, whatever their encoding:
  // an escaped partial path, JSON nested in a JSON string, a key, an escaped or percent-encoded
  // path in a non-JSON file, and an unparsable JSON file.
  const escaped = frozenRoot.replaceAll("/", "\\/");
  for (const [name, file, text] of [
    ["escaped-partial", join("artifacts", "fictional.json"), JSON.stringify({ note: "x" }).replace('"x"', `"see ${escaped}\\/artifacts"`)],
    ["nested-json", join("artifacts", "fictional.json"), JSON.stringify({ arguments: JSON.stringify({ path: `${frozenRoot}/artifacts/x` }).replaceAll("/", "\\/") })],
    ["json-key", join("artifacts", "fictional.json"), `{"${escaped}\\/artifacts":1}`],
    ["prose-escaped", "IDENTITY.md", `Fictional workspace ${escaped}\n`],
    ["prose-percent", "IDENTITY.md", `Fictional workspace file://${encodeURIComponent(frozenRoot)}\n`],
    ["prose-double-percent", "IDENTITY.md", `Fictional workspace ${encodeURIComponent(encodeURIComponent(frozenRoot))}\n`],
    ["torn-json", join("artifacts", "fictional.jsonl"), `{"cwd":"${escaped}"}\n{"torn":`],
  ]) {
    const work = await copy(`refuse-${name}`);
    await writeFile(join(work, file), text, { mode: 0o600 });
    expect(await readFile(join(work, file))).not.toContain(Buffer.from(frozenRoot));
    await expect(relocateE2AbWork(work), name).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
  }
  // SQLite text and JSON columns are decoded table by table, not byte-matched: escaped and nested JSON paths refuse.
  for (const [name, value] of [["sqlite-literal", `${frozenRoot}/artifacts/x`], ["sqlite-json-escaped", JSON.stringify({ path: `${frozenRoot}/x` }).replaceAll("/", "\\/")],
    ["sqlite-unicode", JSON.stringify({ path: `${frozenRoot}/x` }).replaceAll("/", "\\u002f")]]) {
    const work = await copy(name), sdb = open(work);
    try { sdb.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("fictional_note", value); } finally { sdb.close(); }
    await expect(relocateE2AbWork(work), name).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
  }
  const lock = await copy("sqlite-lock"), ldb = new DatabaseSync(join(lock, "history", ".locks", "tool-lifecycles-owner.sqlite"));
  try { ldb.exec("CREATE TABLE fictional_owner (note TEXT)"); ldb.prepare("INSERT INTO fictional_owner VALUES (?)").run(escaped); } finally { ldb.close(); }
  await expect(relocateE2AbWork(lock)).rejects.toThrow("E2_AB_RELOCATION_REFUSED");
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

it("decodes every path encoding the relocation proof scans for", () => {
  const from = "/fictional/frozen/root";
  for (const carried of [from, `x ${from}/y`, from.replaceAll("/", "\\/"), from.replaceAll("/", "\\u002f"), from.replaceAll("/", "\\u002F"), from.replaceAll("/", "\\\\\\/"),
    JSON.stringify(JSON.stringify({ p: from })), JSON.stringify(JSON.stringify(JSON.stringify({ p: from.replaceAll("/", "\\/") }))), encodeURIComponent(from),
    encodeURIComponent(encodeURIComponent(from)), encodeURIComponent(from).toLowerCase(), JSON.stringify(encodeURIComponent(from)).replaceAll("%", "\\u0025")])
    expect(e2AbCarriesRoot(carried, from), carried).toBe(true);
  for (const clean of ["/fictional/frozen", "/fictional/frozen/rooted".replace("/rooted", "/roo"), "\\/fictional\\/other\\/root", "%2Ffictional%2Fother", ""])
    expect(e2AbCarriesRoot(clean, from), clean).toBe(false);
});

it("latches only genuine History store unavailability; a model's lookup mistake is recorded and scored", async () => {
  const [{ handleConversationHistoryRequest }, { handleHistoryRequest }] = await Promise.all([import("../../packages/app/dist/request-tools/conversation-history.js"), import("../../packages/app/dist/request-tools/history.js")]);
  const scope = { conversationId: "fictional-conversation", logicalConversationId: "fictional-logical", runId: "fictional-run" };
  // A store that opens but holds no such record or readable continuity, and a reader that cannot open it at all.
  const empty = { getContinuity: () => ({ status: "unavailable", untrusted: true }), searchContinuity: () => ({ available: false, items: [] }), continuityGaps: () => ({ total: 0, items: [] }), latestContinuitySummary: () => undefined };
  const broken = new Proxy({}, { get: () => () => { throw new Error("fictional store failure"); } });
  const split = async (reader, input) => handleConversationHistoryRequest({ reader, ...scope }, input);
  const unified = async (reader, input) => handleHistoryRequest({ reader, artifactDir: "/fictional/absent/artifacts", ...scope, scopes: ["said", "tools", "runs"] }, input);
  const typo = { action: "get", recordId: "chr1_fictional-typo" }, absent = { action: "get", recordId: `chr1_${"f".repeat(43)}` };
  // [shipping result, class, the model-facing text carries the JSON envelope]
  const cases = [
    [await split(empty, typo), { lookup: "invalid_record" }], [await unified(empty, { scope: "said", ...typo }), { lookup: "invalid_record" }],
    [await unified(empty, { scope: "tools", action: "get", recordId: "" }), { lookup: "invalid_record" }], [await split(empty, absent), { lookup: "record_unavailable" }],
    [await split(empty, { action: "search", query: "" }), { lookup: "invalid_query" }], [await unified(empty, { scope: "nowhere", action: "search" }), { lookup: "invalid_scope" }],
    [await split(empty, { action: "get", cursor: "fictional" }), { lookup: "invalid_cursor" }],
    [await split(empty, { action: "search", query: "fictional" }), { latch: "history_store_unavailable" }],
    [await split(broken, { action: "search", query: "fictional" }), { latch: "history_unavailable" }], [await unified(broken, { scope: "said", ...absent }), { latch: "history_unavailable" }],
    [await unified(broken, { scope: "tools", action: "search", query: "fictional" }), { latch: "history_unavailable" }],
  ];
  expect(E2_AB_STORE_UNAVAILABLE_CODES).toEqual(["history_unavailable"]);
  let id = 0;
  const events = (result, structured, name = "mcp__mono-agent-history__History") => { const callId = `fictional-call-${++id}`; return [{ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name, input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: result.content, ...(structured ? { raw_result: { details: { raw: result } } } : {}) }] } }]; };
  for (const [result, expected] of cases) {
    expect(e2AbHistoryResultClass(result.structuredContent)).toEqual(expected);
    // The latch reads the handler's structured result as the turn records it, else the envelope in the model-facing text.
    for (const structured of [true, false]) {
      const health = e2AbHistoryHealth({ toolName: "History" });
      for (const event of events(result, structured)) health.observe(event);
      if (expected.latch) { expect(health.report().codes).toEqual({ [expected.latch]: 1 }); expect(() => health.assert()).toThrow("E2_HISTORY_DEGRADED"); }
      else { expect(health.report()).toEqual({ warnings: 0, codes: {}, lookupErrors: { [expected.lookup]: 1 } }); expect(() => health.assert()).not.toThrow(); }
    }
  }
  // Results of other tools are ignored; a store that stops opening latches after any History result.
  const other = e2AbHistoryHealth({ toolName: "History" });
  for (const event of events(cases.at(-1)[0], true, "mcp__fictional__Other")) other.observe(event);
  expect(other.report()).toEqual({ warnings: 0, codes: {}, lookupErrors: {} });
  const unreadable = e2AbHistoryHealth({ toolName: "ConversationHistory", verifyStore: () => { throw new Error("fictional unreadable store"); } });
  for (const event of events(cases[3][0], true, "mcp__mono-agent-conversation-history__ConversationHistory")) unreadable.observe(event);
  expect(unreadable.report()).toEqual({ warnings: 1, codes: { history_reader_unavailable: 1 }, lookupErrors: { record_unavailable: 1 } });
  expect(() => unreadable.assert()).toThrow("E2_HISTORY_DEGRADED");
  // Store and endpoint warnings always latch.
  for (const [message, code] of [["Tool history writer acquisition failed (history_artifact_root_mismatch); fictional.", "history_artifact_root_mismatch"],
    ["Continuity is degraded (sidecar_unavailable); fictional.", "sidecar_unavailable"], ["History endpoint could not start; retained evidence is unavailable this run.", "history_endpoint_unavailable"]]) {
    const warned = e2AbHistoryHealth(); warned.warn(message);
    expect(warned.report().codes).toEqual({ [code]: 1 }); expect(() => warned.assert()).toThrow("E2_HISTORY_DEGRADED");
  }
});

it("records a model's typo'd or missing lookup and finishes the probe, but refuses when the store itself becomes unreadable", async () => {
  const root = await scratch(), f = await abFrozenFixture(root), modules = await productionModules(ROOT);
  // Every scripted faux lookup becomes a model mistake: a malformed record id (A) or a well-formed id that does not exist (B).
  const mistaken = recordId => ({ ...modules, pi: { ...modules.pi, fauxToolCall: (name, args, options) => modules.pi.fauxToolCall(name, { ...(args.scope ? { scope: args.scope } : {}), action: "get", recordId }, options) } });
  const results = [];
  const typo = await runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "A", output: join(root, "typo"), modules: mistaken("chr1_fictional-typo"),
    onContext: c => results.push(...c.context.messages.filter(m => m.role === "toolResult")) });
  expect(typo.history).toEqual({ warnings: 0, codes: {}, lookupErrors: { invalid_record: 6 } });
  expect(typo.probes.map(p => p.requests)).toEqual([4, 4]);
  const missing = await runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "B", output: join(root, "missing"), modules: mistaken(`chr1_${"f".repeat(43)}`) });
  expect(missing.history).toEqual({ warnings: 0, codes: {}, lookupErrors: { record_unavailable: 6 } });
  expect(missing.probes.map(p => p.requests)).toEqual([4, 4]);
  // A typo'd unified scope: the shipping server answers invalid_scope, the probe finishes and every attempt is receipted as invalid.
  const scoped = { ...modules, pi: { ...modules.pi, fauxToolCall: (name, args, options) => modules.pi.fauxToolCall(name, { ...args, scope: "sayd" }, options) } };
  const typoScope = await runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "C", output: join(root, "typo-scope"), modules: scoped });
  expect(typoScope.history).toEqual({ warnings: 0, codes: {}, lookupErrors: { invalid_scope: 6 } });
  const scopeReceipts = readE2AbReceipts(join(root, "typo-scope", "probe-receipts")).map(r => r.value);
  expect(scopeReceipts.filter(v => v.phase === "call").map(v => v.scope)).toEqual(Array(6).fill("invalid"));
  expect(scopeReceipts.filter(v => v.phase === "response").map(v => v.isError)).toEqual(Array(6).fill(true));
  expect(scopeReceipts.filter(v => v.phase === "settled").map(v => [v.calls, v.responses, v.unanswered])).toEqual([[3, 3, 0], [3, 3, 0]]);
  // The model saw its own mistakes as tool errors; nothing was hidden.
  expect(results.length).toBeGreaterThan(0);
  expect(results.every(r => JSON.stringify(r.content).includes("invalid_record"))).toBe(true);
  // The store itself stops opening after the first request: the lookup result latches and the next request refuses.
  let moved = false;
  const contexts = [], error = await runE2HistoryAb({ source: f.trace.source, protocol: f.trace.protocol, historyAb: f.binding, frozen: f.frozen, arm: "B", output: join(root, "unreadable"),
    onContext: c => {
      contexts.push(c);
      if (moved) return; moved = true;
      const db = join(root, "unreadable", "branch-0", "work", "history", "tool-history", "tool-lifecycles.sqlite");
      renameSync(db, `${db}.fictional-moved`);
    } }).catch(e => e);
  expect(error?.code).toBe("E2_HISTORY_DEGRADED"); expect(contexts).toHaveLength(1);
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

// Fictional receipt streams written by the shipping all-scope receipt writer, bound like a paid phase.
const AB_TOOL = { A: "mcp__mono-agent-conversation-history__ConversationHistory", B: "mcp__mono-agent-history__History", C: "mcp__mono-agent-history__History" };
const AB_BINDING = { schema: "continuity-e2-history-ab-v1", frozen: { replay: { path: "/fictional/replay.json", sha256: "a".repeat(64) }, snapshot: "/fictional/snapshot", branch: 0, checkpoint: 2,
  receipt: { digest: "b".repeat(64), files: 3 } }, arms: E2_AB_ARMS.map(arm => ({ arm })), rows: AB_ROWS, primary: AB_PRIMARY };
// A minimal fictional registration: the expected receipt provenance comes from it alone.
const AB_PILOT = { descriptor: { fictional: true }, registration: { replayArm: "history-ab", historyAb: AB_BINDING,
  probeCounts: [0, 1, 2, 3].map(checkpoint => ({ checkpoint, questions: checkpoint === 2 ? AB_ROWS.length : 0, lookupRounds: 3 })),
  schedule: E2_AB_ARMS.map(arm => ({ kind: "replay", arm: `history-ab-${arm}`, slotId: hash(`fictional-slot-${arm}`), budgets: [{ checkpoint: 2, paidRole: "probe", model: SOL, maxRequests: 6 }] })) } };
const abSlot = arm => AB_PILOT.registration.schedule.find(s => s.arm === `history-ab-${arm}`).slotId;
async function abReceipts(root, arm, items, { allScopes = true, name = `receipts-${arm}`, slotId = abSlot(arm), registrationSha256 = digest(AB_PILOT) } = {}) {
  const output = join(root, name); await mkdir(output, { mode: 0o700 });
  const receipts = createE2ProbeReceipts({ output, slotId, registrationSha256, allScopes });
  let n = 0;
  for (const { id, repeat, scopes = [], settle = true } of items) {
    receipts.begin({ branch: 0, checkpoint: 2, repeat, itemOrdinal: AB_ROWS.indexOf(id) + 1, arm, rowId: id });
    for (const scope of scopes) {
      const callId = `fictional-call-${++n}`;
      receipts.observeRequest({ messages: [{ role: "user", content: "Fictional request" }] });
      // "invalid" is a typo'd scope and "unscoped" omits it: both fail the shipping scope check.
      const argument = arm === "A" || scope === "unscoped" ? {} : { scope: scope === "invalid" ? "sayd" : scope };
      receipts.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: callId, name: AB_TOOL[arm], input: { ...argument, action: "search", query: "Fictional", limit: 1 } }] } });
      receipts.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: callId, content: [{ type: "text", text: '{"action":"search","status":"available","count":1,"items":[]}' }] }] } });
    }
    receipts.observeRequest({ messages: [{ role: "user", content: "Fictional final request" }] });
    if (settle) receipts.settle();
  }
  await receipts.flush();
  return readE2AbReceipts(join(output, "probe-receipts"));
}
const abExpected = arm => ({ registrationSha256: digest(AB_PILOT), slotId: abSlot(arm), arm, branch: 0, checkpoint: 2 });
const abEvidence = (arm, receipts) => [...e2AbLookupEvidence(AB_BINDING, arm, receipts, abExpected(arm), 3).values()].map(e => e.status);
it("scores each answer with the frozen scorer and crosses it with receipt-derived lookups per arm, overall and primary", async () => {
  const root = await scratch(), binding = AB_BINDING, pilot = AB_PILOT;
  const evaluator = abKeys(), answer = (id, repeat, text, witness = true) => ({ id, repeat, text, witness, excludedSteps: [], excludedCoverage: [] });
  const [exact, referent, control] = AB_ROWS, answers = list => ({ schema: "continuity-e2-answers-v1", answers: list });
  const arms = {
    // A: correct after lookup, contaminated correct without lookup, wrong without lookup, abstain after lookup, wrong after lookup, missing.
    A: { answers: answers([answer(exact, 1, "Fictional response"), answer(exact, 2, "**Fictional response.**"), answer(referent, 1, "Fictional other"), answer(referent, 2, "I don't know"), answer(control, 1, "Fictional other")]),
      receipts: await abReceipts(root, "A", [{ id: exact, repeat: 1, scopes: ["said", "said"] }, { id: exact, repeat: 2 }, { id: referent, repeat: 1 }, { id: referent, repeat: 2, scopes: ["said"] }, { id: control, repeat: 1, scopes: ["said"] }]) },
    // B: every scope of the unified tool is attributed from its own call receipt.
    B: { answers: answers(AB_ROWS.flatMap(id => [1, 2].map(repeat => answer(id, repeat, "Fictional response")))),
      receipts: await abReceipts(root, "B", AB_ROWS.flatMap((id, i) => [1, 2].map(repeat => ({ id, repeat, scopes: [["said", "tools", "runs"][i]] })))) },
    // C: an inconclusive answer after a runs lookup, and an answer whose probe left no receipt at all.
    C: { answers: answers([answer(exact, 1, "Fictional response", false), answer(exact, 2, "Fictional response")]),
      receipts: await abReceipts(root, "C", [{ id: exact, repeat: 1, scopes: ["runs"] }, { id: exact, repeat: 2, scopes: [], settle: false }]) },
  };
  const report = scoreE2HistoryAb({ pilot, evaluator, arms });
  expect(report).toMatchObject({ schema: "continuity-e2-ab-score-v1", qualification: false, gate: "not-applicable-observational", lookupSource: "validated-probe-receipts", registrationSha256: digest(pilot),
    rows: 3, primaryRows: 1, mapping: { ratePass: "correct", blocking: "wrong", rateMiss: "abstain" } });
  const [a, b, c] = report.arms;
  expect(report.arms.map(x => x.slotId)).toEqual(E2_AB_ARMS.map(abSlot));
  expect(a.overall).toMatchObject({ answers: 5, lookups: 3, lookupRate: 0.6, lookupEvidence: { verified: 5, missing: 0, inconsistent: 0 }, correct: 2, correctWithoutLookup: 1, wrongWithoutLookup: 1, wrongAfterLookup: 1, abstain: 1, missing: 1, byScope: { said: 3, tools: 0, runs: 0 } });
  expect(a.primary).toMatchObject({ answers: 2, lookups: 1, correct: 2, correctWithoutLookup: 1, wrongWithoutLookup: 0, missing: 0 });
  expect(a.items.find(i => i.id === exact && i.repeat === 1)).toMatchObject({ classification: "ratePass", outcome: "correct", lookupEvidence: "verified", lookup: true, scopes: { said: 2, tools: 0, runs: 0 } });
  expect(b.overall).toMatchObject({ answers: 6, lookups: 6, lookupRate: 1, correct: 6, correctWithoutLookup: 0, byScope: { said: 2, tools: 2, runs: 2 } });
  // Without a witness the frozen scorer is inconclusive; an unreceipted probe is unverified, never "no lookup".
  expect(c.overall).toMatchObject({ answers: 2, correct: 1, correctWithoutLookup: 0, correctLookupUnverified: 1, missing: 4, other: { inconclusive: 1 }, byScope: { runs: 1 },
    lookups: 1, lookupRate: 1, lookupEvidence: { verified: 1, missing: 1, inconsistent: 0 } });
  expect(c.items.find(i => i.id === exact && i.repeat === 2)).toMatchObject({ outcome: "correct", lookupEvidence: "missing", lookup: null, scopes: null });
  expect(classifyE2AbAnswer(answer(exact, 2, "Fictional response"), evaluator.keys.find(k => k.id === exact))).toBe("ratePass");
  expect(JSON.stringify(report)).not.toContain("Fictional other");
  // Inconsistent receipts: a call whose recorded scope contradicts its arguments, a lost entry, another arm's stream,
  // a response without its call, or no receipts at all. None of them can read as "no lookup".
  const relabeled = structuredClone(arms.B.receipts); relabeled.find(r => r.value.phase === "call").value.scope = "tools";
  expect(abEvidence("B", relabeled)).toEqual(["inconsistent", "verified", "verified", "verified", "verified", "verified"]);
  expect(abEvidence("B", arms.B.receipts.filter((_, i) => i !== 1))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("A", arms.B.receipts)).toEqual(Array(6).fill("inconsistent"));
  const orphan = structuredClone(arms.B.receipts); orphan.find(r => r.value.phase === "call").value.callId.sha256 = "0".repeat(64);
  expect(abEvidence("B", orphan)[0]).toBe("inconsistent");
  const unsettled = scoreE2HistoryAb({ pilot, evaluator, arms: { ...arms, A: { ...arms.A, receipts: [] } } }).arms[0];
  expect(unsettled.overall).toMatchObject({ answers: 5, lookups: 0, lookupRate: null, lookupEvidence: { verified: 0, missing: 5 }, correctWithoutLookup: 0, correctLookupUnverified: 2, wrongWithoutLookup: 0, wrongLookupUnverified: 2 });
  expect(readE2AbReceipts(join(root, "absent"))).toEqual([]);
  // Omitted, the legacy receipt stream stays said-only and unsettled, byte for byte.
  const legacy = await abReceipts(root, "B", [{ id: exact, repeat: 1, scopes: ["said", "tools", "runs", "invalid", "unscoped"] }], { allScopes: false, name: "legacy" });
  expect(legacy.map(r => [r.value.phase, Object.hasOwn(r.value, "scope"), Object.hasOwn(r.value, "tool")])).toEqual([["call", false, false], ["response", false, false]]);
  for (const bad of [{ ...arms, D: arms.A }, { A: arms.A, B: arms.B }, { ...arms, A: { ...arms.A, receipts: undefined } },
    { ...arms, B: { ...arms.B, answers: { ...arms.B.answers, answers: [...arms.B.answers.answers, answer(exact, 1, "x")] } } }])
    expect(() => scoreE2HistoryAb({ pilot, evaluator, arms: bad })).toThrow("E2_SCORING_INVALID");
  const unkeyed = structuredClone(pilot); unkeyed.registration.historyAb = { ...binding, rows: ["fictional-missing-key"], primary: [] }; unkeyed.registration.probeCounts[2].questions = 1;
  expect(() => scoreE2HistoryAb({ pilot: unkeyed, evaluator, arms })).toThrow("E2_SCORING_INVALID");
  // The expectations come from the registration and must be unambiguous.
  for (const mutate of [r => { r.replayArm = "continuity"; }, r => { r.schedule.pop(); }, r => { r.schedule.push({ ...r.schedule[0] }); }, r => { r.probeCounts[1].questions = 1; },
    r => { r.schedule[1].budgets[0].checkpoint = 1; }, r => { r.probeCounts[2].questions = 2; }]) {
    const bent = structuredClone(pilot); mutate(bent.registration);
    expect(() => e2AbReceiptExpectations(bent)).toThrow("E2_SCORING_INVALID");
  }
});

it("refuses forged or foreign receipts: provenance comes from the registration and every capture is recomputed", async () => {
  const root = await scratch(), [exact] = AB_ROWS;
  const stream = await abReceipts(root, "B", AB_ROWS.flatMap(id => [1, 2].map(repeat => ({ id, repeat, scopes: ["said"] }))));
  expect(abEvidence("B", stream)).toEqual(Array(6).fill("verified"));
  const forge = (mutate, receipts = stream) => { const copy = structuredClone(receipts); for (const r of copy) mutate(r.value); return copy; };
  // Checkpoint 999, a foreign slot, a foreign registration, an absent registration binding (offline sizing) and another branch.
  expect(abEvidence("B", forge(v => { v.checkpoint = 999; }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("B", forge(v => { v.slotId = hash("fictional-foreign-slot"); }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("B", forge(v => { v.slotId = abSlot("A"); }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("B", forge(v => { v.registrationSha256 = hash("fictional-foreign-registration"); }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("B", forge(v => { delete v.registrationSha256; }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("B", forge(v => { v.branch = 1; }))).toEqual(Array(6).fill("inconsistent"));
  const foreign = await abReceipts(root, "B", [{ id: exact, repeat: 1, scopes: ["said"] }], { name: "foreign", slotId: hash("fictional-foreign-slot"), registrationSha256: hash("fictional-foreign-registration") });
  expect(abEvidence("B", foreign)).toEqual(Array(6).fill("inconsistent"));
  // B receipts relabelled as C keep the B slot: the C expectations refuse them, as they refuse B's unrelabelled stream.
  expect(abEvidence("C", forge(v => { v.arm = "C"; }))).toEqual(Array(6).fill("inconsistent"));
  expect(abEvidence("C", stream)).toEqual(Array(6).fill("inconsistent"));
  // A said lookup rewritten as runs, keeping the original hashes and lengths ("said" and "runs" are both four bytes).
  const call = stream.find(r => r.value.phase === "call").value;
  expect(call.arguments.text).toContain('"scope":"said"');
  const asRuns = v => { if (v.phase !== "settled" && v.callId.sha256 === call.callId.sha256) { v.arguments.text = v.arguments.text.replace('"scope":"said"', '"scope":"runs"'); v.scope = "runs"; } };
  const rewritten = forge(asRuns);
  expect(rewritten.find(r => r.value.phase === "call").value.arguments).toMatchObject({ bytes: call.arguments.bytes, sha256: call.arguments.sha256 });
  expect(abEvidence("B", rewritten)).toEqual(["inconsistent", "verified", "verified", "verified", "verified", "verified"]);
  // Scored, the forged lookup is unverified: it is never counted as a runs lookup.
  const none = { answers: { schema: "continuity-e2-answers-v1", answers: [] }, receipts: [] };
  const all = { schema: "continuity-e2-answers-v1", answers: AB_ROWS.flatMap(id => [1, 2].map(repeat => ({ id, repeat, text: "Fictional response", witness: true, excludedSteps: [], excludedCoverage: [] }))) };
  const forged = scoreE2HistoryAb({ pilot: AB_PILOT, evaluator: abKeys(), arms: { A: none, B: { answers: all, receipts: rewritten }, C: none } }).arms[1].overall;
  expect(forged).toMatchObject({ lookups: 5, lookupEvidence: { verified: 5, missing: 0, inconsistent: 1 }, correctLookupUnverified: 1, byScope: { said: 5, tools: 0, runs: 0 } });
  // Other forged captures: a truncation flag to skip the argument check, changed result text, a renamed tool or call id, a moved request ordinal.
  const first = v => v.phase !== "settled" && v.callId.sha256 === call.callId.sha256;
  for (const mutate of [v => { if (first(v)) { v.arguments.truncated = true; v.scope = "runs"; } }, v => { if (first(v) && v.phase === "response") v.response.text = v.response.text.replace("available", "availablX"); },
    v => { if (first(v)) v.tool.text = "mcp__mono-agent-history__Hist0ry"; }, v => { if (first(v)) v.callId.text = `${v.callId.text}x`; },
    v => { if (first(v)) v.requestOrdinal = 4; }, v => { if (first(v) && v.phase === "response") v.metadata.text = `${v.metadata.text} `; },
    v => { if (first(v) && v.phase === "response") v.requestOrdinal = 2; }, v => { if (first(v)) v.extra = true; }])
    expect(abEvidence("B", forge(mutate))[0]).toBe("inconsistent");
  // Probes appear once each, in registered order, each closed by its settled receipt.
  const swapped = structuredClone(stream), [p1, p2] = [swapped.slice(0, 3), swapped.slice(3, 6)];
  const reordered = [...p2, ...p1, ...swapped.slice(6)].map((r, i) => ({ ...r, ordinal: i + 1 }));
  expect(abEvidence("B", reordered)).toEqual(Array(6).fill("inconsistent"));
  const repeated = [...stream, ...stream.slice(0, 3)].map((r, i) => ({ ...r, ordinal: i + 1 }));
  expect(abEvidence("B", repeated)).toEqual(Array(6).fill("inconsistent"));
  const unclosed = stream.filter((r, i) => i !== 2).map((r, i) => ({ ...r, ordinal: i + 1 }));
  expect(abEvidence("B", unclosed)).toEqual(Array(6).fill("inconsistent"));
});

it("records a unified History call that fails scope validation as a lookup attempt, never as no lookup", async () => {
  const root = await scratch(), [exact, referent, control] = AB_ROWS;
  const answer = (id, repeat, text) => ({ id, repeat, text, witness: true, excludedSteps: [], excludedCoverage: [] });
  // Typo'd and missing scopes on C; a valid lookup alongside an invalid attempt; one probe with no call at all.
  const receipts = await abReceipts(root, "C", [{ id: exact, repeat: 1, scopes: ["invalid"] }, { id: exact, repeat: 2, scopes: ["unscoped", "said"] },
    { id: referent, repeat: 1, scopes: ["invalid", "invalid"] }, { id: referent, repeat: 2 }, { id: control, repeat: 1, scopes: ["runs"] }, { id: control, repeat: 2 }]);
  const calls = receipts.map(r => r.value).filter(v => v.phase === "call");
  expect(calls.map(v => v.scope)).toEqual(["invalid", "invalid", "said", "invalid", "invalid", "runs"]);
  expect(calls.every(v => v.registrationSha256 === digest(AB_PILOT) && v.slotId === abSlot("C") && v.arm === "C" && v.checkpoint === 2)).toBe(true);
  const evidence = [...e2AbLookupEvidence(AB_BINDING, "C", receipts, abExpected("C"), 3).values()];
  expect(evidence.map(e => e.status)).toEqual(Array(6).fill("verified"));
  expect(evidence.map(e => e.scopes.invalid)).toEqual([1, 1, 2, 0, 0, 0]);
  const none = { answers: { schema: "continuity-e2-answers-v1", answers: [] }, receipts: [] };
  const answers = { schema: "continuity-e2-answers-v1", answers: [answer(exact, 1, "Fictional other"), answer(exact, 2, "Fictional response"), answer(referent, 1, "Fictional other"),
    answer(referent, 2, "Fictional other"), answer(control, 1, "Fictional response"), answer(control, 2, "Fictional response")] };
  const c = scoreE2HistoryAb({ pilot: AB_PILOT, evaluator: abKeys(), arms: { A: none, B: none, C: { answers, receipts } } }).arms[2];
  // A failed attempt is a lookup: wrong after an invalid attempt is "wrong after lookup", never "wrong without lookup".
  expect(c.items.find(i => i.id === exact && i.repeat === 1)).toMatchObject({ outcome: "wrong", lookup: true, scopes: { said: 0, tools: 0, runs: 0, invalid: 1 } });
  expect(c.overall).toMatchObject({ answers: 6, lookups: 4, lookupEvidence: { verified: 6 }, wrongAfterLookup: 2, wrongWithoutLookup: 1, correctWithoutLookup: 1, byScope: { said: 1, tools: 0, runs: 1, invalid: 3 } });
  // The recorded status is re-derived from the integrity-checked arguments: it cannot be relabelled either way.
  const relabel = (from, to) => { const copy = structuredClone(receipts); for (const r of copy) if (r.value.phase !== "settled" && r.value.scope === from) { r.value.scope = to; break; } return copy; };
  expect(e2AbLookupEvidence(AB_BINDING, "C", relabel("invalid", "said"), abExpected("C"), 3).get(`${exact}\u0000${1}`).status).toBe("inconsistent");
  expect(e2AbLookupEvidence(AB_BINDING, "C", relabel("runs", "invalid"), abExpected("C"), 3).get(`${control}\u0000${1}`).status).toBe("inconsistent");
  // The split arm has no scope to fail: ConversationHistory is always said.
  const split = await abReceipts(root, "A", [{ id: exact, repeat: 1, scopes: ["invalid"] }], { name: "split-invalid" });
  expect(split.map(r => r.value).filter(v => v.phase === "call").map(v => v.scope)).toEqual(["said"]);
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
  expect(parseE2Args(["ab-score", "--registration", "r", "--sha256", "h", "--run", "d", "--keys", "k", "--output", "o"])).toEqual({ command: "ab-score", registration: "r", sha256: "h", run: "d", keys: "k", output: "o" });
  expect(() => parseE2Args(["ab-score", "--registration", "r", "--run", "d", "--keys", "k", "--output", "o"])).toThrow("E2_ARGUMENTS_INVALID");
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
    expect(phase.relocation).toMatchObject({ relocated: true, metadata: 1 }); expect(phase.history).toEqual({ warnings: 0, codes: {}, lookupErrors: {} });
    await expect(readFile(join(f.args.outputRoot, "work", `history-ab-${arm}`, "lookups.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  // The frozen tree is unchanged and each arm restored its own copy under the run's output root.
  await assertE2AbSnapshot(f.ab.binding);
  for (const arm of E2_AB_ARMS) expect((await readdir(join(f.args.outputRoot, "work", `history-ab-${arm}`, "branch-0", "work"))).sort()).toEqual((await readdir(f.ab.snapshot)).sort());
  // Observational scoring over the three phase outputs.
  // The scorer binds the registration by its sha256 and the keys by the registration's own binding.
  const out = [], err = [], io = { stdout: v => out.push(v), stderr: v => err.push(v) };
  const abScore = (output, { sha256 = f.args.registrationSha256, keys = f.artifacts.keys.path } = {}) => main(["ab-score", "--registration", f.args.registrationPath, "--sha256", sha256,
    "--run", f.args.outputRoot, "--keys", keys, "--output", join(root, output)], io);
  expect(await abScore("ab-score-wrong-sha", { sha256: "0".repeat(64) })).toBe(1); expect(err.pop()).toBe("E2_SCORING_INVALID\n");
  const otherKeys = join(root, "fictional-other-keys.json"); await writeFile(otherKeys, JSON.stringify({ ...f.keys, keys: f.keys.keys.slice(1) }), { mode: 0o600 });
  expect(await abScore("ab-score-other-keys", { keys: otherKeys })).toBe(1); expect(err.pop()).toBe("E2_SCORING_INVALID\n");
  expect(await abScore("ab-score")).toBe(0);
  expect(err).toEqual([]);
  const registered = JSON.parse(await readFile(f.args.registrationPath));
  const score = JSON.parse(await readFile(join(root, "ab-score", "ab-score.json")));
  expect(score.registrationSha256).toBe(digest(registered));
  expect(score.arms.map(a => a.slotId)).toEqual(registered.registration.schedule.map(s => s.slotId));
  // Every paid-path receipt carries the registration's canonical digest and its arm's slot.
  for (const [i, arm] of E2_AB_ARMS.entries()) {
    const receipts = readE2AbReceipts(join(f.args.outputRoot, "work", `history-ab-${arm}`, "probe-receipts"));
    expect(receipts.length).toBeGreaterThan(0);
    for (const { value } of receipts) expect(value).toMatchObject({ registrationSha256: digest(registered), slotId: registered.registration.schedule[i].slotId, arm, checkpoint: 2, branch: 0 });
  }
  for (const arm of score.arms) {
    expect(arm.overall).toMatchObject({ answers: 4, lookups: 2, lookupRate: 0.5, lookupEvidence: { verified: 4, missing: 0, inconsistent: 0 }, correct: 2, correctWithoutLookup: 0, wrongWithoutLookup: 2, wrongAfterLookup: 0, abstain: 0, missing: 0, byScope: { said: 2 } });
    expect(arm.primary).toMatchObject({ answers: 2, lookups: 2, correct: 2 });
  }
  expect(JSON.stringify(score)).not.toContain("Fictional other");
}, 400_000);
