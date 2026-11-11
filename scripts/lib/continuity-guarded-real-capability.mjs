// Shared guarded-run mechanics; historical authority names remain visible to the exact inventory.
import process from "node:process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { digest } from "./continuity-dataset.mjs";
import { guardedProtocol } from "./continuity-guarded-protocols.mjs";
const nativeDispatch = new AsyncLocalStorage();
export const isGuardedNativeDispatch = id => nativeDispatch.getStore() === id;
const nativeFetch = globalThis.fetch.bind(globalThis);
// Recognition crosses protocol boundaries; authority remains in each protocol-local set.
const realSends = new WeakSet();
export const isAnyGuardedRealSend = send => realSends.has(send);
const instances = new Map();
export function guardedRealCapability(protocolId) {
  const protocol = guardedProtocol(protocolId);
  if (!instances.has(protocol)) instances.set(protocol, bind(protocol, protocolId));
  return instances.get(protocol);
}
function bind(protocol, protocolId) {
  const { bodyBytes: lookupBodyBytes, assertResolvedSafety: assertResolvedLookupSafety, work: lookupPilotWork, forwardedObserver: lookupForwardedObserver, verifyRealAssignment: verifyLookupRealAssignment } = protocol.hooks;
  const sends = new WeakSet(), decorators = new WeakSet(), minted = new Set();
  const fail = (code = protocol.codes.pilot_capability_invalid) => { throw Object.assign(new Error(code), { code }); };
  const need = ok => { if (!ok) fail(); };
  const isRealLookupSend = send => sends.has(send);
  const realLookupSendForGuard = (send, permit, contract) => sends.has(send) && send.permit === permit && send.matchesContract(contract);
  const isRealLookupDecorator = decorator => decorators.has(decorator);
  const realLookupSendBinds = (send, profile) => sends.has(send) && send.binds(profile);
  async function createLookupRealSend(a, resolvedSafety) {
    try {
      need(protocol.realRoute);
      a = structuredClone(a);
      const { handle } = await verifyLookupRealAssignment(a);
      const { wrapModels, assertRealPermitSource, matchesAccount, createIPC } = await protocol.hooks.realModules();
      assertResolvedLookupSafety(resolvedSafety);
      need(digest(resolvedSafety.plan) === digest(a.plan) && resolvedSafety.arm.id === a.roleRequest.binding.arm);
      const mintKey = digest([a.outputRoot, a.epoch, a.slotId, process.pid]);
      need(!minted.has(mintKey)); minted.add(mintKey);
      const permit = await createIPC(a), used = new Set(), forwarded = lookupForwardedObserver();
      assertRealPermitSource(permit);
      const stop = async (code, integrity = false) => {
        let cause;
        try { await permit.stop(code); } catch (error) { cause = error; }
        const error = Object.assign(new Error(code), { code, ...(integrity ? { outcome: "integrity_stop" } : {}) });
        if (cause) { error.stopCode = protocol.codes.stop_failed; error.cause = cause; }
        throw error;
      };
      const quota = error => ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota", "quota_exceeded", "rate_limit_exceeded"].includes(error?.code)
        || ["usage_limit_reached", "usage_limit_exceeded", "insufficient_quota"].includes(error?.type);
      const observeNative = (stage, status, code, binding) => {
        try { protocol.execution?.observeNative?.(resolvedSafety, stage, status, code, binding); } catch { /* Observation cannot change send or refusal. */ }
      };
      const send = async (url, init) => {
        assertResolvedLookupSafety(resolvedSafety);
        need(digest(resolvedSafety.plan) === digest(a.plan) && resolvedSafety.arm.id === a.roleRequest.binding.arm);
        need(init && Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
        const endpoint = String(url);
        init = { ...init, headers: new Headers(init.headers), body: lookupBodyBytes(init.body) };
        need(Object.keys(init).every(key => ["method", "headers", "body", "signal", "redirect"].includes(key)));
        need(endpoint === `${protocol.policy.GUARD_CONTRACT.baseUrl}/codex/responses` && init?.method === "POST"
          && (init.redirect === undefined || init.redirect === "error") && process.connected);
        const { state } = await verifyLookupRealAssignment(a), hold = state.slots[a.index].holds.at(-1);
        const clock = protocol.execution?.deadlines;
        const assertDeadline = async () => {
          const now = Date.now();
          if (now >= state.deadlineAt) await stop(protocol.codes.run_deadline);
          if (now >= Math.min(clock.phaseAt(a.pilot.descriptor.deadlines, state.slots[a.index]), clock.requestAt(a.pilot.descriptor.deadlines, hold))) await stop(protocol.codes.worker_timeout);
        };
        if (clock) await assertDeadline();
        else need(Date.now() < Math.min(state.deadlineAt, state.slots[a.index].startedAt + a.pilot.descriptor.deadlines.deadlineMs));
        const headers = new Headers(init.headers), encoding = headers.get("content-encoding");
        need((encoding === null || encoding === "zstd") && (protocol.execution?.assertCacheHeaders || headers.get("session-id") === a.cacheKey && headers.get("x-client-request-id") === a.cacheKey));
        const bytes = encoding === "zstd" ? zstdDecompressSync(init.body) : Buffer.from(init.body);
        need(hold?.consumed === true && !hold.revoked && !hold.settlement && !used.has(hold.permitId)
          && hold.payloadDigest === createHash("sha256").update(bytes).digest("hex"));
        const binding = { round: hold.round, role: hold.paidRole, checkpoint: hold.checkpoint, payloadDigest: hold.payloadDigest };
        observeNative("request_setup", null, undefined, binding);
        if (!matchesAccount(handle, headers.get("chatgpt-account-id"))) await stop(protocol.codes.account_mismatch);
        try { protocol.execution?.assertCacheHeaders?.(headers, hold, a.cacheKey); protocol.execution?.assertBody(bytes, hold); if (protocol.execution?.verifyNativeBody) await protocol.execution.verifyNativeBody(bytes, hold, state, a, permit); }
        catch (error) { await stop(error?.code ?? protocol.codes.body_mismatch, true); }
        if (clock) await assertDeadline(); // Native-body verification may have awaited durable history.
        used.add(hold.permitId); // Single send per permit, including after rejection/abort. E2 retries need a fresh permit.
        let response;
        try { response = await nativeDispatch.run(protocolId, () => nativeFetch(endpoint, { ...init, redirect: "error" })); }
        catch (error) { observeNative("dispatch", null, error?.code ?? error?.cause?.code); throw error; }
        observeNative("response_headers", response.status);
        const rejectResponse = async code => {
          try { void response.body?.cancel().catch(() => {}); } catch {}
          await stop(code);
        };
        if ([401, 403].includes(response.status)) await rejectResponse(protocol.codes.auth_failure);
        if (response.status === 429 && !protocol.execution?.deferNativeFailure?.(a.pilot, response.status)) await rejectResponse(protocol.codes.quota_exhausted);
        const type = response.headers.get("content-type") ?? "";
        if (type.includes("application/json")) {
          const body = await response.clone().json().catch(() => null);
          observeNative("response_headers", response.status, body?.error?.code ?? body?.error?.type);
          if (quota(body?.error) && !protocol.execution?.deferNativeFailure?.(a.pilot, response.status, body?.error?.code ?? body?.error?.type)) await rejectResponse(protocol.codes.quota_exhausted);
        }
        if (!response.body || !type.includes("text/event-stream")) return response;
        let body = response.body;
        if (protocol.execution?.observeNative) {
          const reader = body.getReader();
          body = new ReadableStream({
            async pull(controller) {
              try { const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }
              catch (error) {
                let code = typeof error?.code === "string" ? error.code : error?.cause?.code;
                if ((!code || code === "ABORT_ERR") && error?.name === "AbortError" && !init.signal?.aborted) code = "ERR_STREAM_PREMATURE_CLOSE";
                observeNative("provider_terminal", null, code, binding); controller.error(error);
              }
            },
            cancel(reason) { return reader.cancel(reason); },
          });
        }
        let buffer = ""; const decoder = new TextDecoder();
        return new Response(body.pipeThrough(new TransformStream({
          async transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            if (buffer.length > 4 * 1024 * 1024) await stop(protocol.codes.payload_forbidden);
            const frames = buffer.split(/\r?\n\r?\n/u); buffer = frames.pop();
            for (const frame of frames) {
              const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              let event; try { event = JSON.parse(data); } catch { continue; }
              if (["response.completed", "response.incomplete", "response.failed", "error"].includes(event?.type) || event?.error || event?.response?.error)
                for (const code of [event?.error?.code, event?.error?.type, event?.response?.error?.code, event?.response?.error?.type, event?.code, event?.type, event?.response?.incomplete_details?.reason])
                  observeNative("provider_terminal", null, code, binding);
              if ((quota(event?.error) || quota(event?.response?.error)) && !protocol.execution?.deferNativeFailure?.(a.pilot, null, event?.error?.code ?? event?.response?.error?.code)) await stop(protocol.codes.quota_exhausted);
            }
            controller.enqueue(chunk);
          },
        })), { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      const decorator = models => {
        need(decorators.delete(decorator));
        return wrapModels(models, { permit, send, resolvedSafety, onForwarded: forwarded.notify, contract: {
          ...protocol.policy.GUARD_CONTRACT, runId: a.runId, slotId: a.slotId, promptCacheKey: a.cacheKey,
        } });
      };
      Object.defineProperties(send, { matchesContract: { value: contract => contract?.slotId === a.slotId && contract.runId === a.runId && contract.promptCacheKey === a.cacheKey }, permit: { value: permit }, decorator: { value: Object.freeze(decorator) }, observeForwarded: { value: forwarded.register }, binds: { value: profile =>
        profile?.routeKind === "real" && profile.authPath === a.authorization.credentialPath && profile.work === lookupPilotWork(a)
        && digest(profile.plan) === digest(a.plan) && profile.arm?.id === a.roleRequest.binding.arm } });
      decorators.add(decorator); sends.add(send); realSends.add(send); return Object.freeze(send);
    } catch (error) {
      // No paths, parser messages, credential values or arbitrary causes leave minting.
      if ([protocol.codes.pilot_real_route_unavailable, protocol.codes.preparation_invalid, protocol.codes.pilot_role_not_measured, protocol.codes.pilot_capability_invalid, "paid_mode_refused_in_ci", protocol.codes.debug_forbidden].includes(error?.code)) throw error;
      fail();
    }
  }
  return Object.freeze({ isRealLookupSend, realLookupSendForGuard, isRealLookupDecorator, realLookupSendBinds, createLookupRealSend });
}
