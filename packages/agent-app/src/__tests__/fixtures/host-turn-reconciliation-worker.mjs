// Finite IPC-controlled built configured-host smoke, real native journal, faux provider only.
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createConfiguredAgentHarness, createConfiguredAgentRuntime } from "@mono-agent/agent-app";
import { createDurableHistoryStore } from "@mono-agent/agent-harness";
import { createMonoRuntime, parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
const root = process.argv[2], bucket = "fictional-reconcile-bucket";
const historyRoot = join(root, ".mono-agent", "history"), piSessionsRoot = join(root, "pi");
const historyKey = createHash("sha256").update("mono-agent-history-v1\0").update(bucket).digest("hex");
const faux = fauxProvider({ provider: "faux", models: [{ id: "reconcile-fixture", reasoning: true, contextWindow: 100_000, maxTokens: 8_000 }], tokensPerSecond: undefined });
const models = createModels(); models.setProvider(faux.provider);
const config = {
  runtime: { model: { provider: "faux", model: "reconcile-fixture", reference: "faux:reconcile-fixture" }, workspace: root,
    session: { mode: "continuous", idleTimeoutMs: 60000 }, compaction: { enabled: false }, maxTurns: 4,
    retry: { primaryAttempts: 1, backoffMs: 1000, maxBackoffMs: 15000 } },
  providers: { piNative: { piSessionsRoot } }, context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] },
  tools: { allowedTools: ["Bash"], disallowedTools: [] }, artifacts: { dir: join(root, ".mono-agent", "artifacts") },
};
const sandboxEngine = { id: "host-turn-smoke-fixture", async isAvailable() { return true; },
  async prepareCommand(command) { return { ...command, args: command.args ?? [], cwd: command.cwd ?? root, sandboxed: true }; } };
