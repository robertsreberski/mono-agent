// Key-blind, provider-free fixtures. Split pins were executed from base a9a4aff6b.
import { expect, it } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openHarness, productionModules } from "../lib/continuity-runner.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { digest as hash } from "../lib/continuity-recorded-schema.mjs";
import { e2ToolPolicies } from "../lib/continuity-e2-registration.mjs";
import { shippingSoul, assertEffectiveSoul, createE2Models, loadE2Estimators, estimatedReply } from "../lib/continuity-e2-models.mjs";
import { e2HistorySurface, historySurfaceBinding, historyArguments, historyConfig, historyToolName, historyServerName, historyCallScope, assertHistorySurfaceBinding } from "../lib/continuity-e2-history.mjs";
import { assertE2BaselineContext, assertE2ReplayBinding, SOL, LUNA } from "../lib/continuity-e2-protocol.mjs";
import { lookupToolAllowlist, fauxLookupSafety, assertResolvedLookupSafety } from "../lib/continuity-lookup-pilot-runtime.mjs";
import { parseE2Args } from "../continuity-e2.mjs";
import { HISTORY_NOTICE, parseConversationHistoryText } from "../lib/continuity-observation-retrieval.mjs";
import { scanRows, retrieval } from "../lib/continuity-observation-events.mjs";
import { toolUseBlock } from "../lib/continuity-score.mjs";
import { loadE2Catalog, e2CatalogRates, e2RequestPrice } from "../lib/continuity-e2-pricing.mjs";
import { estimateE2Reservations } from "../lib/continuity-e2-estimate.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";

