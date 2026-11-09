// Lookup protocol adapter; shared mechanics are owned by the guarded core.
import { guardedModels } from "./continuity-guarded-models.mjs";
import { readFile } from "node:fs/promises";
import { assertResolvedLookupSafety, lookupCacheKey } from "./continuity-lookup-pilot-runtime.mjs";
import { guardedAccounting } from "./continuity-guarded-accounting.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
import { LOOKUP_ASSUMPTIONS, LOOKUP_GUARD_CONTRACT, LookupGuardError } from "./continuity-lookup-guarded-policy.mjs";
export { LOOKUP_ASSUMPTIONS, LOOKUP_GUARD_CONTRACT, LOOKUP_OUTCOMES, LOOKUP_PRE_SEND_REFUSALS, LOOKUP_GUARD_POLICY_REFUSALS, LOOKUP_PERMIT_CONTRACT, LookupGuardError } from "./continuity-lookup-guarded-policy.mjs";
const refuse = (code, classification) => { throw new LookupGuardError(code, "refused_pre_send", classification); };
export function assertLookupAuxiliaryCallersOff(settings) { return guardedProtocol("lookup-pilot").hooks.assertLookupAuxiliaryCallersOff(settings); }
export function assertLookupChildSafety(settings) { return guardedProtocol("lookup-pilot").hooks.assertLookupChildSafety(settings); }
export function lookupSettledCost(usage, tier) { return guardedAccounting("lookup-pilot").settledCost(usage, tier); }
const pilotDecorators = new WeakSet();
export const isFauxLookupDecorator = value => pilotDecorators.has(value);
export async function createFauxLookupDecorator(options) {
  const bindings = { ...options, contract: Object.freeze({ ...options.contract }), permit: Object.freeze({ ...options.permit, pilot: true }) };
  if (bindings.permit.testOnly !== true) refuse("lookup_faux_permit_forbidden");
  if (!lookupCacheKey(bindings.contract.promptCacheKey)) refuse("lookup_prompt_cache_key_forbidden");
  assertResolvedLookupSafety(bindings.resolvedSafety);
  // A private serializer instance has only fictional in-memory OAuth data. Never
  // delegate to the configured Models or its credential store, even for auth.
  const sdk = new URL("../../packages/turn/node_modules/@earendil-works/pi-ai/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", sdk), "utf8"));
  const entry = pkg.exports?.["."]?.import, providerEntry = pkg.exports?.["./providers/*"]?.import;
  if (typeof entry !== "string" || typeof providerEntry !== "string") refuse("lookup_unguarded_dispatch");
  const [pi, providers] = await Promise.all([import(new URL(entry, sdk).href), import(new URL(providerEntry.replace("*", "openai-codex"), sdk).href)]);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url"), credentials = new pi.InMemoryCredentialStore();
  const access = `${encode({ alg: "none" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "FAKE-TEST-ACCOUNT-NOT-REAL" } })}.FAKE-TEST-SIGNATURE`;
  await credentials.modify(LOOKUP_GUARD_CONTRACT.provider, () => ({ type: "oauth", refresh: "FAKE-TEST-REFRESH-NOT-REAL", expires: Number.MAX_SAFE_INTEGER, access }));
  const serializer = pi.createModels({ credentials }); serializer.setProvider(providers.openaiCodexProvider());
  const local = {
    getModel: serializer.getModel.bind(serializer), getProvider: serializer.getProvider.bind(serializer),
    getAuth: (model, overrides) => serializer.getAuth(model, { ...overrides, apiKey: access }),
    streamSimple: (model, context, options) => serializer.streamSimple(model, context, { ...options, apiKey: access }),
  };
  const wrapped = guardedLookupModels(local, bindings);
  const decorator = Object.freeze(_configuredModels => {
    if (!pilotDecorators.delete(decorator)) refuse("lookup_unguarded_dispatch");
    return wrapped;
  }); pilotDecorators.add(decorator); return decorator;
}
export const lookupBodyDigest = (bytes) => guardedModels("lookup-pilot").lookupBodyDigest(bytes);
export function lookupInputEnvelope(payload, settledOutputTokens = [], assumptions = LOOKUP_ASSUMPTIONS) { return guardedModels("lookup-pilot").lookupInputEnvelope(payload, settledOutputTokens, assumptions); }
export function assertRealLookupPermitSource(source) { return guardedModels("lookup-pilot").assertRealLookupPermitSource(source); }
export function createTestOnlyLookupPermitSource() { return guardedModels("lookup-pilot").createTestOnlyLookupPermitSource(); }
export function guardedLookupModels(models, { contract, permit, send, assumptions = LOOKUP_ASSUMPTIONS, resolvedSafety, onForwarded }) { return guardedModels("lookup-pilot").guardedLookupModels(models, { contract, permit, send, assumptions, resolvedSafety, onForwarded }); }
