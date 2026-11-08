import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative } from "node:path";
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
import { readRecordedSource, readRecordedManifest, importRecorded, privateOutput, readRedactor } from "../lib/continuity-recorded-import.mjs";
import { validateSource, emptyQuestions, emptyKeys, validateQuestions, validateKeys, INVENTORY_FIELDS } from "../lib/continuity-recorded-schema.mjs";
import { normalizeSidecar, compareCopies, REDACTION_OPTIONS, EFFECTIVE_ARGUMENT_KEYS, resultCopy, selectResult } from "../lib/continuity-recorded-reconcile.mjs";
import { createRecordedQueue, recordedDefinitions, startRecordedTools } from "../lib/continuity-recorded-tools.mjs";
import { main, parseArgs } from "../continuity-import-recorded.mjs";
import { snapshots, tool, assistant, result, CONVERSATION, AT, boundary, usage } from "./fixtures/continuity-recorded/snapshots.mjs";

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
  expect(source).toMatchObject({ schema: "continuity-recorded-source-v2", dataClass: "private-recorded", conversationId: CONVERSATION });
  expect(source.web.messages[1].parts_json).toBe(JSON.stringify([boundary(), tool()]));
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
  expect(source.web.turns[0].status).toBe("cancelled"); expect(source.web.messages[1].parts_json).toBe(JSON.stringify([boundary(), ...parts]));
  expect(inventory).toMatchObject({ partialTurns: 1, failedTools: 1, attachments: 1, markers: 1, telemetry: 2, steers: 1 });
  expect(gaps(source)).toEqual(expect.arrayContaining(["partial_turn", "attachment_bytes_unavailable"]));
  expect(source.coverage.find(g => g.code === "attachment_bytes_unavailable").tier).toBe("item");
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
  expect(gaps(source)).toEqual(expect.arrayContaining(["source_truncated", "result_missing", "malformed_part", "malformed_tool"]));
  expect(() => createRecordedQueue(source)).toThrow("RECORDED_REPLAY_COVERAGE_GAP");
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

