import type { MemoryStatus, MemoryType } from "../store/index.js";

import type { Bullet } from "./types.js";
import { labelsOf, readableLabelsOf, encodeMemoryLabel } from "./labels.js";

const MARKERS: Record<string, { type: MemoryType; status: MemoryStatus }> = {
  "[ ]": { type: "task", status: "open" },
  "[x]": { type: "task", status: "done" },
  "[>]": { type: "task", status: "migrated" },
  "[<]": { type: "task", status: "scheduled" },
  "[~]": { type: "task", status: "dropped" },
  "◦": { type: "event", status: "open" },
  "–": { type: "note", status: "open" },
};

const STATUS_MARKER: Partial<Record<MemoryStatus, string>> = {
  done: "[x]",
  migrated: "[>]",
  scheduled: "[<]",
  dropped: "[~]",
  invalidated: "[~]", // rendered struck like dropped; the comment metadata stays authoritative for the real status
};

export const MARKER_FOR = (type: MemoryType, status: MemoryStatus): string => {
  // For task-style statuses (done/migrated/scheduled/dropped), the visible marker encodes status.
  const statusMarker = STATUS_MARKER[status];
  if (statusMarker !== undefined) return statusMarker;
  // For open status, use the type-specific marker.
  for (const [marker, m] of Object.entries(MARKERS)) {
    if (m.type === type && m.status === status) return marker;
  }
  // notes/events that have no direct marker fall back to the base marker
  if (type === "event") return "◦";
  return "–";
};

// Allowed enum members (must mirror the SQLite CHECK constraints in ../store/index.js).
// A malformed daily line (`type=bogus`, `status=invalid`) must NOT produce an out-of-enum Bullet,
// or rebuild/upsert would fail the CHECK constraint.
const VALID_TYPES = new Set<string>(["task", "event", "note"]);
const VALID_STATUSES = new Set<string>(["open", "done", "scheduled", "migrated", "dropped", "invalidated"]);

const BULLET_MARKER = String.raw`(\[[ x><~]\]|◦|–)`;
const LEGACY_LINE_RE = new RegExp(`^- ${BULLET_MARKER} (.*?)  <!--mem (.*)-->$`, "u");
const VISIBLE_LINE_RE = new RegExp(`^- ${BULLET_MARKER} (.*?)$`, "u");
const META_LINE_RE = /^\s+<!--mem (.*)-->$/u;

export function parseBullet(line: string): Bullet | undefined {
  const match = parseBulletParts(line);
  if (match === undefined) return undefined;
  const [, marker, text, meta] = match;
  // The optional provenance tail is validated as a unit before the generic
  // whitespace tokenizer sees the base fields, so a malformed tail can neither
  // yield a truncated session nor leak stray tokens into the base metadata.
  const { base: baseMeta, sourceSession } = splitSourceSessionMetadata(meta ?? "");
  const fields = parseMeta(baseMeta);
  const base = MARKERS[marker ?? ""];
  if (base === undefined) return undefined;
  // Validate enum membership before trusting metadata; an empty OR invalid value (e.g. `status=` or
  // `status=bogus`) falls back to the marker-derived base value rather than corrupting the Bullet.
  const status = (VALID_STATUSES.has(fields.status ?? "") ? (fields.status as MemoryStatus) : undefined) ?? base.status;
  const type = (VALID_TYPES.has(fields.type ?? "") ? (fields.type as MemoryType) : undefined) ?? base.type;
  // A bullet needs a stable id, a created timestamp, and non-empty text. Missing/blank values (e.g.
  // `id=` or `created=`) would yield id="" — a primary-key collision on rebuild and impossible to
  // rewrite-by-id. Treat such malformed lines as non-bullets rather than corrupting the index.
  const id = (fields.id ?? "").trim();
  const createdAt = (fields.created ?? "").trim();
  const bulletText = (text ?? "").trim();
  if (id === "" || createdAt === "" || bulletText === "") return undefined;
  const salienceNum = Number(fields.salience);
  const bullet: Bullet = {
    id,
    type,
    status,
    text: bulletText,
    salience: fields.salience !== undefined && Number.isFinite(salienceNum) ? salienceNum : 0.5,
    isInsight: fields.isInsight === "1",
    createdAt,
    refs: fields.refs === undefined || fields.refs.length === 0 ? [] : fields.refs.split(","),
    ...(fields.due !== undefined ? { dueAt: fields.due } : {}),
  };
  // Optional provenance: a missing, repeated, oversized or malformed value is
  // unknown, never a reason to drop the memory line itself.
  return sourceSession === undefined ? bullet : { ...bullet, sourceSession };
}

