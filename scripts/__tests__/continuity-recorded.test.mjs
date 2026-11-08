import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import subprocess from "node:child_process";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import ts from "typescript";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { readRecordedSource, readRecordedManifest, importRecorded, privateOutput } from "../lib/continuity-recorded-import.mjs";
import { validateSource, emptyQuestions, emptyKeys, validateQuestions, validateKeys, INVENTORY_FIELDS } from "../lib/continuity-recorded-schema.mjs";
import { createRecordedQueue, recordedDefinitions, startRecordedTools } from "../lib/continuity-recorded-tools.mjs";
import { main, parseArgs } from "../continuity-import-recorded.mjs";
import { snapshots, tool, assistant, result, CONVERSATION, AT } from "./fixtures/continuity-recorded/snapshots.mjs";

const cleanup = [];
function scratch() { const dir = mkdtempSync(join(tmpdir(), "recorded-fictional-")); chmodSync(dir, 0o700); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); });
const read = f => readRecordedSource(f.manifest, CONVERSATION);
const gaps = source => source.coverage.map(g => g.code);
function sql(f, command) { const db = new DatabaseSync(f.web); try { db.exec(command); } finally { db.close(); } }

it("exports only count inventory and keeps private source, questions and keys isolated", async () => {
  const dir = scratch(), f = snapshots(dir), before = readFileSync(f.web), output = join(dir, "imported");
  const inventory = await importRecorded({ manifest: f.manifest, conversation: CONVERSATION, output });
  expect(Object.keys(inventory)).toEqual(["schema", ...INVENTORY_FIELDS]);
  expect(INVENTORY_FIELDS.every(k => Number.isSafeInteger(inventory[k]))).toBe(true);
  const source = JSON.parse(readFileSync(join(output, "source.json"), "utf8"));
  expect(source).toMatchObject({ schema: "continuity-recorded-source-v1", dataClass: "private-recorded", conversationId: CONVERSATION });
  expect(source.web.messages[1].parts_json).toBe(JSON.stringify([tool()]));
  expect(JSON.stringify(source)).not.toMatch(/reader-questions|evaluator-keys/);
  expect(JSON.parse(readFileSync(join(output, "reader-questions.json")))).toEqual(emptyQuestions());
  expect(JSON.parse(readFileSync(join(output, "evaluator-keys.json")))).toEqual(emptyKeys());
  expect(statSync(output).mode & 0o777).toBe(0o700);
  for (const name of readdirSync(output)) expect(statSync(join(output, name)).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.web)).toEqual(before);
  expect(readdirSync(dir).some(n => /-(wal|shm|journal)$/.test(n))).toBe(false);
  await expect(importRecorded({ manifest: f.manifest, conversation: CONVERSATION, output })).rejects.toMatchObject({ code: "EEXIST" });
  expect(JSON.parse(readFileSync(join(output, "source.json")))).toEqual(source);
  expect(() => validateSource({ ...source, questions: [] })).toThrow("INVALID_RECORDED_SOURCE");
  expect(() => validateSource({ ...source, evaluatorKeys: [] })).toThrow("INVALID_RECORDED_SOURCE");
  expect(() => validateQuestions({ ...emptyQuestions(), questions: ["Fictional question"] })).toThrow();
  expect(() => validateKeys({ ...emptyKeys(), keys: [{ answer: "fictional" }] })).toThrow();
  expect(validateQuestions(emptyQuestions())).toEqual(emptyQuestions()); expect(validateKeys(emptyKeys())).toEqual(emptyKeys());
});

it("preserves steers, partial/cancelled turns, failures, attachments, markers and telemetry verbatim", async () => {
  const parts = [{ type: "text", text: "Partial fictional answer." }, tool("failed", "Fictional denied result", { status: "error" }),
    { type: "steer", inputId: "steer-one", messageId: "user-steer", text: "Keep the fictional note private.", receivedAt: AT },
    { type: "attachment", id: "attachment-one", storedUrl: "https://fictional.invalid/reference", name: "fictional-note.pdf" },
    { type: "conversation-marker", kind: "compaction", message: "Fictional boundary." },
    { type: "telemetry", event: "runtime_telemetry", data: { type: "runtime_telemetry", kind: "session_boundary", data: { kind: "resume_replay", reason: "model_change" } } }];
  const { source, inventory } = await read(snapshots(scratch(), { parts, status: "cancelled" }));
  expect(source.web.turns[0].status).toBe("cancelled"); expect(source.web.messages[1].parts_json).toBe(JSON.stringify(parts));
  expect(inventory).toMatchObject({ partialTurns: 1, failedTools: 1, attachments: 1, markers: 1, telemetry: 1, steers: 1 });
  expect(gaps(source)).toEqual(expect.arrayContaining(["partial_turn", "attachment_bytes_unavailable"]));
  expect(source.coverage.find(g => g.code === "attachment_bytes_unavailable").blocking).toBe(true);
});

