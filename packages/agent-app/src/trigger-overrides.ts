import { EFFORT_LEVELS } from "@mono-agent/config";
import {
  MODEL_REFERENCE_ECHO_MAX_BYTES,
  MODEL_REFERENCE_REASON_MAX_BYTES,
  parseMonoRuntimeModelReference,
  RuntimeAdapterError,
  sanitizeModelReferenceText,
} from "@mono-agent/runtime-adapter";

/** One enabled trigger (cron job / webhook endpoint) carrying override strings. */
export interface TriggerOverrideEntry {
  /** Display name for the issue message, e.g. `cron job "digest"`. */
  readonly name: string;
  readonly model?: string;
  readonly effort?: string;
}

const EFFORT_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/**
 * Bound and neutralize one operator-supplied fragment before quoting it back. The trigger
 * label and the effort value are not model references, but they are the same kind of text --
 * untrusted, unbounded, on its way into durable operator-shared output (`mono-agent doctor`,
 * `mono-agent validate`, startup) -- so they share the one echo budget rather than a second
 * number invented here.
 */
function echo(value: string): string {
  return sanitizeModelReferenceText(value, MODEL_REFERENCE_ECHO_MAX_BYTES);
}

/**
 * The concrete repair (`codex:x` -> `openai-codex:x`, the `<provider>:<model>` grammar) is
 * built by the kernel parser and nested by the runtime adapter in `details.reason`; unwrap one
 * layer so the actionable half survives, exactly as `@mono-agent/config` does for the same
 * error. Re-bounding is a no-op for the adapter's own reason -- sanitizing is idempotent and
 * that reason is already within this budget -- and covers the branches above it, where an
 * unexpected throw contributes arbitrary text. Bounding the UNWRAPPED reason rather than the
 * wrapped message is what keeps the repair from being clamped away by this second pass.
 */
function reasonOf(error: unknown): string {
  const reason = error instanceof RuntimeAdapterError && typeof error.details.reason === "string"
    ? error.details.reason
    : error instanceof Error
      ? error.message
      : String(error);
  return sanitizeModelReferenceText(reason, MODEL_REFERENCE_REASON_MAX_BYTES);
}

/**
 * Validate per-trigger `model`/`effort` overrides with the same parsers the
 * runtime applies at run time (`request-model-override.ts`), but at
 * validate/load time — so a typo'd cron `model` fails `mono-agent validate`
 * before the 3am job silently falls back to the default. At run time an
 * invalid value is still warn-and-ignored; this check only moves the discovery
 * forward, it never changes run behavior.
 *
 * Every piece of operator text this quotes back is escaped and clamped first. Parsing a value
 * is not the same as being able to print it: the values that reach here are exactly the ones
 * that FAILED to parse, so none of them carries the parser's printable/single-line/bounded
 * guarantee, and an embedded newline would otherwise let a cron `model` forge a line that
 * reads as doctor's own.
 */
export function findTriggerOverrideIssues(
  entries: readonly TriggerOverrideEntry[],
): readonly string[] {
  const issues: string[] = [];
  for (const entry of entries) {
    if (entry.model !== undefined) {
      try {
        parseMonoRuntimeModelReference(entry.model);
      } catch (error) {
        issues.push(
          `${echo(entry.name)} has an invalid model override "${echo(entry.model)}": ${reasonOf(error)}`,
        );
      }
    }
    if (entry.effort !== undefined && !EFFORT_SET.has(entry.effort)) {
      issues.push(
        `${echo(entry.name)} has an invalid effort override "${echo(entry.effort)}". Valid: ${[...EFFORT_SET].join(", ")}.`,
      );
    }
  }
  return issues;
}