it.each([undefined, "split"])("keeps base-captured split soul, policy and execution for %s", async surface => {
  const base = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-split-base.json", import.meta.url)));
  expect(await shippingSoul(surface)).toEqual(base.soul);
  expect(JSON.stringify(e2ToolPolicies(undefined, surface))).toBe(JSON.stringify(base.policies));
  expect(historyConfig(surface)).toEqual({}); expect(historySurfaceBinding(surface)).toEqual({});
  expect(historyToolName(surface)).toBe("ConversationHistory"); expect(historyServerName(surface)).toBe("mono-agent-conversation-history");
  const args = { action: "search", query: "fictional" }; expect(historyArguments(surface, args)).toBe(args);
  const pilot = structuredClone(base.pilot);
  pilot.registration.soul = { rawDigest: (await shippingSoul(surface)).rawDigest, normalizedDigest: (await shippingSoul(surface)).normalizedDigest };
  pilot.registration.toolPolicies = e2ToolPolicies(undefined, surface);
  expect(JSON.stringify(pilot)).toBe(base.rawRegistration);
  expect(hash(JSON.stringify(pilot))).toBe(base.rawRegistrationSha256);
  expect(digest(pilot)).toBe(base.canonicalPilotDigest);
  pilot.registration.historySurface = "split";
  expect(hash(JSON.stringify(pilot))).not.toBe(base.rawRegistrationSha256);
  expect(digest(pilot)).not.toBe(base.canonicalPilotDigest);
});
it("selects only History with the pinned unified core and rejects mixed bindings", async () => {
  expect(e2ToolPolicies(undefined, "unified")).toMatchObject({ replay: ["History"], proof: ["History"], cancelContinuation: ["History", "ProofSentinel"] });
  expect(historyConfig("unified")).toEqual({ history: { unified: true } });
  expect(historyArguments("unified", { action: "search" })).toEqual({ scope: "said", action: "search" });
  const unified = await shippingSoul("unified"), split = await shippingSoul();
  assertEffectiveSoul({ systemPrompt: `## Core Guardrails\n\n${unified.text}\n\n## Identity\n\nFictional` }, unified);
  expect(() => assertEffectiveSoul({ systemPrompt: `## Core Guardrails\n\n${split.text}` }, unified)).toThrow("E2_SOUL_MISMATCH");
  for (const [a, b] of [["unified", undefined], ["split", "unified"]]) {
    expect(() => assertHistorySurfaceBinding({ historySurface: a }, { historySurface: b })).toThrow("e2_authorization_binding_mismatch");
    expect(() => assertE2ReplayBinding({ historySurface: a }, { historySurface: b })).toThrow("e2_authorization_binding_mismatch");
  }
  expect(() => e2HistorySurface("other")).toThrow("E2_ARGUMENTS_INVALID");
});
it.each(["size", "run", "proofs", "estimate"])("accepts the CLI selector for %s", command => {
  const required = command === "size" ? ["--source", "fictional", "--protocol", "fictional", "--output", "fictional"] : command === "run" ? ["--summary", "real", "--registration", "fictional", "--sha256", "fictional", "--authorization", "fictional", "--credentials", "fictional", "--output", "fictional"] : command === "proofs" ? ["--output", "fictional"] : ["--protocol", "fictional", "--limits", "fictional", "--sizing", "fictional", "--output", "fictional"];
  expect(parseE2Args([command === "estimate" ? "--estimate" : command, ...required, "--history-surface", "unified"])["history-surface"]).toBe("unified");
});
it.each(["said", "tools", "runs"])("attributes unified calls to %s only", scope => {
  expect(historyCallScope("History", { scope })).toBe(scope);
  expect(historyCallScope("mcp__mono-agent-history__History", { scope })).toBe(scope);
  expect(historyCallScope("mcp__external__History", { scope })).toBeUndefined();
  expect(historyCallScope("History", {})).toBeUndefined();
});
it.each(["History", "mcp__mono-agent-history__History", "ConversationHistory", "SessionHistory", "RunHistory"])("baseline refuses %s in source tools, calls and results", name => {
  for (const context of [{ tools: [{ name }] }, { messages: [{ role: "toolResult", toolName: name }] }, { messages: [{ role: "assistant", content: [{ type: "toolCall", name }] }] }])
    expect(() => assertE2BaselineContext(context, { kind: "source", historySurface: "unified" })).toThrow("E2_PROBE_TOOLS_REFUSED");
  expect(() => assertE2BaselineContext({ mcpServers: { "mono-agent-history": {} } }, { kind: "source", historySurface: "unified" })).toThrow("E2_PROBE_TOOLS_REFUSED");
});
it("keeps metering v1 split-only and selects History-aware v2 explicitly", () => {
  expect(lookupToolAllowlist()).toEqual({ version: "v1", tools: ["ConversationHistory"] });
  expect(lookupToolAllowlist("split")).toBe(lookupToolAllowlist());
  expect(lookupToolAllowlist("unified")).toEqual({ version: "v2", tools: ["ConversationHistory", "History"] });
});
it("parses scoped said framing without treating tools/runs as conversation evidence", () => {
  const body = { scope: "said", notice: HISTORY_NOTICE, untrusted: true, status: "available", navigation: { guidance: "Fictional guidance.", nextActions: [] } };
  const text = `History navigation (scope: said; tool-authored guidance):\n${HISTORY_NOTICE}\nFictional guidance.\nNo follow-up History call is available.\n${HISTORY_NOTICE}\n${JSON.stringify(body)}`;
  expect(parseConversationHistoryText(text)).toEqual(body);
  for (const scope of ["tools", "runs"]) expect(parseConversationHistoryText(text.replaceAll("said", scope))).toBeUndefined();
});
it("extends tool-use name recognition without changing accuracy or call aggregation", () => {
  const trial = name => ({ category: "exact", score: { pass: true }, boundary: { observed: { toolsOffered: [name], conversationHistory: { calls: 1, search: 1 } } } });
  const legacy = toolUseBlock([trial("ConversationHistory")]), unified = toolUseBlock([trial("History")]);
  const { toolName, ...rest } = unified; expect(toolName).toBe("History"); expect(rest).toEqual(legacy);
});
it("accepts, tiers, reserves and admits a fictional 500K Sol summary role only", async () => {
  const catalog = await loadE2Catalog(), sol = catalog.find(c => c.model === SOL);
  expect(sol.contextWindow).toBe(500000);
  expect(e2CatalogRates(sol, 272000)).toMatchObject({ input: 2000n, output: 10000n });
  expect(e2CatalogRates(sol, 272001)).toMatchObject({ input: 4000n, output: 15000n });
  const roles = [ { role: "summary", model: SOL, maxInputTokens: 500000, maxOutputTokens: 128000, expectedOutputTokens: 512 }, { role: "probe", model: SOL, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 }, { role: "summary", model: LUNA, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 } ];
  const size = { method: "intercepted-full-models-context", serializedBytes: 1500000, serializedBytesOver3: 500000, engineFullRequest: 490000, maximum: 500000, usage: "engine-estimate-not-provider-measurement" };
  const requests = [{ checkpoint: 0, role: "summary", paidRole: "summary", model: SOL, size }];
  const estimate = estimateE2Reservations({ roles, requests, catalog });
  expect(estimate.checkpoints[0]).toMatchObject({ maxInputTokens: 500000, fundedInputTokens: 500000, maxReservationUnits: "8840000000", centralUnits: "1057680000" });
  const pilot = { registration: { roles, catalog, toolPolicies: e2ToolPolicies() } }, planned = { kind: "proof", arm: "switch", budgets: [{ checkpoint: 0, paidRole: "summary", model: SOL, maxRequests: 1 }] };
  const p = { requestId: "fictional:1", slotId: "b".repeat(64), round: 1, payloadDigest: "a".repeat(64), inputTokens: 500000, paidRole: "summary", model: SOL, checkpoint: 0, reservationUnits: e2RequestPrice(sol, { inputTokens: 500000, maxOutputTokens: 128000 }).reservationUnits };
  expect(e2ExecutionPolicy.admission(pilot, planned, { holds: [], compaction: { checkpoint: 0, operationDigest: "d".repeat(64) } }, p).reserve).toBe(8840000000n);
  expect(() => e2ExecutionPolicy.admission(pilot, planned, { holds: [], compaction: { checkpoint: 0, operationDigest: "d".repeat(64) } }, { ...p, inputTokens: 500001 })).toThrow("not_admitted_input_envelope");
  expect(() => estimateE2Reservations({ roles, requests: [{ ...requests[0], role: "probe", paidRole: "probe" }], catalog })).toThrow("E2_ESTIMATE_INVALID");
  expect(() => estimateE2Reservations({ roles, requests: [{ ...requests[0], model: LUNA }], catalog })).toThrow("E2_ESTIMATE_INVALID");
});

