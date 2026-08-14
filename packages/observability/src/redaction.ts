import { DEFAULT_MAX_STRING_BYTES } from "./guards.js";

/**
 * Node-free redaction + truncation helpers shared by the recorder and the
 * export-mapping surface. Non-numeric values under sensitive-looking object
 * keys collapse to `[redacted]`; free-text content is not scanned unless the
 * caller explicitly enables the closed high-confidence pattern scan. Circular
 * references collapse to `[circular]`, deeply nested values to `[max-depth]`,
 * and long strings are truncated by UTF-8 byte length. Kept import-free of
 * `node:*` (the prior `Buffer.byteLength` call is replaced with `TextEncoder`)
 * so the mapping module can stay browser-safe.
 */

const SENSITIVE_KEY_PATTERN =
  /(token|password|authorization|api[_-]?key|cookie|credentials?|private[_-]?key|client[_-]?secret|bearer|secret)/iu;

// This is intentionally a short, closed list of high-confidence credential
// shapes. Prefix-only matches (for example prose that mentions `sk-` or
// `ghp_`) are not enough: every pattern requires a credential-specific length
// and alphabet. Quantifiers are capped and avoid unbounded wildcard matching.
const CONTENT_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{48}\b/gu,
  /\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{47,511}[A-Za-z0-9]\b/gu,
  /\bghp_[A-Za-z0-9]{36}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{19,511}[A-Za-z0-9]\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
  /\bxapp-[A-Za-z0-9-]{19,511}[A-Za-z0-9]\b/gu,
] as const;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const TRUNCATION_SUFFIX_PATTERN = /…\[truncated ([1-9]\d*) bytes\]$/u;
const MAX_REDACTION_NODES = 10_000;
const MAX_ARRAY_ITEMS = 1_000;
const MAX_OBJECT_KEYS = 1_000;

export interface RedactJsonValueOptions {
  /**
   * Scan retained free-text content for high-confidence credential shapes.
   * Disabled by default to preserve existing prose exactly. Matches are
   * replaced before UTF-8 truncation so the emitted truncation marker describes
   * the redacted value. An existing canonical marker is preserved while its
   * retained head is scanned, keeping repeated export/backfill passes stable.
   */
  readonly contentPatternRedaction?: boolean;
  /**
   * Apply the same model-visible text guard used by history retrieval. This is
   * opt-in because ordinary observability exports may legitimately retain host
   * paths behind their existing sensitive-data boundary.
   */
  readonly visibleTextSanitization?: VisibleTextSanitizationOptions;
}

export interface VisibleTextSanitizationOptions {
  readonly artifactDir?: string;
  readonly recalledMemoryMarker?: string;
  readonly omitFilesystemPaths?: boolean;
  readonly omission?: string;
  readonly maxBytes?: number;
}

const DEFAULT_VISIBLE_TEXT_OMISSION =
  "[diagnostic omitted because it contained private host data]";

export function redactJsonValue(
  value: unknown,
  maxStringBytes = DEFAULT_MAX_STRING_BYTES,
  options: RedactJsonValueOptions = {},
): unknown {
  return redact(
    value,
    maxStringBytes,
    options,
    0,
    undefined,
    new WeakSet<object>(),
    { remainingNodes: MAX_REDACTION_NODES },
  );
}

interface RedactionBudget {
  remainingNodes: number;
}