it("limits imports to offline helpers, the inert listener and the scanned pure redaction closure", () => {
  const files = ["scripts/continuity-import-recorded.mjs", "scripts/continuity-observe.mjs", ...readdirSync(join(ROOT, "scripts/lib")).filter(n => /^continuity-(recorded|observation)-.*\.mjs$/.test(n)).map(n => `scripts/lib/${n}`)];
  files.push("packages/observability/dist/redaction.js");
  const pureFiles = new Set(["packages/observability/dist/redaction.js", "packages/observability/dist/guards.js"]);
  const builtin = new Set(["node:fs", "node:path", "node:url", "node:crypto", "node:sqlite"]);
  const imports = new Set(files.filter(p => p.startsWith("scripts/lib/")).flatMap(p => [`./${p.slice("scripts/lib/".length)}`, `./lib/${p.slice("scripts/lib/".length)}`]));
  for (const path of files) {
    const product = path.startsWith("packages/");
    const tools = path.endsWith("continuity-recorded-tools.mjs"), ast = ts.createSourceFile(path, readFileSync(join(ROOT, path), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const walk = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const spec = node.moduleSpecifier.text;
        if (product) {
          const dependency = relative(ROOT, resolve(dirname(join(ROOT, path)), spec));
          expect(spec.startsWith("./") && pureFiles.has(dependency), `${path}:${spec}`).toBe(true);
          if (!files.includes(dependency)) files.push(dependency);
        } else expect(builtin.has(spec) || imports.has(spec) || tools && spec === "node:http", `${path}:${spec}`).toBe(true);
        if (!tools) expect(spec.includes("continuity-recorded-tools")).toBe(false);
        if (spec === "node:http") {
          expect(node.importClause?.name).toBeUndefined();
          expect(ts.isNamedImports(node.importClause?.namedBindings)).toBe(true);
          expect(node.importClause.namedBindings.elements.map(e => [e.name.text, e.propertyName?.text])).toEqual([["createServer", undefined]]);
        }
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) expect(path === "scripts/lib/continuity-recorded-import.mjs" && node.arguments[0]?.text === "../../packages/observability/dist/redaction.js" || tools && ["@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk/server/streamableHttp.js", "@modelcontextprotocol/sdk/types.js"].includes(node.arguments[0]?.text)).toBe(true);
        const name = node.expression.getText(ast);
        const regexExec = product && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "exec" && node.expression.expression.kind === ts.SyntaxKind.RegularExpressionLiteral;
        expect(!regexExec && /\b(fetch|spawn|exec|execFile|fork|eval|Function|require|createRequire|load|request|Agent|connect|createConnection|createSocket|constructor|getBuiltinModule|binding|dlopen|Reflect|Proxy)\b/.test(name) && name !== "server.connect", `${path}:${name}`).toBe(false);
        expect(name).not.toBe("http.get");
        if (name === "http.listen") expect(node.arguments.map(a => a.getText(ast))).toEqual(["0", '"127.0.0.1"', "resolve"]);
      }
      if (ts.isNewExpression(node)) expect(/\b(Agent|Worker|WebSocket|Function)\b/.test(node.expression.getText(ast))).toBe(false);
      if (product && ts.isIdentifier(node)) expect(["process", "fetch", "require", "globalThis"].includes(node.text)).toBe(false);
      ts.forEachChild(node, walk);
    }; walk(ast);
  }
  expect(files).toEqual(expect.arrayContaining([...pureFiles]));
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
  expect(source.tools[0].gaps.filter(code => code !== "arguments_may_include_host_defaults")).toEqual([]);
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

it("matches the writer's exact redaction options and secure preprocessing without importing its runtime", async () => {
  const writer = readFileSync(join(ROOT, "packages/conversation/src/tool-history/payload.ts"), "utf8"), helper = readFileSync(join(ROOT, "scripts/lib/continuity-recorded-reconcile.mjs"), "utf8");
  const ast = text => ts.createSourceFile("payload.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = tree => tree.statements.filter(n => ts.isFunctionDeclaration(n) && ["securelyPreprocessPayload", "securePayloadValue", "defineSecurePayloadProperty", "securePayloadString"].includes(n.name?.text)).map(n => n.getText(tree)).join("\n");
  const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  expect(compile(functions(ast(helper)))).toBe(compile(functions(ast(writer))));
  const constants = tree => tree.statements.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => d.name.getText(tree).startsWith("PRE_REDACTION_"))).map(n => n.getText(tree)).join("\n");
  expect(compile(constants(ast(helper)))).toBe(compile(constants(ast(writer))));
  const literal = n => ts.isObjectLiteralExpression(n) ? Object.fromEntries(n.properties.map(p => [p.name.getText().replaceAll('"', ''), literal(p.initializer)]))
    : n.kind === ts.SyntaxKind.TrueKeyword ? true : n.kind === ts.SyntaxKind.FalseKeyword ? false : n.text;
  const calls = []; const visit = n => { if (ts.isCallExpression(n) && n.expression.getText() === "redactJsonValue") calls.push(n); ts.forEachChild(n, visit); }; visit(ast(writer));
  expect(calls).toHaveLength(1); expect(calls[0].arguments[0].getText()).toBe("preprocessed.value");
  expect(literal(calls[0].arguments[2])).toEqual(REDACTION_OPTIONS);
  expect(writer).toContain("const STRING_MAX_BYTES = 4 * 1024;");
  expect(writer).toContain("const maxStringBytes = Math.min(options.maxStringBytes ?? STRING_MAX_BYTES, maxBytes)");
  expect(calls[0].arguments[1].getText()).toBe("maxStringBytes");
  expect(helper).toContain("redactJsonValue(preprocessed.value, 4096, REDACTION_OPTIONS)");
  for (const key of EFFECTIVE_ARGUMENT_KEYS) expect(readFileSync(join(ROOT, key === "head_limit" ? "packages/turn/src/tools/files/grep.ts" : "packages/turn/src/tools/commands/exec.ts"), "utf8")).toContain(key);
  const redactor = await readRedactor(); expect(normalizeSidecar({ text: "x".repeat(65537) }, redactor)).toEqual({ text: "[oversized value omitted before redaction]" });
});

