// Mocked registration/authorization/lease and durable journal; never real authority.
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {digest} from "../lib/continuity-dataset.mjs";

const refusal = "lookup_pilot_slot_ineligible";
const mocked = ["continuity-lookup-pilot", "continuity-lookup-roles", "continuity-lookup-authorization",
  "continuity-lookup-lease", "continuity-holdout-files", "continuity-holdout-workflow", "continuity-lookup-pilot-state",
  "continuity-lookup-child-environment"];
let base, journal, stored, fork, plan, environment, consume, api;
beforeEach(async () => {
  vi.resetModules(); vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  base = await mkdtemp(join(tmpdir(), "fictional-slot-api-")); stored = new Map();
  fork = vi.fn(() => {throw Error("test_child_fork_forbidden");});
  plan = vi.fn(() => {throw Error("test_preparation_setup_forbidden");});
  environment = vi.fn(() => {throw Error("test_child_setup_forbidden");});
  consume = vi.fn(async () => {});
  vi.doMock("node:child_process", async original => ({...await original(), fork}));
  vi.doMock("../lib/continuity-lookup-pilot.mjs", async original => ({...await original(), validateLookupPilotRegistration: async () => {}}));
  vi.doMock("../lib/continuity-lookup-roles.mjs", async original => ({...await original(), ROOT: "/fictional/r0",
    verifyRegisteredCheckouts: async () => {}, rolePlan: plan}));
  const handle = Object.freeze({});
  vi.doMock("../lib/continuity-lookup-authorization.mjs", async original => ({...await original(),
    validateLookupAuthorization: async () => handle, lookupAuthorizationBindsPilot: received => received === handle,
    consumeLookupAuthorization: consume}));
  vi.doMock("../lib/continuity-lookup-lease.mjs", async original => ({...await original(),
    acquireLookupPilotLease: async () => ({release: vi.fn()}), assertLookupPilotLease: async () => {}}));
  vi.doMock("../lib/continuity-holdout-files.mjs", async original => ({...await original(), externalDirectory: async path => path}));
  vi.doMock("../lib/continuity-holdout-workflow.mjs", async original => ({...await original(), durable: async (path, value) => {
    stored.set(path, structuredClone(value));
    if (path.endsWith("/lookup-pilot-controller.json")) journal = value;
  }}));
  vi.doMock("../lib/continuity-lookup-pilot-state.mjs", async original => ({...await original(),
    readPilotPrivate: async path => structuredClone(stored.get(path))}));
  vi.doMock("../lib/continuity-lookup-child-environment.mjs", async original => ({...await original(), lookupChildEnvironment: environment}));
});
afterEach(async () => {
  try {await api?.release(); await rm(base, {recursive: true, force: true});}
  finally {
    api = undefined; journal = undefined;
    for (const name of mocked) vi.doUnmock(`../lib/${name}.mjs`);
    vi.doUnmock("node:child_process"); vi.restoreAllMocks(); vi.unstubAllEnvs();
  }
});

it.each(["faux", "real-schema"])("refuses direct preparation, probe, assignment and admit for an excluded native slot (%s)", async mode => {
  const {createLookupPilotController} = await import("../lib/continuity-lookup-controller.mjs");
  const {LOOKUP_PILOT_STOPS, LOOKUP_GUARD_STOPS, accountLookupPilot} = await import("../lib/continuity-lookup-pilot-accounting.mjs");
  const {LOOKUP_FAUX_CONTROLLER, LOOKUP_REAL_CONTROLLER, LOOKUP_PILOT_IPC, pilotStatePath} = await import("../lib/continuity-lookup-pilot-state.mjs");
  const outputRoot = join(base, "output"); await mkdir(outputRoot, {mode: 0o700});
  const pilot = {registration: {
    roles: [{id: "native", arm: "native-lookup", code: "R0"}],
    codes: {R0: {path: "/fictional/r0", revision: "a".repeat(40), build: {outputSha256: "b".repeat(64)}}},
    common: {protocol: {pilotSha256: "c".repeat(64)}, corpora: [{suite: "holdout", sha256: "d".repeat(64),
      traces: [{id: "fictional-trace", probes: ["fictional-probe"]}]}], policy: {budget: {paths: [
      {role: "native", traceId: "fictional-trace", probeId: "fictional-probe", feasibility: {classification: "feasible"}},
    ]}}},
  }, descriptor: {capUSD: 3.92, rmaxUSD: 3.92, schedule: {seed: 13},
    deadlines: {runDeadlineMs: 60000, deadlineMs: 5000, childWatchdogMs: 5000}}};
  const authorization = mode === "faux" ? {
    schema: "continuity-lookup-faux-authorization-v1", authorizationId: randomUUID(),
    pilotSha256: digest(pilot), outputRoot, scenarios: [], timeoutMs: 1000,
  } : {
    schema: "continuity-lookup-pilot-authorization-v1", controllerRoot: "/fictional/r0", registrationSha256: "e".repeat(64),
    authorizationPath: join(base, "authorization"), registrationPath: join(base, "registration"), credentialPath: join(base, "credential"),
  };
  api = await createLookupPilotController({pilot, outputRoot, authorization});
  const initial = api.snapshot(), worker = {...initial.controller};
  expect(initial.schema).toBe(mode === "faux" ? LOOKUP_FAUX_CONTROLLER : LOOKUP_REAL_CONTROLLER);
  expect(initial.schedule).toMatchObject([{roleId: "native", eligible: false}]);
  for (const operation of [() => api.prepare(0), () => api.probe(0),
    () => api.assignPreparation(0, worker), () => api.assign(0, worker)])
    await expect(operation()).rejects.toMatchObject({code: refusal});
  expect(api.snapshot()).toEqual(initial);

  // Independently challenge admission: a forged journal already has a worker.
  // The mocked durable adapter exposes this state only to this unit; no child exists.
  journal.slots[0].worker = worker; journal.slots[0].startedAt = Date.now();
  stored.set(pilotStatePath(outputRoot), structuredClone(journal));
  const slot = journal.slots[0];
  await expect(api.message(0, worker, {version: LOOKUP_PILOT_IPC, epoch: journal.epoch,
    slotId: slot.slotId, seq: slot.nextMessage, op: "admit", payload: {
      slotId: slot.slotId, requestId: `${journal.runId}:1`, round: 1, payloadDigest: "f".repeat(64), rmax: pilot.descriptor.rmaxUSD,
    }})).rejects.toMatchObject({code: refusal});
  await api.stop("lookup_ipc_invalid"); // A later generic stop must not erase the specific refusal.
  const refused = api.snapshot();
  expect(refused.stop).toBe(refusal); expect(stored.get(pilotStatePath(outputRoot)).stop).toBe(refusal);
  expect(LOOKUP_PILOT_STOPS).toContain(refusal);
  expect(LOOKUP_GUARD_STOPS).not.toContain(refusal); // Controller-owned, not a worker stop cause.
  expect(refused.slots[0].preparation).toBeUndefined(); expect(refused.slots[0].holds).toEqual([]);
  expect(accountLookupPilot(refused.slots)).toMatchObject({activeUnits: "0", retainedUnits: "0", completeUnits: "0", totalUnits: "0"});
  expect(plan).not.toHaveBeenCalled(); expect(environment).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
  expect(consume).toHaveBeenCalledTimes(mode === "faux" ? 0 : 1);
});
