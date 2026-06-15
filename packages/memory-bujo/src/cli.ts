#!/usr/bin/env node
import { join } from "node:path";

import { createEmbeddingProvider } from "@mono-agent/memory-search";
import { openMemoryDb } from "@mono-agent/memory-store";

import { rebuildFromMarkdown } from "./rebuild.js";

async function main(): Promise<void> {
  const [command, root, ...rest] = process.argv.slice(2);
  if (command !== "rebuild" && command !== "recall") {
    process.stderr.write("usage: memory-bujo <rebuild|recall> <root> [query]\n");
    process.exit(2);
  }
  if (root === undefined) {
    process.stderr.write("error: <root> is required\n");
    process.exit(2);
  }
  const model = process.env.MONO_AGENT_EMBED_MODEL ?? "nomic-embed-text:v1.5";
  const dim = Number(process.env.MONO_AGENT_EMBED_DIM ?? "768");
  const embeddings = createEmbeddingProvider({ provider: "ollama", model });
  const db = openMemoryDb({ path: join(root, "memory.db"), embeddings, dim });
  if (command === "rebuild") {
    const result = await rebuildFromMarkdown(root, db);
    process.stdout.write(`rebuilt: indexed ${result.indexed} memories into ${join(root, "memory.db")}\n`);
  } else {
    const hits = await db.recall(rest.join(" "), { topK: 8 });
    for (const hit of hits) process.stdout.write(`${hit.score.toFixed(3)}  ${hit.record.text}\n`);
  }
  db.close();
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-bujo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