it.each(["/Users/morgan/projects/cedar/note.txt", "/srv/fictional/cedar/note.txt"])("reconciles product-redacted fictional path arguments without changing replay values: %s", async path => {
  const redact = await readRedactor(), t = tool("redacted", "Fictional unchanged result", { args: { path } });
  const side = { ...t, args: normalizeSidecar(t.args, redact) };
  const { source, inventory } = await read(snapshots(scratch(), { parts: [t], sidecar: [side] }));
  expect(source.tools[0].reconciliation).toBe("sidecar_redacted"); expect(source.tools[0].args).toEqual(t.args);
  expect(inventory).toMatchObject({ conflicts: 0, sidecarRedacted: 1, replayGaps: 0 });
  expect(source.coverage.find(g => g.code === "sidecar_redacted").tier).toBe("fidelity");
  expect(createRecordedQueue(source).dispatch(t.toolName, t.args).content[0].text).toBe(t.result);
});

it("limits legacy redaction fallback to token-bearing spans and keeps ordinary mismatches conflicting", async () => {
  const redact = await readRedactor(), web = { path: "/Users/morgan/legacy/cedar/note.txt", query: "cedar" };
  expect(compareCopies(web, { path: "[home-path]/note.txt", query: "cedar" }, redact, true)).toBe("sidecar_redacted_unverified");
  expect(compareCopies(web, { path: "[home-path]/note.txt", query: "pine" }, redact, true)).toBe("different");
  expect(compareCopies(web, { path: "[home-path]/other.txt", query: "cedar" }, redact, true)).toBe("different");
  expect(compareCopies({ value: "fictional" }, { value: "[redacted]" }, redact, true)).toBe("sidecar_redacted_unverified");
  const t = tool("legacy", "Fictional result", { args: web });
  const good = await read(snapshots(scratch(), { parts: [t], sidecar: [{ ...t, args: { path: "[home-path]/note.txt", query: "cedar" } }] }));
  expect(good.inventory).toMatchObject({ conflicts: 0, sidecarRedactedUnverified: 1, replayGaps: 0 });
  const bad = await read(snapshots(scratch(), { parts: [t], sidecar: [{ ...t, args: { path: "[home-path]/note.txt", query: "pine" } }] }));
  expect(bad.inventory.conflicts).toBe(1); expect(() => createRecordedQueue(bad.source)).toThrow("RECORDED_REPLAY_COVERAGE_GAP");
});

it("uses model-emitted arguments, permits only declared effective extras, and records web-only uncertainty", async () => {
  const model = tool("effective"), web = { ...model, args: { ...model.args, workdir: "/srv/fictional/cedar", timeout_ms: 1000, max_output_chars: 100, head_limit: 4 } };
  const imported = await read(snapshots(scratch(), { parts: [web], journal: [assistant([model]), result(model)] }));
  expect(imported.source.tools[0]).toMatchObject({ args: model.args, webArgs: web.args, argumentsOrigin: "journal" });
  expect(imported.inventory).toMatchObject({ conflicts: 0, webEffectiveArguments: 1, replayGaps: 0 });
  expect(createRecordedQueue(imported.source).dispatch(model.toolName, model.args).content[0].text).toBe(model.result);
  const unknown = await read(snapshots(scratch(), { parts: [web] }));
  expect(unknown.source.coverage.find(g => g.code === "arguments_may_include_host_defaults").tier).toBe("fidelity");
  const bad = await read(snapshots(scratch(), { parts: [{ ...web, args: { ...web.args, path: "different-fictional.txt", unsafeExtra: true } }], journal: [assistant([model]), result(model)] }));
  expect(bad.inventory.conflicts).toBe(1);
});

