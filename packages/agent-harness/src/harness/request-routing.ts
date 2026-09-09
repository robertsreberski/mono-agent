import { deriveRunSource } from "@mono-agent/observability";
import {
  modelReferenceKey,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import { sessionModelKey } from "../session-runtime.js";
import type { AgentHarnessRequest } from "../types.js";
import { isRecord } from "./value-utils.js";

type ModelOverrideOrigin = "webhook" | "cron" | "web" | "tui" | "telegram" | "slack";

interface ModelOverrideDeclaration {
  readonly origin: ModelOverrideOrigin;
  readonly value: Record<string, unknown>;
}

export function createDefaultRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derives a run's `source` (and optional `sourceDetail`) from its request
 * metadata, for the recorder factory input. Priority order mirrors how each
 * channel/trigger stamps `request.metadata`:
 *  1. `metadata.source === "web"` or `"tui"` (the operator endpoint injects this)
 *  2. `metadata.cron` present → "cron", detail = `metadata.cron.jobId` (string)
 *  3. `metadata.webhook` present → "webhook", detail = `metadata.webhook.endpointName` (string)
 *  4. `metadata.slack` / `metadata.telegram` / `metadata.messenger` present →
 *     that channel name
 *  5. otherwise falls back to {@link deriveRunSource}'s conversationId-prefix
 *     derivation, so unrecognized/legacy metadata still gets a best-effort source.
 * Never throws — `metadata` is `Record<string, unknown> | undefined` and any
 * unexpected shape (e.g. `cron` not itself a record) just falls through.
 */
export function runSourceFromRequest(
  request: Pick<AgentHarnessRequest, "conversationId" | "metadata">,
): { readonly source?: string; readonly sourceDetail?: string } {
  const metadata = request.metadata;
  if (isRecord(metadata)) {
    if (metadata.source === "web") {
      return { source: "web" };
    }
    if (metadata.source === "tui") {
      return { source: "tui" };
    }
    if (isRecord(metadata.cron)) {
      const jobId = metadata.cron.jobId;
      return { source: "cron", ...(typeof jobId === "string" ? { sourceDetail: jobId } : {}) };
    }
    if (isRecord(metadata.webhook)) {
      const endpointName = metadata.webhook.endpointName;
      return { source: "webhook", ...(typeof endpointName === "string" ? { sourceDetail: endpointName } : {}) };
    }
    if (isRecord(metadata.slack)) {
      return { source: "slack" };
    }
    if (isRecord(metadata.telegram)) {
      return { source: "telegram" };
    }
    if (isRecord(metadata.messenger)) {
      return { source: "messenger" };
    }
  }
  return { source: deriveRunSource(request.conversationId) };
}

/**
 * A cron/proactive request carries a `cron` metadata block (set by the cron
 * scheduler when it fires a job). Used to scope the proactive-session-isolation
 * opt-in to scheduled runs without touching interactive turns.
 */
export function isCronRequest(request: AgentHarnessRequest): boolean {
  return isRecord(request.metadata) && request.metadata.cron !== undefined;
}

/**
 * This reader selects the requested session primary before context assembly;
 * its metadata precedence must match agent-app readOverride so the declared
 * binding and executed model agree.
 */
export function requestSessionModel(request: AgentHarnessRequest, defaultModel: RuntimeModelReference): RuntimeModelReference {
  const declaration = modelOverrideDeclaration(request.metadata);
  const model = declaration?.value.model;
  if (typeof model !== "string" || model.trim().length === 0) return parseMonoRuntimeModelReference(sessionModelKey(defaultModel));
  try {
    return parseMonoRuntimeModelReference(model);
  } catch {
    // Invalid declarations are warned-and-ignored by the app extension.
    return parseMonoRuntimeModelReference(sessionModelKey(defaultModel));
  }
}

export function requestOverridesModel(request: AgentHarnessRequest, defaultModel: RuntimeModelReference): boolean {
  return modelReferenceKey(requestSessionModel(request, defaultModel)) !== sessionModelKey(defaultModel);
}

function modelOverrideDeclaration(metadata: AgentHarnessRequest["metadata"]): ModelOverrideDeclaration | undefined {
  if (!isRecord(metadata)) return undefined;
  return isRecord(metadata.webhook)
    ? { origin: "webhook", value: metadata.webhook }
    : isRecord(metadata.cron)
      ? { origin: "cron", value: metadata.cron }
      : isRecord(metadata.web)
        ? { origin: "web", value: metadata.web }
        : isRecord(metadata.tui)
          ? { origin: "tui", value: metadata.tui }
          : isRecord(metadata.telegram)
            ? { origin: "telegram", value: metadata.telegram }
            : isRecord(metadata.slack)
              ? { origin: "slack", value: metadata.slack }
              : undefined;
}
