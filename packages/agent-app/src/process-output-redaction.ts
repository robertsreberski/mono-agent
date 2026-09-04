import { isSensitiveEnvironmentName } from "./redact-secrets.js";

/**
 * Redaction shared by every host surface that retains or forwards the output of
 * a model-authored command: background process jobs and monitors.
 *
 * Keeping one implementation is the point. A monitor forwards command output to
 * the model on a schedule, so a second, subtly weaker redactor here would be a
 * standing way to exfiltrate what the process-job path already refuses to show.
 */
export function redactProcessOutput(
  text: string,
  secrets: readonly string[],
  truncatedAtEnd = false,
): string {
  const orderedSecrets = [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  // If the ordinary marker itself contains a secret, omission is the only
  // literal representation that cannot reproduce that value.
  const literalMarker = orderedSecrets.some((secret) => "[REDACTED]".includes(secret))
    ? ""
    : "[REDACTED]";
  // KNOWN literals go first. The label rule below stops at the first separator,
  // so on `password="correct horse battery staple"` it would replace only
  // `correct` and leave the rest of a multi-word secret in place. Matching the
  // whole literal before any rule can bisect it removes that bypass; the label
  // rule then simply sees an already-redacted value and skips it.
  let redacted = replaceSecretLiterals(text, orderedSecrets, literalMarker);
  redacted = redacted
    // Consume a whole PEM block when the caller has the whole output. The
    // monitor line path additionally keeps explicit block state because it
    // cannot assume the header and footer arrive in one event.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
      "[REDACTED]")
    // Every common HTTP auth scheme, not just Bearer: matching only the scheme
    // word leaves the credential that follows it in place.
    .replace(/\bDigest\s+[^\r\n]*/giu, "Digest [REDACTED]")
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(/(^|\s)((?:--(?:password|passwd|pass|token|secret|api[-_]?key|auth)|-p)(?:=|\s+))(?!\[REDACTED\])("[^"]*"|'[^']*'|\S+)/giu,
      (_match, prefix: string, flag: string) => `${prefix}${flag}[REDACTED]`)
    .replace(/\b([A-Za-z0-9_.-]*(?:api[ _-]?key|secret[ _-]?access[ _-]?key|access[ _-]?key[ _-]?id|(?:access|auth|refresh|session|id|bearer)[ _-]?token|authorization|credential|private[ _-]?key|client[ _-]?secret|passphrase|password|passwd|secret|token|cookie|session[ _-]?id)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(?!\[REDACTED\])("[^"]*"|'[^']*'|[^\s,;}\]]+)/giu,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`)
    .replace(/\b([a-z][a-z0-9+.-]{0,63}:\/\/)([^/\s]+)@/giu, "$1[REDACTED]@");
  if (truncatedAtEnd) {
    for (const secret of orderedSecrets) {
      const maximumPrefix = Math.min(secret.length - 1, redacted.length);
      for (let length = maximumPrefix; length > 0; length -= 1) {
        if (redacted.endsWith(secret.slice(0, length))) {
          redacted = `${redacted.slice(0, -length)}${literalMarker}`;
          break;
        }
      }
    }
  }
  return redacted;
}

function replaceSecretLiterals(text: string, secrets: readonly string[], marker: string): string {
  if (secrets.length === 0) return text;
  // Reserve one UTF-16 code unit absent from both source text and every secret.
  // Sequential native literal replacements can then use that sentinel without
  // letting later rules rescan or amplify earlier redaction markers.
  const used = new Uint8Array(65_536);
  for (let index = 0; index < text.length; index += 1) used[text.charCodeAt(index)] = 1;
  for (const secret of secrets) {
    for (let index = 0; index < secret.length; index += 1) used[secret.charCodeAt(index)] = 1;
  }
  const sentinelCode = used.indexOf(0);
  if (sentinelCode < 0) return marker;
  const sentinel = String.fromCharCode(sentinelCode);
  let redacted = text;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, sentinel);
  return redacted.replaceAll(sentinel, marker);
}

/**
 * Credential SHAPES that identify themselves without any surrounding label.
 *
 * Literal matching against known environment values cannot help when output is
 * consumed a line at a time: a multi-line PEM or a wrapped service-account key
 * has no single line containing the whole value. These rules do not depend on
 * seeing the value whole.
 */
const CREDENTIAL_SHAPES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/gu, "[REDACTED]"],
  [/-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, "[REDACTED]"],
  [
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|A(?:KIA|SIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gu,
    "[REDACTED]",
  ],
  // A long unbroken base64/hex run is credential-shaped whatever precedes it.
  // Redacting the occasional digest is the cheap side of this trade.
  [/(^|\s)(?!\[REDACTED\])([A-Za-z0-9+/=_-]{40,})(?=\s|$)/gu, "$1[REDACTED]"],
];

/**
 * Redaction for output consumed LINE BY LINE, where whole-literal matching
 * against known environment values cannot fire because no single line contains
 * the complete secret.
 */
export function redactProcessOutputLine(line: string, secrets: readonly string[]): string {
  let redacted = redactProcessOutput(line, secrets);
  for (const [pattern, replacement] of CREDENTIAL_SHAPES) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

export function isPrivateKeyBegin(line: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(line);
}

export function isPrivateKeyEnd(line: string): boolean {
  return /-----END [A-Z0-9 ]*PRIVATE KEY-----/u.test(line);
}

/** The longest secret the redactor must be able to see whole to match it. */
export function longestSecretBytes(secrets: readonly string[]): number {
  return secrets.reduce((longest, secret) => Math.max(longest, Buffer.byteLength(secret, "utf8")), 0);
}

/**
 * Every environment value the spawned command can actually observe that is
 * worth treating as a secret in its own output: values the host explicitly
 * injected, anything long enough to be a credential, and anything under a
 * sensitive name.
 */
export function processOutputSecrets(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  return environmentSecrets(overrides, (name, value) =>
    value.length >= 4 || isSensitiveEnvironmentName(name));
}

/**
 * The narrower set used for model-authored free text such as a description: an
 * arbitrary four-character environment value is far more likely to be an
 * ordinary word there than a leaked credential.
 */
export function processDescriptionSecrets(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
): readonly string[] {
  return environmentSecrets(overrides, (name) => isSensitiveEnvironmentName(name));
}

function environmentSecrets(
  overrides: Readonly<Record<string, string | undefined>> | undefined,
  include: (name: string, value: string) => boolean,
): readonly string[] {
  const effective = new Map(Object.entries(process.env));
  const explicitNames = new Set(Object.keys(overrides ?? {}));
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) effective.delete(name);
    else effective.set(name, value);
  }
  const values: string[] = [];
  for (const [name, value] of effective) {
    if (typeof value === "string"
      && value.length > 0
      && (explicitNames.has(name) || include(name, value))) {
      values.push(value);
    }
  }
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}
