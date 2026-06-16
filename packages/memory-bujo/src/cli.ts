#!/usr/bin/env node
import { join } from "node:path";

import { openMemoryDb } from "@mono-agent/memory-store";

import { readEmbeddings } from "./cli-env.js";
import { createIdFactory } from "./ids.js";
import { migrate } from "./migrate.js";
import { createOllamaLlm } from "./ollama-llm.js";
import { writeFutureLog, writeIndex } from "./projections.js";
import { rebuildFromMarkdown } from "./rebuild.js";
import { reflect } from "./reflect.js";

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

  const query = rest.join(" ").trim();
  if (command === "recall" && query.length === 0) {
    process.stderr.write("error: recall requires a non-empty <query>\n");
    process.exit(2);
  }

  if (command === "reflect" || command === "migrate") {
    const chatModel = process.env.MONO_AGENT_MEMORY_LLM_MODEL;
    if (chatModel === undefined) {
      process.stderr.write(
        "error: set MONO_AGENT_MEMORY_LLM_MODEL to a local Ollama chat model (e.g. qwen3.6:latest)\n",
      );
      process.exit(2);
    }
  }

  // Embeddings are opt-in (matching the agent/MCP): only enabled when an embeddings provider is
  // configured. A lite-tier (FTS-only) recall/rebuild then needs no embedding service running.
  const embeddingsConfig = readEmbeddings();
  const db = openMemoryDb({
    path: join(root, "memory.db"),
    ...(embeddingsConfig !== undefined ? { embeddings: embeddingsConfig.provider, dim: embeddingsConfig.dim } : {}),
  });
  try {
    if (command === "rebuild") {
      const result = await rebuildFromMarkdown(root, db);
      process.stdout.write(`rebuilt: indexed ${result.indexed} memories into ${join(root, "memory.db")}\n`);
    } else if (command === "index") {
      writeIndex(root, db, new Date());
      process.stdout.write(`wrote ${join(root, "index.md")}\n`);
    } else if (command === "reflect") {
      // MONO_AGENT_MEMORY_LLM_MODEL is guaranteed non-undefined here (guard above)
      const chatModel = process.env.MONO_AGENT_MEMORY_LLM_MODEL as string;
      const llm = createOllamaLlm({
        model: chatModel,
        ...(process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT ? { endpoint: process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT } : {}),
      });
      const r = await reflect({ db, root, llm, nextId: createIdFactory(), now: () => new Date() });
      writeFutureLog(root, db, new Date());
      writeIndex(root, db, new Date());
      process.stdout.write(`reflected: decayed ${r.decayed}, insights ${r.insights}, due ${r.due}\n`);
    } else if (command === "migrate") {
      // MONO_AGENT_MEMORY_LLM_MODEL is guaranteed non-undefined here (guard above)
      const chatModel = process.env.MONO_AGENT_MEMORY_LLM_MODEL as string;
      const llm = createOllamaLlm({
        model: chatModel,
        ...(process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT ? { endpoint: process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT } : {}),
      });
      const m = await migrate({ db, root, llm, nextId: createIdFactory(), now: () => new Date() });
      writeFutureLog(root, db, new Date());
      process.stdout.write(
        `migrated: promoted ${m.promoted}, rescheduled ${m.rescheduled}, clustered ${m.clustered}, forgotten ${m.forgotten}, reviewed ${m.reviewed}\n`,
      );
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
