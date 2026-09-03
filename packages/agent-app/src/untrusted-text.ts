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
const SECRET_LIKE_VALUE = new RegExp(
  [
    // OpenAI, including project/service-account forms.
    String.raw`sk-[A-Za-z0-9_-]{12,}`,
    // GitHub classic/OAuth/refresh/server/user tokens, plus fine-grained PATs.
    String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`github_pat_[A-Za-z0-9_]{20,}`,
    // Slack bot/user/app-level tokens.
    String.raw`xox[baprs]-[A-Za-z0-9-]{12,}`,
    String.raw`xapp-[A-Za-z0-9-]{12,}`,
    // AWS access key ids.
    String.raw`AKIA[A-Z0-9]{16}`,
    // Telegram bot tokens.
    String.raw`\d{6,12}:[A-Za-z0-9_-]{20,}`,
  ].map((shape) => String.raw`\b${shape}\b`).join("|")
    // Bearer/Basic carry their own delimiter, so they are matched separately
    // from the word-bounded shapes above.
    + String.raw`|\b(?:Bearer|Basic)\s+\S{12,}`,
  // Case-insensitive: a lowercase `bearer ` or `akia…` is the same credential.
  "iu",
);

/** Environment variable names whose values are treated as live credentials. */
const CREDENTIAL_ENV_NAME = /(?:api.?key|credential|password|secret|token)/iu;

/**
 * Names whose value is provably a variable name or a filesystem location rather
 * than a credential, mirroring the `env`/`path` carve-out that
 * `secretBearingPointer` already applies to config pointers.
 *
 * Deliberately narrow. An earlier revision also excluded `_TOKENS`, `_NAME`,
 * and `_URL`, which dropped genuine credential holders such as
 * `SERVICE_API_TOKENS` and `SLACK_APP_TOKENS` from the scan — and because this
 * helper also backs the SELF-CONFIG proposal guard, that weakened two surfaces
 * at once. The residual cost is accepted and documented: a credential-named
 * budget such as `..._KEEP_RECENT_TOKENS=8000` still makes the literal `8000`
 * unstorable through `Remember`. Favouring a false rejection over a persisted
 * credential is the intended trade here.
 */
const NON_CREDENTIAL_ENV_NAME = /(?:_ENV|_ENV_VAR|_PATH|_FILE|_DIR)$/iu;

/**
 * Shortest environment value worth matching.
 *
 * Deliberately low: a short PIN or numeric key is still a credential, and this
 * guard also backs the SELF-CONFIG proposal check, so raising it to reduce
 * false positives would quietly widen what both surfaces let through. The
 * name-based exclusion above is the targeted fix for operational settings.
 */
const MIN_KNOWN_SECRET_LENGTH = 4;

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
      && (value?.length ?? 0) >= MIN_KNOWN_SECRET_LENGTH)
    .map(([, value]) => value!);
}

/**
 * Whether the text contains any of this agent's own configured secret values.
 *
 * Both sides are NFKC-folded before comparison. Callers normalize the text they
 * are about to store, so comparing it against a raw environment value would
 * miss a credential that is itself configured in a compatibility form (a
 * fullwidth password matches only once both sides agree on a domain).
 */
export function containsKnownSecretValue(value: string, secrets: readonly string[]): boolean {
  const folded = value.normalize("NFKC");
  return secrets.some((secret) => {
    const foldedSecret = secret.normalize("NFKC");
    return value.includes(secret)
      || folded.includes(foldedSecret)
      || folded.includes(secret)
      || value.includes(foldedSecret);
  });
}
