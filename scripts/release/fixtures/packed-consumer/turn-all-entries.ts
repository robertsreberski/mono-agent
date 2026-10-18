import * as root from "@mono-agent/turn";
import * as ai from "@mono-agent/turn/ai";
import * as agent from "@mono-agent/turn/agent";
import * as host from "@mono-agent/turn/host";
import * as config from "@mono-agent/turn/host/config";
import type * as types from "@mono-agent/turn/host/types";
import * as sandbox from "@mono-agent/turn/host/sandbox";
import * as engine from "@mono-agent/turn/engine";
import * as sessions from "@mono-agent/turn/engine/sessions.js";
import * as owned from "@mono-agent/turn/engine/owned-fs.js";
import * as tools from "@mono-agent/turn/tools";

const options: types.CreateMonoRuntimeOptions = {};
void [root, ai, agent, host, config, sandbox, engine, sessions, owned, tools, options];

// Compile-only: installed tarballs must expose the same strict absence contracts.
function checkAbsenceContracts(store: Awaited<ReturnType<engine.MemorySessionRepo["create"]>>) {
  void ai.retryableProviderFailureInfo({ errorText: null, stderrTail: null, failureKind: undefined });
  const pricing = ai.normalizePricing({ input: 1 });
  if (pricing) {
    const source: string | undefined = pricing.source;
    // @ts-expect-error provenance is unknown when source was omitted
    const knownSource: string = pricing.source;
    void [source, knownSource];
  }
  // @ts-expect-error no cache signals produces null
  const ratio: number = root.createMetricsObserver().snapshot().cache.hitRatio;
  // @ts-expect-error snapshots can be absent
  const snapshot: object = agent.buildTranscriptTailSnapshot(undefined);
  // @ts-expect-error stats can be absent
  const stats: object = ai.statsForCompletedChange({}, undefined, undefined);
  // @ts-expect-error an empty change list has no summary
  const summary: object = ai.fileChangeSummary([]);
  // @ts-expect-error an invalid sessions root is null
  const sessionsRoot: string = sessions.normalizeDurableSessionsRoot(undefined);
  // @ts-expect-error the default background timeout is unspecified
  const timeout: number = tools.normalizeBackgroundTimeoutMs(undefined);
  // @ts-expect-error the default legacy background timeout is unspecified
  const bashTimeout: number = tools.normalizeBackgroundBashTimeoutMs(undefined);
  // @ts-expect-error no measured assistant usage has no usage index
  const lastUsageIndex: number = engine.estimateContextTokens([]).lastUsageIndex;
  // @ts-expect-error a session with no context entries has a null tip
  const tip: string = store.tip;
  // @ts-expect-error offset-backed I/O does not retain records
  const records: readonly unknown[] = store.records;
  // @ts-expect-error repair cache is cleared to null
  const repairs: Promise<unknown[]> = store.repairCache;
  void store.beginTurn("fictional-turn");
  const context = tools.createToolContext({ workspace: undefined, runId: undefined });
  tools.updateToolContext(context, { workspace: undefined, toolEnvironment: undefined });
  const registry = sessions.createSessionRegistry({ idleTimeoutMs: undefined });
  registry.set("fictional", {}, { idleTimeoutMs: undefined });
  registry.touch("fictional", { idleTimeoutMs: undefined });
  const resolver = root.createPiOAuthApiKeyResolver();
  void resolver.readCredential("fictional");
  void resolver.modifyCredential("fictional", async () => undefined);
  void resolver.deleteCredential("fictional");
  const router = root.createRouterRuntime();
  void router.run("Fictional prompt");
  void router.run("Fictional prompt", {});
  // @ts-expect-error a direct runtime cannot choose a model from a router chain
  void root.createRuntime().run("Fictional prompt", {});
  const storage = sessions.createManagedNativeJournalStorage({ sessionsRoot: "/fictional" });
  const prepared = storage.prepareHandoff({}, {});
  if ("prior" in prepared) {
    // @ts-expect-error the first handoff has no prior evidence
    const prior: object = prepared.prior;
    void prior;
  }
  const built = storage.buildHandoff({}, {});
  if ("artifact" in built && built.artifact) {
    // @ts-expect-error a handoff may not have a checkpoint
    const checkpoint: object = built.artifact.checkpoint;
    void checkpoint;
  }
  void [ratio, snapshot, stats, summary, sessionsRoot, timeout, bashTimeout, lastUsageIndex, tip, records, repairs];
}
void checkAbsenceContracts;