function redact(
  value: unknown,
  maxStringBytes: number,
  options: RedactJsonValueOptions,
  depth: number,
  key: string | undefined,
  seen: WeakSet<object>,
  budget: RedactionBudget,
): unknown {
  // Secrets (access tokens, API keys, passwords, cookies) are always strings, so a
  // numeric value under a "sensitive" key is a count/flag — e.g. `input_tokens`,
  // `output_tokens`, `cache_read_tokens` all match /token/ but carry token COUNTS
  // we want visible for cost observability. Only redact non-numeric matches.
  if (key !== undefined && SENSITIVE_KEY_PATTERN.test(key) && typeof value !== "number") {
    return "[redacted]";
  }
  if (!consumeNode(budget)) {
    return "[max-nodes]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (options.visibleTextSanitization !== undefined) {
      const visibleTextOptions = {
        ...options.visibleTextSanitization,
        maxBytes: maxStringBytes,
      };
      const inspection = inspectVisibleText(value, visibleTextOptions);
      if (inspection.kind !== "none") {
        const sanitized = sanitizedVisibleText(value, visibleTextOptions, inspection);
        return options.contentPatternRedaction === true
          ? redactStringContent(sanitized, maxStringBytes)
          : sanitized;
      }
    }
    return options.contentPatternRedaction === true
      ? redactStringContent(value, maxStringBytes)
      : truncateString(value, maxStringBytes);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (value instanceof Error) {
    return redact(errorToJson(value), maxStringBytes, options, depth + 1, key, seen, budget);
  }
  if (depth >= 12) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
    const out: unknown[] = [];
    for (let index = 0; index < limit; index += 1) {
      out.push(redact(value[index], maxStringBytes, options, depth + 1, undefined, seen, budget));
    }
    if (value.length > limit) {
      out.push("[max-items]");
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  const limit = Math.min(entries.length, MAX_OBJECT_KEYS);
  for (let index = 0; index < limit; index += 1) {
    const [entryKey, entryValue] = entries[index]!;
    out[entryKey] = redact(
      entryValue,
      maxStringBytes,
      options,
      depth + 1,
      entryKey,
      seen,
      budget,
    );
  }
  if (entries.length > limit) {
    out.__truncated__ = "[max-keys]";
  }
  return out;
}

/**
 * Closed, model-visible text guard shared by RunHistory and SessionHistory.
 * It rejects credential assignments and private run evidence, and can also
 * reject filesystem-shaped paths when the caller exposes tool payloads.
 */
export function containsVisibleSensitiveText(
  text: string,
  options: VisibleTextSanitizationOptions = {},
): boolean {
  return inspectVisibleText(text, options).kind !== "none";
}

export function sanitizeVisibleText(
  text: string,
  options: VisibleTextSanitizationOptions = {},
): string {
  return sanitizedVisibleText(text, options, inspectVisibleText(text, options));
}

/** Match RunHistory's stable model-text truncation contract. */
export function truncateVisibleText(value: string, maxBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.length <= maxBytes) return value;
  const suffix = "…[truncated]";
  const suffixBytes = TEXT_ENCODER.encode(suffix).length;
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return `${TEXT_DECODER.decode(encoded.subarray(0, end))}${suffix}`;
}