it.each(["running", "failed", "cancelled"])("never coerces a %s turn into complete", async status => {
  const { source, inventory } = await read(snapshots(scratch(), { status }));
  expect(source.web.turns[0].status).toBe(status); expect(inventory.partialTurns).toBe(1);
});

it("reconciles matching, conflicting, web-only, sidecar-only and representation-different calls without concatenating", async () => {
  const matched = tool("matched"), conflict = tool("conflict"), webOnly = tool("web-only"), representation = tool("representation");
  const f = snapshots(scratch(), { parts: [matched, conflict, webOnly, representation], sidecar: [matched, { ...conflict, result: "Different fictional result" }, tool("sidecar-only"), { ...representation, result: [{ type: "text", text: representation.result }] }] });
  const before = readFileSync(f.value.sidecar), { source, inventory } = await read(f);
  expect(source.tools).toHaveLength(4);
  expect(source.tools.map(t => t.reconciliation)).toEqual(["matched", "conflict", "web_only", "representation_difference"]);
  expect(inventory).toMatchObject({ matched: 1, conflicts: 1, webOnly: 1, sidecarOnly: 1, representationDifferences: 1 });
  expect(gaps(source)).toContain("sidecar_only_tool"); expect(readFileSync(f.value.sidecar)).toEqual(before);
});

it("retains clipping, malformed records and missing tool results as explicit blocking gaps", async () => {
  const clipped = tool("clipped", "Fictional preview", { resultTruncated: true, argsTruncated: true }), missing = tool("missing"); delete missing.result;
  const { source, inventory } = await read(snapshots(scratch(), { parts: [clipped, missing, null, { type: "tool-call", toolName: "Read" }], sidecar: [{ ...clipped, truncated: true }] }));
  expect(inventory).toMatchObject({ truncated: 2, missingResults: 1, malformedParts: 2 });
  expect(gaps(source)).toEqual(expect.arrayContaining(["source_truncated", "sidecar_truncated", "result_missing", "malformed_part", "malformed_tool"]));
  expect(() => createRecordedQueue(source)).toThrow("RECORDED_TOOL_COVERAGE_GAP");
  const malformed = await read(snapshots(scratch(), { malformed: true }));
  expect(malformed.inventory.malformedParts).toBe(1); expect(malformed.source.web.messages[1].parts_json).toContain("{bad fictional");
});

it("turns subagents into parent-visible assistant outcomes without queueing children or Agent calls", async () => {
  const delegated = { type: "subagent", toolCallId: "delegation", name: "fictional-reviewer", status: "complete", result: "Fictional parent-visible report.", calls: [tool("child", "Fictional child output", { toolName: "Bash" })] };
  const native = tool("delegation", delegated.result, { toolName: "Agent" });
  const { source, inventory } = await read(snapshots(scratch(), { parts: [delegated], journal: [assistant([native]), result(native)] }));
  expect(inventory).toMatchObject({ tools: 0, subagentOutcomes: 1 }); expect(source.outcomes[0]).toMatchObject({ role: "assistant", childrenReplayed: false, result: delegated.result });
  expect(JSON.stringify(source.web)).toContain("child"); expect(source.tools).toEqual([]);
});

it("uses native assistant steps, retains timestamps and boundaries, and binds repeated identical calls FIFO", async () => {
  const one = tool("one", "First fictional result"), two = tool("two", "Second fictional result");
  const journal = [assistant([one]), result(one), { kind: "model_change", payload: { before: "fictional-small", after: "fictional-large" } }, assistant([two]), result(two)];
  const { source, inventory } = await read(snapshots(scratch(), { parts: [one, two], journal }));
  expect(inventory).toMatchObject({ steps: 2, ambiguousParallelGroups: 0, journalRecords: 5 });
  expect(source.steps.map(s => s.calls)).toEqual([[0], [1]]); expect(source.journal.records[0].timestamp).toBe(Date.parse(AT));
  const queue = createRecordedQueue(source);
  expect(queue.dispatch(one.toolName, one.args).content[0].text).toBe(one.result);
  expect(queue.dispatch(two.toolName, two.args).content[0].text).toBe(two.result);
  expect(queue.report()).toMatchObject({ pending: 0, served: [0, 1], identity: "name-canonical-arguments-fifo" });
  expect(() => queue.dispatch(one.toolName, one.args)).toThrow("RECORDED_UNEXPECTED_CALL");
});

