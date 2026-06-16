import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseDailyFile, serializeBullet, serializeDailyFile } from "./grammar.js";
import type { Bullet } from "./types.js";

export function dailyFilePath(root: string, when: Date): string {
  const day = when.toISOString().slice(0, 10);
  return join(root, "daily", `${day}.md`);
}

/** Append a bullet to today's daily file (creating it with a heading if absent). Returns the bullet. */
export function appendBullet(root: string, bullet: Bullet, when: Date): Bullet {
  const path = dailyFilePath(root, when);
  mkdirSync(dirname(path), { recursive: true });
  // existsSync (not read-and-catch) so a permission/IO error surfaces instead of being mistaken for a new file.
  const header = existsSync(path) ? "" : `# ${when.toISOString().slice(0, 10)}\n\n`;
  appendFileSync(path, `${header}${serializeBullet(bullet)}\n`, "utf8");
  return bullet;
}

/**
 * Rewrite a single bullet inside an existing daily file.
 *
 * Reads `<root>/<file>`, parses it, finds the line whose `bullet.id === id`,
 * applies `patch` onto that Bullet (object spread), serializes and writes back.
 *
 * Returns `true` if the bullet was found and the file was rewritten, `false` if
 * no bullet with `id` was found (file is not modified in that case).
 *
 * Non-bullet lines (prose, headings, blank lines) are preserved verbatim.
 */
export function rewriteBullet(
  root: string,
  file: string,
  id: string,
  patch: Partial<Pick<Bullet, "text" | "status" | "salience" | "isInsight" | "dueAt" | "refs">>,
): boolean {
  const path = join(root, file);
  const content = readFileSync(path, "utf8");
  const parsed = parseDailyFile(content);

  let found = false;
  const newLines = parsed.lines.map((line) => {
    if (line.bullet === undefined || line.bullet.id !== id) return line;
    found = true;
    // Build the merged bullet by applying only the defined patch keys so that
    // exactOptionalPropertyTypes is satisfied (no undefined values injected).
    const merged: Bullet = { ...line.bullet, ...patch };
    return { raw: line.raw, bullet: merged };
  });

  if (!found) return false;

  writeFileSync(path, serializeDailyFile({ lines: newLines }), "utf8");
  return true;
}
