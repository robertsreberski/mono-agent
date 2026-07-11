import type { MemoryDb } from "../store/index.js";

import type { LlmComplete } from "./llm.js";

export interface ReflectDeps {
  readonly db: MemoryDb;
  readonly root: string;
  readonly llm: LlmComplete;
  readonly nextId: () => string;
  readonly now: () => Date;
  readonly halfLifeDays?: number;
  readonly floor?: number;
  readonly maxInsights?: number;
  readonly abortSignal?: AbortSignal;
}

export interface ReflectResult {
  readonly decayed: number;
  readonly insights: number;
  readonly due: number;
}

/**
 * @deprecated Reflection is a compatibility/read-only status probe in v1.
 * It never calls the configured LLM or mutates canonical or derived memory.
 */
export async function reflect(deps: ReflectDeps): Promise<ReflectResult> {
  deps.abortSignal?.throwIfAborted();
  const now = deps.now();
  const due = deps.db.dueItems(now).length;
  return { decayed: 0, insights: 0, due };
}
