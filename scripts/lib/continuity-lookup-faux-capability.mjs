import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
// Test-only authority, incompatible with the real factory and external transport.
import { digest } from "./continuity-dataset.mjs";
import { lookupPilotWork, lookupBodyBytes } from "./continuity-lookup-pilot-runtime.mjs";
import { createLookupPilotIPC, verifyLookupPilotParent } from "./continuity-lookup-ipc.mjs";
import { ROOT, verifyRoleRequest } from "./continuity-lookup-roles.mjs";
import { LOOKUP_FAUX_CONTROLLER, readPilotPrivate, pilotStatePath } from "./continuity-lookup-pilot-state.mjs";
import { verifyLookupPreparation } from "./continuity-lookup-preparation.mjs";
import { createFauxLookupDecorator, LOOKUP_GUARD_CONTRACT } from "./continuity-lookup-guard.mjs";
const sends = new WeakSet();
export const isFauxLookupSend = value => sends.has(value);
export const fauxLookupSendBinds = (send, profile) => sends.has(send) && send.binds(profile);
const nativeFetch = globalThis.fetch.bind(globalThis);
const need = ok => { if (!ok) throw Object.assign(Error("lookup_pilot_faux_required"), { code: "lookup_pilot_faux_required" }); };
function localEndpoint(value) {
  let url; try { url = new URL(value); } catch { need(false); }
  need(url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0
    && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/codex/responses");
  return url.href;
}
export async function createLookupFauxSend(a, safety) {
  a = structuredClone(a);
  need((await readPilotPrivate(pilotStatePath(a.outputRoot))).schema === LOOKUP_FAUX_CONTROLLER);
  const state = await verifyLookupPilotParent(a); need(state.schema === LOOKUP_FAUX_CONTROLLER && state.stop === null && state.cursor === a.index && state.slots[a.index].terminal === null);
  need(ROOT === a.pilot.registration.codes[a.slot.code].path);
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  await verifyLookupPreparation(a, state, true);
  const endpoint = localEndpoint(state.fauxEndpoint), permit = await createLookupPilotIPC(a);
  const contract = Object.freeze({ ...LOOKUP_GUARD_CONTRACT, runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey });
  const used = new Set();
  const send = async (url, init) => {
    need(init && Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
    need(Object.hasOwn(init, "method") && init.method === "POST" && (init.redirect === undefined || init.redirect === "error"));
    init = { ...init, headers: new Headers(init.headers), body: lookupBodyBytes(init.body) };
    const current = await verifyLookupPilotParent(a);
    need(current.schema === LOOKUP_FAUX_CONTROLLER && current.fauxEndpoint === endpoint && String(url) === `${contract.baseUrl}/codex/responses`);
    await verifyLookupPreparation(a, current, true);
    const slot = current.slots[a.index], hold = slot.holds.at(-1), headers = new Headers(init?.headers), encoding = headers.get("content-encoding");
    need(current.stop === null && current.cursor === a.index && slot.terminal === null
      && Date.now() < current.deadlineAt && Date.now() < slot.startedAt + a.pilot.descriptor.deadlines.deadlineMs
      && [null, "zstd"].includes(encoding) && headers.get("session-id") === a.cacheKey && headers.get("x-client-request-id") === a.cacheKey);
    const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
    need(hold?.consumed === true && !hold.revoked && !hold.settlement && !used.has(hold.permitId)
      && hold.payloadDigest === createHash("sha256").update(bytes).digest("hex"));
    used.add(hold.permitId);
    // No external fallback, including redirects. No real credentials are resolved.
    return nativeFetch(endpoint, { ...init, redirect: "error" });
  };
  const decorator = await createFauxLookupDecorator({ contract, permit, send, resolvedSafety: safety });
  Object.defineProperties(send, { binds: {value: profile => profile?.routeKind === "faux" && profile.work === lookupPilotWork(a) && profile.arm?.id === a.roleRequest.binding.arm && digest(profile.plan) === digest(a.plan)}, permit: { value: permit }, decorator: { value: decorator } });
  sends.add(send); return Object.freeze(send);
}
