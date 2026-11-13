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

it.each(["omitResolverOnRestart", "purgeBeforeRestart"])("does not silently downgrade active durable admission after %s", async control => {
  expect(await runTrialHostAdmission(summary, { [control]: true })).toEqual({ unavailableWithoutDispatch: true, runtimeCalls: 1 });
}, 60000);