it("uses web telemetry boundaries for sequential identical calls and rejects absent/inconsistent boundaries", async () => {
  const one = tool("step-one", "First fictional answer", { history: { sequence: 2 } }), two = tool("step-two", "Second fictional answer", { history: { sequence: 4 } });
  const f = snapshots(scratch(), { parts: [boundary(), one, boundary(), two, boundary()] });
  const { source, inventory } = await read(f);
  expect(source.steps.map(s => s.calls)).toEqual([[0], [1]]); expect(source.steps.every(s => s.origin === "web-assistant-boundary")).toBe(true);
  expect(inventory).toMatchObject({ replayGaps: 0, ambiguousParallelGroups: 0 });
  const queue = createRecordedQueue(source); expect(queue.dispatch(one.toolName, one.args).content[0].text).toBe(one.result); expect(queue.dispatch(two.toolName, two.args).content[0].text).toBe(two.result);
  for (const parts of [[one, two], [boundary(), { ...one, history: { sequence: 9 } }, boundary(), two], [one, boundary(), two], [boundary(), one, usage(), { type: "reasoning", text: "Fictional next-step reasoning without its end marker." }, two]]) {
    const invalid = await read(snapshots(scratch(), { parts, boundaries: false }));
    expect(gaps(invalid.source)).toContain("assistant_step_boundaries_unknown"); expect(() => createRecordedQueue(invalid.source)).toThrow();
  }
});

it("merges earlier web steps with the journal suffix without inventing mixed-order gaps", async () => {
  const one = tool("earlier", "Earlier fictional answer"), two = tool("later", "Later fictional answer");
  const { source, inventory } = await read(snapshots(scratch(), { parts: [boundary(), one, boundary(), two], journal: [assistant([two]), result(two)] }));
  expect(source.steps.map(s => s.calls)).toEqual([[0], [1]]); expect(gaps(source)).not.toContain("mixed_step_order_unknown"); expect(inventory.replayGaps).toBe(0);
});

it("uses the most complete result and emits truncation fidelity only when all available copies are truncated", async () => {
  const full = "Fictional complete note.", clipped = tool("recover", "Fictional", { resultTruncated: true, resultBytes: 100 });
  const recovered = await read(snapshots(scratch(), { parts: [clipped], sidecar: [{ ...clipped, result: full }], journal: [assistant([clipped]), { ...result(clipped), content: full }] }));
  expect(recovered.source.tools[0].result).toBe(full); expect(recovered.inventory).toMatchObject({ conflicts: 0, replayGaps: 0, recoveredResults: 1 });
  expect(gaps(recovered.source)).not.toContain("source_truncated"); expect(gaps(recovered.source)).not.toContain("sidecar_truncated");
  const webFull = tool("web-full", full), onlySideClipped = await read(snapshots(scratch(), { parts: [webFull], sidecar: [{ ...webFull, result: "Fictional", truncated: true }] }));
  expect(onlySideClipped.source.tools[0].result).toBe(full); expect(onlySideClipped.inventory.conflicts).toBe(0); expect(gaps(onlySideClipped.source)).not.toContain("sidecar_truncated");
  const partial = await read(snapshots(scratch(), { parts: [clipped], sidecar: [{ ...clipped, result: "Fictional complete", truncated: true }], journal: [assistant([clipped]), { ...result(clipped), truncated: true, originalBytes: 200 }] }));
  expect(partial.source.tools[0].result).toBe("Fictional complete");
  expect(partial.source.coverage.some(g => g.code.endsWith("truncated") && g.tier === "fidelity")).toBe(true);
  expect(partial.inventory.replayGaps).toBe(0); expect(() => createRecordedQueue(partial.source)).not.toThrow();
  const unknownLength = resultCopy("web", "short", { truncated: true }); expect(unknownLength.originalBytes).toBeNull();
  expect(selectResult([unknownLength, resultCopy("sidecar", "longer partial", { truncated: true, originalBytes: 100 })]).store).toBe("sidecar");
});

