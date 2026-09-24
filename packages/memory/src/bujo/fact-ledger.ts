import { createHash } from "node:crypto";

import { parseJsonExact } from "./json.js";
import { withManagedRollbackRetirement } from "./generations.js";
import {
  appendCanonicalFile,
  CANONICAL_FILE_MISSING,
  readCanonicalFileSnapshot,
  writeCanonicalFileAtomic,
} from "./path-safety.js";

export const FACT_LEDGER_FILE = "graph-facts-v1.jsonl";
export const FACT_MARKER_FILE = "graph-facts-v1.state.json";
export const MAX_FACT_LEDGER_BYTES = 32 * 1024 * 1024;
export const MAX_FACT_LINE_BYTES = 8 * 1024;
const SHA = /^[a-f0-9]{64}$/u;
const FACT_ID = /^f:[a-f0-9]{64}$/u;
const ENTITY_ID = /^[a-z][a-z0-9-]{0,31}:[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const KEY = /^(?:birth_date|full_name|preferred_name|relationship|home_location|work_location|other:[a-z](?:[a-z0-9]|-[a-z0-9]){0,31})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ATTRIBUTIONS = ["user-stated", "document", "assistant-inferred", "unknown"] as const;
const ROLES = ["parent", "child", "partner", "spouse", "sibling", "friend", "colleague", "other"] as const;

type Attribution = typeof ATTRIBUTIONS[number];
type FactValue =
  | { readonly type: "date"; readonly date: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "entity"; readonly entityId: string }
  | { readonly type: "relationship"; readonly role: typeof ROLES[number]; readonly targetEntityId: string };

export interface FactClaim {
  readonly v: 1;
  readonly kind: "fact";
  readonly factId: string;
  readonly runId: string;
  readonly candidateIndex: number;
  readonly factOrdinal: number;
  readonly entityId: string;
  readonly key: string;
  readonly value: FactValue;
  readonly attribution: Attribution;
  readonly sourceMemoryId: string;
  readonly sourceTextSha256: string;
  readonly recordedAt: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly qualifier?: string;
}
export interface FactSource {
  readonly v: 1;
  readonly kind: "fact-source";
  readonly factId: string;
  readonly sourceMemoryId: string;
  readonly sourceTextSha256: string;
  readonly attribution: Attribution;
  readonly recordedAt: string;
}
export interface FactSupersede {
  readonly v: 1;
  readonly kind: "fact-supersede";
  readonly oldFactId: string;
  readonly newFactId: string;
  readonly at: string;
}
export type FactLine = FactClaim | FactSource | FactSupersede;

export interface FactLedgerSnapshot {
  readonly present: boolean;
  readonly lines: readonly FactLine[];
  readonly bytes: number;
  readonly sha256: string;
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Run id is part of the identity: text A→B→A never revives the old claim id. */
export function deriveFactId(input: Pick<FactClaim,
  "runId" | "sourceMemoryId" | "sourceTextSha256" | "candidateIndex" | "factOrdinal" |
  "entityId" | "key" | "value" | "validFrom" | "validTo" | "qualifier">): string {
  const fields = [input.runId, input.sourceMemoryId, input.sourceTextSha256, input.candidateIndex,
    input.factOrdinal, input.entityId, input.key, input.value, input.validFrom ?? null,
    input.validTo ?? null, input.qualifier ?? null];
  return `f:${createHash("sha256").update("bujo-fact-v1\0").update(canonicalFactJson(fields)).digest("hex")}`;
}

export function canonicalFactJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFactJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entry = value as Record<string, unknown>;
    return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${canonicalFactJson(entry[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fail(reason: string): never {
  throw new Error(`memory-facts: ${reason}; stop the store and restore a verified backup or repair the durable capture intent.`);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= max
    && value === value.trim() && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}
function date(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value) || value.startsWith("0000-")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(`${value}T`);
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function sha(value: unknown): value is string { return typeof value === "string" && SHA.test(value); }
function id(value: unknown): value is string { return typeof value === "string" && ENTITY_ID.test(value) && value.length <= 96; }
function factId(value: unknown): value is string { return typeof value === "string" && FACT_ID.test(value); }
function attribution(value: unknown): value is Attribution {
  return typeof value === "string" && (ATTRIBUTIONS as readonly string[]).includes(value);
}
function valueOf(value: unknown, key: string): value is FactValue {
  if (!record(value)) return false;
  if (key === "birth_date") return keys(value, ["type", "date"]) && value.type === "date" && date(value.date);
  if (key === "relationship") return keys(value, ["type", "role", "targetEntityId"])
    && value.type === "relationship" && (ROLES as readonly unknown[]).includes(value.role)
    && id(value.targetEntityId) && value.targetEntityId.startsWith("person:");
  if (value.type === "text") return keys(value, ["type", "text"]) && safeText(value.text, 160);
  if (key.startsWith("other:") && value.type === "date") return keys(value, ["type", "date"]) && date(value.date);
  return key.startsWith("other:") && value.type === "entity"
    && keys(value, ["type", "entityId"]) && id(value.entityId);
}

/** Strict bounded wire parser, independent of any SQLite state or model. */
export function parseFactLedger(content: string | undefined): readonly FactLine[] {
  if (content === undefined) return [];
  if (Buffer.byteLength(content, "utf8") > MAX_FACT_LEDGER_BYTES) fail("fact ledger exceeds the byte limit");
  if (content.length > 0 && !content.endsWith("\n")) fail("fact ledger ends in a partial line");
  const lines: FactLine[] = [];
  const claims = new Map<string, FactClaim>();
  const positions = new Map<string, string>();
  const perRun = new Map<string, number>();
  const sources = new Map<string, string>();
  const perBullet = new Map<string, number>();
  const countMembership = (memoryId: string, textDigest: string): void => {
    const key = `${memoryId}\0${textDigest}`;
    const count = (perBullet.get(key) ?? 0) + 1;
    if (count > 8) fail("more than eight typed assertions share one bullet text");
    perBullet.set(key, count);
  };
  const supersedes = new Map<string, string>();
  const targeted = new Set<string>();
  for (const [index, raw] of content.split("\n").entries()) {
    if (raw === "") continue;
    if (Buffer.byteLength(raw, "utf8") + 1 > MAX_FACT_LINE_BYTES) fail(`fact ledger line ${index + 1} exceeds the byte limit`);
    let value: unknown;
    try { value = parseJsonExact<unknown>(raw); } catch { fail(`fact ledger line ${index + 1} is not exact JSON`); }
    if (!record(value) || value.v !== 1 || typeof value.kind !== "string") fail(`fact ledger line ${index + 1} has unknown version or kind`);
    if (JSON.stringify(value) !== raw) fail(`fact ledger line ${index + 1} is not canonical JSON`);
    if (value.kind === "fact") {
      const required = ["v", "kind", "factId", "runId", "candidateIndex", "factOrdinal", "entityId", "key", "value",
        "attribution", "sourceMemoryId", "sourceTextSha256", "recordedAt"];
      if (!keys(value, required, ["validFrom", "validTo", "qualifier"]) || !factId(value.factId)
        || !safeText(value.runId, 1024) || !Number.isSafeInteger(value.candidateIndex)
        || Number(value.candidateIndex) < 0 || Number(value.candidateIndex) >= 8
        || !Number.isSafeInteger(value.factOrdinal) || Number(value.factOrdinal) < 0
        || Number(value.factOrdinal) >= 4
        || !id(value.entityId) || !value.entityId.startsWith("person:") || typeof value.key !== "string"
        || !KEY.test(value.key) || (value.key.startsWith("other:") && value.key.slice(6).length > 32)
        || !valueOf(value.value, value.key)
        || (record(value.value) && value.value.type === "relationship"
          && value.value.targetEntityId === value.entityId)
        || !attribution(value.attribution) || !safeText(value.sourceMemoryId, 160)
        || !sha(value.sourceTextSha256) || !instant(value.recordedAt)
        || (value.validFrom !== undefined && !date(value.validFrom))
        || (value.validTo !== undefined && !date(value.validTo))
        || (value.validFrom !== undefined && value.validTo !== undefined && value.validFrom > value.validTo)
        || (value.qualifier !== undefined && !safeText(value.qualifier, 160))) {
        fail(`fact ledger line ${index + 1} has invalid claim fields`);
      }
      const claim = value as unknown as FactClaim;
      if (deriveFactId(claim) !== claim.factId) fail(`fact ledger line ${index + 1} has an invalid factId`);
      const earlier = claims.get(claim.factId);
      if (earlier !== undefined && JSON.stringify(earlier) !== raw) fail(`fact ledger line ${index + 1} has a divergent duplicate factId`);
      if (earlier === undefined) {
        const position = `${claim.runId}\0${claim.candidateIndex}\0${claim.factOrdinal}`;
        if (positions.has(position) && positions.get(position) !== claim.factId) {
          fail(`fact ledger line ${index + 1} repeats a candidate fact position`);
        }
        positions.set(position, claim.factId);
        const runCount = (perRun.get(claim.runId) ?? 0) + 1;
        if (runCount > 32) fail(`fact ledger run ${claim.runId} exceeds the fact count bound`);
        perRun.set(claim.runId, runCount);
        claims.set(claim.factId, claim);
        countMembership(claim.sourceMemoryId, claim.sourceTextSha256);
      }
      sources.set(`${claim.factId}\0${claim.sourceMemoryId}\0${claim.sourceTextSha256}`,
        JSON.stringify({ attribution: claim.attribution, recordedAt: claim.recordedAt }));
      lines.push(claim);
    } else if (value.kind === "fact-source") {
      if (!keys(value, ["v", "kind", "factId", "sourceMemoryId", "sourceTextSha256", "attribution", "recordedAt"])
        || !factId(value.factId) || !claims.has(value.factId) || !safeText(value.sourceMemoryId, 160)
        || !sha(value.sourceTextSha256) || !attribution(value.attribution) || !instant(value.recordedAt)) {
        fail(`fact ledger line ${index + 1} has an invalid fact source`);
      }
      const source = value as unknown as FactSource;
      const key = `${source.factId}\0${source.sourceMemoryId}\0${source.sourceTextSha256}`;
      const prior = sources.get(key);
      const membership = JSON.stringify({ attribution: source.attribution, recordedAt: source.recordedAt });
      if (prior !== undefined && prior !== membership) fail(`fact ledger line ${index + 1} has divergent source membership`);
      if (prior === undefined) countMembership(source.sourceMemoryId, source.sourceTextSha256);
      sources.set(key, membership);
      lines.push(source);
    } else if (value.kind === "fact-supersede") {
      if (!keys(value, ["v", "kind", "oldFactId", "newFactId", "at"]) || !factId(value.oldFactId)
        || !factId(value.newFactId) || !instant(value.at)
        || value.oldFactId === value.newFactId) fail(`fact ledger line ${index + 1} has invalid supersession`);
      const edge = value as unknown as FactSupersede;
      const old = claims.get(edge.oldFactId);
      const next = claims.get(edge.newFactId);
      if (old === undefined || next === undefined || old.entityId !== next.entityId || old.key !== next.key
        || (supersedes.has(edge.oldFactId) && supersedes.get(edge.oldFactId) !== JSON.stringify(edge))
        || (targeted.has(edge.newFactId) && supersedes.get(edge.oldFactId) !== JSON.stringify(edge))) {
        fail(`fact ledger line ${index + 1} has orphan or divergent supersession`);
      }
      let cursor: string | undefined = edge.newFactId;
      while (cursor !== undefined) {
        if (cursor === edge.oldFactId) fail(`fact ledger line ${index + 1} creates a correction cycle`);
        const nextEdge: FactSupersede | undefined = supersedes.has(cursor)
          ? JSON.parse(supersedes.get(cursor)!) as FactSupersede : undefined;
        cursor = nextEdge?.newFactId;
      }
      supersedes.set(edge.oldFactId, JSON.stringify(edge));
      targeted.add(edge.newFactId);
      lines.push(edge);
    } else {
      fail(`fact ledger line ${index + 1} has an unsupported fact kind`);
    }
  }
  return lines;
}

export function readFactLedgerStrict(root: string): FactLedgerSnapshot {
  const ledger = readCanonicalFileSnapshot(root, FACT_LEDGER_FILE,
    { allowMissing: true, maxBytes: MAX_FACT_LEDGER_BYTES, strictUtf8: true });
  const marker = readCanonicalFileSnapshot(root, FACT_MARKER_FILE,
    { allowMissing: true, maxBytes: 512, strictUtf8: true });
  if (ledger === undefined && marker === undefined) return { present: false, lines: [], bytes: 0, sha256: digest("") };
  if (ledger === undefined || marker === undefined) fail("fact ledger and marker are not both present");
  const content = ledger.content;
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes !== ledger.identity.size) fail("fact ledger is not valid byte-complete UTF-8");
  let state: unknown;
  try { state = parseJsonExact<unknown>(marker.content); } catch { fail("fact ledger marker is malformed"); }
  if (!record(state) || !keys(state, ["schemaVersion", "ledgerBytes", "ledgerSha256"])
    || state.schemaVersion !== 1 || !Number.isSafeInteger(state.ledgerBytes)
    || Number(state.ledgerBytes) < 0 || !sha(state.ledgerSha256)
    || state.ledgerBytes !== bytes || state.ledgerSha256 !== digest(content)) {
    fail("fact ledger bytes or SHA-256 do not match the marker");
  }
  return { present: true, lines: parseFactLedger(content), bytes, sha256: digest(content) };
}

/**
 * Writer-lease-scoped internal primitive. A1 has no production caller. Future
 * capture intents must pin the lines before invoking this method. The append is
 * fsynced before the atomic marker rename; a crash in between fails closed on
 * open. Retry after a committed marker is idempotent, never a second assertion.
 */
export function appendFactLines(root: string, additional: readonly FactLine[],
  hooks: { readonly afterLedgerAppend?: () => void; readonly afterMarkerRename?: () => void } = {}): FactLedgerSnapshot {
  const current = readFactLedgerStrict(root);
  if (additional.length === 0) return current;
  const existing = readCanonicalFileSnapshot(root, FACT_LEDGER_FILE, { allowMissing: true, maxBytes: MAX_FACT_LEDGER_BYTES, strictUtf8: true });
  const prior = existing?.content ?? "";
  const serialized = additional.map((line) => `${JSON.stringify(line)}\n`).join("");
  const combined = prior + serialized;
  if (Buffer.byteLength(combined, "utf8") > MAX_FACT_LEDGER_BYTES) fail("fact ledger append exceeds the byte limit");
  const parsed = parseFactLedger(combined);
  // Reject an ordinary duplicate batch, but permit the exact already-published
  // suffix on a retry without ever writing a second copy.
  if (prior.endsWith(serialized)) return current;
  return withManagedRollbackRetirement(root, "graph", () => {
    appendCanonicalFile(root, FACT_LEDGER_FILE, serialized,
      existing === undefined ? { requireMissing: true } : { expectedIdentity: existing.identity });
    hooks.afterLedgerAppend?.();
    const state = { schemaVersion: 1, ledgerBytes: Buffer.byteLength(combined, "utf8"), ledgerSha256: digest(combined) };
    const marker = readCanonicalFileSnapshot(root, FACT_MARKER_FILE, { allowMissing: true });
    writeCanonicalFileAtomic(root, FACT_MARKER_FILE, JSON.stringify(state), marker?.identity ?? CANONICAL_FILE_MISSING);
    hooks.afterMarkerRename?.();
    return { present: true, lines: parsed, bytes: state.ledgerBytes, sha256: state.ledgerSha256 };
  });
}
