import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createDurableHistoryStore } from "../../../dist/index.js";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";

const [root, mode] = process.argv.slice(2);
const bucket = "fictional-conversation", modelKey = "openai-codex:fictional-primary";
let inspections = 0, providers = 0, backups = 0;
const store = createDurableHistoryStore({ root,
  retireProviderSession: async () => {},
  reconcileProviderSessionTurn: async () => { inspections++; return { status: "absent" }; },
});
async function files(dir = root) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path.slice(root.length + 1));
  }
  return result.sort();
}
if (mode === "produce") {
  await store.append(bucket, [{ role: "assistant", content: "Fictional prior answer" }]);
  const turn = await store.beginProviderSessionTurn(bucket, "fictional-turn", { modelKey,
    reconciliation: { ownerKey: bucket, purpose: "execution", initial: { persistText: "Fictional current input", timestamp: "2026-01-01T00:00:00.000Z" } },
  });
  const descriptor = turn.reconciliation.descriptor;
  const primary = { provider: "openai-codex", model: "fictional-primary", reference: modelKey };
  const backup = { provider: "anthropic", model: "fictional-backup", reference: "anthropic:fictional-backup" };
  const router = createMonoRuntime({ fallbackChain: [{ model: primary }, { model: backup }], resolveAttempt: ({ attemptIndex }) => ({ runtime: { configureTools() {},
    async run() { if (attemptIndex) { backups++; return { text: "Must not run", events: [] }; }
      providers++; return { error: "Connection error.", failureKind: "provider_unavailable", events: [], providerSessionId: turn.providerSessionId }; },
  } }) });
  await router.run("Fictional system", { messages: [{ role: "user", content: "Fictional current input" }], sessionTurn: descriptor, model: primary, abortSignal: new AbortController().signal,
    onSessionTurnDetached: async () => { await turn.reconciliation.claim("detached"); },
    detachedContext: async () => {
      // Real read-only history load while the conversation turn is still held.
      // The detach claim's awaited payload publication/fsync has already ended.
      const history = await store.load(bucket);
      const paths = await files();
      const pendingPath = paths.find((path) => path.startsWith(".pending-turns/") && path.endsWith(".json"));
      const pending = JSON.parse(await readFile(join(root, pendingPath), "utf8"));
      process.send({ phase: "loader", providers, backups, inspections, history, pending, paths });
      await new Promise(() => {}); // Parent SIGKILLs this owned worker here.
      return [];
    },
  });
} else {
  const recovery = await store.recoverProviderSessionTurn(bucket);
  const paths = await files(), canonicalPath = paths.find((path) => path.endsWith(".history.json"));
  const bytes = await readFile(join(root, canonicalPath), "utf8");
  process.send({ recovery, paths, bytes, canonical: JSON.parse(bytes), providers, backups, inspections });
  process.disconnect();
}
