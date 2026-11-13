import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import * as fs from "node:fs";
import { join, resolve, dirname as dirnameOf } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import http, { request as namedHttpRequest } from "node:http";
import workerThreads from "node:worker_threads";
import { syncBuiltinESMExports } from "node:module";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { main, observe } from "../continuity-observe.mjs";
import { openSnapshot, ROOT, MAX_ROW_BYTES, sourceStamps, assertUnchanged } from "../lib/continuity-observation-input.mjs";
import { PACK_REASONS, statements, scanTurn } from "../lib/continuity-observation-events.mjs";
import { HISTORY_NOTICE, HISTORY_HEADER, parseConversationHistoryText } from "../lib/continuity-observation-retrieval.mjs";
import { historyBody, historyResponse, historyText } from "./fixtures/continuity-observation/text-result.mjs";
import { EXPORT_ALLOWLIST, assertAllowed } from "../lib/continuity-observation-report.mjs";
import { fixture, CANARY, START, END, at, telemetry, boundary, pack, tool, compaction } from "./fixtures/continuity-observation/snapshots.mjs";

const dirs = [];
const temp = () => { const p = fs.mkdtempSync(join(tmpdir(), "continuity-observe-fictional-")); dirs.push(p); return fs.realpathSync(p); };
const update = (f) => fs.writeFileSync(f.manifest, JSON.stringify(f.value));
const run = (f, extra = {}) => observe({ manifest: f.manifest, output: join(temp(), "exports"), ...extra });
const field = (cells, key, value) => cells.find(c => c[key] === value).count;
const digest = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const stamps = (dir) => Object.fromEntries(fs.readdirSync(dir).map(n => [n, digest(join(dir, n))]));
const editDb = (f, edit) => { const db = new DatabaseSync(f.web); try { edit(db); } finally { db.close(); } };
const addAgent = (f) => {
  const agent = `${CANARY}_other_agent`, thread = `${CANARY}_other_thread`, conversation = `${CANARY}_other_conversation`;
  editDb(f, db => {
    db.prepare("INSERT INTO threads VALUES(?,?,?,NULL,?)").run(thread, agent, conversation, CANARY);
    db.prepare("INSERT INTO turns SELECT id||'_other',?,status,started_at,finished_at,text,error_message FROM turns WHERE thread_id=?").run(thread, CANARY);
    db.prepare("INSERT INTO messages SELECT id||'_other',?,turn_id||'_other',role,parts_json,created_at,updated_at,status,seq,cron_suppressed FROM messages WHERE thread_id=?").run(thread, CANARY);
  });
  return { agent, thread, conversation };
};
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });

function assertObserverSourceSafe(source) {
  const parsed = ts.createSourceFile("observer.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw new Error("INVALID_OBSERVER_SOURCE");
  const blocked = new Set(["fetch", "require", "createRequire", "getBuiltinModule", "eval", "Function"]);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || !/^(node:(fs|path|url|crypto|sqlite)|\.\/(?:lib\/)?continuity-observation-[a-z-]+\.mjs)$/.test(node.moduleSpecifier.text)) throw new Error("FORBIDDEN_OBSERVER_IMPORT");
    }
    if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      || (ts.isIdentifier(node) && blocked.has(node.text))
      || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && blocked.has(node.argumentExpression.text))) throw new Error("FORBIDDEN_OBSERVER_CAPABILITY");
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}

function assertExports(dir, reports) {
  expect(fs.readdirSync(dir).sort()).toEqual(["inventory.json", "metrics.json", "outcomes.json", "report.md"]);
  for (const [name, contract] of Object.entries(EXPORT_ALLOWLIST)) {
    const json = JSON.parse(fs.readFileSync(join(dir, `${name}.json`), "utf8"));
    assertAllowed(json, contract); expect(json).toEqual(reports[name]);
  }
  for (const n of fs.readdirSync(dir)) {
    const text = fs.readFileSync(join(dir, n), "utf8");
    for (const forbidden of [CANARY, "Morgan", "Cedar Offsite", START, END, "snapshot.sqlite", "threadId", "turnId", "messageId", "2042-03-01"]) expect(text).not.toContain(forbidden);
  }
}

