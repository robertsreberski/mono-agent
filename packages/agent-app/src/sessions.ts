import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveAppSessionsRoot } from "./app-config.js";
import type { MonoAgentAppConfigInput } from "./app-config.js";

export interface PurgeSessionsResult {
  /** The resolved sessions root, or undefined when sessions are in-memory only. */
  readonly root?: string;
  /** True when an on-disk sessions store existed and was removed. */
  readonly removed: boolean;
  /** Count of removed `*.jsonl` session files (best-effort; 0 when none/unknown). */
  readonly files: number;
}

/**
 * Remove the durable pi-session store so the next start begins with fresh sessions
 * instead of resuming persisted transcripts. A no-op (`removed: false`) when no
 * on-disk store is configured (in-memory sessions) or the directory does not exist.
 *
 * The runtime recreates the directory on the next session, and the agent's durable
 * memory lives elsewhere (`memory.path`), so this drops only resumable conversation
 * transcripts — not the knowledge base. Stop the worker before calling this so it is
 * not writing sessions while they are deleted.
 */
export async function purgeSessions(input: MonoAgentAppConfigInput): Promise<PurgeSessionsResult> {
  const root = await resolveAppSessionsRoot(input);
  if (root === undefined) {
    return { removed: false, files: 0 };
  }

  let files = 0;
  try {
    files = await countSessionFiles(root);
  } catch {
    // The store may not exist yet; treat it as nothing to remove.
    return { root, removed: false, files: 0 };
  }

  await rm(root, { recursive: true, force: true });
  return { root, removed: true, files };
}

/** Recursively count `*.jsonl` session files under a sessions root. */
async function countSessionFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await countSessionFiles(full);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      total += 1;
    }
  }
  return total;
}