function containsCredentialAssignment(text: string): boolean {
  const assignment = /(?:^|(?<=[^a-z0-9_.-]))(["'`]?)([a-z0-9_.-]+(?:[ \t]+[a-z0-9_.-]+){0,5})\1\s*[:=]\s*/giu;
  for (const match of text.matchAll(assignment)) {
    const key = match[2];
    if (key === undefined || !isCredentialKey(key)) continue;
    const value = text.slice((match.index ?? 0) + match[0].length).trimStart();
    if (isExactRedactedSentinel(value)) continue;
    return true;
  }
  return false;
}

function isExactRedactedSentinel(value: string): boolean {
  const trimmed = value.trim();
  if (/^\[redacted\]$/u.test(trimmed)) return true;
  const quote = trimmed[0];
  return (quote === '"' || quote === "'" || quote === "`")
    && trimmed.at(-1) === quote
    && /^\[redacted\]$/u.test(trimmed.slice(1, -1));
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").trim().replace(/[\s.-]+/gu, "_");
  return normalized.endsWith("api_key")
    || normalized.endsWith("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized === "authorization"
    || normalized.endsWith("_authorization")
    || normalized.endsWith("cookie");
}

type VisibleTextInspection =
  | { readonly kind: "none" }
  | { readonly kind: "omission" }
  | { readonly kind: "filesystem"; readonly sanitized: string };

function inspectVisibleText(
  text: string,
  options: VisibleTextSanitizationOptions,
): VisibleTextInspection {
  if (containsPrivateVisibleEvidence(text, options) || containsCredentialAssignment(text)) {
    return { kind: "omission" };
  }
  if (options.omitFilesystemPaths !== true) return { kind: "none" };
  const sanitized = redactFilesystemPaths(text);
  return sanitized === text
    ? { kind: "none" }
    : { kind: "filesystem", sanitized };
}

function sanitizedVisibleText(
  text: string,
  options: VisibleTextSanitizationOptions,
  inspection: VisibleTextInspection,
): string {
  if (inspection.kind === "omission") {
    return options.omission ?? DEFAULT_VISIBLE_TEXT_OMISSION;
  }
  return truncateVisibleText(
    inspection.kind === "filesystem" ? inspection.sanitized : text,
    options.maxBytes ?? DEFAULT_MAX_STRING_BYTES,
  );
}

function containsPrivateVisibleEvidence(
  text: string,
  options: VisibleTextSanitizationOptions,
): boolean {
  return (options.recalledMemoryMarker !== undefined && text.includes(options.recalledMemoryMarker))
    || (options.artifactDir !== undefined
      && options.artifactDir.length > 0
      && text.includes(options.artifactDir))
    || /(?:\.events\.jsonl|\.summary\.json)(?:\b|$)/iu.test(text);
}

type FilesystemPathKind =
  | "file-url"
  | "windows-unc"
  | "windows-drive"
  | "home"
  | "posix"
  | "private-relative";

const OPAQUE_FILESYSTEM_PATH_TOKENS = [
  "[host-path]",
  "[home-path]",
  "[private-path]",
] as const;

const PRIVATE_PATH_SEGMENTS = new Set([
  ".aws", ".gnupg", ".kube", ".mono-agent", ".ssh", "tool-output",
]);
const PRIVATE_PATH_BASENAMES = /^(?:\.env(?:\..*)?|\.git-credentials|\.netrc|\.npmrc|id_(?:dsa|ecdsa|ed25519|rsa)|known_hosts)$/iu;
const HOST_POSIX_ROOTS = new Set([
  "applications",
  "library",
  "system",
  "users",
  "volumes",
  "dev",
  "etc",
  "home",
  "media",
  "mnt",
  "opt",
  "private",
  "proc",
  "repo",
  "root",
  "run",
  "srv",
  "tmp",
  "usr",
  "var",
  "workspace",
  "workspaces",
]);
const PATH_PREFIX_LOOKBEHIND_CODE_UNITS = 64;
// URI schemes are normally short (the longest registered schemes are well
// below this), and treating an unbounded run as a possible scheme lets crafted
// punctuation-dense text repeatedly rescan the remaining input. Overlong
// schemes simply fall back to ordinary text/path handling, which is the
// privacy-conservative behavior.
const MAX_URL_SCHEME_CODE_UNITS = 64;
const PRIVATE_PATH_BASENAME_LITERALS = [
  ".git-credentials",
  ".netrc",
  ".npmrc",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "known_hosts",
] as const;
const HTTP_REQUEST_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
] as const;

interface OpaqueFilesystemMatch {
  readonly end: number;
  readonly replacement: string;
}

/**
 * Replace only filesystem-shaped spans. The stable token carries no host root,
 * account name, drive, UNC authority, artifact root, or run directory; up to
 * two non-sensitive trailing components remain useful for later inspection.
 */
function redactFilesystemPaths(text: string): string {
  let sanitized = "";
  let index = 0;
  while (index < text.length) {
    const opaqueMatch = opaqueFilesystemPathAt(text, index);
    if (opaqueMatch !== undefined) {
      sanitized += opaqueMatch.replacement;
      index = opaqueMatch.end;
      continue;
    }

    const urlEnd = nonFileUrlEndAt(text, index);
    if (urlEnd !== undefined) {
      sanitized += text.slice(index, urlEnd);
      index = urlEnd;
      continue;
    }

    const kind = filesystemPathKindAt(text, index);
    const requestTargetEnd = httpRequestTargetEndAt(text, index, kind);
    if (requestTargetEnd !== undefined) {
      sanitized += text.slice(index, requestTargetEnd);
      index = requestTargetEnd;
      continue;
    }

    if (kind !== undefined) {
      const end = filesystemPathEnd(text, index, kind);
      sanitized += opaqueFilesystemPath(text.slice(index, end), kind);
      index = end;
      continue;
    }

    sanitized += text[index]!;
    index += 1;
  }
  return sanitized;
}

function opaqueFilesystemPathAt(text: string, index: number): OpaqueFilesystemMatch | undefined {
  for (const token of OPAQUE_FILESYSTEM_PATH_TOKENS) {
    if (!text.startsWith(token, index)) continue;
    const tokenEnd = index + token.length;
    if (text[tokenEnd] !== "/") {
      return { end: tokenEnd, replacement: token };
    }
    const suffixEnd = filesystemPathEnd(text, tokenEnd, "posix");
    const suffix = text.slice(tokenEnd, suffixEnd);
    if (opaqueSuffixNeedsResanitization(suffix)) {
      const sanitizedSuffix = opaqueFilesystemPath(
        suffix,
        token === "[home-path]" ? "home" : "posix",
      );
      return {
        end: suffixEnd,
        replacement: token === "[private-path]"
          ? `${token}${sanitizedSuffix}`
          : sanitizedSuffix,
      };
    }
    return { end: suffixEnd, replacement: text.slice(index, suffixEnd) };
  }
  return undefined;
}

function opaqueSuffixNeedsResanitization(suffix: string): boolean {
  const segments = pathSegments(suffix);
  const basename = stripLineColumnSuffix(segments.at(-1) ?? "");
  return segments.some((segment) => PRIVATE_PATH_SEGMENTS.has(segment.toLocaleLowerCase("en-US")))
    || PRIVATE_PATH_BASENAMES.test(basename)
    || segments.some((segment) => {
      const normalized = segment.toLocaleLowerCase("en-US");
      return normalized === "users" || normalized === "home";
    });
}

/**
 * Preserve non-file URLs as one opaque lexical token before looking for path
 * starts. This prevents `/Users/example`-shaped URL components from being mistaken
 * for host paths, including after URL punctuation that also separates shell
 * paths outside a URL.
 */
function nonFileUrlEndAt(text: string, index: number): number | undefined {
  if (!isTokenBoundaryBefore(text, index)) return undefined;
  let cursor: number;
  if (text.startsWith("//", index) && isAsciiLetterOrDigit(text[index + 2])) {
    cursor = index + 2;
  } else {
    // A scheme can contain `+`, `-`, and `.`, so those characters cannot also
    // introduce a fresh scheme probe in the middle of the same lexical run.
    // This makes the candidate runs disjoint; the fixed cap below bounds even
    // the first probe on adversarial input.
    if (index > 0 && isUrlSchemeCharacter(text[index - 1]!)) return undefined;
    if (!isAsciiLetter(text[index])) return undefined;
    cursor = index + 1;
    const schemeLimit = Math.min(text.length, index + MAX_URL_SCHEME_CODE_UNITS);
    while (cursor < schemeLimit && isUrlSchemeCharacter(text[cursor]!)) cursor += 1;
    if (cursor === schemeLimit
      && text[cursor] !== undefined
      && isUrlSchemeCharacter(text[cursor]!)) {
      return undefined;
    }
    if (!text.startsWith("://", cursor)) return undefined;
    if (cursor - index === 4 && startsWithAsciiCaseInsensitive(text, index, "file")) {
      return undefined;
    }
    cursor += 3;
  }
  while (cursor < text.length && !isUrlTerminator(text[cursor]!)) cursor += 1;
  return cursor;
}

function filesystemPathKindAt(text: string, index: number): FilesystemPathKind | undefined {
  const boundary = isTokenBoundaryBefore(text, index);
  if (boundary && text.slice(index, index + 7).toLocaleLowerCase("en-US") === "file://") {
    return "file-url";
  }
  // `./` and `../` are intentionally not candidates: they are portable,
  // workspace-relative evidence and disclose no host root or account name.
  // `~/` does identify a private host location, so retain only its useful
  // suffix behind a distinct opaque root.
  if (boundary && text[index] === "~" && homePrefixEnd(text, index) !== undefined) return "home";
  if (
    boundary
    &&
    isAsciiLetter(text[index])
    && text[index + 1] === ":"
    && isPathSeparator(text[index + 2])
  ) {
    return "windows-drive";
  }
  if (boundary && text[index] === "\\" && text[index + 1] === "\\") return "windows-unc";
  if (isPrivateRelativePathAt(text, index)) return "private-relative";
  if (isHostIdentifyingPosixPathAt(text, index)) return "posix";
  return undefined;
}

function httpRequestTargetEndAt(
  text: string,
  index: number,
  pathKind: FilesystemPathKind | undefined,
): number | undefined {
  if (text[index] !== "/") return undefined;
  if (!hasHttpRequestMethodBefore(text, index)) return undefined;
  let cursor = index + 1;
  while (cursor < text.length && !/\s/u.test(text[cursor]!)) cursor += 1;
  const targetEnd = cursor;
  if (!hasHttpVersionAfter(text, cursor)) return undefined;

  const filesystemPathStart = filesystemPathStartInRange(
    text,
    index,
    targetEnd,
    pathKind,
  );
  if (filesystemPathStart === undefined) return targetEnd;
  return filesystemPathStart === index ? undefined : filesystemPathStart;
}

function filesystemPathStartInRange(
  text: string,
  start: number,
  end: number,
  initialKind: FilesystemPathKind | undefined,
): number | undefined {
  let cursor = start;
  while (cursor < end) {
    const opaqueMatch = opaqueFilesystemPathAt(text, cursor);
    if (opaqueMatch !== undefined) {
      if (opaqueMatch.replacement !== text.slice(cursor, opaqueMatch.end)) return cursor;
      cursor = Math.min(end, opaqueMatch.end);
      continue;
    }
    const urlEnd = nonFileUrlEndAt(text, cursor);
    if (urlEnd !== undefined) {
      cursor = Math.min(end, urlEnd);
      continue;
    }
    const kind = cursor === start ? initialKind : filesystemPathKindAt(text, cursor);
    if (kind === undefined) {
      cursor += 1;
      continue;
    }
    return cursor;
  }
  return undefined;
}

function hasHttpRequestMethodBefore(text: string, index: number): boolean {
  const windowStart = Math.max(0, index - PATH_PREFIX_LOOKBEHIND_CODE_UNITS);
  let cursor = index - 1;
  let whitespaceCodeUnits = 0;
  while (cursor >= windowStart) {
    const character = text[cursor]!;
    if (!/\s/u.test(character)) break;
    // The old classifier considered only the current line prefix. A newline
    // between the method and target therefore cannot form a request prefix.
    if (character === "\n") return false;
    whitespaceCodeUnits += 1;
    cursor -= 1;
  }
  if (whitespaceCodeUnits === 0 || cursor < windowStart) return false;

  const methodEnd = cursor + 1;
  for (const method of HTTP_REQUEST_METHODS) {
    const methodStart = methodEnd - method.length;
    if (methodStart < windowStart || !text.startsWith(method, methodStart)) continue;
    if (methodStart === 0) return true;
    const delimiterIndex = methodStart - 1;
    // A truncated window is not a synthetic line/token boundary. Require the
    // real delimiter to be observable inside the fixed window.
    if (delimiterIndex < windowStart) return false;
    return /\s/u.test(text[delimiterIndex]!);
  }
  return false;
}

function hasHttpVersionAfter(text: string, start: number): boolean {
  let cursor = start;
  let whitespaceCodeUnits = 0;
  while (cursor < text.length && /\s/u.test(text[cursor]!)) {
    whitespaceCodeUnits += 1;
    cursor += 1;
  }
  if (whitespaceCodeUnits === 0 || !text.startsWith("HTTP/", cursor)) return false;
  cursor += 5;
  const majorStart = cursor;
  while (cursor < text.length && isAsciiDigit(text[cursor]!)) cursor += 1;
  if (cursor === majorStart) return false;
  if (text[cursor] === ".") {
    cursor += 1;
    const minorStart = cursor;
    while (cursor < text.length && isAsciiDigit(text[cursor]!)) cursor += 1;
    if (cursor === minorStart) return false;
  }
  return cursor === text.length || /\s/u.test(text[cursor]!);
}

function filesystemPathEnd(text: string, start: number, kind: FilesystemPathKind): number {
  let end = kind === "file-url"
    ? start + 7
    : kind === "windows-drive"
      ? start + 3
      : start + 1;
  while (end < text.length) {
    const character = text[end]!;
    if (character === ":") {
      const lineColumnEnd = lineColumnSuffixEnd(text, end);
      if (lineColumnEnd !== undefined) {
        end = lineColumnEnd;
        continue;
      }
      break;
    }
    if (isFilesystemPathTerminator(character)) break;
    end += 1;
  }
  return end;
}

function isHostIdentifyingPosixPathAt(text: string, index: number): boolean {
  if (text[index] !== "/" || text[index + 1] === "/") return false;
  if (text[index - 1] === "<") return false;
  if (!isTokenBoundaryBefore(text, index)
    && !isAttachedPathOptionBefore(text, index)
    && text.slice(Math.max(0, index - 3), index) !== "...") {
    return false;
  }
  const segmentEnd = firstPathSegmentEnd(text, index + 1);
  const root = text.slice(index + 1, segmentEnd).toLocaleLowerCase("en-US");
  if (!HOST_POSIX_ROOTS.has(root)) return false;
  return segmentEnd === text.length || isPathSegmentBoundary(text[segmentEnd]);
}

function isAttachedPathOptionBefore(text: string, index: number): boolean {
  const windowStart = Math.max(0, index - PATH_PREFIX_LOOKBEHIND_CODE_UNITS);
  let cursor = index - 1;
  if (cursor < windowStart) return false;
  if (text[cursor] === "=") cursor -= 1;

  let letterCodeUnits = 0;
  while (cursor >= windowStart) {
    const character = text[cursor]!;
    if (!isAsciiLetter(character)) break;
    letterCodeUnits += 1;
    cursor -= 1;
  }
  if (letterCodeUnits === 0 || cursor < windowStart || text[cursor] !== "-") return false;
  if (cursor === 0) return true;
  const delimiterIndex = cursor - 1;
  // Do not accept `windowStart` as an invented token boundary when the actual
  // delimiter lies outside the bounded lookbehind window.
  if (delimiterIndex < windowStart) return false;
  const delimiter = text[delimiterIndex]!;
  return delimiter === " " || delimiter === "\t" || delimiter === "\n";
}

function isPrivateRelativePathAt(text: string, index: number): boolean {
  if (!isPrivatePathBoundaryBefore(text, index)) return false;
  const initial = text[index]?.toLocaleLowerCase("en-US");
  if (initial === undefined) return false;

  for (const directory of PRIVATE_PATH_SEGMENTS) {
    if (directory[0] !== initial
      || !startsWithAsciiCaseInsensitive(text, index, directory)) {
      continue;
    }
    if (isPathSeparator(text[index + directory.length])) return true;
  }

  // Every `.env.<suffix>` basename is private. Recognizing the fixed prefix is
  // sufficient and avoids scanning an attacker-controlled segment to its end.
  if (initial === "." && startsWithAsciiCaseInsensitive(text, index, ".env")) {
    const afterEnvironment = text[index + 4];
    if (afterEnvironment === "." || isPathSegmentBoundary(afterEnvironment)) return true;
  }

  for (const basename of PRIVATE_PATH_BASENAME_LITERALS) {
    if (basename[0] !== initial
      || !startsWithAsciiCaseInsensitive(text, index, basename)) {
      continue;
    }
    if (isPathSegmentBoundary(text[index + basename.length])) return true;
  }
  return false;
}

function homePrefixEnd(text: string, index: number): number | undefined {
  let cursor = index + 1;
  if (isPathSeparator(text[cursor])) return cursor + 1;
  while (cursor < text.length && /[A-Za-z0-9_.-]/u.test(text[cursor]!)) cursor += 1;
  return cursor > index + 1 && isPathSeparator(text[cursor]) ? cursor + 1 : undefined;
}

function firstPathSegmentEnd(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !isPathSegmentBoundary(text[cursor])) cursor += 1;
  return cursor;
}

function isPathSegmentBoundary(character: string | undefined): boolean {
  return character === undefined
    || isPathSeparator(character)
    || isFilesystemPathTerminator(character)
    || character === ":";
}

function isPrivatePathBoundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  return isPathSeparator(previous) || isTokenBoundaryBefore(text, index);
}

