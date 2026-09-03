import { parseDailyFile } from "./grammar.js";
import {
  listCanonicalFileNames,
  listCanonicalRootFileNames,
  readCanonicalFileSnapshot,
} from "./path-safety.js";
import type { Bullet } from "./types.js";

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
  const matches: CanonicalBulletLocation[] = [];
  for (const file of files) {
    const snapshot = readCanonicalFileSnapshot(root, file);
    if (snapshot === undefined) throw new Error(`memory-bujo: canonical source "${file}" disappeared.`);
    for (const bullet of parseDailyFile(snapshot.content).bullets) {
      if (bullet.id === id) matches.push({ file, bullet });
    }
  }
  if (matches.length > 1) {
    throw new Error(`memory-bujo: ${subject} ${id} is duplicated in canonical source.`);
  }
  return matches[0];
}
