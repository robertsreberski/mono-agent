import { parseDailyFile } from "./grammar.js";
import {
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
} from "./path-safety.js";
import type { Bullet } from "./types.js";

/**
 * Canonical bullet-id prefix for an explicitly remembered fact.
 *
 * Shared because rebuild must be able to tell a deliberate `Remember` write
 * apart from legacy raw host-audit prose that merely starts the same way.
 */
export const REMEMBER_ID_PREFIX = "RM-";

/**
 * Whether this canonical id was minted by an explicit `Remember` write.
 *
 * The complete content-hash identity is validated, not just the prefix: a
 * legacy or hand-authored bullet named `RM-anything` must not inherit the
 * rebuild exemption that a real remembered fact gets.
 */
const REMEMBERED_MEMORY_ID = /^RM-[0-9a-f]{64}$/u;

export function isRememberedMemoryId(id: string): boolean {
  return REMEMBERED_MEMORY_ID.test(id);
}

/**
 * Duplicate-scan bounds. Roughly a decade of daily files and far more prose than
 * a curated store accumulates, chosen so the bound trips on a runaway store
 * rather than on ordinary long-term use.
 */
const MAX_SCANNED_CANONICAL_FILES = 4_000;
const MAX_SCANNED_CANONICAL_BYTES = 64 * 1024 * 1024;

/** One canonical memory bullet together with the canonical file that holds it. */
export interface CanonicalBulletLocation {
  readonly file: string;
  readonly bullet: Bullet;
}

/**
 * Locate one canonical memory bullet by id across the WHOLE canonical source —
 * every `daily/<day>.md` plus the root-legacy `<day>.md` files.
 *
 * Deliberately date-independent. A caller that only scanned today's file would
 * miss a bullet appended before a UTC date rollover, so an idempotent retry
 * would append the same id a second time and collide on the `memories` primary
 * key at the next rebuild. Callers therefore pay one bounded whole-source read
 * rather than assume the calendar.
 *
 * A duplicated id is corruption, never something to repair by appending more:
 * it throws instead of returning an arbitrary match.
 *
 * Bounded on purpose. The caller holds the mutation serializer, the journal
 * chain, and the cross-process lock while this runs, so an unbounded walk over
 * a growing store would block unrelated writes and shutdown. Exceeding either
 * bound raises rather than silently searching a prefix, because a partial
 * answer here would report "not found" and append a duplicate id.
 */
export function findCanonicalMemoryBullet(
  root: string,
  id: string,
  subject: string,
): CanonicalBulletLocation | undefined {
  const dailyNames = listCanonicalFileNames(root, "daily", {
    allowMissing: true,
    include: (name) => name.endsWith(".md"),
  });
  const dailyNameSet = new Set(dailyNames);
  const files = [
    ...dailyNames.map((name) => `daily/${name}`),
    ...listCanonicalRootFileNames(root, {
      include: (name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name) && !dailyNameSet.has(name),
    }),
  ];
  if (files.length > MAX_SCANNED_CANONICAL_FILES) {
    throw new Error(
      `memory-bujo: canonical source has ${files.length} dated files, over the `
      + `${MAX_SCANNED_CANONICAL_FILES}-file duplicate-scan bound; consolidate or archive older files.`,
    );
  }
  const matches: CanonicalBulletLocation[] = [];
  let scannedBytes = 0;
  for (const file of files) {
    // Bound the read itself: checking the total after loading would already
    // have materialized an oversized file into memory under the write locks.
    const remainingBytes = MAX_SCANNED_CANONICAL_BYTES - scannedBytes;
    if (remainingBytes <= 0) {
      throw new Error(
        `memory-bujo: canonical source exceeds the ${MAX_SCANNED_CANONICAL_BYTES}-byte duplicate-scan `
        + "bound; consolidate or archive older files.",
      );
    }
    let snapshot;
    try {
      snapshot = readCanonicalFileSnapshot(root, file, { maxBytes: remainingBytes });
    } catch (error) {
      throw new Error(
        `memory-bujo: canonical source "${file}" exceeds the remaining duplicate-scan byte budget: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (snapshot === undefined) throw new Error(`memory-bujo: canonical source "${file}" disappeared.`);
    scannedBytes += Buffer.byteLength(snapshot.content, "utf8");
    for (const bullet of parseDailyFile(snapshot.content).bullets) {
      if (bullet.id === id) matches.push({ file, bullet });
    }
  }
  if (matches.length > 1) {
    throw new Error(`memory-bujo: ${subject} ${id} is duplicated in canonical source.`);
  }
  return matches[0];
}
