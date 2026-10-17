import { randomUUID } from "node:crypto";

import type { DurableContinuationRecord } from "./continuation-store.js";
import { ContinuationProtocolError } from "./continuation-service-errors.js";
import {
  asObject,
  authorizeRecordToken,
  expire,
  parseClaim,
  requireRecord,
  requiredStringField,
  type ParsedClaim,
} from "./continuation-service-helpers.js";
import {
  type ClaimBinding,
} from "./continuation-service-types.js";
import {
  TERMINAL_CONTINUATION_STATES,
  canonicalContinuationJson,
  continuationDigest,
} from "./continuations.js";
import type { ContinuationProtocolDependencies } from "./operation-ports.js";

export function createContinuationProtocolOperations(dependencies: ContinuationProtocolDependencies) {
  async function claim(binding: ClaimBinding, body: unknown): Promise<Record<string, unknown>> {
    const claim = parseClaim(body, dependencies.now(), dependencies.maxDeadlineMs);
    return await claimBound(binding, claim);
  }

  async function claimDetached(serviceName: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const routeName = requiredStringField(object, "route");
    const route = dependencies.namedRoutes[routeName];
    if (route === undefined) {
      throw new ContinuationProtocolError(403, "unknown_named_route", "Detached claim route is not configured.");
    }
    const claim = parseClaim(body, dependencies.now(), dependencies.maxDeadlineMs);
    const originConversationId = route.conversationId ?? `continuation-route:${routeName}`;
    const fingerprint = continuationDigest([
      "v1-detached",
      serviceName,
      routeName,
      route.mode,
      route.conversationId ?? "",
    ].join("\0"));
    return await claimBound({
      serverName: `detached:${serviceName}`,
      originRunId: `detached:${serviceName}:${claim.taskKey}`,
      originConversationId,
      ...(route.conversationId === undefined ? {} : { replyToConversationId: route.conversationId }),
      mode: route.mode,
      fingerprint,
      closed: false,
      settled: true,
      inFlightOperations: 0,
    }, claim, routeName);
  }

  async function claimBound(
    binding: ClaimBinding,
    claim: ParsedClaim,
    routeName?: string,
  ): Promise<Record<string, unknown>> {
    let created = false;
    const record = await dependencies.store.mutate((records) => {
      const existing = [...records.values()].find((candidate) =>
        candidate.serverName === binding.serverName
        && candidate.originRunId === binding.originRunId
        && candidate.taskKey === claim.taskKey,
      );
      if (existing !== undefined) {
        if (existing.taskHash !== claim.taskHash
          || existing.claimFingerprint !== binding.fingerprint
          || existing.deadline !== claim.deadline) {
          throw new ContinuationProtocolError(
            409,
            "claim_conflict",
            "taskKey was already claimed with different immutable inputs.",
          );
        }
        return structuredClone(existing);
      }
      const active = [...records.values()].filter(
        (candidate) => !TERMINAL_CONTINUATION_STATES.has(candidate.state),
      );
      if (active.length >= dependencies.limits.maxActiveRecords) {
        throw new ContinuationProtocolError(
          429,
          "active_continuation_limit",
          `The service already has its maximum ${String(dependencies.limits.maxActiveRecords)} active continuations.`,
        );
      }
      const activeForOrigin = active.filter(
        (candidate) => candidate.claimFingerprint === binding.fingerprint,
      ).length;
      if (activeForOrigin >= dependencies.limits.maxActivePerOrigin) {
        throw new ContinuationProtocolError(
          429,
          "active_origin_limit",
          `This claim origin already has its maximum ${String(dependencies.limits.maxActivePerOrigin)} active continuations.`,
        );
      }
      const now = dependencies.now().toISOString();
      const continuationId = randomUUID();
      const token = dependencies.deriveResultToken(continuationId, claim.taskHash);
      const next: DurableContinuationRecord = {
        continuationId,
        serverName: binding.serverName,
        originRunId: binding.originRunId,
        originConversationId: binding.originConversationId,
        ...(binding.replyToConversationId === undefined
          ? {}
          : { replyToConversationId: binding.replyToConversationId }),
        ...(binding.historyBoundary === undefined ? {} : { historyBoundary: binding.historyBoundary }),
        originContextState: binding.historyBoundary === undefined ? "detached_latest" : "pending",
        mode: binding.mode,
        ...(routeName === undefined ? {} : { routeName }),
        taskKey: claim.taskKey,
        taskHash: claim.taskHash,
        claimFingerprint: binding.fingerprint,
        resultTokenHash: continuationDigest(token),
        createdAt: now,
        updatedAt: now,
        deadline: claim.deadline,
        state: "claimed",
        synthesisAttempts: 0,
        synthesisDeferrals: 0,
        deliveryAttempts: 0,
      };
      records.set(continuationId, next);
      created = true;
      return structuredClone(next);
    });
    const token = dependencies.deriveResultToken(record.continuationId, record.taskHash);
    return {
      continuationId: record.continuationId,
      resultUrl: `${dependencies.baseUrl()}/v1/continuations/${encodeURIComponent(record.continuationId)}/result`,
      statusUrl: `${dependencies.baseUrl()}/v1/continuations/${encodeURIComponent(record.continuationId)}/status`,
      token,
      expiresAt: record.deadline,
      fingerprint: record.claimFingerprint,
      ...(created ? {} : { replayed: true }),
    };
  }

  async function acceptResult(id: string, token: string, body: unknown): Promise<Record<string, unknown>> {
    const object = asObject(body);
    const idempotencyKey = requiredStringField(object, "idempotencyKey", 256);
    if (!("payload" in object)) {
      throw new ContinuationProtocolError(400, "missing_payload", "Result payload is required.");
    }
    const serialized = canonicalContinuationJson(object.payload);
    const payloadHash = continuationDigest(serialized);
    const providedHash = typeof object.payloadHash === "string" ? object.payloadHash : undefined;
    if (providedHash !== undefined && providedHash !== payloadHash) {
      throw new ContinuationProtocolError(
        400,
        "payload_hash_mismatch",
        "Result payload hash does not match the payload.",
      );
    }
    const now = dependencies.now();
    const record = await dependencies.store.mutate((records) => {
      const current = requireRecord(records, id);
      authorizeRecordToken(current, token);
      if (current.resultIdempotencyKey !== undefined) {
        if (current.resultIdempotencyKey !== idempotencyKey || current.resultPayloadHash !== payloadHash) {
          throw new ContinuationProtocolError(
            409,
            "result_conflict",
            "Continuation already has a different immutable result.",
          );
        }
        return structuredClone(current);
      }
      if (current.state !== "claimed") {
        throw new ContinuationProtocolError(409, "result_not_accepted", `Continuation is ${current.state}.`);
      }
      if (Date.parse(current.deadline) <= now.getTime()) {
        expire(current, now.toISOString());
        throw new ContinuationProtocolError(410, "continuation_expired", "Continuation deadline has passed.");
      }
      current.resultIdempotencyKey = idempotencyKey;
      current.resultPayloadHash = payloadHash;
      current.resultPayload = structuredClone(object.payload);
      current.state = "result_received";
      current.updatedAt = now.toISOString();
      return structuredClone(current);
    });
    dependencies.scheduleProcess();
    return { continuationId: id, state: record.state, accepted: true };
  }

  async function authorizedRecord(id: string, token: string): Promise<DurableContinuationRecord> {
    const record = await dependencies.store.get(id);
    if (record === undefined) {
      throw new ContinuationProtocolError(404, "not_found", "Continuation not found.");
    }
    authorizeRecordToken(record, token);
    return record;
  }

  return { claim, claimDetached, acceptResult, authorizedRecord };
}