it("recognizes said-only persisted observations and retains legacy scoring outcomes", () => {
  const p = { type: "tool-call", toolName: "History", toolCallId: "fictional-call", args: { scope: "said", action: "search" }, status: "complete", structuredResult: { status: "available", count: 2 } };
  const scan = part => scanRows({ parts: { get: () => ({ parts_json: JSON.stringify([part]) }) } }, [{ id: "fictional" }]);
  const observed = scan(p);
  expect(observed.events).toHaveLength(1);
  const legacy = { ...p, toolName: "ConversationHistory", args: { action: "search" } };
  expect(retrieval(p)).toEqual(retrieval(legacy));
  for (const scope of ["tools", "runs"]) expect(scan({ ...p, args: { scope, action: "search" } }).events).toHaveLength(0);
});

it.each([undefined, "split", "unified"])("enforces the metered tool/config surface for %s", historySurface => {
  const safety = { ...fauxLookupSafety({ judge: null }, { midCheckpoint: null, ledgerUpkeep: false }), historySurface };
  safety.config.tools = { ...historyConfig(historySurface), allowedTools: [historyToolName(historySurface)] };
  expect(() => assertResolvedLookupSafety(safety)).not.toThrow();
  safety.config.tools.allowedTools = [historySurface === "unified" ? "ConversationHistory" : "History"];
  expect(() => assertResolvedLookupSafety(safety)).toThrow("lookup_tools_forbidden");
});
it("offers and executes all three shipping scopes through the unified harness", async () => {
  const root = await mkdtemp(join(tmpdir(), "fictional-history-surface-")), work = join(root, "work");
  let opened;
  try {
    const { mkdir } = await import("node:fs/promises"); await mkdir(work); await writeFile(join(work, "IDENTITY.md"), "Fictional offline scope rehearsal.");
    const modules = await productionModules(ROOT), estimators = await loadE2Estimators(), soul = await shippingSoul("unified");
    let round = 0; const results = [];
    const route = createE2Models({ pi: modules.pi, estimators, soul, historySurface: "unified", models: [{ model: SOL }], limits: { sourceRequests: 4, probeRequests: 0, compactions: 0 },
      sourceContext(context) {
        const offered = context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []);
        expect(offered.map(t => t.name)).toEqual(["History"]);
        for (const scope of ["said", "tools", "runs"]) expect(offered[0].description).toContain(`scope ${scope}`);
        results.push(...context.messages.filter(m => m.role === "toolResult"));
      },
      sourceReply(context) {
        const scope = ["said", "tools", "runs"][round++];
        return estimatedReply(modules.pi, scope ? [modules.pi.fauxToolCall("History", { scope, action: "search" }, { id: `fictional-${scope}` })] : "Fictional complete.", context, estimators, { stopReason: scope ? "toolUse" : "stop" });
      },
    });
    route.setPosition({ model: SOL, turn: 0, message: 0 });
    opened = await openHarness({ modules, work, authPath: join(root, "absent.json"), model: SOL, effort: "none", tools: false, clock: { value: new Date("2040-01-01") },
      configPatch: { tools: { history: { unified: true }, allowedTools: ["History"] }, runtime: { compaction: { enabled: false } } }, route: async () => ({ piModelsDecorator: route.decorator }),
    });
    const result = await opened.harness.run({ conversationId: "web:fictional-scopes", userMessage: "Inspect fictional history without effects.", abortSignal: new AbortController().signal });
    expect(result.failure).toBeUndefined();
    expect(new Set(results.map(r => r.toolCallId))).toEqual(new Set(["fictional-said", "fictional-tools", "fictional-runs"]));
    expect(results.every(r => !r.isError)).toBe(true);
  } finally { await opened?.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

it.each([undefined, "split"])("pins the split baseline refusal set to executed base source for %s", async historySurface => {
  const base = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-split-base.json", import.meta.url)));
  for (const { context, refusal } of base.baselineSourceCases) {
    let actual = null;
    try { assertE2BaselineContext(context, { kind: "source", historySurface }); } catch (error) { actual = error.code; }
    expect(actual, JSON.stringify(context)).toBe(refusal);
  }
});
it("keeps the capacity scan's explicit 272K fit/fallback fixture byte-identical to base", async () => {
  const base = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-split-base.json", import.meta.url)));
  expect(hash(await readFile(new URL("../lib/continuity-e2-capacity.mjs", import.meta.url)))).toBe(base.capacitySourceSha256);
});
it("captures the sizing fork binding before evaluating the history helper", async () => {
  const source = await readFile(new URL("../continuity-e2.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";/gmu)].map(m => m[1]);
  expect(imports[0]).toBe("./lib/continuity-e2-sizing-process.mjs");
  expect(imports.indexOf("./lib/continuity-e2-history.mjs")).toBeGreaterThan(0);
});
it.each([undefined, "split", "unified"])("carries baseline surface from funding into serialized-body checks for %s", async historySurface => {
  const catalog = await loadE2Catalog(), sol = catalog.find(c => c.model === SOL);
  const pilot = { registration: { replayArm: "baseline", ...historySurfaceBinding(historySurface), catalog,
    roles: [{ role: "summary", model: SOL, maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 }], toolPolicies: e2ToolPolicies("baseline", historySurface) } };
  const planned = { kind: "replay", arm: "baseline", budgets: [{ checkpoint: 0, paidRole: "summary", model: SOL, maxRequests: 1 }] };
  const p = { requestId: "fictional:1", slotId: "b".repeat(64), round: 1, payloadDigest: "a".repeat(64), inputTokens: 100, paidRole: "summary", model: SOL, checkpoint: 0,
    reservationUnits: e2RequestPrice(sol, { inputTokens: 100, maxOutputTokens: 128000 }).reservationUnits };
  const { metadata } = e2ExecutionPolicy.admission(pilot, planned, { holds: [], compaction: { checkpoint: 0, operationDigest: "d".repeat(64) } }, p);
  expect(metadata.historySurface).toBe(historySurface === "unified" ? "unified" : undefined);
  const body = Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", store: false, stream: true, input: [{ type: "function_call", name: "History", arguments: "{}" }] }));
  if (historySurface === "unified") expect(() => e2ExecutionPolicy.assertBody(body, metadata)).toThrow("E2_PROBE_TOOLS_REFUSED");
  else expect(() => e2ExecutionPolicy.assertBody(body, metadata)).not.toThrow();
});
