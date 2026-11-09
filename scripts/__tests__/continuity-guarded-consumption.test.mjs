// A second, incompatible protocol exercises the real generic burn implementation, never paid authority.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, readdir, unlink, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
let root, home, outputRoot, sourceRoot, args, auth, leases, lease, protocol, identity, fetch;
const osUser = userInfo();
beforeEach(async () => {
  vi.resetModules();
  root = await realpath(await mkdtemp(join(tmpdir(), "guarded-consumption-")));
  home = join(root, "home"); outputRoot = join(root, "output"); sourceRoot = join(root, "source");
  for (const path of [home, outputRoot, sourceRoot]) await mkdir(path, { mode: 0o700 });
  vi.doMock("node:os", async original => ({ ...await original(), userInfo: () => ({ ...osUser, homedir: home }) }));
  fetch = vi.fn(() => { throw Error("fictional_network_forbidden"); }); vi.stubGlobal("fetch", fetch);
  protocol = (await import("../lib/continuity-guarded-protocols.mjs")).guardedProtocol("fictional");
  auth = (await import("../lib/continuity-guarded-authorization.mjs")).guardedAuthorization("fictional");
  leases = (await import("../lib/continuity-guarded-lease.mjs")).guardedLease("fictional");
  const start = (await import("../lib/continuity-process-identity.mjs")).lookupProcessStartIdentity(process.pid);
  identity = { runId: "fictional-run", controllerEpoch: "fictional-epoch", controller: { pid: process.pid, startIdentity: start } };
  args = { authorizationPath: join(root, "attestation.json"), outputRoot, sourceRoot };
  await writeFile(args.authorizationPath, JSON.stringify({ schema: protocol.policy.AUTHORIZATION_SCHEMA, authorizationId: "fictional-approval", outputRoot, sourceRoot }), { mode: 0o600 });
  lease = await leases.acquireLease(outputRoot);
});
afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { lease?.release(); vi.doUnmock("node:os"); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); } });
const registry = () => join(home, ...protocol.policy.REGISTRY_LAYOUT.map(([name]) => name));
const entry = () => join(registry(), createHash("sha256").update(protocol.registryDomain).update("fictional-approval").digest("hex"));
it("uses the selected domain and private home, persists both markers and has exactly one concurrent winner", async () => {
  const handle = await auth.validate(args);
  const outcomes = await Promise.allSettled([auth.consumeAuthorization(handle, identity, lease), auth.consumeAuthorization(handle, identity, lease)]);
  expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
  const outer = JSON.parse(await readFile(join(outputRoot, "authorization-consumed.json")));
  expect(JSON.parse(await readFile(join(entry(), "claim.json")))).toEqual(outer);
  expect(outer).toMatchObject({ schema: "fictional-consumed-v1", runId: identity.runId, controllerEpoch: identity.controllerEpoch, outputRoot });
  expect(await readdir(registry())).toEqual([entry().split("/").at(-1)]);
  await expect(auth.verifyConsumption(handle, identity)).resolves.toBe(true);
  await expect(auth.consumeAuthorization(handle, identity, lease)).rejects.toThrow("fictional_authorization_already_consumed");
});
it("read verification cannot repair a missing marker, and the burn remains non-reusable", async () => {
  const handle = await auth.validate(args); await auth.consumeAuthorization(handle, identity, lease);
  const claim = await readFile(join(entry(), "claim.json"));
  await unlink(join(outputRoot, "authorization-consumed.json"));
  await expect(auth.verifyConsumption(handle, identity)).rejects.toThrow("fictional_authorization_consumption_incomplete");
  await expect(auth.consumeAuthorization(handle, identity, lease)).rejects.toThrow("fictional_authorization_consumption_incomplete");
  expect(await readFile(join(entry(), "claim.json"))).toEqual(claim);
  expect(await readdir(outputRoot)).not.toContain("authorization-consumed.json");
});
it("an opaque fictional attestation or fabricated handle cannot mint the native real capability", async () => {
  const handle = await auth.validate(args);
  await expect(auth.consumeAuthorization({}, identity, lease)).rejects.toThrow("fictional_authorization_required");
  const capability = (await import("../lib/continuity-guarded-real-capability.mjs")).guardedRealCapability("fictional");
  await expect(capability.createLookupRealSend({ authorization: handle }, {})).rejects.toThrow("fictional_pilot_capability_invalid");
  expect(capability.isRealLookupSend(() => {})).toBe(false);
  expect(await readdir(outputRoot)).toEqual(["controller-lock.sqlite"]);
});
