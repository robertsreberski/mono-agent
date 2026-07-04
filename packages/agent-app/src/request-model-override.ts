import { EFFORT_LEVELS } from "@mono-agent/config";
import { parseMonoRuntimeModelReference, runtimeOptionsForLocalProvider } from "@mono-agent/runtime-adapter";
import type {
  LocalProviderDefinition,
  LocalProviderRuntimeOptions,
  RuntimeModelReference,
} from "@mono-agent/runtime-adapter";

/**
 * Per-request runtime-options extension that applies a per-turn model/effort
 * override carried on webhook (`metadata.webhook`), cron (`metadata.cron`), or
 * interactive TUI (`metadata.tui`) request metadata — an operator can pick a
 * per-session model/effort from the TUI just as a trigger can pin one. The
 * adapters carry the override as raw strings; this is the
 * first place with both the model parser and the effort enum, so validation
 * lives here. An invalid value is WARNED and IGNORED (the turn falls back to the
 * harness default) rather than failing — a bad dynamic webhook `model` must not
 * 500 the request.
 *
 * Execution mode is NOT set here: the harness derives it from the effective model
 * plus the host's configured executionMode (keeping a compatible host mode, e.g.
 * claude in `cli`, and only falling back to the model default for an incompatible
 * one, e.g. a `codex:*` override under an `sdk` host).
 *
 * A model override OWNS the local-provider endpoint block. Whenever a VALID model
 * override is applied, this extension SETS the four endpoint fields
 * (`customProvider`/`customModel`/`modelCapabilities`/`isPrivateProvider`):
 *   - LOCAL override (`sdk === "pi"` with a configured provider id): recompute the
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
}

export interface RequestModelOverrideOptions {
  readonly logger?: RequestModelOverrideLogger;
  /**
   * Configured local providers (`config.providers?.local`). When an override
   * names a model one of these serves, the extension recomputes the provider
   * endpoint block so the override reaches the right local endpoint instead of
   * inheriting the host default's block.
   */
  readonly localProviders?: readonly LocalProviderDefinition[];
}

interface RequestModelOverrideInput {
  readonly request: { readonly metadata?: Record<string, unknown> };
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

export function createRequestModelOverrideRuntimeExtension(
  options?: RequestModelOverrideOptions,
): (input: RequestModelOverrideInput) => Promise<RequestModelOverrideResult> {
  const logger = options?.logger;
  const localProviders = options?.localProviders;
  return async (input) => {
    const { model: rawModel, effort: rawEffort } = readOverride(input.request.metadata);
    const runtimeOptions: RequestModelOverrideResult["runtimeOptions"] = {};

    if (rawModel !== undefined) {
      let parsed: RuntimeModelReference | undefined;
      try {
        parsed = parseMonoRuntimeModelReference(rawModel);
      } catch (error) {
        logger?.warn?.("Ignoring invalid per-request model override.", {
          model: rawModel,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (parsed !== undefined) {
        runtimeOptions.model = parsed;
        applyLocalProviderBlock(runtimeOptions, parsed, rawModel, localProviders, logger);
      }
    }

    if (rawEffort !== undefined) {
      if (EFFORT_SET.has(rawEffort)) {
        runtimeOptions.effort = rawEffort;
      } else {
        logger?.warn?.("Ignoring invalid per-request effort override.", {
          effort: rawEffort,
          valid: [...EFFORT_SET],
        });
      }
    }

    return { runtimeOptions, cleanup: async () => {} };
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
      model: rawModel,
      reason: error instanceof Error ? error.message : String(error),
    });
    local = {};
  }
  runtimeOptions.customProvider = local.customProvider ?? null;
  runtimeOptions.customModel = local.customModel ?? null;
  runtimeOptions.modelCapabilities = local.modelCapabilities ?? null;
  runtimeOptions.isPrivateProvider = local.isPrivateProvider ?? null;
}

/**
 * Read model/effort from webhook, cron, or TUI request metadata. Webhook takes
 * precedence, then cron, then an interactive TUI per-session override — a turn
 * is only ever one of the three. A turn carrying none of these blocks (e.g. an
 * ordinary chat turn) returns `{}` and the extension is a no-op.
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
      : isRecord(metadata.tui)
        ? metadata.tui
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
