#!/usr/bin/env node
import { join } from "node:path";

import { createEmbeddingProvider } from "@mono-agent/memory-search";
import { openMemoryDb } from "@mono-agent/memory-store";

import { rebuildFromMarkdown } from "./rebuild.js";
import { writeIndex } from "./projections.js";

async function main(): Promise<void> {
  const [command, root, ...rest] = process.argv.slice(2);
  if (command !== "rebuild" && command !== "recall" && command !== "index" && command !== "reflect" && command !== "migrate") {
    process.stderr.write("usage: memory-bujo <rebuild|recall|index|reflect|migrate> <root> [query]\n");
    process.exit(2);
  }
  if (root === undefined) {
    process.stderr.write("error: <root> is required\n");
    process.exit(2);
  }

  // reflect and migrate require an LLM — not wired until P4 (real chat adapter).
  // Print a clear message and exit 2; do NOT fabricate an LLM.
  if (command === "reflect") {
    process.stderr.write(
      "reflect requires an LLM; it runs via BujoMemoryStore with an injected llm (wired by the host in Phase 4). Not available from the CLI yet.\n",
    );
    process.exit(2);
  }
  if (command === "migrate") {
    process.stderr.write(
      "migrate requires an LLM; it runs via BujoMemoryStore with an injected llm (wired by the host in Phase 4). Not available from the CLI yet.\n",
    );
    process.exit(2);
  }

  const query = rest.join(" ").trim();
  if (command === "recall" && query.length === 0) {
    process.stderr.write("error: recall requires a non-empty <query>\n");
    process.exit(2);
  }
  const model = process.env.MONO_AGENT_EMBED_MODEL ?? "nomic-embed-text:v1.5";
  const dim = Number(process.env.MONO_AGENT_EMBED_DIM ?? "768");
  const embeddings = createEmbeddingProvider({ provider: "ollama", model });
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim });
  try {
    if (command === "rebuild") {
      const result = await rebuildFromMarkdown(root, db);
      process.stdout.write(`rebuilt: indexed ${result.indexed} memories into ${join(root, "memory.db")}\n`);
    } else if (command === "index") {
      writeIndex(root, db, new Date());
      process.stdout.write(`wrote ${join(root, "index.md")}\n`);
    } else {
      const hits = await db.recall(query, { topK: 8 });
      for (const hit of hits) process.stdout.write(`${hit.score.toFixed(3)}  ${hit.record.text}\n`);
    }
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-bujo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
