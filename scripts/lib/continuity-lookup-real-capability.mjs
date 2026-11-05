// Child-only authority. No issuer, transport injection, public registration or nonce.
import process from "node:process";
import { assertLookupPilotEntry } from "./continuity-lookup-pilot-entry.mjs";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
const sends = new WeakSet(), decorators = new WeakSet(), minted = new Set();
const nativeFetch = globalThis.fetch.bind(globalThis);
const fail = (code = "lookup_pilot_capability_invalid") => { throw Object.assign(new Error(code), { code }); };
const need = ok => { if (!ok) fail(); };
export const isRealLookupSend = send => sends.has(send);
export const realLookupSendForGuard = (send, permit, contract) => sends.has(send) && send.permit === permit && send.matchesContract(contract);
export const isRealLookupDecorator = decorator => decorators.has(decorator);
export const realLookupSendBinds = (send, profile) => sends.has(send) && send.binds(profile);

/** Read-only verification, not authority. Minting never accepts its return value. */
export async function verifyLookupRealAssignment(a, ready = true) {
  assertLookupPilotEntry();
  if (Object.hasOwn(process.env, "CI")) fail("paid_mode_refused_in_ci");
  if (Object.hasOwn(process.env, "CONTINUITY_DEBUG")) fail("lookup_debug_forbidden");
  try { return await verifyAssignment(a, ready); } catch { fail(); }
}
async function verifyAssignment(a, ready) {
  need(!Object.hasOwn(process.env, "CI") && !Object.hasOwn(process.env, "CONTINUITY_DEBUG"));
  const [{ ROOT, verifyRoleRequest, roleBinding }, { validateLookupPilotRegistration }, auth, stateModule, identity, runtime] = await Promise.all([
    import("./continuity-lookup-roles.mjs"), import("./continuity-lookup-pilot.mjs"), import("./continuity-lookup-authorization.mjs"),
    import("./continuity-lookup-pilot-state.mjs"), import("./continuity-process-identity.mjs"), import("./continuity-lookup-pilot-runtime.mjs"),
  ]);
  need(a?.authorization?.schema === auth.LOOKUP_AUTHORIZATION_SCHEMA && a.recovery !== true && process.connected);
  await validateLookupPilotRegistration(a.pilot);
  const { digest } = await import("./continuity-dataset.mjs"), registration = a.pilot.registration;
  const role = registration.roles.find(r => r.id === a.slot.roleId), corpus = registration.common.corpora.find(c => c.suite === a.slot.suite);
  need(role && corpus && ROOT === registration.codes[a.slot.code]?.path
    && stateModule.samePilot(a.roleRequest.binding, roleBinding(registration, role, corpus))
    && stateModule.samePilot(a.roleRequest.common, registration.common)
    && stateModule.samePilot(a.roleRequest.build, registration.codes[a.slot.code].build));
  await verifyRoleRequest(ROOT, a.roleRequest, a.plan);
  const state = await stateModule.readPilotPrivate(stateModule.pilotStatePath(a.outputRoot)), slot = state.slots[a.index];
  runtime.assertLookupCacheAssignment(state, a);
  need(state.schema === stateModule.LOOKUP_REAL_CONTROLLER && state.recovery === false && state.stop === null
    && state.binding === digest(a.pilot)
    && state.cursor === a.index && slot.terminal === null
    && typeof state.controller.startIdentity === "string" && state.controller.startIdentity.length > 0
    && typeof slot.worker?.startIdentity === "string" && slot.worker.startIdentity.length > 0
    && state.runId === a.runId && state.epoch === a.epoch && state.controller.pid === process.ppid
    && identity.lookupProcessStartIdentity(process.ppid) === state.controller.startIdentity
    && slot?.worker?.pid === process.pid && slot.worker.startIdentity === identity.lookupProcessStartIdentity(process.pid)
    && slot.slotId === a.slotId && stateModule.samePilot(state.schedule, stateModule.lookupPilotSchedule(a.pilot))
    && stateModule.samePilot(state.schedule[a.index], a.slot) && a.slot.roleId === a.roleRequest.binding.id
    && a.slot.code === a.roleRequest.binding.code && (!ready || slot.ready === true));
  await (await import("./continuity-lookup-preparation.mjs")).verifyLookupPreparation(a, state, ready);
  const handle = await auth.validateLookupAuthorization({ ...a.authorization, outputRoot: a.outputRoot });
  need(auth.lookupAuthorizationBindsPilot(handle, a.pilot));
  await auth.verifyLookupConsumption(handle, { runId: state.runId, controllerEpoch: state.epoch, controller: state.controller });
  return { state, handle };
}

