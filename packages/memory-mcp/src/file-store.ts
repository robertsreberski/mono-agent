import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const MEMORY_SUBDIRS = ["daily", "monthly"] as const;

export interface GrepHit {
  readonly source: string;
  readonly score: number;
  readonly snippet: string;
}

export function isValidDay(day: string): boolean {
  return DATE_RE.test(day);
}

/** Reads a single day's note. Throws on a non `YYYY-MM-DD` date (path-traversal guard). */
export async function readDailyNote(rootDir: string, day: string): Promise<string | undefined> {
  if (!isValidDay(day)) {
    throw new Error("date must be formatted YYYY-MM-DD.");
  }
  return readUtf8(join(rootDir, "daily", `${day}.md`));
}

/** Lists available daily-note days (sorted ascending). */
export async function listDailyNotes(rootDir: string): Promise<readonly string[]> {
  const entries = await readDirSafe(join(rootDir, "daily"));
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .filter(isValidDay)
    .sort();
}

/**
 * Keyword scan over the daily/monthly markdown archive. Splits each file into
 * `##`-delimited sections and ranks sections by how many distinct query tokens
 * they contain.
 */
export async function grepMemory(rootDir: string, query: string, limit = 8): Promise<readonly GrepHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }

  const hits: GrepHit[] = [];
  for (const subdir of MEMORY_SUBDIRS) {
    const dir = join(rootDir, subdir);
    for (const name of await readDirSafe(dir)) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const content = await readUtf8(join(dir, name));
      if (content === undefined) {
        continue;
      }
      for (const section of splitSections(content)) {
        const haystack = section.toLowerCase();
        const score = tokens.reduce((sum, token) => (haystack.includes(token) ? sum + 1 : sum), 0);
        if (score > 0) {
          hits.push({ source: `${subdir}/${name}`, score, snippet: truncate(section, 600) });
        }
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, limit));
}

function splitSections(content: string): readonly string[] {
  const sections = content.split(/\n(?=#{1,3} )/u).map((section) => section.trim()).filter(Boolean);
  return sections.length === 0 ? [content.trim()].filter(Boolean) : sections;
}

function tokenize(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/u).map((token) => token.trim()).filter(Boolean);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

async function readUtf8(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function readDirSafe(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { readonly code?: unknown }).code === code;
}
