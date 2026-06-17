import type {
  RuntimeEventLike,
  RuntimeModelReference,
  RuntimeResult,
  RuntimeRunOptions,
} from "./types.js";

/**
 * Error factory passed by each SDK runtime so the shared scaffolding can throw
 * the runtime's own typed Error without this module depending on any concrete
 * error class. The runtime owns its code union;
 * here the factory is called only with the generic "invalid_options" code, which
 * every runtime already defines.
 */
export type RuntimeErrorFactory = (code: "invalid_options", message: string) => Error;

/**
 * Structural object guard shared by all runtimes. Excludes arrays so callers can
 * treat the result as a plain `Record<string, unknown>`. Codex previously kept
 * ~4 byte-identical copies of this; the SDK runtimes all used the same shape.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The base run-option preconditions every SDK runtime asserts before doing any
 * work: a non-empty trimmed system prompt, a model with a non-empty `model`
 * field, and a real AbortSignal. Each runtime supplies its own error factory so
 * the thrown error keeps that runtime's `name`/`code`.
 *
 * SDK-specific guards (e.g. the fail-closed `model.sdk` check) stay in the
 * runtime and run alongside this helper.
 */
export function assertBaseRunOptions(
  systemPrompt: string,
  runOptions: RuntimeRunOptions,
  makeError: RuntimeErrorFactory,
  subject: string,
): void {
  if (typeof systemPrompt !== "string" || systemPrompt.trim().length === 0) {
    throw makeError("invalid_options", `${subject} requires a non-empty system prompt.`);
  }
  if (
    runOptions === undefined ||
    runOptions === null ||
    !isPlainObject(runOptions.model) ||
    typeof runOptions.model.model !== "string" ||
    runOptions.model.model.length === 0
  ) {
    throw makeError("invalid_options", `${subject} requires runOptions.model.model.`);
  }
  if (!(runOptions.abortSignal instanceof AbortSignal)) {
    throw makeError("invalid_options", `${subject} requires runOptions.abortSignal.`);
  }
}

/**
 * Reads the final user message as a string. Mirrors the identical
 * "last message must have string content" rule each runtime enforced inline.
 */
export function readLastStringUserMessage(
  runOptions: RuntimeRunOptions,
  makeError: RuntimeErrorFactory,
  subject: string,
): string {
  const last = runOptions.messages[runOptions.messages.length - 1];
  if (last === undefined) {
    throw makeError("invalid_options", `${subject} requires at least one runtime message.`);
  }
  if (typeof last.content !== "string") {
    throw makeError("invalid_options", `${subject} only supports string message content.`);
  }
  return last.content;
}

/**
 * Fields a runtime fills in while streaming. Optional values are spread onto the
 * canonical {@link RuntimeResult} only when present, matching the
 * "...(x === undefined ? {} : { x })" boilerplate each runtime duplicated.
 */
export interface RuntimeResultParts {
  readonly text?: string | undefined;
  readonly events: readonly RuntimeEventLike[];
  readonly model: RuntimeModelReference;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly usage?: unknown;
  readonly cost?: unknown;
  readonly providerSessionId?: string | undefined;
  readonly stopReason?: string | null | undefined;
  readonly cancelled?: boolean | undefined;
  readonly failureKind?: string | undefined;
  readonly error?: string | undefined;
  readonly errorDetails?: unknown;
  readonly diagnostics?: unknown;
}

/**
 * Builds the canonical {@link RuntimeResult}, applying the shared optional-field
 * spread so every runtime emits the same shape. The runtime's own `sdk` echo is
 * taken from `model.sdk`.
 */
export function buildRuntimeResult(parts: RuntimeResultParts): RuntimeResult {
  return {
    ...(parts.text === undefined ? {} : { text: parts.text }),
    events: parts.events,
    sdk: parts.model.sdk,
    model: parts.model.model,
    numTurns: parts.numTurns,
    durationMs: parts.durationMs,
    ...(parts.usage === undefined ? {} : { usage: parts.usage }),
    ...(parts.cost === undefined ? {} : { cost: parts.cost }),
    ...(parts.providerSessionId === undefined ? {} : { providerSessionId: parts.providerSessionId }),
    ...(parts.stopReason === undefined || parts.stopReason === null ? {} : { stopReason: parts.stopReason }),
    ...(parts.cancelled ? { cancelled: true } : {}),
    ...(parts.failureKind === undefined ? {} : { failureKind: parts.failureKind }),
    ...(parts.error === undefined ? {} : { error: parts.error }),
    ...(parts.errorDetails === undefined ? {} : { errorDetails: parts.errorDetails }),
    ...(parts.diagnostics === undefined ? {} : { diagnostics: parts.diagnostics }),
  };
}

/** The MCP server name policy shared by all three SDK projectors. */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/u;

/** True when `name` is a syntactically valid MCP server key. */
export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name);
}

/**
 * Applies `vars` to `process.env` for the duration of `fn`, then restores the
 * previous values (deleting keys that were absent). Replaces the per-runtime
 * apply/restore env closures. Synchronous restore on throw is guaranteed.
 */
export async function withTemporaryEnv<T>(
  vars: Readonly<Record<string, string | undefined>>,
  fn: () => Promise<T>,
): Promise<T> {
  const restore = applyTemporaryEnv(vars);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Lower-level form of {@link withTemporaryEnv} for runtimes that already own a
 * try/finally and need to control exactly when restore runs. Applies `vars` and
 * returns the restore function.
 */
export function applyTemporaryEnv(
  vars: Readonly<Record<string, string | undefined>>,
): () => void {
  const previous: Array<[string, string | undefined]> = [];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      continue;
    }
    previous.push([name, process.env[name]]);
    process.env[name] = value;
  }
  return (): void => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