describe("read-only continuity observation", () => {
  it("exports versioned allowlisted aggregates and a separate private worklist, with source bytes unchanged", async () => {
    const dir = temp(), f = fixture(dir, { sidecar: true, journal: true }), before = stamps(dir);
    const out = join(temp(), "exports"), worklist = join(temp(), "review.jsonl");
    const r = await run(f, { output: out, privateWorklist: worklist });
    expect(stamps(dir)).toEqual(before); assertExports(out, r);
    const m = r.metrics.strata[0];
    expect(m.boundaries.total).toBe(1); expect(m.compactions.total).toBe(1);
    expect(m.packs.injected).toBe(1); expect(m.packs.distributions.ownerEntries).toEqual({ samples: 1, sum: 2, min: 2, max: 2, missing: 0 });
    expect(m.retrieval.total).toBe(1); expect(field(m.retrieval.outcomes, "outcome", "success")).toBe(1);
    expect(field(m.retrieval.reconciliation, "status", "matched")).toBe(1);
    expect(m.followup.windows).toBe(2); expect(m.followup.observedRetrieval).toBe(2);
    expect(r.inventory.auxiliary.journalCompactions).toBe(1); // Never double-counted with web compactions.
    expect(r.inventory.auxiliary.continuityRecords).toBe(1);
    expect(r.outcomes.strata[0].unreviewed).toBe(2);
    expect(r.outcomes.strata[0].coverage).toBe("unknown"); expect(r.outcomes.strata[0].reasks).toBe("unknown");
    const lines = fs.readFileSync(worklist, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines).toHaveLength(2); expect(lines[0].ownerTurns).toHaveLength(3);
    expect(lines[0].web).toBe(f.web); expect(lines[0].messageId).toContain(CANARY);
    expect(fs.statSync(worklist).mode & 0o777).toBe(0o600);
    expect(fs.statSync(out).mode & 0o777).toBe(0o700);
  });

  it.each(["stripped", "unknown"])("keeps absent %s telemetry unknown, even with system markers", async (telemetryCoverage) => {
    const f = fixture(temp(), { telemetryCoverage, parts: () => [{ type: "conversation-marker", kind: "compaction", message: CANARY }] });
    const r = await run(f), m = r.metrics.strata[0];
    for (const k of ["boundaries", "compactions", "retrieval"]) { expect(m[k].coverage).toBe("unknown"); expect(m[k].total).toBe("unknown"); }
    expect(m.packs.injected).toBe("unknown"); expect(r.inventory.records.markers).toBe(4);
    expect(r.inventory.auxiliary.sidecarCalls).toBe("unknown");
  });

  it("recognizes stripped telemetry parts even when the caller declared complete capture", async () => {
    const r = await run(fixture(temp(), { parts: () => [{ type: "telemetry", event: "runtime_telemetry", kind: "session_boundary" }] }));
    expect(r.inventory.records.missingRecords).toBe(4);
    expect(r.metrics.strata[0].boundaries.coverage).toBe("unknown"); expect(r.metrics.strata[0].boundaries.total).toBe("unknown");
  });

  it("marks observed but undeclared telemetry partial, and does not infer availability from tool completion", async () => {
    const f = fixture(temp(), { telemetryCoverage: "unknown", parts: i => i === 1 ? [boundary(), tool({ structuredResult: undefined })] : [] });
    const r = await run(f), m = r.metrics.strata[0];
    expect(m.boundaries.coverage).toBe("partial"); expect(m.packs.coverage).toBe("unknown");
    expect(field(m.retrieval.outcomes, "outcome", "unknown")).toBe(1);
  });

  it("deduplicates telemetry and calls within a turn, retaining incomplete-window denominators", async () => {
    const b = boundary(), c = compaction(), t = tool();
    const f = fixture(temp(), { count: 2, parts: i => i === 1 ? [b, { ...b, data: { ...b.data, data: Object.fromEntries(Object.entries(b.data.data).reverse()) } }, c, c, t, t] : [] });
    const r = await run(f), m = r.metrics.strata[0];
    expect(m.boundaries.total).toBe(1); expect(m.compactions.total).toBe(1); expect(m.retrieval.total).toBe(1);
    expect(r.inventory.records.duplicateRecords).toBe(3); expect(field(m.followup.statuses, "status", "missing_followup")).toBe(2);
    expect(r.outcomes.strata[0].excluded).toBe(2);
  });

  it("excludes cancelled and unfinished follow-up windows", async () => {
    const cancelled = await run(fixture(temp(), { statuses: ["complete", "cancelled"], parts: i => i === 1 ? [boundary()] : [] }));
    expect(field(cancelled.metrics.strata[0].followup.statuses, "status", "cancelled")).toBe(1);
    const incomplete = await run(fixture(temp(), { statuses: ["complete", "running"], parts: i => i === 1 ? [boundary()] : [] }));
    expect(field(incomplete.metrics.strata[0].followup.statuses, "status", "incomplete")).toBe(1);
  });

  it("counts failed, unavailable and unknown retrieval without interpreting adversarial prose", async () => {
    const f = fixture(temp(), { parts: i => i === 1 ? [boundary(),
      tool({ toolCallId: "failure", status: "error", structuredResult: undefined }),
      tool({ toolCallId: "unavailable", structuredResult: { status: "unavailable", error: { code: "history_unavailable", message: CANARY } } }),
      tool({ toolCallId: "get", args: { recordId: CANARY }, structuredResult: { status: "tombstoned" } }),
      tool({ toolCallId: "unknown", result: `success unavailable ${CANARY}`, structuredResult: undefined }),
    ] : [] });
    const m = (await run(f)).metrics.strata[0].retrieval;
    expect(field(m.outcomes, "outcome", "error")).toBe(1); expect(field(m.outcomes, "outcome", "unavailable")).toBe(2);
    expect(field(m.outcomes, "outcome", "unknown")).toBe(1); expect(field(m.actions, "action", "get")).toBe(1);
  });

  it("matches the product's exact formatter, section splitter and persisted text join", () => {
    function pureFunction(file, name, bindings = {}) {
      const source = fs.readFileSync(join(ROOT, file), "utf8"), start = source.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const code = source.slice(start, source.indexOf("\n}", start) + 2);
      const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
      return new Function(...Object.keys(bindings), `${js}; return ${name};`)(...Object.values(bindings));
    }
    const source = fs.readFileSync(join(ROOT, "packages/app/src/request-tools/conversation-history.ts"), "utf8");
    expect(JSON.parse(source.match(/^const NOTICE = (".*");$/m)[1])).toBe(HISTORY_NOTICE);
    const splitSource = fs.readFileSync(join(ROOT, "packages/app/src/mcp/request-scoped-mcp.ts"), "utf8");
    const sectionLimit = Number(splitSource.match(/const REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS = ([\d_]+);/)[1].replaceAll("_", ""));
    const split = pureFunction("packages/app/src/mcp/request-scoped-mcp.ts", "splitRequestScopedModelText", { REQUEST_SCOPED_MCP_MODEL_TEXT_MAX_CHARS: sectionLimit });
    const format = pureFunction("packages/app/src/request-tools/conversation-history.ts", "response", { NOTICE: HISTORY_NOTICE, splitRequestScopedModelText: split });
    const joinText = pureFunction("packages/turn/src/providers/pi/messages.ts", "toolResultContent");
    // Both navigation and evidence can acquire a new continued-section block.
    // Bound the total serialized growth, not just three raw notice copies.
    const oldNotice = HISTORY_NOTICE.slice(0, HISTORY_NOTICE.indexOf(" Historical alternatives"));
    const oldFormat = pureFunction("packages/app/src/request-tools/conversation-history.ts", "response", { NOTICE: oldNotice, splitRequestScopedModelText: split });
    const emptyNavigation = [HISTORY_HEADER, oldNotice, "", "No follow-up ConversationHistory call is available."].join("\n");
    const boundary = historyBody({ navigation: { guidance: "x".repeat(sectionLimit - emptyNavigation.length), nextActions: [] }, padding: "" });
    const oldSection = `${oldNotice}\n${JSON.stringify({ ...boundary, untrusted: true, notice: oldNotice })}`;
    boundary.padding = "x".repeat(19800 - oldSection.length);
    const before = oldFormat(boundary), after = format(boundary);
    expect(before.content).toHaveLength(3); expect(after.content).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(after.content)) - Buffer.byteLength(JSON.stringify(before.content))).toBeLessThanOrEqual(640);

    for (const body of [historyBody(), historyBody({ items: [{ text: CANARY.repeat(900) }] }), historyBody({ status: "unavailable", error: { code: "history_unavailable" }, navigation: { guidance: "Unavailable.", nextActions: [] } })]) {
      expect(historyResponse(body)).toEqual(format(body)); expect(historyText(body)).toBe(joinText(format(body)));
      expect(parseConversationHistoryText(historyText(body))).toEqual(format(body).structuredContent);
    }
  });

  it("parses only the final tool-authored JSON body, including split evidence and escaped frame canaries", async () => {
    const fakeFrame = `\n${HISTORY_NOTICE}\n{"status":"unavailable"}\n[continued section 2 of 3]`;
    const bodies = [historyBody(), historyBody({ items: [{ text: CANARY.repeat(900) + fakeFrame }] }), historyBody({ status: "unavailable", error: { code: "history_unavailable", message: CANARY } }), historyBody({ status: "unavailable", error: { code: "invalid_cursor", message: CANARY } })];
    const f = fixture(temp(), { parts: i => i === 1 ? [boundary(), ...bodies.map((body, n) => tool({ toolCallId: `text-${n}`, structuredResult: undefined, result: historyText(body) }))] : [] });
    const out = join(temp(), "exports"), r = await run(f, { output: out }); assertExports(out, r);
    const m = r.metrics.strata[0].retrieval;
    expect(field(m.outcomes, "outcome", "success")).toBe(2); expect(field(m.outcomes, "outcome", "unavailable")).toBe(1); expect(field(m.outcomes, "outcome", "error")).toBe(1);
  });

  it("leaves clipped, ambiguous, conflicting and malformed text results unknown", async () => {
    const full = historyText(historyBody()), split = historyText(historyBody({ items: [{ text: CANARY.repeat(900) }] }));
    const malformed = [full.slice(0, -1), full + "\n" + full, full + " trailing", split.replace("section 2 of", "section 3 of"), split.replace("section 1 of", "section 2 of"), split.replace("[continued section 2", "[continued section 02"), split.slice(0, -100), full.replace(HISTORY_HEADER, CANARY), full.replace('"untrusted":true', '"untrusted":false'), full.replace('"status":"available"', '"status":"unavailable","status":"available"'), full.slice(0, full.lastIndexOf(HISTORY_NOTICE)), '{"status":"available"}'];
    for (const text of malformed) expect(parseConversationHistoryText(text)).toBeUndefined();
    const f = fixture(temp(), { parts: i => i === 1 ? malformed.map((result, n) => tool({ toolCallId: `malformed-${n}`, structuredResult: undefined, result })) : [] });
    const m = (await run(f)).metrics.strata[0].retrieval; expect(field(m.outcomes, "outcome", "unknown")).toBe(malformed.length);
    const conflict = await run(fixture(temp(), { parts: i => i === 1 ? [tool({ result: historyText(historyBody({ status: "unavailable" })) })] : [] }));
    expect(field(conflict.metrics.strata[0].retrieval.outcomes, "outcome", "unknown")).toBe(1);
  });

  it("pins the reason allowlist to source-defined pack and snapshot reasons", () => {
    const contracts = fs.readFileSync(join(ROOT, "packages/conversation/src/tool-history/continuity-contracts.ts"), "utf8");
    const packSource = fs.readFileSync(join(ROOT, "packages/conversation/src/continuity/pack.ts"), "utf8");
    // Search pages also have degradedReason, but are not pack observations.
    // Pin the actual snapshot union, not the first similarly named field.
    const snapshotContract = contracts.match(/export interface ContinuitySnapshot \{([\s\S]*?)^\}/m)?.[1];
    expect(snapshotContract).toBeDefined();
    const snapshotReasons = [...snapshotContract.match(/readonly degradedReason\?: (.*);/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const packReasons = [...packSource.matchAll(/degradedReason: "([^"]+)"/g)].map(m => m[1]);
    const implicit = ["none", "empty", "overflow", "coverage_gap", "upkeep_gap"];
    for (const reason of implicit) expect(packSource).toContain(`"${reason}"`);
    expect(PACK_REASONS.filter(r => !["other", "unknown"].includes(r)).sort()).toEqual([...new Set([...snapshotReasons, ...packReasons, ...implicit])].sort());
  });

  it("separates pack reason enums, coverage gaps and ordinary bounded selection", async () => {
    const bounded = ["overflow", "snapshot_bounds", "headroom", "trigger_headroom"];
    const gaps = ["coverage_gap", "upkeep_gap", "purge_pending", "source_changed", "source_unavailable", "boundary_unavailable", "unavailable"];
    const reasons = ["none", "empty", ...bounded, ...gaps, "scan_capacity", CANARY];
    const f = fixture(temp(), { parts: i => i === 1 ? reasons.map(reason => telemetry(reason === "trigger_headroom" ? "continuity_pack_skipped" : "continuity_pack_injected", { degradedReason: reason })) : [] });
    const out = join(temp(), "exports"), r = await run(f, { output: out }); assertExports(out, r);
    const packs = r.metrics.strata[0].packs; expect(packs.gap).toBe(gaps.length); expect(packs.boundedSelection).toBe(bounded.length);
    for (const reason of reasons.slice(0, -1)) expect(field(packs.reasons, "reason", reason)).toBe(1);
    expect(field(packs.reasons, "reason", "other")).toBe(1);
  });

  it("distinguishes observed absence from unknown retrieval follow-up", async () => {
    for (const coverage of ["complete", "unknown"]) {
      const r = await run(fixture(temp(), { telemetryCoverage: coverage, parts: i => i === 1 ? [boundary()] : [] }));
      const f = r.metrics.strata[0].followup;
      expect(f.observedRetrieval).toBe(0); expect(f.noObservedRetrieval).toBe(coverage === "complete" ? 1 : 0);
      expect(f.unknownRetrieval).toBe(coverage === "unknown" ? 1 : 0);
    }
    const r = await run(fixture(temp(), { parts: i => i === 1 ? [boundary()] : i === 3 ? [tool()] : [] }));
    expect(r.metrics.strata[0].followup.observedRetrieval).toBe(1);
  });

  it("reconciles lifecycle failures, conflicts and ambiguous matches without adding sidecar calls", async () => {
    const f = fixture(temp(), { sidecar: true });
    let d = new DatabaseSync(f.value.snapshots[0].sidecar); d.exec("UPDATE tool_calls SET state='error'"); d.close();
    const conflict = (await run(f)).metrics.strata[0].retrieval;
    expect(conflict.total).toBe(1); expect(field(conflict.reconciliation, "status", "conflict")).toBe(1);
    editDb(f, db => {
      const p = [boundary(), tool({ structuredResult: undefined })];
      db.prepare("UPDATE messages SET parts_json=? WHERE id=?").run(JSON.stringify(p), `${CANARY}_turn_1_assistant`);
    });
    const failure = (await run(f)).metrics.strata[0].retrieval;
    expect(field(failure.outcomes, "outcome", "error")).toBe(1);
    d = new DatabaseSync(f.value.snapshots[0].sidecar); d.exec("UPDATE tool_calls SET ended_at_ms=NULL"); d.close();
    expect(field((await run(f)).metrics.strata[0].retrieval.outcomes, "outcome", "unknown")).toBe(1);
    d = new DatabaseSync(f.value.snapshots[0].sidecar); d.exec("INSERT INTO tool_calls SELECT * FROM tool_calls"); d.close();
    const ambiguous = (await run(f)).metrics.strata[0].retrieval;
    expect(field(ambiguous.reconciliation, "status", "ambiguous")).toBe(1);
  });

  it("folds running-to-terminal duplicate calls without retaining source payloads", async () => {
    const r = await run(fixture(temp(), { parts: i => i === 1 ? [boundary(), tool({ status: "running", structuredResult: undefined }), tool()] : [] }));
    expect(r.metrics.strata[0].retrieval.total).toBe(1);
    expect(field(r.metrics.strata[0].retrieval.outcomes, "outcome", "success")).toBe(1);
    expect(r.inventory.records.duplicateRecords).toBe(1);
  });

  it("counts injected, skipped, degraded and missing pack measurements", async () => {
    const f = fixture(temp(), { parts: i => i === 1 ? [pack(), telemetry("continuity_pack_skipped", { degradedReason: "unavailable", tokens: 0 }),
      telemetry("continuity_pack_injected", { degradedReason: CANARY, ownerEntries: -5, toolEntries: CANARY })] : [] });
    const m = (await run(f)).metrics.strata[0].packs;
    expect(m.injected).toBe(2); expect(m.skipped).toBe(1); expect(m.degraded).toBe(2);
    expect(m.distributions.ownerEntries.missing).toBe(2);
  });

  it.each(["default", "custom", "unknown"])("preserves declared %s soul without guessing", async (soul) => {
    const r = await run(fixture(temp(), { soul, closure: "unknown" }));
    expect(r.inventory.strata[0].soul).toBe(soul); expect(r.metrics.strata[0].closure).toBe("unknown");
  });

  it("excludes windows crossing closure/soul periods, including a change back to the original stratum", async () => {
    const f = fixture(temp(), { strata: [
      { start: START, end: at(2), closure: "target", soul: "default" },
      { start: at(2), end: at(3), closure: "other", soul: "custom" },
      { start: at(3), end: END, closure: "target", soul: "default" },
    ], parts: i => i === 1 ? [boundary()] : [] });
    const r = await run(f), m = r.metrics.strata.find(g => g.closure === "target");
    expect(field(m.followup.statuses, "status", "stratum_changed")).toBe(1);
    expect(r.inventory.strata.find(g => g.closure === "other").turns).toBe(1);
  });

  it("adjudicates only caller-reviewed eligible windows with numeric outcome counts", async () => {
    const dir = temp(), f = fixture(dir), reviews = join(dir, "reviews.jsonl");
    fs.writeFileSync(reviews, `${JSON.stringify({ window: 1, reask: "yes", correction: "yes", repeatedEffectCandidate: "yes", confirmed: "yes" })}\n${JSON.stringify({ window: 2, reask: "ambiguous", correction: "no", repeatedEffectCandidate: "no", confirmed: "no" })}\n`);
    f.value.reviews = reviews; update(f);
    const o = (await run(f)).outcomes.strata[0];
    expect(o).toMatchObject({ reviewed: 2, unreviewed: 0, reasks: 1, corrections: 1, repeatedEffectCandidates: 1, confirmedCases: 1, ambiguousCases: 1 });
    editDb(f, db => db.prepare("UPDATE turns SET status='cancelled' WHERE id=?").run(`${CANARY}_turn_2`));
    await expect(run(f)).rejects.toThrow("REVIEW_WINDOW_EXCLUDED");
  });

  it("marks review coverage complete when all eligible windows are reviewed despite excluded windows", async () => {
    const dir = temp(), f = fixture(dir, { count: 6, parts: i => [1, 2, 5].includes(i) ? [boundary()] : [] });
    const reviews = join(dir, "reviews.jsonl"), review = window => ({ window, reask: "no", correction: "no", repeatedEffectCandidate: "no", confirmed: "no" });
    f.value.reviews = reviews; update(f);
    fs.writeFileSync(reviews, JSON.stringify(review(1)) + "\n");
    const partial = (await run(f)).outcomes.strata[0];
    expect(partial).toMatchObject({ windows: 3, eligible: 2, excluded: 1, reviewed: 1, unreviewed: 2, coverage: "partial" });
    fs.writeFileSync(reviews, [review(1), review(2)].map(JSON.stringify).join("\n") + "\n");
    const complete = (await run(f)).outcomes.strata[0];
    expect(complete).toMatchObject({ windows: 3, eligible: 2, excluded: 1, reviewed: 2, unreviewed: 1, coverage: "complete" });
  });

  it("refuses unmatched, duplicate and malformed adjudications", async () => {
    for (const entries of [
      [{ window: 3, reask: "no", correction: "no", repeatedEffectCandidate: "no", confirmed: "no" }],
      [{ window: 1, reask: CANARY, correction: "no", repeatedEffectCandidate: "no", confirmed: "no" }],
      [1, 1].map(window => ({ window, reask: "no", correction: "no", repeatedEffectCandidate: "no", confirmed: "no" })),
    ]) {
      const dir = temp(), f = fixture(dir); f.value.reviews = join(dir, "reviews.jsonl");
      fs.writeFileSync(f.value.reviews, entries.map(JSON.stringify).join("\n") + "\n"); update(f);
      await expect(run(f)).rejects.toThrow(/REVIEW/);
    }
  });

  it("refuses unsupported web, column, sidecar and journal schemas clearly", async () => {
    const f = fixture(temp()); editDb(f, db => db.exec("PRAGMA user_version=44"));
    await expect(run(f)).rejects.toThrow("UNSUPPORTED_WEB_SCHEMA");
    editDb(f, db => db.exec("PRAGMA user_version=43; ALTER TABLE messages RENAME COLUMN parts_json TO opaque"));
    await expect(run(f)).rejects.toThrow("UNSUPPORTED_TABLE_SCHEMA");
    const s = fixture(temp(), { sidecar: true });
    const db = new DatabaseSync(s.value.snapshots[0].sidecar); db.exec("PRAGMA application_id=0"); db.close();
    await expect(run(s)).rejects.toThrow("UNSUPPORTED_SIDECAR_SCHEMA");
    const j = fixture(temp(), { journal: true }); fs.writeFileSync(j.value.snapshots[0].journal, '{"format":"unknown","version":1}\n');
    await expect(run(j)).rejects.toThrow("UNSUPPORTED_JOURNAL_SCHEMA");
  });

  it("refuses non-standalone WAL snapshots before SQLite can create shared-memory files", async () => {
    const dir = temp(), f = fixture(dir); editDb(f, db => db.exec("PRAGMA journal_mode=WAL"));
    const before = stamps(dir); await expect(run(f)).rejects.toThrow("NON_STANDALONE_SNAPSHOT"); expect(stamps(dir)).toEqual(before);
  });

  it("really uses a mode=ro SQLite connection", () => {
    const f = fixture(temp()), db = openSnapshot(f.web, "web");
    try { expect(() => db.exec("CREATE TABLE forbidden(a)")).toThrow(/readonly|read-only/); }
    finally { db.close(); }
  });

  it("keeps SQLite extension loading disabled at connection creation", () => {
    const f = fixture(temp()), db = openSnapshot(f.web, "web");
    try { expect(() => db.enableLoadExtension(true)).toThrow(/disabled|not allowed/i); }
    finally { db.close(); }
    const source = fs.readFileSync(join(ROOT, "scripts/lib/continuity-observation-input.mjs"), "utf8");
    expect(source).toContain("allowExtension: false"); expect(source).not.toContain("enableExtensions:");
  });

  it.each(["deleted", "renamed"])("maps a %s stamped source to SNAPSHOT_CHANGED", kind => {
    const f = fixture(temp()), before = sourceStamps([f.web]);
    if (kind === "deleted") fs.unlinkSync(f.web); else fs.renameSync(f.web, f.web + ".moved");
    expect(() => assertUnchanged(before)).toThrowError(expect.objectContaining({ code: "SNAPSHOT_CHANGED", message: "SNAPSHOT_CHANGED" }));
  });

  it("refuses worklists inside this repository, via symlinks, or within the export set", async () => {
    const f = fixture(temp()), inside = join(ROOT, "scripts", "must-not-exist-private-review.jsonl");
    await expect(run(f, { privateWorklist: inside })).rejects.toThrow("PRIVATE_WORKLIST_PATH_REFUSED"); expect(fs.existsSync(inside)).toBe(false);
    const alias = join(temp(), "alias"); fs.symlinkSync(join(ROOT, "scripts"), alias);
    await expect(run(f, { privateWorklist: join(alias, "must-not-exist.jsonl") })).rejects.toThrow("PRIVATE_WORKLIST_PATH_REFUSED");
    const newOutput = join(temp(), "new-output");
    await expect(run(f, { output: newOutput, privateWorklist: join(newOutput, "review.jsonl") })).rejects.toThrow("PRIVATE_WORKLIST_PATH_REFUSED");
    const parent = temp(), nested = join(parent, "exports"); fs.mkdirSync(nested, { mode: 0o700 });
    await expect(run(f, { output: join(parent, "new"), privateWorklist: join(nested, "review") })).resolves.toBeDefined(); // Separate private directory is allowed.
    await expect(run(f, { privateWorklist: f.web })).rejects.toThrow("PRIVATE_WORKLIST_PATH_REFUSED");
    const existing = join(temp(), "existing"); fs.writeFileSync(existing, CANARY);
    await expect(run(f, { privateWorklist: existing })).rejects.toThrow(); expect(fs.readFileSync(existing, "utf8")).toBe(CANARY);
  });

  it("permits a private directory inside a different consumer repository, requiring uid ownership and 0700", async () => {
    const consumer = temp(); fs.mkdirSync(join(consumer, ".git")); const privateDir = join(consumer, "ignored-private"); fs.mkdirSync(privateDir, { mode: 0o700 });
    const f = fixture(temp()), path = join(privateDir, "worklist.jsonl"); await run(f, { privateWorklist: path }); expect(fs.existsSync(path)).toBe(true);
    for (const mode of [0o755, 0o750, 0o770, 0o777]) {
      fs.chmodSync(privateDir, mode);
      await expect(run(f, { privateWorklist: join(privateDir, `refused-${mode}`) })).rejects.toThrow("PRIVATE_WORKLIST_DIRECTORY_REFUSED");
    }
    fs.chmodSync(privateDir, 0o700); const uid = process.getuid();
    const fakeUid = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
    await expect(run(f, { privateWorklist: join(privateDir, "wrong-owner") })).rejects.toThrow("PRIVATE_WORKLIST_DIRECTORY_REFUSED"); fakeUid.mockRestore();
  });

  it("makes no network calls or child processes, including the CLI path", async () => {
    const forbidden = [];
    for (const [module, methods] of [[childProcess, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]], [http, ["request", "get"]], [https, ["request", "get"]], [net, ["connect", "createConnection"]], [tls, ["connect"]], [dgram, ["createSocket"]], [workerThreads, ["Worker"]]]) {
      for (const method of methods) forbidden.push(vi.spyOn(module, method).mockImplementation(() => { throw new Error("NETWORK_OR_PROCESS_FORBIDDEN"); }));
    }
    forbidden.push(vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("FETCH_FORBIDDEN"); }));
    syncBuiltinESMExports();
    expect(namedHttpRequest).toBe(http.request); // Named built-in bindings see the installed spy.
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const f = fixture(temp(), { sidecar: true, journal: true });
    expect(await main(["--manifest", f.manifest, "--output", join(temp(), "exports")])).toBe(0);
    for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    const toolFiles = ["continuity-observe.mjs", ...fs.readdirSync(join(ROOT, "scripts/lib")).filter(n => /^continuity-observation-.*\.mjs$/.test(n)).map(n => `lib/${n}`)];
    expect(toolFiles.length).toBeGreaterThan(1);
    for (const file of toolFiles) assertObserverSourceSafe(fs.readFileSync(resolve(ROOT, "scripts", file), "utf8"));
  });

  it("statically rejects forbidden capabilities, including side-effect/re-export and dynamic imports", () => {
    for (const module of ["net", "http", "https", "child_process", "worker_threads", "dgram", "tls"]) {
      for (const specifier of [module, `node:${module}`]) for (const code of [
        `import anything from "${specifier}";`, `import "${specifier}";`, `export * from "${specifier}";`, `import("${specifier}");`,
      ]) expect(() => assertObserverSourceSafe(code)).toThrow(/FORBIDDEN_OBSERVER/);
    }
    for (const code of ['import("node:" + name)', 'import("./continuity-observation-input.mjs")', 'fetch(url)', 'globalThis.fetch(url)', 'globalThis["fetch"](url)', 'require("node:net")', 'process.getBuiltinModule("net")', 'new Function("return 1")']) expect(() => assertObserverSourceSafe(code)).toThrow(/FORBIDDEN_OBSERVER/);
    expect(() => assertObserverSourceSafe('import { readFileSync } from "node:fs"; // fetch and import("node:net") are comments')).not.toThrow();
  });

  it("runs the real CLI entrypoint through a symlink", () => {
    const alias = join(temp(), "observe-link.mjs"); fs.symlinkSync(join(ROOT, "scripts/continuity-observe.mjs"), alias);
    // The test harness invokes the CLI; the observer itself never spawns.
    const text = childProcess.execFileSync(process.execPath, [alias, "--help"], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
    expect(text).toContain("Usage: node scripts/continuity-observe.mjs");
  });

  it("refuses inherited Object.prototype members in CLI flag positions", async () => {
    const f = fixture(temp()), stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (const flag of Object.getOwnPropertyNames(Object.prototype)) {
      const output = join(temp(), "exports");
      expect(await main(["--manifest", f.manifest, "--output", output, flag, "ignored"])).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
    }
    expect(stderr.mock.calls.every(([text]) => text.startsWith("Usage:"))).toBe(true); expect(stdout).not.toHaveBeenCalled();
  });

  it("sanitizes CLI failures rather than echoing paths or free-form SQLite errors", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await main(["--manifest", join(temp(), CANARY), "--output", join(temp(), "exports")])).toBe(1);
    expect(stderr.mock.calls.flat().join("")).toContain("OBSERVATION_REFUSED"); expect(stderr.mock.calls.flat().join("")).not.toContain(CANARY);
  });

  it("rejects added export fields and arbitrary strings at every output level", async () => {
    const r = await run(fixture(temp()));
    function paths(v, prefix = []) {
      if (Array.isArray(v)) return v.flatMap((x, i) => paths(x, [...prefix, i]));
      if (v && typeof v === "object") return [prefix, ...Object.entries(v).flatMap(([k, x]) => paths(x, [...prefix, k]))];
      return [];
    }
    for (const [name, spec] of Object.entries(EXPORT_ALLOWLIST)) for (const path of paths(r[name])) {
      const mutated = structuredClone(r[name]); let target = mutated;
      for (const key of path) target = target[key]; target[CANARY] = CANARY;
      expect(() => assertAllowed(mutated, spec)).toThrow("INVALID_EXPORT");
    }
    const mutated = structuredClone(r.metrics); mutated.strata[0].boundaries.reasons[0].reason = CANARY;
    expect(() => assertAllowed(mutated, EXPORT_ALLOWLIST.metrics)).toThrow("INVALID_EXPORT");
  });

  it("does not leak canary substitutions from any JSON source field", async () => {
    const base = [boundary(), compaction(), pack(), tool()];
    function leaves(v, path = []) {
      if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
      return [path];
    }
    for (const path of leaves(base)) {
      const parts = structuredClone(base); let target = parts;
      for (const key of path.slice(0, -1)) target = target[key]; target[path.at(-1)] = CANARY;
      const f = fixture(temp(), { parts: i => i === 1 ? parts : [] }), out = join(temp(), "exports");
      assertExports(out, await run(f, { output: out }));
    }
  });

  it("classifies NULL parts as invalid but not oversized", async () => {
    const f = fixture(temp()); editDb(f, db => db.prepare("UPDATE messages SET parts_json=NULL WHERE id=?").run(`${CANARY}_turn_2_assistant`));
    const r = await run(f); expect(r.inventory.records.invalidRecords).toBe(1); expect(r.inventory.records.oversizedRecords).toBe(0);
    expect(r.metrics.strata[0].boundaries.coverage).toBe("partial");
  });

  it("keeps malformed/oversized rows explicit and never hides them as complete coverage", async () => {
    const f = fixture(temp());
    editDb(f, db => {
      db.prepare("UPDATE messages SET parts_json=? WHERE id=?").run(`{${CANARY}`, `${CANARY}_turn_2_assistant`);
      db.prepare("UPDATE messages SET parts_json=? WHERE id=?").run(JSON.stringify([{ type: "text", text: CANARY.repeat(Math.ceil(MAX_ROW_BYTES / CANARY.length)) }]), `${CANARY}_turn_3_assistant`);
    });
    const r = await run(f); expect(r.inventory.records.invalidRecords).toBe(2); expect(r.inventory.records.oversizedRecords).toBe(1);
    expect(r.metrics.strata[0].boundaries.coverage).toBe("partial");
    expect(field(r.metrics.strata[0].followup.statuses, "status", "incomplete")).toBe(2);
  });

  it("reads selected messages from a snapshot with a sparse tail exceeding 1 GiB", async () => {
    const f = fixture(temp()); fs.truncateSync(f.web, 1024 ** 3 + 4096);
    const r = await run(f); expect(fs.statSync(f.web).size).toBeGreaterThan(1024 ** 3); expect(r.inventory.records.messages).toBe(8);
  });

  it("isolates agents sharing one web snapshot into content-free entry strata, even with identical enums", async () => {
    const f = fixture(temp(), { sidecar: true }), other = addAgent(f), otherFixture = fixture(temp(), { sidecar: true });
    const otherSidecar = otherFixture.value.snapshots[0].sidecar, d = new DatabaseSync(otherSidecar);
    d.prepare("UPDATE runs SET conversation_id=?,logical_id=?").run(other.conversation, other.conversation);
    for (const table of ["tool_calls", "tool_records", "continuity_generations"]) d.prepare(`UPDATE ${table} SET conversation_id=?`).run(other.conversation);
    d.close();
    f.value.snapshots.push({ ...structuredClone(f.value.snapshots[0]), agents: [other.agent], sidecar: otherSidecar }); update(f);
    const out = join(temp(), "exports"), worklist = join(temp(), "private.jsonl"), before = stamps(dirnameOf(f.web));
    const r = await run(f, { output: out, privateWorklist: worklist }); assertExports(out, r); expect(stamps(dirnameOf(f.web))).toEqual(before);
    expect(r.inventory.sources.web).toBe(1); expect(r.inventory.sources.sidecar).toBe(2);
    expect(r.inventory.entries).toEqual([{ entry: 1, excludedAgentThreads: 1 }, { entry: 2, excludedAgentThreads: 1 }]);
    expect(r.inventory.records.messages).toBe(16); expect(r.metrics.strata.map(g => g.entry)).toEqual([1, 2]);
    for (const m of r.metrics.strata) { expect(m.boundaries.total).toBe(1); expect(m.compactions.total).toBe(1); expect(m.packs.injected).toBe(1); expect(field(m.retrieval.reconciliation, "status", "matched")).toBe(1); }
    expect(r.outcomes.strata.map(g => g.windows)).toEqual([2, 2]);
    const lines = fs.readFileSync(worklist, "utf8").trim().split("\n").map(JSON.parse);
    expect(lines.filter(l => l.sourceIndex === 0).every(l => l.threadId === CANARY)).toBe(true);
    expect(lines.filter(l => l.sourceIndex === 1).every(l => l.threadId === other.thread)).toBe(true);
  });

  it("counts only excludedAgentThreads for unselected agents and never scans their parts", async () => {
    const f = fixture(temp()), other = addAgent(f);
    editDb(f, db => db.prepare("UPDATE messages SET parts_json=? WHERE thread_id=?").run(`{${CANARY}`, other.thread));
    const r = await run(f); expect(r.inventory.entries[0].excludedAgentThreads).toBe(1);
    expect(r.inventory.records.messages).toBe(8); expect(r.inventory.records.invalidRecords).toBe(0);
    expect(r.metrics.strata[0].boundaries.total).toBe(1); expect(r.metrics.strata[0].boundaries.coverage).toBe("complete");
  });

  it("refuses duplicate/overlapping agent sets and inconsistent sidecar bindings", async () => {
    for (const agents of [[`${CANARY}_agent`], [`${CANARY}_agent`, `${CANARY}_other_agent`], undefined]) {
      const f = fixture(temp()); f.value.snapshots.push({ ...structuredClone(f.value.snapshots[0]), agents }); update(f);
      await expect(run(f)).rejects.toThrow("DUPLICATE_SNAPSHOT");
    }
    for (const agents of [[], [CANARY, CANARY], [1]]) {
      const f = fixture(temp()); f.value.snapshots[0].agents = agents; update(f); await expect(run(f)).rejects.toThrow("INVALID_AGENT_BINDING");
    }
    const f = fixture(temp(), { sidecar: true }); delete f.value.snapshots[0].agents; update(f);
    await expect(run(f)).rejects.toThrow("SIDECAR_AGENT_BINDING_REQUIRED");
    f.value.snapshots[0].agents = [`${CANARY}_agent`]; f.value.snapshots.push({ ...structuredClone(f.value.snapshots[0]), agents: [`${CANARY}_other_agent`] }); update(f);
    await expect(run(f)).rejects.toThrow("SIDECAR_AGENT_BINDING_MISMATCH");
  });

  it("applies overlap checks only to each entry's selected agents in different web snapshots", async () => {
    const first = fixture(temp()), other = addAgent(first), second = fixture(temp()); addAgent(second);
    second.value.snapshots[0].agents = [other.agent]; first.value.snapshots.push(second.value.snapshots[0]); update(first);
    const r = await run(first); expect(r.metrics.strata.map(m => m.boundaries.total)).toEqual([1, 1]);
    expect(r.inventory.entries.map(e => e.excludedAgentThreads)).toEqual([1, 1]);
  });

  it("does not reconcile another agent's lifecycle failure, even with a colliding tool-call/record id", async () => {
    const f = fixture(temp(), { sidecar: true }), other = addAgent(f);
    f.value.snapshots[0].agents = [other.agent]; update(f);
    const d = new DatabaseSync(f.value.snapshots[0].sidecar); d.exec("UPDATE tool_calls SET state='error'"); d.close();
    editDb(f, db => db.prepare("UPDATE messages SET parts_json=? WHERE thread_id=? AND role='assistant' AND seq=3").run(JSON.stringify([tool({ structuredResult: undefined })]), other.thread));
    const r = await run(f), m = r.metrics.strata[0].retrieval;
    expect(field(m.reconciliation, "status", "unmatched")).toBe(1); expect(field(m.outcomes, "outcome", "unknown")).toBe(1);
  });

  it("refuses overlapping conversations in separately copied web snapshots", async () => {
    const f = fixture(temp()), duplicate = fixture(temp()); f.value.snapshots.push(duplicate.value.snapshots[0]); update(f);
    await expect(run(f)).rejects.toThrow("OVERLAPPING_SNAPSHOTS");
  });

  it("inventory-excludes non-owner and automated turns without inventing review windows", async () => {
    const f = fixture(temp()); editDb(f, db => db.exec("UPDATE threads SET trigger_kind='cron'"));
    const r = await run(f); expect(r.inventory.strata[0].excludedTurns).toBe(4);
    expect(r.inventory.strata[0].excludedConversations).toBe(1); expect(r.outcomes.strata[0].windows).toBe(0);
    expect(r.metrics.strata[0].boundaries.total).toBe(1);
  });

  it.each(["cron", "ownerless-wake"])("counts all boundary/compaction/pack metrics in excluded %s turns, with no review windows", async (kind) => {
    const f = fixture(temp());
    editDb(f, db => {
      if (kind === "cron") db.exec("UPDATE threads SET trigger_kind='cron'");
      else {
        db.exec("DELETE FROM messages WHERE role='user'");
        const parts = [ { type: "process-job-wake", jobId: CANARY, deliveryKey: CANARY }, boundary(), compaction(), pack(), tool() ];
        db.prepare("UPDATE messages SET parts_json=? WHERE id=?").run(JSON.stringify(parts), `${CANARY}_turn_1_assistant`);
      }
    });
    const r = await run(f), m = r.metrics.strata[0];
    expect(r.inventory.strata[0].excludedTurns).toBe(4); expect(m.boundaries.total).toBe(1);
    expect(m.compactions.total).toBe(1); expect(m.packs.injected).toBe(1); expect(m.retrieval.total).toBe(1);
    expect(m.followup.windows).toBe(0); expect(r.outcomes.strata[0].windows).toBe(0);
  });

  it("inventories unassigned system parts and missing turn records without losing their telemetry", async () => {
    const f = fixture(temp());
    editDb(f, db => {
      db.prepare("INSERT INTO messages VALUES(?,?,NULL,'system',?,?,?,'complete',0,0)").run("unassigned", CANARY, JSON.stringify([boundary(), { type: "conversation-marker", kind: "resumed" }]), at(1), at(1));
      db.prepare("INSERT INTO turns VALUES(?,?,?,?,?,?,?)").run("missing", CANARY, "complete", at(5), at(6), CANARY, CANARY);
    });
    const r = await run(f); expect(r.inventory.records.unassignedMessages).toBe(1); expect(r.inventory.records.systemMessages).toBe(1);
    expect(r.inventory.records.missingRecords).toBe(1); expect(r.metrics.strata[0].boundaries.total).toBe(2);
    expect(r.metrics.strata[0].boundaries.coverage).toBe("partial"); expect(r.outcomes.strata[0].windows).toBe(2);
  });

  it("retains unknown continuity coverage for version-2 sidecars", async () => {
    const f = fixture(temp(), { sidecar: true }); const d = new DatabaseSync(f.value.snapshots[0].sidecar);
    d.exec("PRAGMA user_version=2; DROP TABLE continuity_records; DROP TABLE continuity_generations"); d.close();
    expect((await run(f)).inventory.auxiliary.continuityRecords).toBe("unknown");
  });

  it("validates interval capture availability, exact strata coverage and duplicate snapshots", async () => {
    const f = fixture(temp()); f.value.snapshots[0].captureAvailableFrom = at(1); update(f); await expect(run(f)).rejects.toThrow("INVALID_SNAPSHOT");
    f.value.snapshots[0].captureAvailableFrom = START; f.value.snapshots[0].strata[0].start = at(1); update(f); await expect(run(f)).rejects.toThrow("INVALID_STRATA");
    f.value.snapshots[0].strata[0].start = START; f.value.snapshots.push(structuredClone(f.value.snapshots[0])); update(f); await expect(run(f)).rejects.toThrow("DUPLICATE_SNAPSHOT");
  });
});

