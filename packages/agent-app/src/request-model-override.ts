import { detectEffortKeyword, EFFORT_LEVELS, effortRank } from "@mono-agent/config";
import {
  assertParsedRuntimeModelReference,
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
  runtimeOptionsForLocalProvider,
  sanitizeModelReferenceText,
} from "@mono-agent/runtime-adapter";
import type {
  LocalProviderDefinition,
  LocalProviderRuntimeOptions,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

/**
 * Per-request runtime-options extension that applies a per-turn model/effort
 * override carried on webhook (`metadata.webhook`), cron (`metadata.cron`), or
 * web console (`metadata.web`), interactive TUI (`metadata.tui`), Telegram
 * (`metadata.telegram`), or Slack (`metadata.slack`) request metadata — an operator can pick model/effort
 * just as a trigger can pin one. The
 * adapters carry the override as raw strings; this is the
 * first place with both the model parser and the effort enum, so validation
 * lives here. An invalid value is WARNED and IGNORED (the turn falls back to the
 * harness default) rather than failing — a bad dynamic webhook `model` must not
 * 500 the request.
 *
 * The extension ALSO scans every turn's message text for effort trigger
 * phrases ("think"/"extra think"/"ultra think") and escalates the turn's
 * effort — see `applyEffortKeywordEscalation`. This lives here rather than in
 * a sibling extension because siblings compose later-wins in parallel: only
 * this extension knows the metadata effort the keyword must be compared
 * against (escalation-only).
 * Effort-only writes keep the shared session (the harness isolates on MODEL
 * overrides only).
 *
 * A model override OWNS the local-provider endpoint block. Whenever a VALID model
 * override is applied, this extension SETS the four endpoint fields
 * (`customProvider`/`customModel`/`modelCapabilities`/`isPrivateProvider`):
 *   - LOCAL override with a configured provider id: recompute the
 *     block for the OVERRIDE model via `runtimeOptionsForLocalProvider`.
 *   - CLOUD/registry override, an UNCONFIGURED local provider id, or a
 *     misconfigured provider: set the four fields to `null` to explicitly CLEAR
 *     the host default's block.
 * This is required because the host default block is computed ONCE from
 * `config.runtime.model` at harness creation, and the pi runtime routes on
 * `customProvider` PRESENCE alone — so a cloud override under an all-LOCAL default
 * would otherwise inherit the default's local endpoint and send the cloud model to
 * localhost (same mis-route for an unconfigured local provider id). The harness
 * `mergeRuntimeOptions` applies the override AFTER the host default
 * (last-writer-wins) and reads `null` on these keys as "delete", so a set block
 * REPLACES the default and a null CLEARS it. An effort-only / no-model turn leaves
 * the block untouched (the default's block is correct for the default model).
 */
export interface RequestModelOverrideLogger {
  warn?(message: string, metadata?: Record<string, unknown>): void;
  info?(message: string, metadata?: Record<string, unknown>): void;
}

export interface RequestModelOverrideOptions {
  readonly logger?: RequestModelOverrideLogger;
  /** Host primary retained when a request does not select another model. */
  readonly baseModel?: RuntimeModelReference;
  /** Host fallback chain retained behind a request-level primary override. */
  readonly fallbackModels?: readonly RuntimeModelReference[];
  /** Host effort inherited by model-only overrides unless the override supplies one. */
  readonly baseEffort?: string;
  /**
   * Configured local providers (`config.providers?.local`). When an override
   * names a model one of these serves, the extension recomputes the provider
   * endpoint block so the override reaches the right local endpoint instead of
   * inheriting the host default's block.
   */
  readonly localProviders?: readonly LocalProviderDefinition[];
}

interface RequestModelOverrideInput {
  readonly request: {
    readonly metadata?: Record<string, unknown>;
    readonly userMessage?: string;
  };
}

interface RequestModelOverrideResult {
  readonly runtimeOptions: {
    model?: RuntimeModelReference;
    effort?: string;
    // `null` is an explicit CLEAR sentinel the harness merge reads as "delete the
    // host default's value" (undefined would leave it untouched) — see the module
    // doc. Set for a local override, null for a non-local one.
    customProvider?: LocalProviderRuntimeOptions["customProvider"] | null;
    customModel?: LocalProviderRuntimeOptions["customModel"] | null;
    modelCapabilities?: LocalProviderRuntimeOptions["modelCapabilities"] | null;
    isPrivateProvider?: LocalProviderRuntimeOptions["isPrivateProvider"] | null;
  };
  readonly cleanup: () => Promise<void>;
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/**
 * Bound and neutralize one operator-supplied fragment before a diagnostic quotes it. The
 * values that reach these warnings are exactly the ones that FAILED to parse, so none of them
 * carries a parsed reference's printable/single-line/bounded guarantee. A structured logger
 * escapes a newline for its own encoding, but nothing bounds the record: a 1 MB webhook
 * `model` wrote a 1 MB log line every turn it was replayed. Same escape-then-clamp helper and
 * same budget as every other operator surface, so an operator sees one rendering of a value.
 */
function echoValue(value: string): string {
  return sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

/**
 * Reasons come from the runtime adapter (already bounded, so this pass is a no-op -- the
 * sanitizer is idempotent) and from arbitrary throws below it, which are not. Bounding here
 * covers both without the call sites having to know which is which.
 */
function echoReason(error: unknown): string {
  return sanitizeModelReferenceText(
    error instanceof Error ? error.message : String(error),
    MODEL_REFERENCE_REASON_MAX_BYTES,
  );
}

export function createRequestModelOverrideRuntimeExtension(
  options?: RequestModelOverrideOptions,
): (input: RequestModelOverrideInput) => Promise<RequestModelOverrideResult> {
  const logger = options?.logger;
  const localProviders = options?.localProviders;
  return async (input) => {
    const { rawModel, rawEffort, model } = resolveAcceptedModelOverride(
      input.request.metadata,
      options,
      logger,
    );
    const runtimeOptions: RequestModelOverrideResult["runtimeOptions"] = {};
    if (model !== undefined && rawModel !== undefined) {
      runtimeOptions.model = model;
      applyLocalProviderBlock(runtimeOptions, model, rawModel, localProviders, logger);
    }

    if (rawEffort !== undefined) {
      if (EFFORT_SET.has(rawEffort)) {
        runtimeOptions.effort = rawEffort;
      } else {
        logger?.warn?.("Ignoring invalid per-request effort override.", {
          effort: echoValue(rawEffort),
          valid: [...EFFORT_SET],
        });
      }
    }

    applyEffortKeywordEscalation(
      runtimeOptions,
      input.request.userMessage,
      options?.baseEffort,
      logger,
    );

    return { runtimeOptions, cleanup: async () => {} };
  };
}

/**
 * Always-on background escalation: a trigger phrase in the turn's message text
 * ("think" → high, "extra think" → xhigh, "ultra think" → max) RAISES this
 * turn's effort, never lowers it. The baseline is the effort the turn would
 * otherwise run at — an accepted metadata override, else the host default — so
 * a webhook `effort:"max"` survives a bare "think" and an equal-or-lower
 * keyword writes nothing (no spurious `run_config.overridden`). The message
 * text itself is never mutated — trigger words reach the model.
 */
function applyEffortKeywordEscalation(
  runtimeOptions: RequestModelOverrideResult["runtimeOptions"],
  userMessage: string | undefined,
  baseEffort: string | undefined,
  logger: RequestModelOverrideLogger | undefined,
): void {
  if (typeof userMessage !== "string" || userMessage.length === 0) {
    return;
  }
  const match = detectEffortKeyword(userMessage);
  if (match === undefined) {
    return;
  }
  const resolvedEffort = runtimeOptions.effort ?? baseEffort;
  if (effortRank(match.effort) <= effortRank(resolvedEffort)) {
    return;
  }
  runtimeOptions.effort = match.effort;
  logger?.info?.("Escalating per-turn effort from message keyword.", {
    keyword: match.keyword,
    from: resolvedEffort ?? null,
    to: match.effort,
  });
}

/** Whether the accepted request route (or its configured base) is Pi-native. */
export function requestModelOverrideTargetsPiNative(
  metadata: Record<string, unknown> | undefined,
  options?: RequestModelOverrideOptions,
): boolean {
  const accepted = resolveAcceptedModelOverride(metadata, options, undefined).model ?? options?.baseModel;
  return [accepted, ...(options?.fallbackModels ?? [])].some((model) => model !== undefined);
}

/**
 * Whether every route the configured fallback router can reach for this
 * request is Pi-native. ProcessJobs private-state protection requires this
 * stronger contract: a single non-Pi primary or fallback would move execution
 * to a provider-owned tool loop that cannot enforce the mono-agent sandbox.
 *
 * Keep this separate from `requestModelOverrideTargetsPiNative`, whose
 * intentionally permissive any-Pi meaning is used by other capability
 * discovery. The chain projection mirrors `fallbackChainForConfig`: an
 * accepted request override replaces the primary and a configured fallback
 * equal to that effective primary is skipped without otherwise rewriting the
 * configured order. Missing, malformed, or duplicate reachable routes fail
 * closed — and a resolution failure is WARNED rather than discarded, so it can
 * be told apart from a genuine non-Pi route.
 */
export function requestModelOverrideRoutesOnlyPiNative(
  metadata: Record<string, unknown> | undefined,
  options?: RequestModelOverrideOptions,
): boolean {
  try {
    const primary = resolveAcceptedModelOverride(metadata, options, undefined).model ?? options?.baseModel;
    assertParsedRuntimeModelReference(primary);
    const fallbacks = options?.fallbackModels;
    if (fallbacks !== undefined && !Array.isArray(fallbacks)) {
      return false;
    }

    const primaryKey = modelReferenceKey(primary);
    const reachableKeys = new Set([primaryKey]);
    for (const fallback of fallbacks ?? []) {
      assertParsedRuntimeModelReference(fallback);
      const key = modelReferenceKey(fallback);
      if (key === primaryKey) {
        continue;
      }
      if (reachableKeys.has(key)) {
        return false;
      }
      reachableKeys.add(key);
    }
    return true;
  } catch (error) {
    // Fail CLOSED — an unresolvable chain must not be granted process-job
    // authority — but never silently. At every call site a resolution failure
    // is indistinguishable from a genuinely non-Pi route, and discarding the
    // cause is what made mono-agent#664 undiagnosable from outside.
    options?.logger?.warn?.(
      "Treating this request's route chain as non-Pi-native because it could not be resolved.",
      { reason: echoReason(error) },
    );
    return false;
  }
}

interface ModelOverrideResolution {
  readonly rawModel?: string;
  readonly rawEffort?: string;
  readonly model?: RuntimeModelReference;
}

function resolveAcceptedModelOverride(
  metadata: Record<string, unknown> | undefined,
  options: RequestModelOverrideOptions | undefined,
  logger: RequestModelOverrideLogger | undefined,
): ModelOverrideResolution {
  const { model: rawModel, effort: rawEffort } = readOverride(metadata);
  if (rawModel === undefined) {
    return { ...(rawEffort === undefined ? {} : { rawEffort }) };
  }

  let parsed: RuntimeModelReference;
  try {
    parsed = parseMonoRuntimeModelReference(rawModel);
  } catch (error) {
    logger?.warn?.("Ignoring invalid per-request model override.", {
      model: echoValue(rawModel),
      reason: echoReason(error),
    });
    return { rawModel, ...(rawEffort === undefined ? {} : { rawEffort }) };
  }

  return {
    rawModel,
    ...(rawEffort === undefined ? {} : { rawEffort }),
    model: parsed,
  };
}

/**
 * OWN the endpoint block for a valid model override. For a model served by a
 * configured LOCAL provider, `runtimeOptionsForLocalProvider` yields the block and
 * we SET all four fields. For a cloud/registry model or an unconfigured provider
 * id it returns `{}`, so `x ?? null` sets each field to `null` — the harness merge
 * reads that as an explicit CLEAR of the host default's local block (undefined
 * would silently inherit it and mis-route the run to localhost). A genuinely
 * MISCONFIGURED provider (e.g. an untrusted public HTTP baseUrl) throws; that is
 * warned-and-ignored and treated as non-local (block cleared) so a bad override
 * never fails the turn — the model ref still applies.
 */
function applyLocalProviderBlock(
  runtimeOptions: RequestModelOverrideResult["runtimeOptions"],
  model: RuntimeModelReference,
  rawModel: string,
  localProviders: readonly LocalProviderDefinition[] | undefined,
  logger: RequestModelOverrideLogger | undefined,
): void {
  let local: LocalProviderRuntimeOptions;
  try {
    local = runtimeOptionsForLocalProvider(model, localProviders);
  } catch (error) {
    logger?.warn?.("Ignoring local-provider endpoint for per-request model override.", {
      model: echoValue(rawModel),
      reason: echoReason(error),
    });
    local = {};
  }
  runtimeOptions.customProvider = local.customProvider ?? null;
  runtimeOptions.customModel = local.customModel ?? null;
  runtimeOptions.modelCapabilities = local.modelCapabilities ?? null;
  runtimeOptions.isPrivateProvider = local.isPrivateProvider ?? null;
}

/**
 * Read model/effort from webhook, cron, web-console, TUI, Telegram, or Slack request metadata.
 * Webhook takes precedence, then cron, then the web block, then its optional TUI
 * compatibility mirror, then Telegram, then Slack. A turn carrying none of these blocks
 * returns `{}`, leaving only the keyword escalation scan.
 */
function readOverride(metadata: Record<string, unknown> | undefined): {
  readonly model?: string;
  readonly effort?: string;
} {
  if (!isRecord(metadata)) {
    return {};
  }
  const source = isRecord(metadata.webhook)
    ? metadata.webhook
    : isRecord(metadata.cron)
      ? metadata.cron
      : isRecord(metadata.web)
        ? metadata.web
        : isRecord(metadata.tui)
          ? metadata.tui
          : isRecord(metadata.telegram)
            ? metadata.telegram
            : isRecord(metadata.slack)
              ? metadata.slack
              : undefined;
  if (source === undefined) {
    return {};
  }
  return {
    ...(typeof source.model === "string" ? { model: source.model } : {}),
    ...(typeof source.effort === "string" ? { effort: source.effort } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