const SOURCE_SESSION_TAIL = /(?:^|\s)source_session=/u;
const SOURCE_SESSION_TAIL_EXACT = /^source_session=(\S+)$/u;

/**
 * Split a `<!--mem ...-->` payload into its base fields and the optional
 * provenance tail. The tail starts at the first whitespace-delimited
 * `source_session=` key and runs to the end of the payload; the serializer
 * always writes it last. Only a tail that is exactly one canonical
 * `source_session=<value>` token yields a known session. Anything else
 * (repeated key, embedded ASCII or Unicode whitespace, trailing tokens, invalid
 * encoding) is unknown provenance, and the base fields before it are unaffected.
 */
export function splitSourceSessionMetadata(meta: string): { readonly base: string; readonly sourceSession?: string } {
  const found = SOURCE_SESSION_TAIL.exec(meta);
  if (found === null) return { base: meta };
  const start = found.index + found[0].length - `${SOURCE_SESSION_KEY}=`.length;
  const value = SOURCE_SESSION_TAIL_EXACT.exec(meta.slice(start))?.[1];
  const sourceSession = value === undefined ? undefined : decodeSourceSession(value);
  return { base: meta.slice(0, start), ...(sourceSession === undefined ? {} : { sourceSession }) };
}

/** Optional canonical metadata key carrying {@link Bullet.sourceSession}. */
export const SOURCE_SESSION_KEY = "source_session";
/** Decoded UTF-8 bound; longer host conversation ids are left unknown rather than truncated. */
export const MAX_SOURCE_SESSION_BYTES = 512;
const SOURCE_SESSION_SAFE = /^[A-Za-z0-9._~:#@/+-]$/u;
const SOURCE_SESSION_ENCODED = /^(?:[A-Za-z0-9._~:#@/+-]|%[0-9A-F]{2})+$/u;

/**
 * The storable form of a host-supplied conversation id, or undefined when it
 * cannot be recorded exactly (empty, oversized, or containing control, format,
 * separator or unpaired surrogate code points). Never derived from model output.
 */
export function sourceSessionFor(conversationId: string | undefined): string | undefined {
  if (conversationId === undefined || conversationId.length === 0) return undefined;
  if (Buffer.byteLength(conversationId, "utf8") > MAX_SOURCE_SESSION_BYTES) return undefined;
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(conversationId)) return undefined;
  return conversationId;
}

/** Percent-encode every byte outside a conservative identifier alphabet. */
function encodeSourceSession(value: string): string {
  let out = "";
  for (const char of value) {
    out += SOURCE_SESSION_SAFE.test(char) ? char
      : [...Buffer.from(char, "utf8")].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("");
  }
  return out;
}

/** Only the exact canonical encoding of a storable value decodes; anything else is unknown. */
function decodeSourceSession(encoded: string): string | undefined {
  if (!SOURCE_SESSION_ENCODED.test(encoded) || encoded.length > MAX_SOURCE_SESSION_BYTES * 3) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(encoded); }
  catch { return undefined; }
  const storable = sourceSessionFor(decoded);
  return storable !== undefined && encodeSourceSession(storable) === encoded ? storable : undefined;
}


export function serializeBullet(bullet: Bullet): string {
  labelsOf(bullet);
  if (/[\r\n\p{Zl}\p{Zp}]/u.test(bullet.text) || bullet.text.includes("<!--mem")) {
    throw new Error("memory-bujo: bullet text must not contain a newline or the '<!--mem' delimiter.");
  }
  if (bullet.sourceSession !== undefined && sourceSessionFor(bullet.sourceSession) !== bullet.sourceSession) {
    throw new Error("memory-bujo: bullet source session is not a storable host conversation id.");
  }
  const marker = MARKER_FOR(bullet.type, bullet.status);
  const meta = [
    `id=${bullet.id}`,
    `type=${bullet.type}`,
    `status=${bullet.status}`,
    `salience=${bullet.salience}`,
    `isInsight=${bullet.isInsight ? "1" : "0"}`,
    `created=${bullet.createdAt}`,
    `refs=${bullet.refs.join(",")}`,
    ...(bullet.dueAt === undefined ? [] : [`due=${bullet.dueAt}`]),
    // Appended last and only when known, so a line without provenance keeps
    // its pre-provenance bytes exactly.
    ...(bullet.sourceSession === undefined ? [] : [`${SOURCE_SESSION_KEY}=${encodeSourceSession(bullet.sourceSession)}`]),
  ].join(" ");
  return `- ${marker} ${bullet.text}\n  <!--mem ${meta}-->`;
}

function parseBulletParts(line: string): RegExpExecArray | undefined {
  const legacy = LEGACY_LINE_RE.exec(line);
  if (legacy !== null) return legacy;

  const split = line.split("\n");
  if (split.length !== 2) return undefined;
  const visible = VISIBLE_LINE_RE.exec(split[0] ?? "");
  const meta = META_LINE_RE.exec(split[1] ?? "");
  if (visible === null || meta === null) return undefined;
  const out = [line, visible[1] ?? "", visible[2] ?? "", meta[1] ?? ""] as unknown as RegExpExecArray;
  out.index = 0;
  out.input = line;
  return out;
}

function parseMeta(meta: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of meta.trim().split(/\s+/u)) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    out[key] = key === "refs" && out.refs !== undefined ? `${out.refs},${value}` : value;
  }
  return out;
}