it.each([false, true])("checks parallel duplicate keys with different results: %s", async different => {
  const one = tool("one"), two = tool("two", different ? "Different fictional parallel result" : one.result);
  const { source, inventory } = await read(snapshots(scratch(), { parts: [one, two], journal: [assistant([one, two]), result(two), result(one)] }));
  expect(inventory.ambiguousParallelGroups).toBe(different ? 1 : 0);
  if (different) {
    expect(gaps(source)).toContain("ambiguous_parallel_results");
    expect(() => createRecordedQueue(source)).toThrow("RECORDED_AMBIGUOUS_PARALLEL_GROUP");
    source.steps[0].gaps = []; source.coverage = [];
    expect(() => createRecordedQueue(source)).toThrow("RECORDED_AMBIGUOUS_PARALLEL_GROUP");
    expect(createRecordedQueue(source, { excludedSteps: [0] }).report().pending).toBe(0);
  } else {
    const queue = createRecordedQueue(source);
    expect(queue.dispatch("Read", one.args)).toEqual(queue.dispatch("Read", two.args));
  }
});

it("refuses unexpected dispatch and future-step calls without consuming recorded entries", async () => {
  const one = tool("one"), two = tool("two", "Fictional second", { args: { path: "fictional-other.txt" } });
  const { source } = await read(snapshots(scratch(), { parts: [one, two], journal: [assistant([one]), result(one), assistant([two]), result(two)] }));
  const queue = createRecordedQueue(source);
  expect(() => queue.dispatch("Bash", { command: "fictional-denied" })).toThrow("RECORDED_UNEXPECTED_CALL");
  expect(() => queue.dispatch(two.toolName, two.args)).toThrow("RECORDED_UNEXPECTED_CALL"); expect(queue.report().pending).toBe(2);
  expect(queue.dispatch("Read", { path: "fictional-note.txt" }).content[0].text).toBe(one.result);
});

it("rejects definition collisions rather than renaming original names", async () => {
  const { source } = await read(snapshots(scratch()));
  expect(() => recordedDefinitions(source, undefined, ["Read"])).toThrow("RECORDED_TOOL_COLLISION");
  const definition = { name: "Read", inputSchema: { type: "object", properties: { path: { type: "string" } } } };
  expect(recordedDefinitions(source, [definition])).toEqual([definition]);
  expect(() => recordedDefinitions(source, [definition, definition])).toThrow("RECORDED_TOOL_DEFINITIONS_REFUSED");
  expect(() => recordedDefinitions(source, [{ ...definition, execute: "forbidden" }])).toThrow("RECORDED_TOOL_DEFINITIONS_REFUSED");
});

it("refuses inside-root, symlinked-root, public-parent and existing output destinations", async () => {
  const dir = scratch(); symlinkSync(ROOT, join(dir, "root-link"));
  for (const path of [join(ROOT, ".worklab-tmp/recorded-denied"), join(dir, "root-link", "recorded-denied")]) expect(() => privateOutput(path)).toThrow("RECORDED_OUTPUT_REFUSED");
  const publicParent = join(dir, "public"); mkdirSync(publicParent, { mode: 0o755 }); chmodSync(publicParent, 0o755);
  expect(() => privateOutput(join(publicParent, "output"))).toThrow("RECORDED_OUTPUT_REFUSED");
  const f = snapshots(dir); expect(() => privateOutput(dir, [f.web])).toThrow("RECORDED_OUTPUT_REFUSED");
});

it("refuses unsupported schemas, non-standalone WAL snapshots and absent conversations without writes", async () => {
  const dir = scratch(), f = snapshots(dir);
  await expect(readRecordedSource(f.manifest, "web:fictional-absent")).rejects.toThrow("RECORDED_CONVERSATION_NOT_FOUND");
  sql(f, "PRAGMA user_version=42"); const before = readFileSync(f.web);
  await expect(read(f)).rejects.toThrow("UNSUPPORTED_WEB_SCHEMA"); expect(readFileSync(f.web)).toEqual(before);
  sql(f, "PRAGMA user_version=43"); writeFileSync(f.web + "-wal", "Fictional WAL marker");
  await expect(read(f)).rejects.toThrow("NON_STANDALONE_SNAPSHOT");
});

