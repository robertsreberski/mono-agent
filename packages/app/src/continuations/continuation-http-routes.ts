import type { IncomingMessage, ServerResponse } from "node:http";

import { ContinuationProtocolError } from "./continuation-service-errors.js";
import {
  asObject,
  readJson,
  requireBearer,
  requireHeader,
  safeReason,
  sendJson,
  statusOfRequired,
} from "./continuation-service-helpers.js";
import {
  MAX_CLAIM_BODY_BYTES,
} from "./continuation-service-types.js";
import type { ContinuationHttpOperations } from "./operation-ports.js";

export function createContinuationHttpRoutes(operations: ContinuationHttpOperations) {
  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    if (operations.isStopped()) {
      throw new ContinuationProtocolError(503, "service_stopping", "Continuation service is stopping.");
    }
    const url = new URL(request.url ?? "/", operations.baseUrl());
    if (request.method === "POST" && url.pathname === "/v1/continuations/claim") {
      const token = requireBearer(request);
      const claim = operations.authorizeRunClaim(token);
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      await claim(body, (result) => { sendJson(response, 200, result); });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/continuations/detached/claim") {
      const serviceName = requireHeader(request, "x-mono-agent-service-name");
      operations.authorizeDetached(serviceName, requireBearer(request));
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      sendJson(response, 200, await operations.claimDetached(serviceName, body));
      return;
    }
    const resultMatch = /^\/v1\/continuations\/([^/]+)\/result$/u.exec(url.pathname);
    if ((request.method === "PUT" || request.method === "POST") && resultMatch?.[1] !== undefined) {
      const body = await readJson(request, operations.maxResultBytes);
      sendJson(response, 202, await operations.acceptResult(resultMatch[1], requireBearer(request), body));
      return;
    }
    const statusMatch = /^\/v1\/continuations\/([^/]+)\/status$/u.exec(url.pathname);
    if (request.method === "GET" && statusMatch?.[1] !== undefined) {
      const record = await operations.authorizedRecord(statusMatch[1], requireBearer(request));
      sendJson(response, 200, statusOfRequired(record));
      return;
    }
    if (url.pathname === "/v1/operator/continuations") {
      operations.authorizeOperator(request);
      if (request.method !== "GET") {
        throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      }
      sendJson(response, 200, await operations.list(url));
      return;
    }
    if (url.pathname === "/v1/operator/health") {
      operations.authorizeOperator(request);
      if (request.method !== "GET") {
        throw new ContinuationProtocolError(405, "method_not_allowed", "Method not allowed.");
      }
      sendJson(response, 200, await operations.health());
      return;
    }
    const operatorMatch = /^\/v1\/operator\/continuations\/([^/]+)\/(retry|cancel|resolve)$/u.exec(url.pathname);
    if (request.method === "POST" && operatorMatch?.[1] !== undefined && operatorMatch[2] !== undefined) {
      operations.authorizeOperator(request);
      const body = await readJson(request, MAX_CLAIM_BODY_BYTES);
      if (operatorMatch[2] === "retry") {
        sendJson(response, 200, await operations.retry(operatorMatch[1], {
          allowUnknown: asObject(body).allowUnknown === true,
        }));
      } else if (operatorMatch[2] === "cancel") {
        sendJson(response, 200, await operations.cancel(operatorMatch[1]));
      } else {
        const value = asObject(body);
        const kind = value.kind;
        if (kind !== "delivered" && kind !== "not_delivered" && kind !== "dead_lettered") {
          throw new ContinuationProtocolError(400, "invalid_resolution", "Resolution kind is invalid.");
        }
        sendJson(response, 200, await operations.resolveUnknown(operatorMatch[1], {
          kind,
          ...(kind === "delivered" && typeof value.deliveryId === "string"
            ? { deliveryId: value.deliveryId }
            : {}),
        }));
      }
      return;
    }
    throw new ContinuationProtocolError(404, "not_found", "Continuation endpoint not found.");
  }

  function handleRequestError(response: ServerResponse, error: unknown): void {
    if (response.headersSent || response.writableEnded) return;
    const protocol = error instanceof ContinuationProtocolError
      ? error
      : new ContinuationProtocolError(500, "internal_error", "Continuation request failed.");
    if (!(error instanceof ContinuationProtocolError)) {
      operations.logger?.error?.("Continuation request failed.", { reason: safeReason(error) });
    }
    sendJson(response, protocol.status, { error: { code: protocol.code, message: protocol.message } });
  }
  return { handleRequest, handleRequestError };
}
