import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { selectionReplayCases, replayCoverage } from "../lib/continuity-selection-cases.mjs";
import { replayLedgerSelection } from "../lib/continuity-selection-replay.mjs";

// Captured with the PR 1 source selection modules, not redefined scoring logic.
// Input digests prevent changing a fixture while silently keeping its old base.
const baseline = JSON.parse(await readFile(new URL("./fixtures/continuity-selection-baseline.json", import.meta.url), "utf8"));

it.each(selectionReplayCases())("preserves source diversity and improves first offers: $name", async scenario => {
  const base = baseline.cases[scenario.name];
  expect(createHash("sha256").update(JSON.stringify(scenario.records)).digest("hex")).toBe(base.sourceDigest);
  const passes = await replayLedgerSelection(scenario.records), candidate = replayCoverage(passes, scenario);
  expect(passes.map(pass => pass.deltaEntries)).toEqual([1, 0, 1]);
  expect(passes.map(pass => pass.published)).toEqual([true, false, true]);
  expect(passes.map(pass => pass.inputTokens)).toEqual([128000, 64000, 64000]);
  for (const [index, current] of candidate.entries()) {
    const prior = base.passes[index];
    expect(current.cap).toBeGreaterThanOrEqual(prior.cap);
    expect(current.fitted).toBeGreaterThanOrEqual(prior.fitted);
    expect(current.tool).toBeGreaterThanOrEqual(Math.ceil(prior.tool * 0.8));
    // Stronger than cumulative preservation: every base-offered constraint or
    // next-action record must still be offered in that SAME pass.
    for (const id of prior.protectedOwners) expect(current.protectedOwners).toContain(id);
    expect(passes[index].selection.projectedBytes).toBeLessThanOrEqual(128 * 1024);
    expect(passes[index].selection.lineageBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  }
  for (const text of scenario.requiredTransitions ?? []) {
    expect(passes.some(pass => pass.records.some(record => record.text === text))).toBe(true);
    if (scenario.name === "transitions") {
      const id = `fictional-input-${scenario.records.findIndex(record => record.text === text)}`;
      expect(base.passes.flatMap(pass => pass.transitionIds)).not.toContain(id);
    }
  }
  for (const text of scenario.requiredTools ?? []) expect(passes.some(pass => pass.records.some(record => record.text === text))).toBe(true);
  // Repeat all five cases through fresh SQLite stores, including adversarial
  // floods. Exact offers and retained records, not just totals, must agree.
  expect(await replayLedgerSelection(scenario.records)).toEqual(passes);
}, 60000);
