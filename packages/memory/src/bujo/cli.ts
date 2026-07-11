#!/usr/bin/env node
import { join } from "node:path";

import { openMemoryDb } from "../store/index.js";

import { readEmbeddings } from "./cli-env.js";
import { createIdFactory } from "./ids.js";
import { migrate } from "./migrate.js";
import { createOllamaLlm } from "./ollama-llm.js";
import { writeFutureLog, writeIndex } from "./projections.js";
import { rollbackMemoryIndex, safeRebuildMemoryIndex } from "./rebuild.js";
import { reflect } from "./reflect.js";
import {
  acquireMemoryWriterLease,
  readManagedIndexManifest,
  resolveActiveMemoryDbPath,
} from "./generations.js";
import type { BujoTier } from "./types.js";

/** Optional per-call LLM timeout override (ms). Invalid values fall back to the client default. */
function llmTimeoutMsFromEnv(): number | undefined {
  const raw = process.env.MONO_AGENT_MEMORY_LLM_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function main(): Promise<void> {
  const [command, root, ...rest] = process.argv.slice(2);
  if (command !== "rebuild" && command !== "rollback" && command !== "recall" && command !== "index" && command !== "reflect" && command !== "migrate") {
    process.stderr.write("usage: memory-bujo <rebuild|rollback|recall|index|reflect|migrate> <root> [query] [--tier <lite|journal|bujo>]\n");
    process.exit(2);
  }
  if (root === undefined) {
    process.stderr.write("error: <root> is required\n");
    process.exit(2);
  }

  const parsedArgs = parseArgs(rest);
  const query = parsedArgs.rest.join(" ").trim();
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
  if (command === "rebuild" || command === "rollback") {
    if (parsedArgs.tier === undefined) {
      throw new Error(`${command} requires --tier <lite|journal|bujo>; the standalone CLI cannot infer configured tier semantics.`);
    }
    if (command === "rebuild" && readManagedIndexManifest(root) === undefined) {
      throw new Error(
        "first managed activation must use config-aware `mono-agent memory rebuild`; stop the configured agent first.",
      );
    }
    const options = {
      root,
      tier: parsedArgs.tier,
      ...(embeddingsConfig === undefined ? {} : { embeddings: embeddingsConfig.provider, dim: embeddingsConfig.dim }),
    };
    const result = command === "rebuild"
      ? await safeRebuildMemoryIndex(options)
      : await rollbackMemoryIndex(options);
    process.stdout.write(
      `${command === "rebuild" ? "rebuilt" : "rolled back"}: generation ${result.generation}, ${result.indexed} memories at ${result.active}; `
      + `skipped raw=${result.skippedRawRecords}, unstructured=${result.skippedUnstructuredRecords}, `
      + `missing identity=${result.skippedMissingIdentityRecords} (${result.missingIdentityLocations.join(", ") || "none"}), `
      + `legacy source=${result.skippedLegacySourceRecords} (${result.legacySourceLocations.join(", ") || "none"}), `
      + `journal duplicates=${result.skippedJournalDuplicateRecords}, source items=${result.parsedSourceItems}, `
      + `derived legacy associations=${result.derivedLegacyAssociations}\n`,
    );
    return;
  }

  const writerLease = command === "recall" ? undefined : acquireMemoryWriterLease(root);
  let db: ReturnType<typeof openMemoryDb> | undefined;
  try {
    db = openMemoryDb({
      path: resolveActiveMemoryDbPath(root),
      ...(embeddingsConfig !== undefined ? { embeddings: embeddingsConfig.provider, dim: embeddingsConfig.dim } : {}),
      ...(command === "recall" ? { readOnly: true } : {}),
    });
    if (command === "index") {
      writeIndex(root, db, new Date());
      process.stdout.write(`wrote ${join(root, "index.md")}\n`);
    } else if (command === "reflect") {
      // MONO_AGENT_MEMORY_LLM_MODEL is guaranteed non-undefined here (guard above)
      const chatModel = process.env.MONO_AGENT_MEMORY_LLM_MODEL as string;
      const timeoutMs = llmTimeoutMsFromEnv();
      const llm = createOllamaLlm({
        model: chatModel,
        ...(process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT ? { endpoint: process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const r = await reflect({ db, root, llm, nextId: createIdFactory(), now: () => new Date() });
      writeFutureLog(root, db, new Date());
      writeIndex(root, db, new Date());
      process.stdout.write(`reflected: decayed ${r.decayed}, insights ${r.insights}, due ${r.due}\n`);
    } else if (command === "migrate") {
      // MONO_AGENT_MEMORY_LLM_MODEL is guaranteed non-undefined here (guard above)
      const chatModel = process.env.MONO_AGENT_MEMORY_LLM_MODEL as string;
      const timeoutMs = llmTimeoutMsFromEnv();
      const llm = createOllamaLlm({
        model: chatModel,
        ...(process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT ? { endpoint: process.env.MONO_AGENT_MEMORY_LLM_ENDPOINT } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      const m = await migrate({ db, root, llm, nextId: createIdFactory(), now: () => new Date() });
      writeFutureLog(root, db, new Date());
      process.stdout.write(
        `migrated: promoted ${m.promoted}, rescheduled ${m.rescheduled}, clustered ${m.clustered}, forgotten ${m.forgotten}, reviewed ${m.reviewed}\n`,
      );
    } else {
      const hits = await db.recall(query, { topK: 8, trackAccess: false });
      for (const hit of hits) process.stdout.write(`${hit.score.toFixed(3)}  ${hit.record.text}\n`);
    }
  } finally {
    db?.close();
    writerLease?.release();
  }
}

function parseArgs(values: readonly string[]): { readonly tier?: BujoTier; readonly rest: string[] } {
  const rest: string[] = [];
  let tier: BujoTier | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "--tier") {
      const candidate = values[index + 1];
      if (candidate !== "lite" && candidate !== "journal" && candidate !== "bujo") {
        throw new Error("--tier must be lite, journal, or bujo.");
      }
      tier = candidate;
      index += 1;
    } else if (value.startsWith("--tier=")) {
      const candidate = value.slice("--tier=".length);
      if (candidate !== "lite" && candidate !== "journal" && candidate !== "bujo") {
        throw new Error("--tier must be lite, journal, or bujo.");
      }
      tier = candidate;
    } else {
      rest.push(value);
    }
  }
  return { ...(tier === undefined ? {} : { tier }), rest };
}

main().catch((error: unknown) => {
  process.stderr.write(`memory-bujo failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
