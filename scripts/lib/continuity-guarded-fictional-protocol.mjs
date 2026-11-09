// Minimal offline-only descriptor. This is not E2 policy and cannot authorize paid dispatch.
import { lookupGuardedProtocol as lookup } from "./continuity-lookup-guarded-protocol.mjs";
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const fictionalGuardedProtocol = freeze({ ...lookup, id: "fictional", realRoute: false, refusalPattern: /^(fictional_[a-z_]+|paid_mode_refused_in_ci)$/u, hooks: { validateAuthorization: async () => { throw Object.assign(Error("fictional_authorization_unavailable"), { code: "fictional_authorization_unavailable" }); } }, journal: "fictional-controller.json",
  registryDomain: "fictional/guarded/consumed-v1\0", accountDomain: "fictional/guarded/account-v1\0",
  codes: Object.fromEntries(Object.entries(lookup.codes).map(([key, code]) => [key, code.replace(/^lookup_/u, "fictional_")])),
  policy: { ...Object.fromEntries(Object.entries(lookup.policy).map(([name, value]) => [name, Array.isArray(value) && value.every(v => typeof v === "string") ? value.map(v => v.replace(/^lookup_/u, "fictional_")) : value])), REAL_CONTROLLER: "fictional-controller-v1", FAUX_CONTROLLER: "fictional-faux-controller-v1",
    AUTHORIZATION_SCHEMA: "fictional-authorization-v1", FAUX_AUTHORIZATION: "fictional-faux-authorization-v1", PILOT_IPC: "fictional-ipc-v1",
    REGISTRY_LAYOUT: [[".local", false], ["state", false], ["fictional-guarded", true], ["consumed-v1", true]] } });
