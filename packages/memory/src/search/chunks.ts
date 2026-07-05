import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { MemoryChunk } from "./types.js";

const MEMORY_SUBDIRS = ["daily", "monthly"] as const;
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/u;

/** Minimal structural shape of an entity, to avoid a package dependency on memory-graph. */
export interface EntityLike {
  readonly name: string;
  readonly entityType: string;
  readonly observations: readonly string[];
}

/**
 * Builds indexable chunks from the markdown journal archive plus the entity
 * snapshot. Journal files are split into `##`-delimited sections; each entity
 * becomes one summary chunk.
 */
export async function gatherMemoryChunks(rootDir: string, entities: readonly EntityLike[]): Promise<readonly MemoryChunk[]> {
  const chunks: MemoryChunk[] = [];

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
      const source = `${subdir}/${name}`;
      const day = subdir === "daily" ? DATE_RE.exec(name)?.[1] : undefined;
      splitSections(content).forEach((section, index) => {
        chunks.push({
          id: `${source}#${index}`,
          source,
          text: section,
          ...(day === undefined ? {} : { day }),
        });
      });
    }
  }

  for (const entity of entities) {
    const facts = entity.observations.join("; ");
    const text = facts.length === 0
      ? `${entity.name} (${entity.entityType})`
      : `${entity.name} (${entity.entityType}): ${facts}`;
    chunks.push({ id: `entity:${normalizeName(entity.name)}`, source: "graph", text });
  }

  return chunks;
}

function splitSections(content: string): readonly string[] {
  const sections = content.split(/\n(?=#{1,3} )/u).map((section) => section.trim()).filter(Boolean);
  return sections.length === 0 ? [content.trim()].filter(Boolean) : sections;
}

function normalizeName(name: string): string {
  return name.replace(/\s+/gu, " ").trim().toLowerCase();
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