function lineColumnSuffixEnd(text: string, index: number): number | undefined {
  let cursor = index + 1;
  const lineStart = cursor;
  while (cursor < text.length && isAsciiDigit(text[cursor]!)) cursor += 1;
  if (cursor === lineStart) return undefined;
  if (text[cursor] !== ":") return cursor;

  const columnDelimiter = cursor;
  cursor += 1;
  const columnStart = cursor;
  while (cursor < text.length && isAsciiDigit(text[cursor]!)) cursor += 1;
  return cursor === columnStart ? columnDelimiter : cursor;
}

function isTokenBoundaryBefore(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  return !isAsciiLetter(previous)
    && !isAsciiDigit(previous)
    && previous !== "_"
    && previous !== "."
    && previous !== "-"
    && previous !== "~"
    && previous !== "/"
    && previous !== "\\";
}

function isFilesystemPathTerminator(character: string): boolean {
  return /\s/u.test(character)
    || character === "\""
    || character === "'"
    || character === "`"
    || character === "("
    || character === ")"
    || character === "["
    || character === "]"
    || character === "{"
    || character === "}"
    || character === "<"
    || character === ">"
    || character === ","
    || character === ";"
    || character === "?"
    || character === "#"
    || character === "|"
    || character === "@"
    || character === "&";
}

