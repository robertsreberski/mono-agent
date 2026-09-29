import { readCanonicalFileSnapshot } from "./path-safety.js";

/** Avoid creating a modern daily file that would hide a nonempty root-level legacy day on rebuild. */
export function assertNoShadowedLegacyDailyFile(root: string, when: Date): void {
  const day = when.toISOString().slice(0, 10);
  const legacy = readCanonicalFileSnapshot(root, `${day}.md`, { allowMissing: true });
  if (legacy === undefined) return;
  const modern = readCanonicalFileSnapshot(root, `daily/${day}.md`, { allowMissing: true });
  if (modern !== undefined) return;
  const legacyBody = legacy.content.trim();
  if (legacyBody.length === 0 || legacyBody === `# ${day}`) return;
  throw new Error(
    `memory-bujo: ${day}.md still uses the root-level legacy layout; remembering a fact would create `
    + `daily/${day}.md and hide it from the next rebuild. Migrate that file into daily/ first.`,
  );
}