it("keeps CLI stdout counts-only and all failures content-free", async () => {
  const dir = scratch(), f = snapshots(dir), stdout = vi.fn(), stderr = vi.fn();
  expect(await main(["--manifest", f.manifest, "--conversation", CONVERSATION, "--output", join(dir, "output")], { stdout, stderr })).toBe(0);
  expect(stdout.mock.calls[0][0]).not.toContain(CONVERSATION); expect(stderr).not.toHaveBeenCalled();
  stdout.mockClear(); expect(await main(["--manifest", "fictional-private-path", "--conversation", "private-canary", "--output", join(dir, "denied")], { stdout, stderr })).toBe(1);
  expect(stdout).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalledWith("RECORDED_IMPORT_REFUSED\n");
  for (const flag of ["__proto__", "constructor", "toString", "--unknown"]) expect(() => parseArgs([flag, "fictional"])).toThrow("INVALID_RECORDED_ARGUMENTS");
  expect(() => readRecordedManifest(f.web)).toThrow();
});

it("measures result representation/clipping instead of claiming built-in byte equivalence", async () => {
  const { source } = await read(snapshots(scratch())); const queue = createRecordedQueue(source);
  const expected = queue.dispatch("Read", source.tools[0].args).content;
  expect(queue.observe(0, expected)).toMatchObject({ exact: true, representationDifference: false, possiblyClipped: false });
  expect(queue.observe(0, [{ type: "text", text: "F" }])).toMatchObject({ exact: false, possiblyClipped: true });
  expect(source.transport).toMatchObject({ byteEquivalence: "not-claimed", arguments: "unchanged" });
});

it("contains no importer network, provider, executable, dynamic import or loader capability", () => {
  const files = ["scripts/continuity-import-recorded.mjs", "scripts/continuity-observe.mjs", ...readdirSync(join(ROOT, "scripts/lib")).filter(n => /^continuity-(recorded|observation)-.*\.mjs$/.test(n)).map(n => `scripts/lib/${n}`)];
  const builtin = new Set(["node:fs", "node:path", "node:url", "node:crypto", "node:sqlite"]);
  const imports = new Set(files.filter(p => p.startsWith("scripts/lib/")).flatMap(p => [`./${p.slice("scripts/lib/".length)}`, `./lib/${p.slice("scripts/lib/".length)}`]));
  for (const path of files) {
    const tools = path.endsWith("continuity-recorded-tools.mjs"), ast = ts.createSourceFile(path, readFileSync(join(ROOT, path), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const walk = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = node.moduleSpecifier.text;
        expect(builtin.has(spec) || imports.has(spec) || tools && spec === "node:http", `${path}:${spec}`).toBe(true);
        if (!tools) expect(spec.includes("continuity-recorded-tools")).toBe(false);
        if (spec === "node:http") {
          expect(node.importClause?.name).toBeUndefined();
          expect(ts.isNamedImports(node.importClause?.namedBindings)).toBe(true);
          expect(node.importClause.namedBindings.elements.map(e => [e.name.text, e.propertyName?.text])).toEqual([["createServer", undefined]]);
        }
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) expect(tools && ["@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk/server/streamableHttp.js", "@modelcontextprotocol/sdk/types.js"].includes(node.arguments[0]?.text)).toBe(true);
        const name = node.expression.getText(ast);
        const regexExec = ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" && node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral;
        expect(!regexExec && /\b(fetch|spawn|exec|execFile|fork|eval|Function|require|createRequire|load|request|Agent|connect|createConnection|createSocket|constructor|getBuiltinModule|binding|dlopen|Reflect|Proxy)\b/.test(name) && name !== "server.connect", `${path}:${name}`).toBe(false);
        expect(name).not.toBe("http.get");
        if (name === "http.listen") expect(node.arguments.map(a => a.getText(ast))).toEqual(["0", '"127.0.0.1"', "resolve"]);
      }
      if (ts.isNewExpression(node)) expect(/\b(Agent|Worker|WebSocket|Function)\b/.test(node.expression.getText(ast))).toBe(false);
      ts.forEachChild(node, walk);
    }; walk(ast);
  }
});