function isUrlTerminator(character: string): boolean {
  return /\s/u.test(character)
    || character === "\""
    || character === "'"
    || character === "`"
    || character === "("
    || character === ")"
    || character === "["
    || character === "]"
    || character === "{"
    || character === "}"
    || character === "<"
    || character === ">"
    || character === "|";
}

function isUrlSchemeCharacter(character: string): boolean {
  return isAsciiLetter(character)
    || isAsciiDigit(character)
    || character === "+"
    || character === "-"
    || character === ".";
}

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return code >= 65 && code <= 90 || code >= 97 && code <= 122;
}

function isAsciiDigit(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isAsciiLetterOrDigit(character: string | undefined): boolean {
  return isAsciiLetter(character) || character !== undefined && isAsciiDigit(character);
}

function startsWithAsciiCaseInsensitive(text: string, index: number, expected: string): boolean {
  if (index + expected.length > text.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const actualCode = text.charCodeAt(index + offset);
    const foldedCode = actualCode >= 65 && actualCode <= 90 ? actualCode + 32 : actualCode;
    if (foldedCode !== expected.charCodeAt(offset)) return false;
  }
  return true;
}

function isPathSeparator(character: string | undefined): boolean {
  return character === "/" || character === "\\";
}

function opaqueFilesystemPath(path: string, kind: FilesystemPathKind): string {
  let normalized = path.replace(/\\/gu, "/");
  if (kind === "file-url") {
    const remainder = normalized.replace(/^file:\/\//iu, "");
    if (remainder.startsWith("/")) {
      normalized = remainder;
    } else {
      const authorityEnd = remainder.indexOf("/");
      normalized = authorityEnd === -1 ? "" : remainder.slice(authorityEnd);
    }
  }
  const privateSegments = pathSegments(normalized).map((segment) => segment.toLocaleLowerCase("en-US"));
  const privateBasename = stripLineColumnSuffix(privateSegments.at(-1) ?? "");
  if (
    privateSegments.some((segment) => PRIVATE_PATH_SEGMENTS.has(segment))
    || PRIVATE_PATH_BASENAMES.test(privateBasename)
  ) {
    return "[private-path]";
  }

  const unc = kind === "windows-unc";
  let segments = normalized
    .replace(/^[A-Za-z]:\//u, "")
    .replace(/^\/[A-Za-z]:\//u, "")
    .replace(/^\/+|\/+$/gu, "")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== ".." && segment !== "~");
  if (unc) segments = segments.slice(2);
  if (kind === "home" && segments[0]?.startsWith("~")) segments = segments.slice(1);
  segments = stripHostIdentitySegments(segments);

  const first = segments[0]?.toLocaleLowerCase("en-US");
  const temporaryRoot = first === "tmp"
    || first === "private" && segments[1]?.toLocaleLowerCase("en-US") === "tmp"
    || first === "var" && segments[1]?.toLocaleLowerCase("en-US") === "folders"
    || first === "private"
      && segments[1]?.toLocaleLowerCase("en-US") === "var"
      && segments[2]?.toLocaleLowerCase("en-US") === "folders";
  const suffixSegments = temporaryRoot ? segments.slice(-1) : segments.slice(-2);
  const opaqueRoot = kind === "home" ? "[home-path]" : "[host-path]";
  return suffixSegments.length === 0
    ? opaqueRoot
    : `${opaqueRoot}/${suffixSegments.join("/")}`;
}

function pathSegments(path: string): string[] {
  return path.replace(/\\/gu, "/").split("/").filter(Boolean);
}

function stripLineColumnSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/u, "");
}

function stripHostIdentitySegments(segments: readonly string[]): string[] {
  const retained: string[] = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const normalized = segment.toLocaleLowerCase("en-US");
    if (normalized === "users" || normalized === "home") {
      index += 1;
      continue;
    }
    retained.push(segment);
  }
  return retained;
}

