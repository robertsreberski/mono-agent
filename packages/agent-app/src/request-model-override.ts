import { EFFORT_LEVELS } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { RuntimeModelReference } from "@mono-agent/runtime-adapter";

/**
 * Per-request runtime-options extension that applies a per-trigger model/effort
 * override carried on cron (`metadata.cron`) or webhook (`metadata.webhook`)
 * request metadata. The adapters carry the override as raw strings; this is the
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
 * NOTE: targets are cloud/registry models. Overriding to a model served by a
 * different LOCAL provider than the host default is unsupported — the default's
 * local-provider endpoint/capabilities are retained for the turn.
 */
export interface RequestModelOverrideLogger {
  warn?(message: string, metadata?: Record<string, unknown>): void;
}

interface RequestModelOverrideInput {
  readonly request: { readonly metadata?: Record<string, unknown> };
}

interface RequestModelOverrideResult {
  readonly runtimeOptions: {
    readonly model?: RuntimeModelReference;
    readonly effort?: string;
  };
  readonly cleanup: () => Promise<void>;
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

export function createRequestModelOverrideRuntimeExtension(
  logger?: RequestModelOverrideLogger,
): (input: RequestModelOverrideInput) => Promise<RequestModelOverrideResult> {
  return async (input) => {
    const { model: rawModel, effort: rawEffort } = readOverride(input.request.metadata);
    const runtimeOptions: {
      model?: RuntimeModelReference;
      effort?: string;
    } = {};

    if (rawModel !== undefined) {
      try {
        runtimeOptions.model = parseMonoRuntimeModelReference(rawModel);
      } catch (error) {
        logger?.warn?.("Ignoring invalid per-request model override.", {
          model: rawModel,
          reason: error instanceof Error ? error.message : String(error),
        });
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
 * Read model/effort from cron or webhook request metadata. Webhook takes
 * precedence when both are somehow present, though a turn is only ever one or
 * the other. Interactive turns carry neither, so this returns `{}` and the
 * extension is a no-op.
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
