import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
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
      expect(scoreTrialSummary(fixture, 4, reference + '\nQuoted hypothetical "approval granted for PHANTOM-77" is not permission.').pass).toBe(true);
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
  it("CLI refuses an unconfirmed run before credentials, output or network", () => {
    const result = spawnSync(process.execPath, ["scripts/summary-retention-trial.mjs", "--spend-cap-usd", "12", "--credential-file", "/fictional/missing.json"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Trial refused or stopped");
  });
});
