import { execFileSync } from "node:child_process";
import { it } from "vitest";

// Real Node resolution, not transformed barrels or Vitest aliases.
it("publishes exactly the curated entries and rejects every retired file-shaped entry", () => {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { readFileSync } from "node:fs";
    import * as runtime from "@mono-agent/turn";
    import * as ai from "@mono-agent/turn/ai";
    import * as agent from "@mono-agent/turn/agent";
    import * as tools from "@mono-agent/turn/tools";
    import * as hostConfig from "@mono-agent/turn/host/config";
    import * as sessions from "@mono-agent/turn/engine/sessions.js";
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@mono-agent/turn"))));
    assert.deepEqual(Object.keys(manifest.exports).sort(), [
      ".", "./ai", "./agent", "./tools", "./host", "./host/config", "./host/types", "./host/sandbox",
      "./engine", "./engine/sessions.js", "./engine/owned-fs.js",
    ].sort());
    assert.equal(Object.hasOwn(hostConfig, "RuntimeAdapterError"), false);
    const hostError = new hostConfig.TurnHostError("invalid_runtime_options", "Fictional failure", { field: "fixture" });
    assert.equal(hostError.name, "TurnHostError");
    assert.equal(hostError.message, "Fictional failure");
    assert.equal(hostError.code, "invalid_runtime_options");
    assert.deepEqual(hostError.details, { field: "fixture", code: "invalid_runtime_options" });
    assert.deepEqual(runtime.DEFAULT_RUNTIME_BRAND, {
      schemaPrefix: "agent_runtime", mcpClientName: "agent-runtime", mcpClientVersion: "0.1.0",
      tempdirPrefix: "agent-runtime-cli-", providerModelPrefix: "agent", doctorCommand: "agent-runtime doctor",
      serviceName: "agent-runtime", clientInfoName: "agent-runtime", clientInfoTitle: "Agent Runtime",
    });
    const turnRequire = createRequire(import.meta.resolve("@mono-agent/turn"));
    for (const key of ["#turn/contracts/runtime", "#turn/telemetry/cost", "#turn/contracts/native-storage"]) assert.equal(typeof turnRequire.resolve(key), "string");
    for (const key of ["#kernel/types", "#kernel/cost", "#kernel/native-journal-types"]) assert.throws(() => turnRequire.resolve(key), { code: "ERR_PACKAGE_IMPORT_NOT_DEFINED" });
    assert.deepEqual(Object.keys(runtime).sort(), [
      "createRuntime", "createRouterRuntime", "createPiOAuthApiKeyResolver", "DEFAULT_RUNTIME_BRAND", "resolveRuntimeBrand",
      "parseRuntimeModelReference", "createMetricsObserver", "resolveAgentCompactionPolicy", "isLikelyContextTermination",
    ].sort());
    function absent(entry, names) {
      for (const name of names) assert.equal(Object.hasOwn(entry, name), false, name);
    }
    for (const entry of [runtime, ai]) {
      absent(entry, [
        "normalizeRuntimeModelReference", "createSessionRegistry", "createObserverHub", "buildCapabilitiesUsed",
        "toolCompactionAppliedFromWarnings", "UNKNOWN_CAPABILITY", "RUNTIME_CAPABILITIES", "PROVIDER_CHECK_PROMPT",
        "HANDOFF_SUMMARY_PROMPT", "disposeAllProviderSessions", "disposeProviderSession", "invalidateProviderSession",
        "refreshProviderSession", "syncProviderSession", "describePiBuiltinProvider",
      ]);
    }
    absent(tools, ["DEFAULT_CODEX_SEARCH_MODEL", "searchCodexSubscription", "createWebToolController", "cachedRgPath"]);
    absent(ai, ["PROVIDER_ABORT_RE", "createFileChangePayload"]);
    assert.equal(typeof sessions.createSessionRegistry, "function");
    for (const name of ["normalizePricing", "zeroPricing", "unknownPricing", "pricingHasRates", "isPrivateHost", "parseReference",
      "resolvePricing", "estimateCost", "classifyFailure", "digestNativeTurnInput", "formatLiveInputGuidance", "createCodexAppServerClient",
      "produceNativeHandoffSummary", "createManagedNativeJournalStorage", "NativeEvidenceCapacityError", "detachDurableNativeSession"]) {
      assert.equal(typeof ai[name], "function", name);
    }
    for (const name of ["formatSkillBodyWithPathNote", "buildTranscriptTailSnapshot", "renderResumeSnapshot"]) assert.equal(typeof agent[name], "function", name);
    for (const name of ["readToolImpl", "bashToolImpl", "execToolImpl", "performWebFetch", "performWebSearch", "resolveRgPath", "createToolContext", "updateToolContext"]) {
      assert.equal(typeof tools[name], "function", name);
    }
    for (const removed of [
      "ai/failure.js", "ai/cost.js", "ai/runtime/model-refs.js", "ai/runtime/registry.js", "ai/live-input-prompt.js",
      "ai/file-change-stats.js", "ai/providers/codex/app-server-client.js", "agent/tools/index.js", "agent/tools/shared/ripgrep.js",
      "agent/prompt/skill-index.js", "agent/allowlists.js", "agent/transcript.js", "agent/compaction.js", "agent/tools/shared/tool-context.js",
    ]) await assert.rejects(import("@mono-agent/turn/" + removed), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  `], { stdio: "pipe" });
});
