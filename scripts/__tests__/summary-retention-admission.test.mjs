import { afterEach, beforeEach, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { runTrialHostAdmission } from "../lib/summary-retention-host.mjs";
const deny = () => { throw Error("Network forbidden in retained admission proof"); };
beforeEach(() => {
  vi.stubGlobal("fetch", deny);
  for (const client of [http, https]) for (const method of ["request", "get"]) vi.spyOn(client, method).mockImplementation(deny);
  syncBuiltinESMExports();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); syncBuiltinESMExports(); });
const summary = `## Historical events and corrections\n${Array.from({ length: 31 }, (_, i) => `- Fictional item ${i}; m${i}; cobalt chosen instead of coral; historical decision.`).join("\n")}\n\n## Pending items\n- Review the fictional diagram.`;
it("authenticates a real cold admission through restart, loss refusal, exact successor, purge and branch rewind", async () => {
  const result = await runTrialHostAdmission(summary);
  expect(result.admissionProof).toMatchObject({ predecessorSha256: result.retainedSha256, protectedTupleCount: 31,
    guardedCalls: 2, lossyRefused: true, exactCommitted: true, unchangedRefusalSuppressed: true,
    coveredRestartAfterPurge: true, rewindPresentProtected: true, rewindPurgedLegacy: true });
  expect(result.admissionProof.receiptBytes).toBeLessThanOrEqual(8192);
  expect(result.admissionProof.successorAdmissionId).toBe(result.admissionProof.admissionId);
  expect(result.runtimeCalls).toBe(3);
}, 60000);
it("keeps legacy cold/restart behavior without admission when a store omits canonical destination epoch", async () => {
  const result = await runTrialHostAdmission(summary, { omitDestinationEpoch: true });
  expect(result.noCanonicalEpochLegacy).toBe(true);
  expect(result.admissionProof).toBeUndefined();
  expect(result.runtimeCalls).toBe(2);
}, 60000);

it("protects only the admitted sanitized retained bytes, never the removed source path", async () => {
  const source = summary + "\nFictional private path: /home/example/private/marker.txt";
  const result = await runTrialHostAdmission(source);
  expect(result.redacted).toBe(true);
  expect(result.retainedText).not.toContain("/home/example/private/marker.txt");
  expect(result.admissionProof.predecessorSha256).toBe(result.retainedSha256);
  expect(result.retainedSha256).not.toBe(result.nativeSha256);
  expect(result.admissionProof).toMatchObject({ protectedTupleCount: 31, exactCommitted: true });
}, 60000);

it("keeps physical-bucket isolation at rollover: no admission, no protection, legacy restart", async () => {
  const result = await runTrialHostAdmission(summary, { rollover: true });
  expect(result.rolloverLegacy).toBe(true);
  expect(result.admissionProof).toBeUndefined();
  expect(result.runtimeCalls).toBe(2);
}, 60000);

it.each(["omitResolverOnRestart", "purgeBeforeRestart", "excludeOnRestart"])("keeps uncovered admission live with a legacy warning after %s", async control => {
  expect(await runTrialHostAdmission(summary, { [control]: true })).toEqual({ legacyFallbackWithWarning: true, runtimeCalls: 2 });
}, 60000);

it("engages admitted protection through the actual restarted runtime's automatic pre-turn hook", async () => {
  expect(await runTrialHostAdmission(summary, { automaticRefusal: true })).toEqual({ realPreTurnProtectedRefused: true, runtimeCalls: 3 });
}, 60000);

it.each(["oversizedCandidate", "purgeBeforeAdmit"])("keeps cold admission optional through %s", async control => {
  expect(await runTrialHostAdmission(summary, { [control]: true })).toEqual({ skippedAdmissionLegacy: true, runtimeCalls: 2 });
}, 60000);
it("keeps a cold-admitted current journal protected through prepared configured wake", async () => {
  expect(await runTrialHostAdmission(summary, { automaticRefusal: true, preparedWake: true })).toEqual({ realPreTurnProtectedRefused: true, runtimeCalls: 3, preparedCurrentJournalProtected: true });
}, 60000);

// Whole quotation exceeds even the 16k presentation ceiling; only the
// small protected section belongs in the bounded successor output.
const largeSummary = `## Goal
${"Fictional background detail. ".repeat(2300)}

${summary}`;
it.each([{}, { packDisabled: true }, { preparedCold: true }])("carries an omitted >16k quotation through real cold trigger %j and same-destination restart", async options => {
  const result = await runTrialHostAdmission(largeSummary, { ...options, exactSummary: summary });
  expect(Buffer.byteLength(result.retainedText)).toBeGreaterThan(48000);
  expect(result.admissionProof).toMatchObject({ kind: "reseed_predecessor_admitted", protectedTupleCount: 31,
    guardedCalls: 2, lossyRefused: true, exactCommitted: true, unchangedRefusalSuppressed: true,
    coveredRestartAfterPurge: true, rewindPresentProtected: true, rewindPurgedLegacy: true });
  expect(result.admissionProof.receiptBytes).toBeLessThanOrEqual(8192);
  if (options.preparedCold) expect(result.admissionProof.preparedRuns).toBeGreaterThanOrEqual(2);
}, 60000);

// About 10.6k incremental pack tokens once JSON-quoted: omitted by the former
// 8k ceiling, quoted whole within the 16k ceiling and admitted by B.
const mediumSummary = `## Goal
${"Fictional background detail. ".repeat(1000)}

${summary}`;
it("admits a ~10.6k-token quotation through B at the 16k ceiling that an explicit 8k cap leaves to carry", async () => {
  const { packTokensOfBytes, PACK_HEADER } = await import("../../packages/conversation/dist/continuity/render-fit.js");
  const quoted = await runTrialHostAdmission(mediumSummary, { exactSummary: summary, coldBudgetCap: Number.POSITIVE_INFINITY });
  const cost = packTokensOfBytes(Buffer.byteLength(PACK_HEADER) + Buffer.byteLength(JSON.stringify(quoted.retainedText))) - packTokensOfBytes(Buffer.byteLength(PACK_HEADER));
  expect(cost).toBeGreaterThan(10_000); expect(cost).toBeLessThan(11_000);
  expect(quoted.coldBudgets).toEqual([16000]);
  const seed = JSON.stringify(quoted.seedMessages);
  expect(seed).toContain(quoted.retainedSha256); expect(seed).not.toContain("Generated summary omitted");
  expect(seed).toContain(JSON.stringify(JSON.stringify(quoted.retainedText)).slice(1, -1)); // whole quotation, never a fragment
  expect(quoted.admissionProof).toMatchObject({ kind: "retained_summary_admitted", protectedTupleCount: 31, guardedCalls: 2, lossyRefused: true,
    exactCommitted: true, unchangedRefusalSuppressed: true, coveredRestartAfterPurge: true, rewindPresentProtected: true, rewindPurgedLegacy: true });
  expect(quoted.admissionProof.successorAdmissionId).toBe(quoted.admissionProof.admissionId);
  const capped = await runTrialHostAdmission(mediumSummary, { exactSummary: summary, coldBudgetCap: 8000 });
  expect(capped.coldBudgets).toEqual([16000]);
  const cappedSeed = JSON.stringify(capped.seedMessages);
  expect(cappedSeed).toContain("Generated summary omitted"); expect(cappedSeed).not.toContain("Fictional background detail. Fictional background detail.");
  expect(capped.admissionProof).toMatchObject({ kind: "reseed_predecessor_admitted", protectedTupleCount: 31, exactCommitted: true });
}, 120000);