function redactContentPatterns(value: string): string {
  let redacted = value;
  for (const pattern of CONTENT_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted;
}

function redactStringContent(value: string, maxStringBytes: number): string {
  const preserved = splitPreservableTruncation(value, maxStringBytes);
  if (preserved !== undefined) {
    return `${redactContentPatterns(preserved.head)}${preserved.marker}`;
  }
  return truncateString(redactContentPatterns(value), maxStringBytes);
}

function splitPreservableTruncation(
  value: string,
  maxStringBytes: number,
): { readonly head: string; readonly marker: string } | undefined {
  const match = TRUNCATION_SUFFIX_PATTERN.exec(value);
  if (match === null || match.index + match[0].length !== value.length) {
    return undefined;
  }
  const omittedBytes = Number(match[1]);
  const head = value.slice(0, match.index);
  const retainedBytes = TEXT_ENCODER.encode(head).length;
  const originalBytes = retainedBytes + omittedBytes;
  const strictCanonical =
    Number.isSafeInteger(originalBytes)
    && originalBytes > maxStringBytes
    && maxStringBytes - retainedBytes <= 3;
  const alreadyRedacted = head.includes("[redacted]");
  if (
    !Number.isSafeInteger(omittedBytes)
    || retainedBytes > maxStringBytes
    || (!strictCanonical && !alreadyRedacted)
  ) {
    return undefined;
  }
  return { head, marker: match[0] };
}

function consumeNode(budget: RedactionBudget): boolean {
  if (budget.remainingNodes <= 0) {
    return false;
  }
  budget.remainingNodes -= 1;
  return true;
}

export function truncateString(value: string, maxStringBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.length <= maxStringBytes) {
    return value;
  }
  // Recorder summaries can pass through another redaction/export boundary
  // during backfill. Preserve a marker we emitted previously instead of
  // replacing its original omitted-byte count with the marker's own size.
  // A canonical retained head ends at most three bytes below the cap because a
  // UTF-8 code point occupies at most four bytes.
  const existingMarker = TRUNCATION_SUFFIX_PATTERN.exec(value);
  if (existingMarker !== null) {
    const omittedBytes = Number(existingMarker[1]);
    const retainedBytes = TEXT_ENCODER.encode(value.slice(0, existingMarker.index)).length;
    const originalBytes = retainedBytes + omittedBytes;
    if (
      Number.isSafeInteger(omittedBytes)
      && Number.isSafeInteger(originalBytes)
      && existingMarker.index + existingMarker[0].length === value.length
      && retainedBytes <= maxStringBytes
      && maxStringBytes - retainedBytes <= 3
      && originalBytes > maxStringBytes
    ) {
      return value;
    }
  }
  // Cut on a UTF-8 boundary so the kept text never EXCEEDS the byte cap and never
  // splits a multi-byte code point. Slicing the string by `maxStringBytes` UTF-16
  // code units (the prior bug) could emit several bytes per unit. Walk back from
  // the byte cap past any continuation byte (0b10xxxxxx) to the start of its code point.
  let end = maxStringBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  const head = TEXT_DECODER.decode(encoded.subarray(0, end));
  return `${head}…[truncated ${encoded.length - end} bytes]`;
}

export function errorFailureKind(error: unknown): string {
  if (typeof error === "object" && error !== null && "failureKind" in error) {
    const failureKind = (error as { readonly failureKind?: unknown }).failureKind;
    if (typeof failureKind === "string" && failureKind.trim().length > 0) {
      return failureKind;
    }
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "exception";
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  return { message: String(error) };
}