it("counts tiered gaps and only refuses replay-tier coverage unless explicitly excluded", async () => {
  const t = tool(), { source, inventory } = await read(snapshots(scratch(), { parts: [t, { type: "attachment", id: "fictional-attachment" }, { type: "subagent", toolCallId: "fictional-child", result: "Fictional preview", resultTruncated: true, status: "complete" }] }));
  expect(inventory).toMatchObject({ replayGaps: 0, itemGaps: 2 }); expect(inventory.coverageGaps).toBe(inventory.itemGaps + inventory.fidelityGaps);
  expect(source.coverage.every(g => !Object.hasOwn(g, "blocking"))).toBe(true); expect(() => createRecordedQueue(source)).not.toThrow();
  const unknown = await read(snapshots(scratch(), { parts: [t], boundaries: false }));
  expect(() => createRecordedQueue(unknown.source)).toThrow(); expect(createRecordedQueue(unknown.source, { excludedSteps: [0] }).report().pending).toBe(0);
});

it("returns a coded build-prerequisite refusal without loading another product surface", async () => {
  const f = snapshots(scratch()), original = fs.existsSync;
  vi.spyOn(fs, "existsSync").mockImplementation(path => String(path).endsWith("/observability/dist/redaction.js") ? false : original(path)); syncBuiltinESMExports();
  await expect(readRedactor()).rejects.toThrow("RECORDED_REDACTION_BUILD_REQUIRED");
  const stdout = vi.fn(), stderr = vi.fn();
  expect(await main(["--manifest", f.manifest, "--conversation", CONVERSATION, "--output", join(scratch(), "output")], { stdout, stderr })).toBe(1);
  expect(stdout).not.toHaveBeenCalled(); expect(stderr).toHaveBeenCalledWith("RECORDED_REDACTION_BUILD_REQUIRED\n");
});

it("recovers a complete native returned result even when the placed receipt was clipped", async () => {
  const t = tool("native-recovery", "Fictional full receipt."), web = { ...t, result: "Fictional", resultTruncated: true };
  const { source, inventory } = await read(snapshots(scratch(), { parts: [web], journal: [assistant([t]), { kind: "tool_result", payload: { phase: "returned", message: result(t) } }, { ...result(t), content: "Fictional", truncated: true, originalBytes: 100 }] }));
  expect(source.tools[0].result).toBe(t.result); expect(inventory).toMatchObject({ recoveredResults: 1, conflicts: 0, replayGaps: 0 });
  expect(gaps(source)).not.toContain("source_truncated");
});


it("groups usage-only steps with their preceding prose and following tools/subagent outcome", async () => {
  const one = tool("usage-first", "First fictional note", { history: { sequence: 3 } }), two = tool("usage-next", "Second fictional note", { history: { sequence: 7 } });
  const child = { type: "subagent", toolCallId: "fictional-usage-child", status: "complete", result: "Fictional assistant-side outcome" };
  const parts = [{ type: "reasoning", text: "Inspect the fictional note." }, usage(), one, child,
    { type: "text", text: "Read the next fictional revision." }, usage(), two,
    { type: "text", text: "Fictional final answer." }, usage()];
  const { source, inventory } = await read(snapshots(scratch(), { parts, boundaries: false }));
  expect(source.steps.map(s => s.calls)).toEqual([[0], [1]]);
  expect(source.steps).toMatchObject([
    { origin: "web-usage-boundary", boundaryIndex: 1, usageBoundaryIndex: 1, partStartIndex: 0, partEndIndex: 3, subagentPartIndices: [3] },
    { origin: "web-usage-boundary", boundaryIndex: 5, usageBoundaryIndex: 5, partStartIndex: 4, partEndIndex: 6, subagentPartIndices: [] },
  ]);
  expect(inventory).toMatchObject({ steps: 2, tools: 2, subagentOutcomes: 1, ambiguousParallelGroups: 0, replayGaps: 0 });
  expect(JSON.parse(source.web.messages.find(m => m.id === "assistant-one").parts_json)).toEqual(parts);
  const queue = createRecordedQueue(source); expect(queue.dispatch(one.toolName, one.args).content[0].text).toBe(one.result); expect(queue.dispatch(two.toolName, two.args).content[0].text).toBe(two.result);
});

