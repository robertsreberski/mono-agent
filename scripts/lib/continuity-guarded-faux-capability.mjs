// Shared guarded-run mechanics; historical authority names remain visible to the exact inventory.
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { digest } from "./continuity-dataset.mjs";
import { guardedState } from "./continuity-guarded-state.mjs";
import { guardedIPC } from "./continuity-guarded-ipc.mjs";
import { guardedSnapshot } from "./continuity-guarded-snapshot.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const nativeFetch = globalThis.fetch.bind(globalThis);
const instances = new Map();
export function guardedFauxCapability(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const LOOKUP_FAUX_CONTROLLER = protocol.policy.FAUX_CONTROLLER, LOOKUP_GUARD_CONTRACT = protocol.policy.GUARD_CONTRACT;
  const { readPrivate: readPilotPrivate, statePath: pilotStatePath } = guardedState(protocolId);
  const { createLookupPilotIPC, verifyLookupPilotParent } = guardedIPC(protocolId), { verifyLookupPreparation } = guardedSnapshot(protocolId);
  const { work: lookupPilotWork, bodyBytes: lookupBodyBytes, forwardedObserver: lookupForwardedObserver } = protocol.hooks;
  const sends = new WeakSet();
  const isFauxLookupSend = value => sends.has(value);
  const fauxLookupSendBinds = (send, profile) => sends.has(send) && send.binds(profile);
  const need = ok => { if (!ok) throw Object.assign(Error(protocol.codes.pilot_faux_required), { code: protocol.codes.pilot_faux_required }); };
  function localEndpoint(value) {
    let url; try { url = new URL(value); } catch { need(false); }
    need(url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/codex/responses");
    return url.href;
  }
  async function createLookupFauxSend(a, safety) {
    a = structuredClone(a);
    const { readPrivate: readPilotPrivate, statePath: pilotStatePath, verifyParent: verifyLookupPilotParent, createIPC: createLookupPilotIPC, verifyPreparation: verifyLookupPreparation, guardContract: LOOKUP_GUARD_CONTRACT, createDecorator, verifyRole } = await protocol.hooks.fauxBindings();
    need((await readPilotPrivate(pilotStatePath(a.outputRoot))).schema === LOOKUP_FAUX_CONTROLLER);
    const state = await verifyLookupPilotParent(a); need(state.schema === LOOKUP_FAUX_CONTROLLER && state.stop === null && state.cursor === a.index && state.slots[a.index].terminal === null);
    await verifyRole(a);
    await verifyLookupPreparation(a, state, true);
    const endpoint = localEndpoint(state.fauxEndpoint), permit = await createLookupPilotIPC(a);
    const contract = Object.freeze({ ...LOOKUP_GUARD_CONTRACT, runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey });
    const used = new Set();
    const send = async (url, init) => {
      need(init && Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
      need(Object.hasOwn(init, "method") && init.method === "POST" && (init.redirect === undefined || init.redirect === "error"));
      init = { ...init, headers: new Headers(init.headers), body: lookupBodyBytes(init.body) };
      need(Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
      // Accessors may change between validation and spread; authorize the snapshot sent.
      need(init.method === "POST" && (init.redirect === undefined || init.redirect === "error"));
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
    const forwarded = lookupForwardedObserver();
    const decorator = await createDecorator({ contract, permit, send, resolvedSafety: safety, onForwarded: forwarded.notify });
    Object.defineProperties(send, { observeForwarded: { value: forwarded.register }, binds: {value: profile => profile?.routeKind === "faux" && profile.work === lookupPilotWork(a) && profile.arm?.id === a.roleRequest.binding.arm && digest(profile.plan) === digest(a.plan)}, permit: { value: permit }, decorator: { value: decorator } });
    sends.add(send); return Object.freeze(send);
  }
  return Object.freeze({ isFauxLookupSend, fauxLookupSendBinds, createLookupFauxSend });
}
