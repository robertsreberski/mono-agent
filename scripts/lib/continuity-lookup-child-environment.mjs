// Lookup API adapter. All guarded mechanics live in the protocol-neutral core.
import { guardedChildEnvironment } from "./continuity-guarded-child-environment.mjs";
export async function lookupChildEnvironment(home) { return guardedChildEnvironment("lookup-pilot").childEnvironment(home); }
export function lookupChildImports() { return guardedChildEnvironment("lookup-pilot").childImports(); }