export interface DailyLine {
  readonly raw: string;
  readonly lineNumber: number;
  readonly bullet?: Bullet;
}

export interface DailyFile {
  readonly lines: readonly DailyLine[];
}

export function parseDailyFile(content: string): DailyFile & { bullets: Bullet[] } {
  const rawLines = content.split("\n");
  const lines: DailyLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i] ?? "";
    const lineNumber = i + 1;
    let bullet: Bullet | undefined;
    try { bullet = parseBullet(raw); }
    catch (error) { throw new Error(`memory-bujo: invalid label at line ${lineNumber}.`, { cause: error }); }
    if (bullet !== undefined) {
      lines.push({ raw, lineNumber, bullet });
      continue;
    }

    const next = rawLines[i + 1];
    if (next !== undefined) {
      const splitRaw = `${raw}\n${next}`;
      let splitBullet: Bullet | undefined;
      try { splitBullet = parseBullet(splitRaw); }
      catch (error) { throw new Error(`memory-bujo: invalid label at line ${lineNumber}.`, { cause: error }); }
      if (splitBullet !== undefined) {
        lines.push({ raw: splitRaw, lineNumber, bullet: splitBullet });
        i += 1;
        continue;
      }
    }

    lines.push({ raw, lineNumber });
  }
  return { lines, bullets: lines.flatMap((l) => (l.bullet ? [l.bullet] : [])) };
}

export function hasDuplicateLabelRefsMetadata(raw: string): boolean {
  const refs = [...raw.matchAll(/(?:^|\s)refs=(\S*)/gu)].map((match) => match[1] ?? "");
  return refs.length > 1 && refs.some((value) => value.includes("label:"));
}

export function serializeDailyFile(file: DailyFile): string {
  return file.lines.map((line) => {
    if (line.bullet === undefined) return line.raw;
    let damaged = hasDuplicateLabelRefsMetadata(line.raw);
    try { labelsOf(line.bullet); }
    catch { damaged = true; }
    if (damaged) {
      // Unchanged damaged source is readable, not silently repaired. Forgetting its
      // line removes invalid labels while preserving ordinary and healthy refs.
      if (JSON.stringify(parseBullet(line.raw)) === JSON.stringify(line.bullet)) return line.raw;
      if (line.bullet.status === "invalidated" || line.bullet.status === "dropped") {
        return serializeBullet({ ...line.bullet, refs: [
          ...line.bullet.refs.filter((ref) => !ref.startsWith("label:")),
          ...readableLabelsOf(line.bullet).map(encodeMemoryLabel),
        ] });
      }
    }
    return serializeBullet(line.bullet);
  }).join("\n");
}
