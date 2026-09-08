import { deriveRunSource } from "@mono-agent/observability";
import {
  modelReferenceKey,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

import type { AgentHarnessRequest } from "../types.js";
import { isRecord } from "./value-utils.js";

type ModelOverrideOrigin = "webhook" | "cron" | "web" | "tui" | "telegram" | "slack";

interface ModelOverrideDeclaration {
  readonly origin: ModelOverrideOrigin;
  readonly value: Record<string, unknown>;
}

// Existing host-owned producer convention. Operator writes a non-enumerable
// descriptor; Slack, Telegram, and WhatsApp use enumerable symbol properties.
// Presence alone marks proactive work: never read or expose the value here.
const HOST_WAKE_DELIVERY_METADATA = Symbol.for("mono-agent.process-job-wake.delivery-key.v1");

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
 * Whether the request carries a per-turn MODEL override that resolves to a
 * model DIFFERENT from the harness default. The override may be pinned by a
 * trigger (`metadata.webhook`/`metadata.cron`) or picked interactively from the
 * web console (`metadata.web`), TUI (`metadata.tui`), Telegram
 * (`metadata.telegram`), or Slack (`metadata.slack`). Only a different model
 * forces session isolation — it
 * runs on a different model (often a different runtime), and the provider session
 * is keyed by conversationId + bound to a model, so resuming or persisting it
 * against the shared session would mix two models' lineage (durable-session
 * corruption / wrong-runtime disposal).
 *
 * A SAME-MODEL override (e.g. an endpoint redundantly naming the host default)
 * leaves the runtime/model chain unchanged, so it must keep the shared continuous
 * session like an ordinary turn. An effort-only override carries no model string;
 * an unparseable string is ignored downstream (warn+ignore → the turn runs on the
 * default), so both are treated as "no model override" here. This keys off the
 * SAME canonical `modelReferenceKey` comparison the harness uses to decide whether
 * to switch runtimes (`sameRuntimeModel`), so the isolation decision and the
 * runtime/session-key decision can never disagree.
 * Keep this metadata-reader precedence in lockstep with `readOverride` in
 * `@mono-agent/agent-app`, which resolves the runtime options used below.
 */
export function requestOverridesModel(request: AgentHarnessRequest, defaultModel: RuntimeModelReference): boolean {
  const declaration = modelOverrideDeclaration(request.metadata);
  if (declaration === undefined) {
    return false;
  }
  return overridesDefaultModel(declaration.value, defaultModel);
}

/** @internal Whether an isolated different-model request is genuinely interactive. */
export function interactiveModelOverrideCanOwnLiveInput(
  request: AgentHarnessRequest,
  defaultModel: RuntimeModelReference,
): boolean {
  const metadata = request.metadata;
  if (!isRecord(metadata) || request.continuation !== undefined) return false;

  const cronPresent = ownPropertyPresent(metadata, "cron");
  const webhookPresent = ownPropertyPresent(metadata, "webhook");
  const hostWakePresent = ownPropertyPresent(metadata, HOST_WAKE_DELIVERY_METADATA);
  if (
    cronPresent !== false
    || webhookPresent !== false
    || hostWakePresent !== false
  ) {
    return false;
  }

  const declaration = modelOverrideDeclaration(metadata);
  if (declaration === undefined || !overridesDefaultModel(declaration.value, defaultModel)) return false;

  try {
    switch (declaration.origin) {
      case "web": return metadata.source === "web";
      case "tui": return metadata.source === "tui";
      case "telegram": return metadata.source === undefined || metadata.source === "telegram";
      case "slack": return metadata.source === undefined || metadata.source === "slack";
      case "webhook":
      case "cron":
        return false;
    }
  } catch {
    return false;
  }
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

function overridesDefaultModel(source: Record<string, unknown>, defaultModel: RuntimeModelReference): boolean {
  if (typeof source.model !== "string" || source.model.trim().length === 0) return false;
  try {
    return modelReferenceKey(parseMonoRuntimeModelReference(source.model)) !== modelReferenceKey(defaultModel);
  } catch {
    // An unparseable override is warned-and-ignored downstream, so the turn runs
    // on the default model — i.e. no model change, no isolation.
    return false;
  }
}

function ownPropertyPresent(value: object, property: PropertyKey): boolean | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, property) !== undefined;
  } catch {
    // A hostile/exceptional metadata object cannot qualify for the new isolated
    // mailbox exception. This does not change the existing metadata readers.
    return undefined;
  }
}
