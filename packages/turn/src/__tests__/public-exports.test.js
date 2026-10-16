import { execFileSync } from "node:child_process";
import { it } from "vitest";

// Use Node's real export resolution, not Vitest aliases or transformed barrels.
it("keeps removed public symbols absent and documented extensions available", () => {
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import * as runtime from "@mono-agent/turn";
    import * as ai from "@mono-agent/turn/ai";
    import * as tools from "@mono-agent/turn/agent/tools/index.js";
    import * as allowlists from "@mono-agent/turn/agent/allowlists.js";
    import * as registry from "@mono-agent/turn/ai/runtime/registry.js";
    import * as modelRefs from "@mono-agent/turn/ai/runtime/model-refs.js";
    import * as fileChanges from "@mono-agent/turn/ai/file-change-stats.js";
    import * as failure from "@mono-agent/turn/ai/failure.js";
    import * as pricing from "@mono-agent/turn/ai/cost.js";
    import * as sessions from "@mono-agent/turn/engine/sessions.js";

    function absent(entry, names) {
      for (const name of names) assert.equal(Object.hasOwn(entry, name), false, name);
    }
    for (const entry of [runtime, ai]) {
      absent(entry, [
        "normalizeRuntimeModelReference", "createSessionRegistry", "createObserverHub",
        "buildCapabilitiesUsed", "toolCompactionAppliedFromWarnings", "UNKNOWN_CAPABILITY",
        "RUNTIME_CAPABILITIES", "PROVIDER_CHECK_PROMPT", "HANDOFF_SUMMARY_PROMPT",
        "disposeAllProviderSessions", "disposeProviderSession", "invalidateProviderSession",
        "refreshProviderSession", "syncProviderSession", "describePiBuiltinProvider",
      ]);
      assert.equal(typeof entry.createMetricsObserver, "function");
      assert.equal(typeof entry.parseRuntimeModelReference, "function");
    }
    absent(runtime, ["RESUME_SNAPSHOT_DEFAULTS", "createApprovalManager", "inferAllowlistMode"]);
    absent(tools, ["DEFAULT_CODEX_SEARCH_MODEL", "searchCodexSubscription", "createWebToolController"]);
    absent(registry, ["RUNTIME_CAPABILITIES"]);
    absent(modelRefs, ["normalizeRuntimeModelReference"]);
    absent(fileChanges, ["createFileChangePayload"]);
    absent(failure, ["PROVIDER_ABORT_RE"]);
    assert.deepEqual(Object.keys(allowlists), []);
    assert.equal(typeof sessions.createSessionRegistry, "function");
    for (const name of ["normalizePricing", "zeroPricing", "unknownPricing", "pricingHasRates", "isPrivateHost", "parseReference"]) {
      assert.equal(typeof pricing[name], "function", name);
    }
  `], { stdio: "pipe" });
});