it("imports and starts only a closable loopback listener under outbound/process/worker guards", async () => {
  const f = snapshots(scratch()), invoked = [];
  const deny = label => { invoked.push(label); throw Error("fictional_capability_denied"); };
  for (const [module, names] of [[http, ["request", "get", "Agent"]], [https, ["request", "get", "Agent"]], [net, ["connect", "createConnection"]], [tls, ["connect"]], [dgram, ["createSocket"]],
    [subprocess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]], [workerThreads, ["Worker"]]]) for (const name of names) vi.spyOn(module, name).mockImplementation(() => deny(name));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => deny("socket"));
  vi.stubGlobal("fetch", () => deny("fetch")); vi.stubGlobal("WebSocket", () => deny("WebSocket")); syncBuiltinESMExports();
  const { source } = await read(f), server = await startRecordedTools({ source }); cleanup.push(server.close);
  expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" }); expect(server.address().port).toBeGreaterThan(0);
  server.queue.dispatch("Read", source.tools[0].args);
  await server.close(); expect(server.address()).toBeNull(); expect(invoked).toEqual([]);
});

it("keeps an owned frozen queue even if its caller mutates the imported source", async () => {
  const { source } = await read(snapshots(scratch())), original = source.tools[0].result, queue = createRecordedQueue(source);
  source.tools[0].result = "Changed fictional result";
  expect(queue.dispatch("Read", source.tools[0].args).content[0].text).toBe(original);
});

it("reconciles journal-only calls with sidecar evidence and deduplicates returned/placed receipts", async () => {
  const t = tool("native-only", [{ type: "text", text: "Fictional native result" }]);
  const f = snapshots(scratch(), { parts: [], sidecar: [t], journal: [assistant([t]), { kind: "tool_result", payload: { phase: "returned", callId: t.toolCallId, message: result(t) } }, result(t)] });
  const { source, inventory } = await read(f);
  expect(inventory).toMatchObject({ tools: 1, journalOnly: 1, sidecarOnly: 0, matched: 1 });
  expect(source.tools[0].gaps).toEqual([]);
  expect(source.tools[0].provenance.find(p => p.phase === "result").recordIds).toEqual(["record-2", "record-3"]);
  expect(createRecordedQueue(source).dispatch(t.toolName, t.args).content).toEqual(t.result);
});

it("does not double-count native/web steers or count initial native input as a steer", async () => {
  const f = snapshots(scratch(), { parts: [{ type: "steer", inputId: "follow-up", text: "Fictional follow-up.", receivedAt: AT }], journal: [
    { kind: "input_consumed", payload: { inputId: "initial" } }, { kind: "input_consumed", payload: { inputId: "follow-up" } },
  ] });
  expect((await read(f)).inventory.steers).toBe(1);
});

it("records damaged payload hashes and unknown terminal states rather than inventing a match", async () => {
  const t = tool(), f = snapshots(scratch(), { sidecar: [t] }), db = new DatabaseSync(f.value.sidecar);
  db.exec("UPDATE tool_calls SET state=NULL; UPDATE tool_records SET payload_sha256='damaged' WHERE phase='result'"); db.close();
  const { source, inventory } = await read(f);
  expect(inventory.matched).toBe(0); expect(source.tools[0].reconciliation).toBe("incomplete");
  expect(gaps(source)).toContain("malformed_sidecar_payload"); expect(source.tools[0].comparison.state).toBe("missing");
});

it("bounds rows before materializing payloads and refuses changed snapshots", async () => {
  const f = snapshots(scratch()); sql(f, "UPDATE messages SET parts_json=CAST(zeroblob(8388609) AS TEXT) WHERE role='assistant'");
  await expect(read(f)).rejects.toThrow("RECORDED_ROW_TOO_LARGE");
  const stable = snapshots(scratch(), { journal: [{ kind: "compaction", payload: { compaction: { summary: "Fictional summary." } } }] });
  const reading = read(stable); sql(stable, "UPDATE turns SET error_message='Changed fictional source'");
  await expect(reading).rejects.toThrow("SNAPSHOT_CHANGED");
});

it("refuses invalid journal chains and explicit mismatched bindings", async () => {
  const f = snapshots(scratch(), { journal: [assistant([tool()]), result(tool())] });
  const lines = readFileSync(f.value.journal.path, "utf8").trim().split("\n").map(JSON.parse); lines[2].parentId = "unrelated-fictional-record";
  writeFileSync(f.value.journal.path, lines.map(JSON.stringify).join("\n") + "\n");
  await expect(read(f)).rejects.toThrow("INVALID_JOURNAL_RECORD");
  f.value.journal.conversationId = "web:another-fictional"; writeFileSync(f.manifest, JSON.stringify(f.value));
  await expect(read(f)).rejects.toThrow("RECORDED_JOURNAL_BINDING_MISMATCH");
});
