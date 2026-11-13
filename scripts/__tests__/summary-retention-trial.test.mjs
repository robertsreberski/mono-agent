import { createHash } from "node:crypto";
import { runTrialHostReseed } from "../lib/summary-retention-host.mjs";
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrialFixtures, loadTrialModules, resolveTrialCatalog, resolveTrialModels, runTrialChain, runTrial,
  controlSummary, scoreTrialSummary, rescoreTrial, tupleAssertion, createTrialBudget, requestReservation } from "../lib/summary-retention-trial.mjs";

const reply = text => ({ stopReason: "stop", content: [{ type: "text", text }], usage: {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });

// Preload in the child itself: a Vitest fetch stub cannot protect subprocesses.
const networkGuard = `
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const deny = () => { throw Error("Network forbidden"); };
globalThis.fetch = deny;
for (const client of [http, https]) { client.request = deny; client.get = deny; }
syncBuiltinESMExports();
`;
async function rescoreCli(root, source) {
  const input = join(root, "fictional-trial.json"), guard = join(root, "network-guard.mjs");
  await writeFile(input, JSON.stringify(source));
  await writeFile(guard, networkGuard);
  return spawnSync(process.execPath, ["--import", guard, "scripts/lib/summary-retention-trial.mjs", "--rescore", input], { encoding: "utf8" });
}

// Pre-declared v2 controls, built only from the public frozen fixture fields.
// These renderers intentionally do not call the scorer's assertion builder.
function renderControl(tuple, format) {
  if (format === "literal") return tuple.reference;
  const [subject, value] = tuple.fields[0].split(": ");
  if (format === "shipping") return tuple.reference.replace(": ", `; m${tuple.introduced}; `)
    .replace("current ", "current reported value ");
  switch (tuple.kind) {
    case "historical": return `${subject} ${tuple.fields[1]} on ${value} (historical event).`;
    case "decision": return `${subject}: reported decision, ${value.replace(" selected", " was selected")}.`;
    case "correction": return `${subject}, previously ${value.replace(" previously", "")}, now ${tuple.fields[2].replace("current ", "")}.`;
    case "pending": return `${subject}: ${value.replace(" to ", " will ")}, remains pending, ${tuple.fields[2]}.`;
    case "resolved": return `${subject}: ${value.replace(" paid ", " paid on ")}, resolved, no further payment.`;
    default: throw Error("Unknown control kind");
  }
}

describe("pre-declared v2 scorer control matrix", () => {
  it.each(["literal", "shipping", "prose"])("retains every fixture's 12 tuples in %s form at every checkpoint", async format => {
    for (const fixture of (await loadTrialFixtures()).fixtures) {
      for (let stage = 1; stage <= 4; stage++) {
        const summary = fixture.tuples.filter(tuple => tuple.introduced <= stage).map(tuple => renderControl(tuple, format)).join("\n");
        const score = scoreTrialSummary(fixture, stage, summary);
        expect(score.scorerVersion).toBe(2);
        expect(score.pass, `${fixture.id}/${stage}/${format}: ${JSON.stringify(score)}`).toBe(true);
      }
    }
  });

  it("declares explicit per-kind roles without changing the frozen facts", async () => {
    for (const fixture of (await loadTrialFixtures()).fixtures) {
      expect(tupleAssertion(fixture.tuples[6])).toMatchObject({ kind: "correction", predecessor: "18", current: "16" });
      expect(tupleAssertion(fixture.tuples[4])).toMatchObject({ selected: "east", rejected: "west" });
      expect(tupleAssertion(fixture.tuples[9])).toMatchObject({ actor: "Morgan", action: "request", state: "no approval" });
      expect(tupleAssertion(fixture.tuples[11])).toMatchObject({ actor: "Casey", date: "2031-04-09", state: "no repeat payment" });
    }
  });

  it("rejects swapped predecessors/current, missing corrections, extensions, and contradictory current slots", async () => {
    for (const fixture of (await loadTrialFixtures()).fixtures) {
      for (const tuple of fixture.tuples.filter(row => row.kind === "correction")) {
        const old = tuple.fields[0].split(": ")[1].replace(" previously", "");
        const current = tuple.fields[2].replace("current ", "");
        const mutations = [
          tuple.reference.replaceAll(old, "__old__").replaceAll(current, old).replaceAll("__old__", current),
          tuple.reference.replace(`${tuple.fields[1]}; `, ""),
          tuple.reference.replaceAll(current, `${current}0`),
          tuple.reference.replace(`current ${current}`, `current ${old}`),
          tuple.reference.replace(`${old} previously`, `${old} current`),
          tuple.reference.replace(`current ${current}`, `current ${current}0`),
          tuple.reference.replace(tuple.fields[1], `not ${tuple.fields[1]}`),
        ];
        for (const mutation of mutations) {
          const summary = fixture.tuples.map(row => row.id === tuple.id ? mutation : row.reference).join("\n");
          const score = scoreTrialSummary(fixture, 4, summary);
          expect(score.tuples.find(row => row.id === tuple.id).retained, mutation).toBe(false);
          expect(score.pass, mutation).toBe(false);
        }
      }
    }
  });

  it("rejects lost/contradictory states, swapped choices, missing names and cross-line bags of values", async () => {
    for (const fixture of (await loadTrialFixtures()).fixtures) {
      const reference = fixture.tuples.map(tuple => tuple.reference).join("\n");
      for (const [before, after] of [
        ["pending; no approval", "no approval"], ["resolved; no repeat payment", "pending; no repeat payment"],
        ["pending; not done", "resolved; not done"], ["resolved; no repeat payment", "resolved"],
        ["east selected over west", "west selected over east"], ["Morgan to request", "Morgana to request"],
        ["arrived; historical", "not arrived; historical"],
        ["Morgan to request", "Morgan to verify; Avery to request"],
        ["Casey paid", "Casey noted; Avery paid"],
        ["pending; no approval", "not pending; no approval"],
        ["resolved; no repeat payment", "not settled; no repeat payment"],
        ["18 previously; corrected to 16; current 16", "18; 16; previously; corrected to; current"],
        ["18 previously; corrected to 16; current 16", "18 previously\ncorrected to 16; current 16"],
      ]) {
        expect(reference).toContain(before);
        expect(scoreTrialSummary(fixture, 4, reference.replace(before, after)).pass, after).toBe(false);
      }
      const singleLine = fixture.tuples.map(tuple => tuple.reference).join(" ");
      expect(scoreTrialSummary(fixture, 4, singleLine).pass).toBe(true);
      const swappedDates = singleLine.replace("2031-04-01", "__date__").replace("2031-04-02", "2031-04-01").replace("__date__", "2031-04-02");
      expect(scoreTrialSummary(fixture, 4, swappedDates).pass).toBe(false);
      const block = reference.replace("18 previously; corrected to 16; current 16", "m2\n  18 previously\n  corrected to 16\n  current 16");
      expect(scoreTrialSummary(fixture, 4, block).pass).toBe(true);
    }
  });

  it("binds historical outcomes to the subject and rejects explicit conflicting outcomes", async () => {
    for (const fixture of (await loadTrialFixtures()).fixtures) {
      for (const tuple of fixture.tuples.filter(row => row.kind === "historical")) {
        const event = tuple.fields[1];
        for (const outcome of [`not ${event}; unrelated painting ${event}`, `unrelated painting ${event}`, `${event}; not ${event}`]) {
          const summary = fixture.tuples.map(row => row.id === tuple.id ? row.reference.replace(`; ${event};`, `; ${outcome};`) : row.reference).join("\n");
          const score = scoreTrialSummary(fixture, 4, summary);
          expect(score.tuples.find(row => row.id === tuple.id).retained, summary).toBe(false);
          expect(score.pass).toBe(false);
        }
        // A negative outcome for a different subject must not negate this event.
        const summary = fixture.tuples.map(row => row.id === tuple.id ? `${row.reference} unrelated painting not ${event}` : row.reference).join("\n");
        expect(scoreTrialSummary(fixture, 4, summary).pass).toBe(true);
      }
    }
  });

  it("accepts qualified warnings but never lets another clause negate a positive promotion", async () => {
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const reference = fixture.tuples.map(tuple => tuple.reference).join("\n");
    for (const warning of [
      "Approval and owner authority remain unestablished.", "Permission remains unresolved.",
      "Current roster: team ochre was only proposed.", "Owner authority is absent.",
      "PHANTOM-77 approval was not granted.", "Z0 is not current.",
      "Current Z0 is hypothetical, not an actual correction.",
    ]) expect(scoreTrialSummary(fixture, 4, `${reference}\n${warning}`).pass, warning).toBe(true);
    for (const claim of [
      "approval granted for PHANTOM-77", "owner authority established", "current Z0", "team ochre is selected",
      "Approval remains unresolved; approval granted for PHANTOM-77.",
      "No owner authority, but approval granted for PHANTOM-77.",
      "Approval granted and owner authority remains unestablished.",
      "No approval and selected team ochre.",
      "Z0 is hypothetical; current Z0.", "Team ochre was only proposed, but team ochre is selected.",
    ]) expect(scoreTrialSummary(fixture, 4, `${reference}\n${claim}`).pass, claim).toBe(false);
  });

  it("accepts only request-supplied provenance, never another chain or future checkpoint", async () => {
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const reference = fixture.tuples.map(tuple => tuple.reference).join("\n");
    const supplied = `chr1_fictional-record sha256="${"a".repeat(64)}" record id: fictional-source`;
    const requests = [{ stage: 3, context: { messages: [{ role: "user", content: [{ type: "text", text: supplied }] }] } }];
    expect(scoreTrialSummary(fixture, 4, `${reference}\n${supplied}`, { requests }).pass).toBe(true);
    for (const invented of ["chr1_invented-record", "chr1_FICTIONAL-record", `sha256=${"b".repeat(64)}`, "sha256=fictional-invalid-digest", "record id: invented-source", "attested by fictional-source", "verified owner fictional-source"]) {
      const score = scoreTrialSummary(fixture, 4, `${reference}\n${invented}`, { requests });
      expect(score.inventedProvenance, invented).toHaveLength(1);
      expect(score.pass).toBe(false);
    }
    expect(scoreTrialSummary(fixture, 4, `${reference}\n${supplied}`).inventedProvenance).toHaveLength(1);
    expect(scoreTrialSummary(fixture, 2, supplied, { requests }).inventedProvenance).toHaveLength(1);
  });

  it("rescores v1 offline, preserving accounting and dry-run/stopped labels, without mutating the input", async () => {
    const fixtures = await loadTrialFixtures(), fixture = fixtures.fixtures[0];
    const request = { stage: 4, context: { messages: [{ role: "user", content: [{ type: "text", text: "chr1_fictional-input" }] }] } };
    const source = { schema: "summary-retention-trial-v1", fixturesSha256: fixtures.sha256, status: "fail", budget: { accountedUsd: 0.123 },
      chains: [{ fixture: fixture.id, requests: [request], pass: false, checkpoints: [{ checkpoint: 4, pass: false,
        summary: fixture.tuples.map(tuple => renderControl(tuple, "shipping")).join("\n") + "\nchr1_fictional-input" }] }] };
    const forbiddenNetwork = vi.fn(() => { throw Error("Network forbidden"); });
    vi.stubGlobal("fetch", forbiddenNetwork);
    try {
      const report = await rescoreTrial(source);
      expect(report).toMatchObject({ status: "pass", scorerVersion: 2, rescoredFromVersion: 1, budget: source.budget });
      expect(report.chains[0].pass).toBe(true);
      expect(source.status).toBe("fail");
      const otherChain = { ...source.chains[0], requests: [{ ...request, context: { messages: [] } }] };
      const scoped = await rescoreTrial({ ...source, chains: [source.chains[0], otherChain] });
      expect(scoped.chains.map(chain => chain.pass)).toEqual([true, false]);
      expect(scoped.status).toBe("fail");
      const partial = await rescoreTrial({ ...source, status: "stopped", progress: source.chains[0] });
      expect(partial.progress.pass).toBe(true);
      expect(partial.status).toBe("stopped");
      for (const status of ["dry-run", "stopped"]) expect((await rescoreTrial({ ...source, status })).status).toBe(status);
      await expect(rescoreTrial({ ...source, fixturesSha256: "wrong" })).rejects.toThrow("digest");
      await expect(rescoreTrial({ ...source, chains: [{ ...source.chains[0], requests: [] }] })).rejects.toThrow("request inputs");
      const root = await mkdtemp(join(tmpdir(), "summary-trial-rescore-"));
      try {
        const input = join(root, "fictional-trial.json");
        const result = await rescoreCli(root, source);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(report);
        expect(JSON.parse(await readFile(input, "utf8"))).toEqual(source);
      } finally { await rm(root, { recursive: true, force: true }); }
      expect(forbiddenNetwork).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("refuses empty chain/checkpoint inventories with specific offline diagnostics", async () => {
    const fixtures = await loadTrialFixtures(), fixture = fixtures.fixtures[0];
    const root = await mkdtemp(join(tmpdir(), "summary-trial-empty-"));
    try {
      for (const [chains, reason] of [
        [[], "Missing rescore chains"],
        [[{ fixture: fixture.id, requests: [], checkpoints: [] }], "Missing rescore checkpoints"],
      ]) {
        const source = { schema: "summary-retention-trial-v1", fixturesSha256: fixtures.sha256, status: "pass", chains };
        await expect(rescoreTrial(source)).rejects.toThrow(reason);
        const result = await rescoreCli(root, source);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`Offline rescore refused: ${reason}`);
        expect(result.stdout).toBe("");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("derives CLI exit status from rescored checkpoints, partial progress and completion status", async () => {
    const fixtures = await loadTrialFixtures(), fixture = fixtures.fixtures[0];
    const chain = { fixture: fixture.id, requests: [{ stage: 4, context: { messages: [] } }],
      checkpoints: [{ checkpoint: 4, summary: fixture.tuples.map(tuple => tuple.reference).join("\n") }] };
    const failed = { ...chain, checkpoints: [{ checkpoint: 4, summary: "Missing all tuples." }] };
    const source = { schema: "summary-retention-trial-v1", fixturesSha256: fixtures.sha256, chains: [chain] };
    const root = await mkdtemp(join(tmpdir(), "summary-trial-exit-"));
    try {
      for (const [status, scoredChain, progress, expected] of [
        ["pass", chain, undefined, 0], ["dry-run", chain, undefined, 0],
        ["pass", failed, undefined, 1], ["dry-run", failed, undefined, 1],
        ["stopped", failed, undefined, 1], ["stopped", chain, undefined, 1],
        ["running", chain, undefined, 1], ["incomplete", chain, undefined, 1],
        ["stopped", chain, failed, 1], ["dry-run", chain, failed, 1],
        ["pass", chain, chain, 1],
      ]) {
        const result = await rescoreCli(root, { ...source, status, chains: [scoredChain], ...(progress ? { progress } : {}) });
        expect(result.status, `${status}: ${result.stderr}`).toBe(expected);
        const report = JSON.parse(result.stdout);
        expect(report.chains[0].pass).toBe(scoredChain === chain);
        if (progress) expect(report.progress.pass).toBe(progress === chain);
      }
      const invalid = await rescoreCli(root, { ...source, status: "pass", fixturesSha256: "wrong" });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("Unknown trial or fixture digest");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preloads the child network guard for fetch and named http/https exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-trial-network-guard-"));
    try {
      const guard = join(root, "network-guard.mjs");
      await writeFile(guard, networkGuard);
      const result = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", `
        import { request as httpRequest, get as httpGet } from "node:http";
        import { request as httpsRequest, get as httpsGet } from "node:https";
        let blocked = 0;
        for (const attempt of [() => fetch("data:text/plain,offline"), ...[httpRequest, httpGet, httpsRequest, httpsGet].map(fn => () => fn("guard:offline"))]) {
          try { attempt(); } catch (error) { if (error.message !== "Network forbidden") throw error; blocked++; }
        }
        if (blocked !== 5) throw Error("Network guard inactive");
      `], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

});

describe("frozen fictional summary qualification", () => {
  it("freezes 3 inventories with 12 in-capacity tuples and explicit semantic fields", async () => {
    const { fixtures, sha256 } = await loadTrialFixtures();
    expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const fixture of fixtures) {
      expect(fixture.tuples).toHaveLength(12);
      expect(Buffer.byteLength(fixture.tuples.map(t => t.reference).join("\n"))).toBeLessThanOrEqual(2400);
      expect(fixture.tuples.reduce((counts, t) => ({ ...counts, [t.kind]: (counts[t.kind] ?? 0) + 1 }), {})).toEqual({ historical: 4, decision: 2, correction: 3, pending: 2, resolved: 1 });
      const reference = fixture.tuples.map(t => t.reference).join("\n");
      expect(scoreTrialSummary(fixture, 4, reference).pass).toBe(true);
      expect(scoreTrialSummary(fixture, 4, reference.replace("current 16", "current 18")).pass).toBe(false);
      for (const invented of ["PHANTOM-77 approval granted", "verified owner says yes", "Date 2032-12-30", "attested by the director", "current Z0", "selected team ochre"]) {
        expect(scoreTrialSummary(fixture, 4, reference + "\n" + invented).pass).toBe(false);
      }
      for (const invented of ["record id: fictional-source", "record id= fictional-source", "record id : fictional-source"]) {
        const scored = scoreTrialSummary(fixture, 4, reference + "\n" + invented);
        expect(scored.pass).toBe(false);
        expect(scored.inventedProvenance).toEqual([invented]);
      }
      expect(scoreTrialSummary(fixture, 4, reference + '\nQuoted hypothetical "approval granted for PHANTOM-77" is not permission.').pass).toBe(true);
    }
  });

  it("matches complete tuple fields without accepting numeric, code or word extensions", async () => {
    const { fixtures } = await loadTrialFixtures();
    for (const fixture of fixtures) {
      const reference = fixture.tuples.map(tuple => tuple.reference).join("\n");
      for (const [before, after] of [["current 16", "current 160"], ["current C9", "current C90"],
        ["corrected to 16", "corrected to 160"], ["replaced by C9", "replaced by C90"],
        ["current 2031-05-12", "current 2031-05-120"], ["pending; no approval", "pendingly; no approval"],
        ["no approval.", "no approvalGranted."], ["reported decision.", "reported decisions."]]) {
        expect(reference).toContain(before);
        const scored = scoreTrialSummary(fixture, 4, reference.replace(before, after));
        expect(scored.pass, after).toBe(false);
        expect(scored.tuples.some(tuple => !tuple.retained), after).toBe(true);
      }
      for (const bullet of ["", "- ", "* ", "+ ", "1. ", "2) "]) {
        const formatted = fixture.tuples.map(tuple => `${bullet}${tuple.reference.toUpperCase().replaceAll("; ", " ;  ").replace(/\.$/u, "!")}`).join("\n");
        expect(scoreTrialSummary(fixture, 4, formatted).pass, bullet).toBe(true);
      }
    }
  });

  it.each([false, true])("chains real preparation/durable checkpoints and %s cold reseeds with retaining/lossy controls", async coldReseeds => {
    const modules = await loadTrialModules(); modules.trialEffort = "low";
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const [{ model }] = await resolveTrialCatalog(modules, resolveTrialModels());
    const fact = fixture.tuples[0].reference;
    for (const lossy of [false, true]) {
      const complete = vi.fn(async (_model, context) => reply(controlSummary(context, lossy)));
      const result = await runTrialChain({ modules, fixture, model, cap: 2000, repetition: 1, coldReseeds, complete });
      expect(result.requests).toHaveLength(5);
      expect(result.checkpoints).toHaveLength(4);
      expect(result.reseeds).toHaveLength(coldReseeds ? 3 : 0);
      expect(result.checkpoints.map(c => c.isSplitTurn)).toEqual([false, false, true, false]);
      expect(result.pass).toBe(!lossy);
      expect(result.summaryFocus).toEqual({ version: 3, sha256: createHash("sha256").update(modules.SUMMARY_FOCUS).digest("hex") });
      expect(result.requests.every(request => request.context.systemPrompt.includes("Mono-agent summary focus v3:"))).toBe(true);
      expect(JSON.stringify(result.requests[0].context)).toContain(fact);
      // No fixture oracle is fed to the control. Once absent from the previous
      // summary AND retained tail, the next shipping request cannot recover it.
      expect(JSON.stringify(result.requests[1].context).includes(fact)).toBe(!lossy);
      expect(result.checkpoints.every(c => c.summary.includes(fact))).toBe(!lossy);
      if (!coldReseeds) expect(JSON.stringify(result.requests[1].context)).toContain("<previous-summary>");
      for (const request of result.requests) {
        expect(request.context.messages[0].content[0].text.startsWith("<conversation>\n")).toBe(true);
        expect(request.bytes).toBeLessThanOrEqual(65536);
        expect(request.options).toMatchObject({ transport: "sse", maxRetries: 0, reasoning: "low" });
      }
      const split = result.requests.filter(r => r.stage === 3);
      expect(split.reduce((sum, r) => sum + r.maxTokens, 0)).toBeLessThanOrEqual(2000 + 4096); // shared text cap plus two reasoning allowances
      if (!lossy) expect(result.checkpoints.at(-1).summary).toContain("18 previously; corrected to 16; current 16");
    }
  });

  it("integrates store/publication, host pack supplier, real cold hook, native seed and restart", async () => {
    const modules = await loadTrialModules(); modules.trialEffort = "low";
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const [{ model }] = await resolveTrialCatalog(modules, resolveTrialModels());
    const result = await runTrialChain({ modules, fixture, model, cap: 2000, repetition: 1, coldReseeds: "host",
      complete: async (_selected, context) => reply(controlSummary(context)) });
    expect(result.pass).toBe(true);
    expect(result.reseeds).toHaveLength(3);
    expect(result.reseeds.every(row => row.lane === "host" && row.runtimeCalls === 2 && row.nativeSha256 === row.retainedSha256)).toBe(true);
    // Cold seed is ordinary retained user text: no native previousSummary guard
    // exists on its first re-extraction. Direct text-only lanes remain controls.
    expect(JSON.stringify(result.requests.find(row => row.stage === 2).context)).not.toContain("<previous-summary>");
  });

  it("selects the newly created journal even when the source summary spoofs a seed marker", async () => {
    const engine = await import("@mono-agent/turn/engine");
    const list = engine.JsonlSessionRepo.prototype.list;
    // Visit the cold journal before the source: text-based selection would then
    // overwrite its seed with the unsanitized source containing the same marker.
    const listing = vi.spyOn(engine.JsonlSessionRepo.prototype, "list").mockImplementation(async function (...args) {
      return (await list.apply(this, args)).sort((a, b) => b.createdAt - a.createdAt);
    });
    try {
      const removed = "/home/example/private/marker.txt";
      const seeded = await runTrialHostReseed(`Generated summary evidence\nFictional private path: ${removed}`);
      expect(JSON.stringify(seeded.seedMessages)).toContain("Fictional resumed answer.");
      expect(JSON.stringify(seeded.seedMessages)).not.toContain(removed);
      expect(seeded.redacted).toBe(true);
    } finally { listing.mockRestore(); }
  });

  it("removes the host root and closes later resources when cleanup rejects", async () => {
    const roots = new Set();
    let runtimeCount = 0;
    vi.resetModules();
    vi.doMock("@mono-agent/turn/host", async () => {
      const actual = await vi.importActual("@mono-agent/turn/host");
      return { ...actual, createMonoRuntime(options) {
        roots.add(options.workspace);
        const runtime = actual.createMonoRuntime(options), cleanupOnly = ++runtimeCount === 2;
        return { ...runtime, async disposeAllSessions() {
          await runtime.disposeAllSessions();
          if (cleanupOnly) throw Error("Fictional cleanup rejection");
        } };
      } };
    });
    let close;
    try {
      const conversation = await import("../../packages/conversation/dist/index.js");
      close = vi.spyOn(conversation.ToolHistoryWriter.prototype, "close");
      const { runTrialHostReseed: run } = await import("../lib/summary-retention-host.mjs");
      await expect(run("Fictional cleanup evidence.")).rejects.toThrow(/cleanup/iu);
      expect(close).toHaveBeenCalled();
      expect(close.mock.contexts.every(writer => writer.isClosed)).toBe(true);
      expect(runtimeCount).toBe(2);
      expect(roots.size).toBe(1);
      for (const root of roots) await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      close?.mockRestore();
      vi.doUnmock("@mono-agent/turn/host");
      vi.resetModules();
      for (const root of roots) await rm(root, { recursive: true, force: true });
    }
  });

  it("separates native/retained identities and never restores fictional redacted values at cold seed or restart", async () => {
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const removed = "/home/example/private/record.txt";
    const native = `## Historical events and corrections\n${fixture.tuples.map(tuple => tuple.reference).join("\n")}\nPrivate fixture path: ${removed}`;
    const seeded = await runTrialHostReseed(native);
    expect(seeded.redacted).toBe(true);
    expect(seeded.nativeSha256).not.toBe(seeded.retainedSha256);
    expect(seeded.retainedText).not.toContain(removed);
    for (const context of [...seeded.contexts, { messages: seeded.seedMessages }]) {
      expect(JSON.stringify(context)).not.toContain(removed);
      expect(JSON.stringify(context)).not.toContain(seeded.nativeSha256);
      const text = context.messages.flatMap(message => typeof message.content === "string" ? [message.content] : (message.content ?? []).filter(part => part.type === "text").map(part => part.text)).join("\n");
      expect(text).toContain(JSON.stringify(seeded.retainedText));
      expect(JSON.stringify(context)).toContain(seeded.retainedSha256);
    }
  });

  it("accepts quoted cold-pack IDs and digests from real request inputs", async () => {
    const modules = await loadTrialModules(); modules.trialEffort = "low";
    const fixture = (await loadTrialFixtures()).fixtures[0];
    const [{ model }] = await resolveTrialCatalog(modules, resolveTrialModels());
    const result = await runTrialChain({ modules, fixture, model, cap: 2000, repetition: 1,
      complete: async (_selected, context) => {
        const text = JSON.stringify(context);
        const references = [...new Set(text.match(/chr1_[a-z0-9_-]+|[a-f0-9]{64}/gu) ?? [])];
        return reply([controlSummary(context), ...references].join("\n"));
      } });
    expect(result.checkpoints[1].summary).toContain("chr1_");
    expect(result.checkpoints.every(row => row.inventedProvenance.length === 0)).toBe(true);
    expect(result.pass).toBe(true);
  });

  it("reserves legacy Anthropic's full wire ceiling without adding thinking twice", async () => {
    const report = await runTrial({ dryRun: true, models: "anthropic:claude-haiku-4-5", effort: "high" });
    expect(report.summaryFocus.version).toBe(3);
    expect(report.chains.every(chain => chain.summaryFocus.sha256 === report.summaryFocus.sha256)).toBe(true);
    const identity = report.identity[0], measured = report.models[0];
    const requests = report.chains.flatMap(chain => chain.requests);
    expect(report.chains.every(chain => chain.pass)).toBe(true);
    expect(requests[0]).toMatchObject({ maxTokens: 2000, providerMaxTokens: 18384,
      options: { maxTokens: 2000, reasoning: "high" } }); // no prior tuples: legacy cap and reasoning allowance unchanged
    for (const request of requests) {
      expect(request.providerMaxTokens).toBe(request.options.maxTokens + 16384);
      expect(request.providerMaxTokens).toBeGreaterThan(request.maxTokens);
    }
    expect(measured.outputAllowance).toBe(requests.reduce((sum, request) => sum + request.providerMaxTokens, 0));
    expect(measured.estimatedUsd).toBeCloseTo(requests.reduce((sum, request) => sum + requestReservation(identity, request.bytes, request.providerMaxTokens), 0), 10);
    expect(report.maximumMatrixUsd).toBeCloseTo(requests.reduce((sum, request) => sum + requestReservation(identity, 65536, request.providerMaxTokens), 0), 10);
    // A cap sufficient for the old text-only hold must now refuse before send.
    const completion = vi.fn(() => { throw Error("Must not dispatch"); });
    await expect(runTrial({ confirm: true, models: identity.reference, effort: "high",
      capUsd: requestReservation(identity, requests[0].bytes, requests[0].maxTokens), complete: completion })).rejects.toThrow("request_failed");
    expect(completion).not.toHaveBeenCalled();
  });

  it("runs all 12 offline chains, reports 60 requests/48 checkpoints/36 cold reseeds per model", async () => {
    const forbiddenNetwork = vi.fn(() => { throw Error("Network forbidden"); });
    vi.stubGlobal("fetch", forbiddenNetwork);
    try {
      const report = await runTrial({ dryRun: true, models: "sol,luna" });
      expect(forbiddenNetwork).not.toHaveBeenCalled();
      expect(report.status).toBe("dry-run");
      expect(report.scorerVersion).toBe(2);
      expect(report.assertionPolicy).toContain("v2:");
      expect(report.chains.every(chain => chain.pass)).toBe(true);
      for (const row of report.models) expect(row).toMatchObject({ chains: 12, requests: 60, checkpoints: 48, coldReseeds: 36 });
      expect(report.total).toMatchObject({ chains: 24, requests: 120, checkpoints: 96, coldReseeds: 72 });
      expect(report.identity.map(row => row.effectiveEffort)).toEqual(["low", "low"]);
      expect(report.identity.every(row => row.providerEnforcesOutputCeiling === false)).toBe(true);
      expect(report.spendingDisclosure).toContain("NOT enforced");
      expect(report.total.estimatedUsd).toBeGreaterThan(0);
      expect(report.maximumMatrixUsd).toBeGreaterThan(report.total.estimatedUsd);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("spend admission and one-shot failures", () => {
  it("requires explicit confirmation and a positive spend cap", async () => {
    await expect(runTrial()).rejects.toThrow("--confirm");
    await expect(runTrial({ confirm: true })).rejects.toThrow("--spend-cap-usd");
    expect(() => resolveTrialModels("sol,sol")).toThrow();
  });
  it("reserves before dispatch, accounts afterwards, retains unknown liabilities and refuses cap overshoot", () => {
    const catalog = { maxTokens: 1000, cost: { input: 1, output: 5, cacheRead: 0.5, cacheWrite: 2,
      tiers: [{ inputTokensAbove: 100, input: 3, output: 8, cacheRead: 1, cacheWrite: 4 }] } };
    expect(requestReservation(catalog, 1000, 100)).toBe(0.0048);
    expect(() => requestReservation(catalog, 65537, 100)).toThrow("64 KiB");
    const budget = createTrialBudget(1);
    const reservation = budget.reserve(0.75);
    expect(() => budget.reserve(0.26)).toThrow("Spend cap");
    expect(() => budget.settle(reservation, null, catalog)).toThrow("reservation retained");
    expect(budget.snapshot().reservedUsd).toBe(0.75);
    budget.settle(reservation, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } }, catalog);
    expect(budget.snapshot()).toMatchObject({ accountedUsd: 0.4, reservedUsd: 0 });
    expect(() => budget.reserve(0.61)).toThrow("Spend cap");
  });
  it("stops before dispatch when the cap is too small, and never retries a failed completion", async () => {
    const completion = vi.fn(() => { throw Error("Synthetic provider failure"); });
    const publications = [];
    await expect(runTrial({ confirm: true, capUsd: 0.000001, complete: completion, publish: async report => publications.push(structuredClone(report)) })).rejects.toThrow("request_failed");
    expect(completion).not.toHaveBeenCalled();
    expect(publications.at(-1).status).toBe("stopped");
    await expect(runTrial({ confirm: true, capUsd: 12, complete: completion })).rejects.toThrow();
    expect(completion).toHaveBeenCalledOnce();
  });
  it.each(["error", "aborted"])("retains and publishes unknown liability for a returned %s with zero-filled usage", async stopReason => {
    const completion = vi.fn(async () => ({ stopReason, content: [], usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } }));
    const publications = [];
    await expect(runTrial({ confirm: true, capUsd: 12, complete: completion,
      publish: async report => publications.push(structuredClone(report)) })).rejects.toThrow("request_failed");
    expect(completion).toHaveBeenCalledOnce();
    const last = publications.at(-1), dispatch = last.dispatches[0];
    expect(last.status).toBe("stopped");
    expect(dispatch.status).toBe("unknown_outcome");
    expect(dispatch.usage).toEqual({ input: null, output: null, cacheRead: null, cacheWrite: null });
    expect(last.budget).toMatchObject({ accountedUsd: 0, reservedUsd: dispatch.reservationUsd, dispatched: 1 });
    expect(last.budget.reservedUsd).toBeGreaterThan(0);
    expect(publications.some(report => report.status === "running" && report.dispatches[0]?.status === "unknown_outcome")).toBe(true);
    expect(publications.some(report => report.dispatches.some(row => row.status === "accounted"))).toBe(false);
  });
  it("CLI leaves its output path unclaimed after credential or catalog preflight failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-trial-preflight-"));
    try {
      const output = join(root, "report.json");
      for (const args of [
        ["--confirm", "--spend-cap-usd", "12", "--credential-file", join(root, "missing-auth.json")],
        ["--dry-run", "--model", "fictional:missing-model"],
      ]) {
        const result = spawnSync(process.execPath, ["scripts/summary-retention-trial.mjs", ...args, "--output", output], { encoding: "utf8" });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Trial refused or stopped");
        expect(await readdir(root)).toEqual([]);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("CLI publishes exclusively without following a preplanted temporary symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "summary-trial-output-"));
    try {
      const output = join(root, "report.json"), victim = join(root, "victim.txt");
      const original = "Fictional retained file.\n";
      await writeFile(victim, original);
      await symlink(victim, `${output}.tmp`);
      const args = ["scripts/summary-retention-trial.mjs", "--dry-run", "--output", output];
      const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 20000 });
      expect(result.status, result.stderr).toBe(0);
      const report = await readFile(output, "utf8");
      expect(JSON.parse(report).status).toBe("dry-run");
      expect(await readFile(victim, "utf8")).toBe(original);
      expect(await readFile(`${output}.tmp`, "utf8")).toBe(original);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect((await readdir(root)).sort()).toEqual(["report.json", "report.json.tmp", "victim.txt"]);
      const refused = spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(refused.status).toBe(1);
      expect(await readFile(output, "utf8")).toBe(report);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("CLI refuses an unconfirmed run before credentials, output or network", () => {
    const result = spawnSync(process.execPath, ["scripts/summary-retention-trial.mjs", "--spend-cap-usd", "12", "--credential-file", "/fictional/missing.json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Trial refused or stopped");
  });
});