it("prefers a coincident explicit boundary without counting legacy-wrapped usage as an extra step", async () => {
  const one = tool("paired-first", "Fictional parallel answer", { history: { sequence: 8 } }), two = tool("paired-next", "Other fictional answer", { args: { path: "other-fictional-note.txt" }, history: { sequence: 6 } });
  const wrappedUsage = { type: "telemetry", data: { data: usage().data } };
  const parts = [{ type: "reasoning", text: "Fictional parallel reads." }, wrappedUsage,
    { type: "telemetry", event: "fictional-passive-metric", data: {} }, boundary(), one, two,
    { type: "text", text: "Fictional final answer." }, usage(), boundary()];
  const { source, inventory } = await read(snapshots(scratch(), { parts, boundaries: false }));
  expect(source.steps).toHaveLength(1); expect(source.steps[0]).toMatchObject({ calls: [0, 1], origin: "web-assistant-boundary", usageBoundaryIndex: 1, boundaryIndex: 3, partStartIndex: 0, partEndIndex: 5 });
  expect(inventory).toMatchObject({ steps: 1, replayGaps: 0 });
  const queue = createRecordedQueue(source); expect(queue.dispatch(two.toolName, two.args).content[0].text).toBe(two.result); expect(queue.dispatch(one.toolName, one.args).content[0].text).toBe(one.result);
});

it("mixes usage-only, explicit-only and paired markers without merging adjacent scripted steps", async () => {
  const one = tool("mixed-first", "First fictional answer", { history: { sequence: 2 } }), two = tool("mixed-next", "Second fictional answer", { history: { sequence: 5 } }), three = tool("mixed-last", "Third fictional answer", { history: { sequence: 9 } });
  const parts = [{ type: "text", text: "Fictional first narration." }, usage(), one,
    { type: "reasoning", text: "Fictional second reasoning." }, boundary(), two,
    { type: "reasoning", text: "Fictional third reasoning." }, usage(), boundary(), three,
    { type: "text", text: "Fictional final answer." }, usage()];
  const { source, inventory } = await read(snapshots(scratch(), { parts, boundaries: false }));
  expect(source.steps.map(s => s.calls)).toEqual([[0], [1], [2]]);
  expect(source.steps.map(s => s.origin)).toEqual(["web-usage-boundary", "web-assistant-boundary", "web-assistant-boundary"]);
  expect(inventory).toMatchObject({ steps: 3, ambiguousParallelGroups: 0, replayGaps: 0 });
  const queue = createRecordedQueue(source); for (const call of [one, two, three]) expect(queue.dispatch(call.toolName, call.args).content[0].text).toBe(call.result);
});

it.each([
  ["reversed sequence across steps", (one, two) => [usage(), { ...one, history: { sequence: 9 } }, usage(), { ...two, history: { sequence: 3 } }]],
  ["duplicate sequence across steps", (one, two) => [usage(), { ...one, history: { sequence: 4 } }, usage(), { ...two, history: { sequence: 4 } }]],
  ["duplicate sequence within a parallel step", (one, two) => [usage(), { ...one, history: { sequence: 4 } }, { ...two, history: { sequence: 4 } }]],
  ["invalid sequence", (one, two) => [usage(), { ...one, history: { sequence: 1.5 } }, usage(), two]],
  ["tool before the first marker", (one, two) => [one, usage(), two]],
  ["new prose before an unmarked tool", (one, two) => [usage(), one, { type: "text", text: "Fictional next-step narration." }, two]],
])("keeps usage boundary inconsistency replay-tier: %s", async (_name, makeParts) => {
  const one = tool("invalid-first"), two = tool("invalid-next", "Different fictional note");
  const { source, inventory } = await read(snapshots(scratch(), { parts: makeParts(one, two), boundaries: false }));
  expect(source.steps).toMatchObject([{ calls: [0, 1], origin: "web-message-conservative", gaps: expect.arrayContaining(["assistant_step_boundaries_unknown"]) }]);
  expect(source.coverage.find(g => g.code === "assistant_step_boundaries_unknown").tier).toBe("replay"); expect(inventory.replayGaps).toBeGreaterThan(0);
  expect(() => createRecordedQueue(source)).toThrow();
});