const readRecord = async () => JSON.parse(await readFile(join(historyRoot, `${historyKey}.history.json`), "utf8"));
const counter = async () => { try { return (await readFile(join(root, "effect-count.txt"), "utf8")).trim().split("\n").length; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } };
process.once("message", async ({ mode, crash }) => {
  let harness, runtime;
  try {
    if (crash === "overflow-compaction") config.runtime.compaction = { enabled: true, triggerRatio: 0.95,
      keepRecentTokens: 4_000, minSavingsTokens: 500, summaryMaxTokens: 2_000, contextWindowOverride: 100_000 };
    await writeFile(join(root, "IDENTITY.md"), "You are Mono. Use only the requested harmless fixture.");
    let context, runtimeCalls = 0, nativeInspections = 0;
    const manualAbort = new AbortController();
    if (mode === "recover") {
      runtime = createConfiguredAgentRuntime({ config, cwd: root, sandboxEngine });
      const store = createDurableHistoryStore({ root: historyRoot,
        reconcileProviderSessionTurn: async (request) => {
          nativeInspections += 1; const selected = parseMonoRuntimeModelReference(request.modelKey);
          return runtime.reconcileSessionTurn({ sessionsRoot: piSessionsRoot, descriptor: request.descriptor, purpose: request.purpose,
            expectedInputs: request.expectedInputs, expectedModel: { provider: selected.provider, id: selected.model } });
        }, retireProviderSession: async (id) => { await runtime.retireDurableSession(id, piSessionsRoot); } });
      const recovery = await store.recoverProviderSessionTurn(bucket);
      await runtime.disposeAllSessions(); runtime = undefined;
      process.send({ recovery, record: await readRecord(), counter: await counter(), providerCalls: faux.state.callCount,
        runtimeCalls, nativeInspections, pending: await readdir(join(historyRoot, ".pending-turns")) }, () => process.exit(0));
      return;
    }
    const base = createMonoRuntime({ workspace: root });
    harness = await createConfiguredAgentHarness({ cwd: root, config, sandboxEngine,
      runtime: { ...base, async reconcileSessionTurn(request) { nativeInspections += 1; return base.reconcileSessionTurn(request); }, async run(prompt, options) {
        runtimeCalls += 1; const result = await base.run(prompt, crash === "legacy-unbound"
          ? { ...options, sessionTurn: { ...options.sessionTurn, reconciliation: undefined } } : options);
        if (crash === "manual-cancelled" && options.manualCompaction) manualAbort.abort();
        if (mode === "produce" && (crash === "native-return" || crash === "legacy-unbound")) { process.send({ phase: crash, counter: await counter() }); await new Promise(() => {}); }
        return result;
      } }, runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, piMaxRetries: 0, effort: "none" } });
    if (mode === "verbatim") {
      await harness.appendVerbatimTurn(bucket, "Fictional verbatim delivery.", { idempotencyKey: "fictional-verbatim-delivery" });
      await harness.dispose(); harness = undefined;
      process.send({ record: await readRecord(), counter: await counter(), runtimeCalls, nativeInspections,
        providerCalls: faux.state.callCount, pending: await readdir(join(historyRoot, ".pending-turns")) }, () => process.exit(0));
      return;
    }
    if (mode === "produce") faux.setResponses([
      fauxAssistantMessage([...(crash === "overflow-compaction" ? [fauxText("Fictional archived context. ".repeat(1_600).slice(0, 40_000))] : []), { ...fauxThinking("Fictional signed reasoning."), thinkingSignature: "fictional-durable-signature" },
        fauxToolCall("Bash", { command: "printf 'effect-marker\\n' >> effect-count.txt" }, { id: "fictional-counted-effect" })]),
      async (value) => {
        context = structuredClone(value.messages);
        if (crash === "returned-tool") { process.send({ phase: "returned-tool", counter: await counter() }); await new Promise(() => {}); }
        return fauxAssistantMessage([fauxText("Fictional verbatim final reply.")]);
      },
    ]);
    else faux.setResponses([(value) => { context = structuredClone(value.messages); return fauxAssistantMessage([fauxText("Fictional explicit next reply.")]); }]);
    const result = await harness.run({ conversationId: bucket, userMessage: mode === "produce" ? crash === "overflow-compaction" ? "Fictional prior context. ".repeat(1_800).slice(0, 40_000) : "Fictional counted effect request." : "Fictional explicit next request.",
      abortSignal: new AbortController().signal });
    if (result.failure) throw new Error(JSON.stringify(result.failure));
    if (mode === "produce" && crash === "native-deleted") {
      for (const name of await readdir(piSessionsRoot, { recursive: true })) if (name.endsWith(".jsonl")) await rm(join(piSessionsRoot, name));
      faux.setResponses([fauxAssistantMessage([fauxText("Fictional explicit reseeded reply.")])]);
      const cold = await harness.run({ conversationId: bucket, userMessage: "Fictional explicit next request.", abortSignal: new AbortController().signal });
      if (cold.failure) throw new Error(JSON.stringify(cold.failure));
    }
    if (mode === "produce" && crash === "overflow-compaction") {
      faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "context length exceeded, too many tokens" }),
        fauxAssistantMessage([fauxText("Fictional overflow checkpoint summary.")]), fauxAssistantMessage([fauxText("Fictional final overflow reply.")])]);
      const overflow = await harness.run({ conversationId: bucket, userMessage: "Fictional overflow request.", abortSignal: new AbortController().signal });
      if (overflow.failure) throw new Error(JSON.stringify(overflow.failure));
    }
    if (mode === "produce" && (crash === "manual-start" || crash === "manual-cancelled")) {
      faux.setResponses([fauxAssistantMessage([fauxText("Fictional checkpoint summary.")])]);
      try { await harness.compactConversation(bucket, undefined, manualAbort.signal); }
      catch (error) { if (crash !== "manual-cancelled" || error.failureKind !== "compaction_failed") throw error; }
      if (crash === "manual-cancelled") {
        process.send({ phase: crash, counter: await counter() }); await new Promise(() => {});
      }
    }
    await harness.dispose(); harness = undefined;
    process.send({ record: await readRecord(), counter: await counter(), context, runtimeCalls, providerCalls: faux.state.callCount }, () => process.exit(0));
  } catch (error) { console.error(error); await harness?.dispose().catch(() => {}); await runtime?.disposeAllSessions?.().catch(() => {}); process.exit(1); }
});
