import { parentPort } from "node:worker_threads";

import { auditBujoMemoryHealth } from "@mono-agent/memory/bujo";

import type {
  MemoryHealthWorkerRequest,
  MemoryHealthWorkerResponse,
} from "./memory-health-worker-client.js";

if (parentPort === null) {
  throw new Error("Memory health worker requires a parent port.");
}

const port = parentPort;
port.on("message", (value: unknown) => {
  if (!isRequest(value)) return;
  let response: MemoryHealthWorkerResponse;
  try {
    response = {
      type: "result",
      id: value.id,
      report: auditBujoMemoryHealth(value.options),
    };
  } catch {
    // Raw native, filesystem, and configuration errors stay inside the worker.
    response = { type: "error", id: value.id };
  }
  port.postMessage(response);
});

function isRequest(value: unknown): value is MemoryHealthWorkerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request.type !== "audit" || typeof request.id !== "number" || !Number.isSafeInteger(request.id) || request.id <= 0) {
    return false;
  }
  const options = request.options;
  if (typeof options !== "object" || options === null || Array.isArray(options)) return false;
  const candidate = options as Record<string, unknown>;
  return typeof candidate.root === "string"
    && (candidate.mode === "lite" || candidate.mode === "journal" || candidate.mode === "bujo")
    && (candidate.configuredEmbeddingModel === undefined || typeof candidate.configuredEmbeddingModel === "string")
    && (candidate.configuredLegacyEmbeddingModel === undefined
      || typeof candidate.configuredLegacyEmbeddingModel === "string")
    && (candidate.configuredDimension === undefined || (typeof candidate.configuredDimension === "number" && Number.isSafeInteger(candidate.configuredDimension)))
    && (candidate.now === undefined || candidate.now instanceof Date)
    && (candidate.maxStabilityAttempts === undefined
      || (typeof candidate.maxStabilityAttempts === "number"
        && Number.isSafeInteger(candidate.maxStabilityAttempts)
        && candidate.maxStabilityAttempts >= 1
        && candidate.maxStabilityAttempts <= 3));
}
