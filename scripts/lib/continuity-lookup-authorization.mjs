// Lookup API adapter; the core alone owns handles and consumption.
import { guardedAuthorization } from "./continuity-guarded-authorization.mjs";
export { LOOKUP_AUTHORIZATION_SCHEMA, LOOKUP_CONSUMPTION_SCHEMA } from "./continuity-lookup-guarded-policy.mjs";
export function lookupAuthorizationBinds(handle, descriptor, catalog) { return guardedAuthorization("lookup-pilot").binds(handle, descriptor, catalog); }
export async function validateLookupAuthorization(args) { return guardedAuthorization("lookup-pilot").validate(args); }
export function lookupAuthorizationBindsPilot(handle, pilot) { return guardedAuthorization("lookup-pilot").bindsRegistration(handle, pilot); }
export function lookupAuthorizationMatchesAccount(handle, account) { return guardedAuthorization("lookup-pilot").matchesAccountHandle(handle, account); }
export async function consumeLookupAuthorization(handle, identity, lease) { return guardedAuthorization("lookup-pilot").consumeAuthorization(handle, identity, lease); }
export async function verifyLookupConsumption(handle, identity) { return guardedAuthorization("lookup-pilot").verifyConsumption(handle, identity); }
