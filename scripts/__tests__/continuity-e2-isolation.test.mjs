// Resolver receiver regression: originals are local stubs, never actual DNS.
import { afterEach, expect, it, vi } from "vitest";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const window = vi.hoisted(() => ({ active: false }));
vi.mock("../lib/continuity-guarded-real-capability.mjs", () => ({ isGuardedNativeDispatch: id => id === "e2-validation" && window.active }));
import { installProofIsolation, proofEnvironment } from "../lib/continuity-e2-isolation.mjs";
let restore, root;
afterEach(async () => { restore?.(); restore = null; window.active = false; vi.restoreAllMocks(); if (root) await rm(root, { recursive: true, force: true }); });
it("preserves callback and promise Resolver instances only inside native dispatch", async () => {
  root = await mkdtemp(join(tmpdir(), "e2-resolver-"));
  const callbackCalls = [], promiseCalls = [];
  vi.spyOn(dns.Resolver.prototype, "resolve4").mockImplementation(function (host, callback) { callbackCalls.push(this); callback(null, [host]); });
  vi.spyOn(dnsPromises.Resolver.prototype, "resolve4").mockImplementation(async function (host) { promiseCalls.push(this); return [host]; });
  const callbackResolver = new dns.Resolver(), promiseResolver = new dnsPromises.Resolver();
  restore = installProofIsolation(await proofEnvironment(root)); window.active = true;
  await expect(new Promise((resolve, reject) => callbackResolver.resolve4("example.invalid", (error, result) => error ? reject(error) : resolve(result)))).resolves.toEqual(["example.invalid"]);
  await expect(promiseResolver.resolve4("example.invalid")).resolves.toEqual(["example.invalid"]);
  expect(callbackCalls).toEqual([callbackResolver]); expect(promiseCalls).toEqual([promiseResolver]);
  window.active = false;
  expect(() => callbackResolver.resolve4("example.invalid", () => {})).toThrow("E2_PROOF_EGRESS_REFUSED");
  await expect(promiseResolver.resolve4("example.invalid")).rejects.toThrow("E2_PROOF_EGRESS_REFUSED");
  await expect(promiseResolver.resolve4("127.0.0.1")).resolves.toEqual(["127.0.0.1"]);
  expect(callbackCalls).toHaveLength(1); expect(promiseCalls).toHaveLength(1);
});
