/**
 * Shared deterministic checks for model-authored free text that the host is
 * about to display to an operator or persist durably.
 *
 * These are defense in depth, not a guarantee. `SECURITY.md` is explicit that
 * free-form model, user, and tool text may still contain sensitive data: what
 * follows catches known credential shapes and this agent's own configured
 * secrets, not every conceivable secret. Callers reject rather than redact, so
 * a partial match never produces a silently mangled value that still reports
 * success.
 */

const BIDI_CONTROL = /\p{Bidi_Control}/u;

/**
 * Well-known credential shapes that are dangerous even with no surrounding
 * label: OpenAI, GitHub, and Slack tokens, bearer headers, and Telegram bot
 * tokens. Each requires a credential-specific alphabet and length, so prose
 * that merely mentions `sk-` does not match.
 */
const SECRET_LIKE_VALUE =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|Bearer\s+\S{12,}|\d{6,12}:[A-Za-z0-9_-]{20,})\b/u;

/** Environment variable names whose values are treated as live credentials. */
const CREDENTIAL_ENV_NAME = /(?:api.?key|credential|password|secret|token)/iu;

/**
 * Names that merely *reference* a credential rather than holding one, or that
 * are operational settings whose names happen to contain a credential word —
 * `MONO_AGENT_COMPACTION_KEEP_RECENT_TOKENS` is a token budget, not a token.
 * Treating those values as secrets would reject ordinary facts that happen to
 * contain the same number or path.
 */
const NON_CREDENTIAL_ENV_NAME = /(?:_ENV|_ENV_VAR|_PATH|_FILE|_DIR|_URL|_TOKENS|_NAME)$/iu;

/** A bare number is a budget or a limit, never a credential. */
const NUMERIC_VALUE = /^\d+$/u;

/**
 * Shortest environment value worth matching. Real credentials are long; a short
 * value collides with ordinary prose far more often than it protects anything.
 */
const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Reject terminal and bidi control characters. Ordinary Unicode text and LF
 * newlines stay intact; what goes is anything that could clear, overwrite, or
 * visually reorder text an operator later reads.
 */
export function containsUnsafeReviewControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint <= 0x1f && codePoint !== 0x0a)
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || BIDI_CONTROL.test(character)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether the text carries a value shaped like a well-known credential. */
export function containsSecretLikeValue(value: string): boolean {
  return SECRET_LIKE_VALUE.test(value);
}

/**
 * The live credential values this process actually holds, taken from
 * environment variables whose NAME looks credential-bearing. Matching against
 * these is exact rather than heuristic: it catches the agent echoing back a
 * secret it was configured with, which no shape rule can promise.
 */
export function knownEnvironmentSecretValues(env: Record<string, string | undefined>): readonly string[] {
  return Object.entries(env)
    .filter(([name, value]) =>
      CREDENTIAL_ENV_NAME.test(name)
      && !NON_CREDENTIAL_ENV_NAME.test(name)
      && (value?.length ?? 0) >= MIN_KNOWN_SECRET_LENGTH
      && !NUMERIC_VALUE.test(value!))
    .map(([, value]) => value!);
}

/** Whether the text contains any of this agent's own configured secret values. */
export function containsKnownSecretValue(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => value.includes(secret));
}
