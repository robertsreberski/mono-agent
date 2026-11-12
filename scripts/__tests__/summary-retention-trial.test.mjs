import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrialFixtures, loadTrialModules, resolveTrialCatalog, resolveTrialModels, runTrialChain, runTrial,
  controlSummary, scoreTrialSummary, createTrialBudget, requestReservation } from "../lib/summary-retention-trial.mjs";

const reply = text => ({ stopReason: "stop", content: [{ type: "text", text }], usage: {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });

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

  it("reserves legacy Anthropic's full wire ceiling without adding thinking twice", async () => {
    const report = await runTrial({ dryRun: true, models: "anthropic:claude-haiku-4-5", effort: "high" });
    const identity = report.identity[0], measured = report.models[0];
    const requests = report.chains.flatMap(chain => chain.requests);
    expect(report.chains.every(chain => chain.pass)).toBe(true);
    expect(requests[0]).toMatchObject({ maxTokens: 2000, providerMaxTokens: 18384,
      options: { maxTokens: 2000, reasoning: "high" } });
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