it("uses creation time and rowid for message order and post-boundary retrieval, not write counters or UUID order", async () => {
  const f = fixture(temp(), { count: 1 });
  editDb(f, db => {
    db.prepare("DELETE FROM messages WHERE role='assistant'").run();
    const add = (id, second, seq, parts) => { const at = `2042-03-01T01:00:0${second}.000Z`;
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, CANARY, `${CANARY}_turn_1`, "assistant", JSON.stringify(parts), at, at, "complete", seq, 0); };
    add("a-late-retrieval", 3, 0, [tool()]); add("z-early-boundary", 1, 49, [boundary()]);
    add("z-tie-first", 2, 0, [{ type: "text", text: "Fictional first tie" }]); add("a-tie-next", 2, 87, [{ type: "text", text: "Fictional next tie" }]);
    const sql = statements(db), rows = sql.messages.all(`${CANARY}_turn_1`);
    expect(rows.slice(1).map(r => r.id)).toEqual(["z-early-boundary", "z-tie-first", "a-tie-next", "a-late-retrieval"]);
    const scanned = scanTurn(sql, { id: `${CANARY}_turn_1` });
    expect(scanned.events.map(e => e.kind)).toEqual(["session_boundary", "retrieval"]);
    expect(scanned.events[1].position).toBeGreaterThan(scanned.events[0].position);
  });
  const r = await run(f); expect(r.metrics.strata[0].followup.observedRetrieval).toBe(1);
});