/** The sole factory: validate in the child, then close over its own IPC client. */
export async function createLookupRealSend(a, resolvedSafety) {
  try {
    a = structuredClone(a);
    const { handle } = await verifyLookupRealAssignment(a);
    const [{ assertResolvedLookupSafety, lookupPilotWork }, guard, auth, { createLookupPilotIPC }, { digest }] = await Promise.all([
      import("./continuity-lookup-pilot-runtime.mjs"), import("./continuity-lookup-guard.mjs"), import("./continuity-lookup-authorization.mjs"),
      import("./continuity-lookup-ipc.mjs"), import("./continuity-dataset.mjs"),
    ]);
    assertResolvedLookupSafety(resolvedSafety);
    need(digest(resolvedSafety.plan) === digest(a.plan) && resolvedSafety.arm.id === a.roleRequest.binding.arm);
    const mintKey = digest([a.outputRoot, a.epoch, a.slotId, process.pid]);
    need(!minted.has(mintKey)); minted.add(mintKey);
    const permit = await createLookupPilotIPC(a), used = new Set();
    guard.assertRealLookupPermitSource(permit);
    const stop = async code => {
      let cause;
      try { await permit.stop(code); } catch (error) { cause = error; }
      const error = Object.assign(new Error(code), { code });
      if (cause) { error.stopCode = "lookup_stop_failed"; error.cause = cause; }
      throw error;
    };
    const quota = error => ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota", "quota_exceeded", "rate_limit_exceeded"].includes(error?.code)
      || ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota"].includes(error?.type);
    const send = async (url, init) => {
      assertResolvedLookupSafety(resolvedSafety);
      need(digest(resolvedSafety.plan) === digest(a.plan) && resolvedSafety.arm.id === a.roleRequest.binding.arm);
      need(init && Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
      const endpoint = String(url);
      init = { ...init, headers: new Headers(init?.headers), body: Buffer.from(Buffer.from(init?.body ?? "")) };
      need(endpoint === `${guard.LOOKUP_GUARD_CONTRACT.baseUrl}/codex/responses` && init?.method === "POST"
        && (init.redirect === undefined || init.redirect === "error") && process.connected);
      const { state } = await verifyLookupRealAssignment(a), hold = state.slots[a.index].holds.at(-1);
      need(Date.now() < Math.min(state.deadlineAt, state.slots[a.index].startedAt + a.pilot.descriptor.deadlines.deadlineMs));
      const headers = new Headers(init.headers), encoding = headers.get("content-encoding");
      need((encoding === null || encoding === "zstd") && headers.get("session-id") === a.cacheKey && headers.get("x-client-request-id") === a.cacheKey);
      const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
      need(hold?.consumed === true && !hold.revoked && !hold.settlement && !used.has(hold.permitId)
        && hold.payloadDigest === createHash("sha256").update(bytes).digest("hex"));
      if (!auth.lookupAuthorizationMatchesAccount(handle, headers.get("chatgpt-account-id"))) await stop("lookup_account_mismatch");
      used.add(hold.permitId); // No retry, including after fetch rejection or abort.
      const response = await nativeFetch(endpoint, { ...init, redirect: "error" });
      const rejectResponse = async code => {
        try { void response.body?.cancel().catch(() => {}); } catch {}
        await stop(code);
      };
      if ([401, 403].includes(response.status)) await rejectResponse("lookup_auth_failure");
      if (response.status === 429) await rejectResponse("lookup_quota_exhausted");
      const type = response.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const body = await response.clone().json().catch(() => null);
        if (quota(body?.error)) await rejectResponse("lookup_quota_exhausted");
      }
      if (!response.body || !type.includes("text/event-stream")) return response;
      let buffer = ""; const decoder = new TextDecoder();
      return new Response(response.body.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) await stop("lookup_payload_forbidden");
          const frames = buffer.split(/\r?\n\r?\n/u); buffer = frames.pop();
          for (const frame of frames) {
            const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            let event; try { event = JSON.parse(data); } catch { continue; }
            if (quota(event?.error) || quota(event?.response?.error)) await stop("lookup_quota_exhausted");
          }
          controller.enqueue(chunk);
        },
      })), { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const decorator = models => {
      need(decorators.delete(decorator));
      return guard.guardedLookupModels(models, { permit, send, resolvedSafety, contract: {
        ...guard.LOOKUP_GUARD_CONTRACT, runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey,
      } });
    };
    Object.defineProperties(send, { matchesContract: { value: contract => contract?.slotId === a.slotId && contract.runId === a.runId && contract.promptCacheKey === a.cacheKey }, permit: { value: permit }, decorator: { value: Object.freeze(decorator) }, binds: { value: profile =>
      profile?.routeKind === "real" && profile.authPath === a.authorization.credentialPath && profile.work === lookupPilotWork(a)
      && digest(profile.plan) === digest(a.plan) && profile.arm?.id === a.roleRequest.binding.arm } });
    decorators.add(decorator); sends.add(send); return Object.freeze(send);
  } catch (error) {
    // No paths, parser messages, credential values or arbitrary causes leave minting.
    if (["lookup_pilot_real_route_unavailable", "lookup_pilot_capability_invalid", "paid_mode_refused_in_ci", "lookup_debug_forbidden"].includes(error?.code)) throw error;
    fail();
  }
}
