// Minimal offline proof protocol, not E2 policy. It has no paid entry or credential policy.
import { lookupGuardedProtocol as lookup } from "./continuity-lookup-guarded-protocol.mjs";
import { lookupGuardedModelPolicy } from "./continuity-lookup-guarded-model-policy.mjs";
import { digest } from "./continuity-dataset.mjs";
import { externalDirectory } from "./continuity-holdout-files.mjs";
import { createHash } from "node:crypto";
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const codes = Object.fromEntries(Object.entries(lookup.codes).map(([key, code]) => [key, code.replace(/^lookup_/u, "fictional_")]));
const need = ok => { if (!ok) throw Object.assign(Error(codes.pilot_faux_required), { code: codes.pilot_faux_required }); };
const policy = {
  ...Object.fromEntries(Object.entries(lookup.policy).map(([name, value]) => [name, Array.isArray(value) && value.every(v => typeof v === "string") ? value.map(v => v.replace(/^lookup_/u, "fictional_")) : value])),
  REAL_CONTROLLER: "fictional-controller-v1", FAUX_CONTROLLER: "fictional-faux-controller-v1", PREFLIGHT: "fictional-preflight-controller-v1",
  ASSUMPTIONS: { ...lookup.policy.ASSUMPTIONS, version: "fictional-assumed-v1" },
  PERMIT_CONTRACT: { ...lookup.policy.PERMIT_CONTRACT, version: "fictional-permit-v1" },
  AUTHORIZATION_SCHEMA: "fictional-authorization-v1", CONSUMPTION_SCHEMA: "fictional-consumed-v1", FAUX_AUTHORIZATION: "fictional-faux-authorization-v1", PILOT_IPC: "fictional-ipc-v1",
  GUARD_CONTRACT: { ...lookup.policy.GUARD_CONTRACT, version: "fictional-guard-v1" },
  REGISTRY_LAYOUT: [[".local", false], ["state", false], ["fictional-guarded", true], ["fictional-consumed-v1", true]],
};
export const fictionalGuardedProtocol = freeze({
  ...lookup, id: "fictional", realRoute: false, policy, codes,
  // This journal-only fixture has no spawnable lookup child or preflight entry.
  children: { preparation: null, probe: null }, preflightPrefix: "fictional-preflight-",
  leaseSQL: { select: "SELECT pid, start_identity FROM fictional_controller WHERE id = 1", create: "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; CREATE TABLE fictional_controller (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, start_identity TEXT NOT NULL)", insert: "INSERT INTO fictional_controller VALUES (1, ?, ?)" },
  journal: "fictional-controller.json", permitBrand: "fictional-controller-v1", fauxBrand: "fictional-faux-test-only-v1",
  registryDomain: "fictional/guarded/consumed-v1\0", accountDomain: "fictional/guarded/account-v1\0",
  fauxDomain: "fictional/guarded/faux-consumed-v1\0", fauxRegistry: ".fictional-faux-consumed-v1",
  schemas: Object.fromEntries(Object.entries(lookup.schemas).map(([key, value]) => [key, value.replace(/^lookup-/u, "fictional-")])),
  refusalPattern: /^(fictional_[a-z_]+|paid_mode_refused_in_ci)$/u,
  hooks: {
    ...lookup.hooks, ...lookupGuardedModelPolicy(codes, lookup.Error),
    realModules: async () => { throw Object.assign(Error(codes.pilot_capability_invalid), { code: codes.pilot_capability_invalid }); },
    fauxBindings: async () => { throw Object.assign(Error(codes.pilot_faux_required), { code: codes.pilot_faux_required }); },
    async controllerBindings() {
      const [leases, state, environment] = await Promise.all([import("./continuity-guarded-lease.mjs"), import("./continuity-guarded-state.mjs"), import("./continuity-guarded-child-environment.mjs")]);
      const lease = leases.guardedLease("fictional");
      return { acquireLease: lease.acquireLease, assertLease: lease.assertLease, readPrivate: state.guardedState("fictional").readPrivate, childEnvironment: environment.guardedChildEnvironment("fictional").childEnvironment };
    },
    // A private fictional attestation can exercise the generic burn, but never mint a paid capability.
    async validateAuthorization(args, { safeRead, safeDirectory, id }) {
      const raw = await safeRead(args.authorizationPath, codes.authorization_invalid), artifact = JSON.parse(raw);
      need(artifact.schema === policy.AUTHORIZATION_SCHEMA && id(artifact.authorizationId)
        && artifact.outputRoot === args.outputRoot && artifact.sourceRoot === args.sourceRoot);
      await safeDirectory(args.outputRoot, codes.authorization_invalid, true);
      await safeDirectory(args.sourceRoot, codes.authorization_invalid, true);
      return { artifact, rawDigest: createHash("sha256").update(raw).digest("hex"), outputRoot: args.outputRoot,
        registration: { paths: [args.sourceRoot] }, args: { ...args } };
    },
    checkoutPaths: registration => registration.paths,
    authorizationBinds: () => false,
    verifyRealAssignment: async () => { throw Object.assign(Error(codes.pilot_capability_invalid), { code: codes.pilot_capability_invalid }); },
    async prepareController(options) {
      options = structuredClone(options);
      const { pilot, authorization, outputRoot } = options;
      need(Object.keys(options).sort().join() === "authorization,outputRoot,pilot" && authorization?.schema === policy.FAUX_AUTHORIZATION);
      need(!Object.hasOwn(process.env, "CONTINUITY_DEBUG") && Array.isArray(pilot?.schedule) && pilot.schedule.length > 0);
      need(authorization.pilotSha256 === digest(pilot) && await externalDirectory(outputRoot, false, []) === outputRoot);
      return { pilot, authorization, outputRoot, real: false, authorizationHandle: null, schedule: pilot.schedule };
    },
    publicState: pilot => pilot.publicState,
    schedule: async pilot => pilot.schedule,
    snapshotSource: a => ({ sourceId: a.sourceId }), snapshotMatches: (manifest, a) => manifest.sourceId === a.sourceId,
    assignmentArm: a => a.arm, armForAssignment: a => ({ id: a.arm }),
    // The miniature proof only drives the journal, never a registered inference child.
    slotRequest: async () => { throw Object.assign(Error(codes.pilot_faux_required), { code: codes.pilot_faux_required }); },
  },
});
