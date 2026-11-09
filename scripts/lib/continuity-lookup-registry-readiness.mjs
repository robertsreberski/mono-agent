import { userInfo } from "node:os";
// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedRegistryReadiness } from "./continuity-guarded-registry-readiness.mjs";
export { LOOKUP_REGISTRY_LAYOUT } from "./continuity-lookup-guarded-policy.mjs";
export async function lookupRegistryReadiness(home = userInfo().homedir) { return guardedRegistryReadiness("lookup-pilot").registryReadiness(home); }
