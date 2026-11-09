// Closed static selection; never load a CLI-supplied module, callback or registry path.
import { lookupGuardedProtocol } from "./continuity-lookup-guarded-protocol.mjs";
import { fictionalGuardedProtocol } from "./continuity-guarded-fictional-protocol.mjs";
import { e2GuardedProtocol } from "./continuity-e2-guarded-protocol.mjs";
export function guardedProtocol(id) {
  if (id === "lookup-pilot") return lookupGuardedProtocol;
  if (id === "fictional") return fictionalGuardedProtocol;
  if (id === "e2-validation") return e2GuardedProtocol;
  throw Object.assign(Error("guarded_protocol_unknown"), { code: "guarded_protocol_unknown" });
}
