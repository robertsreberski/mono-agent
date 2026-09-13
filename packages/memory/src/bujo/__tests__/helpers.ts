import { randomUUID } from "node:crypto";
import type { MemoryCompletedTurnResult } from "@mono-agent/agent-contracts";
import type { BujoMemoryStore } from "../store.js";
import type { EmbeddingProvider } from "../../search/index.js";
import type { LlmComplete } from "../llm.js";

/** Deterministic bag-of-words embedding for tests: shared words → similar vectors. */
export function fakeEmbeddings(dim: number): EmbeddingProvider {
  return {
    id: `fake-${dim}`,
    embed: async (texts) => texts.map((text) => embedOne(text, dim)),
  };
}

function embedOne(text: string, dim: number): number[] {
  const vec = new Array<number>(dim).fill(0);
  const stripped = text.replace(/^search_(query|document):\s*/u, "");
  for (const token of stripped.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (token.length === 0) continue;
    const idx = hash(token) % dim;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function hash(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Deterministic fake LLM: returns the first canned response whose key substring appears in the prompt. */
export function fakeLlm(responses: ReadonlyArray<readonly [match: string, reply: string]>): LlmComplete {
  return {
    id: "fake-llm",
    complete: async (prompt: string) => {
      for (const [match, reply] of responses) if (prompt.includes(match)) return reply;
      return "[]";
    },
  };
}

/** Admit a summary and await its canonical projection, without waiting for Journal vectors. */
export async function projectSummary(
  store: BujoMemoryStore,
  conversationId: string,
  summary: string,
): Promise<MemoryCompletedTurnResult> {
  const result = await store.persistCompletedTurn({ runId: randomUUID(), conversationId, summary });
  const deadline = Date.now() + 20_000;
  while ((store.queueSnapshot().intake?.pending ?? 0) > 0) {
    if (Date.now() > deadline) throw new Error("Completed-turn summary projection did not settle.");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  if ((store.queueSnapshot().intake?.dead ?? 0) > 0) throw new Error("Completed-turn summary projection failed.");
  return result;
}

/** Exercise completed-turn capture and wait for downstream work before assertions. */
export async function projectCapture(store: BujoMemoryStore, conversationId: string, captureText: string): Promise<void> {
  await store.persistCompletedTurn({ runId: randomUUID(), conversationId, summary: captureText, captureText });
  await store.flush();
}
