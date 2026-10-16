// Scan source declarations after `pnpm run build`: cross-package consumers resolve
// through built manifest entry points. No temporary package tsconfigs required.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const turnHost = (file: string) => [resolve(root, `packages/turn/src/host/${file}.ts`)];
const paths = {
  "@mono-agent/turn/host": turnHost("index"),
  "@mono-agent/turn/host/config": turnHost("config"),
  "@mono-agent/turn/host/types": turnHost("types"),
  "@mono-agent/turn/host/sandbox": turnHost("sandbox/index"),
};

// Exact names/citations for documented, indirect, fixture-control and deferred surfaces.
// taggedNames is enforced by the focused policy test; no file-wide export ignores.
export const retainedExports = [
  {
    "file": "packages/contracts/src/bearer.ts",
    "names": [
      "generateBearerToken"
    ],
    "reason": "documented extension: HTTP listener protection",
    "citation": "packages/contracts/README.md:260",
    "taggedNames": [
      "generateBearerToken"
    ]
  },
  {
    "file": "packages/turn/src/telemetry/cost.js",
    "names": [
      "normalizePricing",
      "zeroPricing",
      "unknownPricing",
      "pricingHasRates",
      "isPrivateHost",
      "parseReference"
    ],
    "reason": "documented extension: custom host pricing resolvers",
    "citation": "packages/turn/src/telemetry/cost.js:178-183",
    "taggedNames": [
      "zeroPricing",
      "pricingHasRates",
      "isPrivateHost"
    ]
  },
  {
    "file": "packages/turn/src/telemetry/observer.js",
    "names": [
      "createMetricsObserver"
    ],
    "reason": "documented extension: metrics observer",
    "citation": "packages/turn/README.md#start-here",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/shared/tool-context.js",
    "names": [
      "createToolContext",
      "updateToolContext"
    ],
    "reason": "documented extension: host tool context",
    "citation": "packages/turn/README.md#direct-tool-calls",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/files/read.js",
    "names": [
      "readToolImpl"
    ],
    "reason": "documented extension: direct tool calls",
    "citation": "packages/turn/README.md#direct-tool-calls",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/runtime/bridges.js",
    "names": [
      "resolveEngineTurnAdapter",
      "listRuntimeBridges"
    ],
    "reason": "documented extension: advanced runtime imports",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/runtime/model-reference.js",
    "names": [
      "parseRuntimeModelReference"
    ],
    "reason": "documented extension: advanced model reference parsing",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/telemetry/failure.js",
    "names": [
      "classifyFailure",
      "FAILURE_KINDS"
    ],
    "reason": "documented extension: advanced failure classification",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/telemetry/cost.js",
    "names": [
      "resolvePricing",
      "estimateCost"
    ],
    "reason": "documented extension: advanced pricing resolution",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/agent/compaction.js",
    "names": [
      "resolveAgentCompactionPolicy",
      "isLikelyContextTermination"
    ],
    "reason": "documented extension: advanced compaction policy",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/engine/index.js",
    "names": [
      "JsonlSessionRepo",
      "MemorySessionRepo",
      "createRunDriver",
      "projectContext",
      "projectInheritedContext",
      "digestTurnInput",
      "HANDOFF_SUMMARY_FIELDS",
      "estimateHandoffTokens",
      "validateHandoffSummary",
      "ENGINE_CONTEXT",
      "calculateContextTokens",
      "compact",
      "estimateContextTokens",
      "estimateTokens",
      "getLastAssistantUsage",
      "prepareCompaction",
      "shouldCompact",
      "generateSummaryWithRequest"
    ],
    "reason": "documented extension: engine repositories, projection, compaction, ownership and lifecycle",
    "citation": "packages/turn/ENGINE.md:274-289",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/engine/sessions.js",
    "names": [
      "resolveDurableNativeSessionRepo",
      "resolveSession",
      "discardUncommittedSession",
      "commitSession",
      "rollbackAbortedTurn",
      "cleanupSessionOnThrow",
      "captureSessionRecovery",
      "recoverDurableNativeSession",
      "reconcileNativeSessionTurn",
      "retireDurableNativeSession",
      "detachDurableNativeSession",
      "nativeSessionRegistry",
      "salvageDurableNativeSession",
      "createManagedNativeJournalStorage",
      "NativeEvidenceCapacityError",
      "assertNativeSessionAccess",
      "normalizeDurableSessionsRoot",
      "validateSessionTurn",
      "isJournalStorageError",
      "NativeSuspendedError",
      "settleNativeSession",
      "createSessionRegistry"
    ],
    "reason": "documented extension: engine repositories, projection, compaction, ownership and lifecycle",
    "citation": "packages/turn/ENGINE.md:274-289",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/engine/owned-fs.js",
    "names": [
      "OwnedFileDamagedError",
      "assertIdentity",
      "isOwned",
      "listOwned",
      "publishAtomic",
      "readOwned",
      "sameIdentity",
      "syncDir",
      "unchanged"
    ],
    "reason": "documented extension: engine repositories, projection, compaction, ownership and lifecycle",
    "citation": "packages/turn/ENGINE.md:274-289",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/providers/codex/app-server-client.js",
    "names": [
      "createCodexAppServerClient"
    ],
    "reason": "consumed: runtime Codex broker; tested client subpath retained until turn entry regrouping",
    "citation": "packages/turn/src/tools/web/codex-subscription-search.js:7",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/web/codex-subscription-search.js",
    "names": [
      "__resetCodexSubscriptionSearchForTests"
    ],
    "reason": "test isolation control for process-global Codex broker/cache",
    "citation": "packages/turn/src/tools/web/codex-subscription-search.js",
    "taggedNames": [
      "__resetCodexSubscriptionSearchForTests"
    ]
  },
  {
    "file": "packages/turn/src/tools/web/search-providers/shared.js",
    "names": [
      "__resetWebSearchThrottleForTests"
    ],
    "reason": "test isolation control for process-global WebSearch throttle",
    "citation": "packages/turn/src/tools/web/search-providers/shared.js",
    "taggedNames": [
      "__resetWebSearchThrottleForTests"
    ]
  },
  {
    "file": "packages/turn/src/host/providers/provider-discovery.ts",
    "names": [
      "clearLocalProviderDiscoveryCache"
    ],
    "reason": "test isolation control for process-global local provider discovery cache",
    "citation": "packages/turn/src/host/providers/provider-discovery.ts",
    "taggedNames": [
      "clearLocalProviderDiscoveryCache"
    ]
  },
  {
    "file": "packages/turn/src/tools/web/web-controller.js",
    "names": [
      "__resetSharedSearchCacheForTests"
    ],
    "reason": "test isolation control for process-global shared search cache",
    "citation": "packages/turn/src/tools/web/web-controller.js",
    "taggedNames": [
      "__resetSharedSearchCacheForTests"
    ]
  },
  {
    "file": "packages/turn/src/providers/pi/transport-errors.js",
    "names": [
      "resetTransportErrorProbeForTests",
      "recordTransportErrorForTests"
    ],
    "reason": "test isolation control for process-global transport error probe",
    "citation": "packages/turn/src/providers/pi/transport-errors.js",
    "taggedNames": [
      "resetTransportErrorProbeForTests",
      "recordTransportErrorForTests"
    ]
  },
  {
    "file": "packages/turn/src/runtime/session-fanout.js",
    "names": [
      "createSessionRegistry"
    ],
    "reason": "test isolation control for process-global runtime registry fan-out",
    "citation": "packages/turn/src/runtime/session-fanout.js",
    "taggedNames": [
      "createSessionRegistry"
    ]
  },
  {
    "file": "packages/app/src/config-reference.ts",
    "names": [
      "buildGeneratedConfigReferenceMarkdown"
    ],
    "reason": "indirect: built-module config reference generator",
    "citation": "scripts/generate-config-reference.mjs",
    "taggedNames": [
      "buildGeneratedConfigReferenceMarkdown"
    ]
  },
  {
    "file": "packages/app/src/background-runtime.ts",
    "names": [
      "attestManagedBackgroundRuntime"
    ],
    "reason": "indirect: built-module runtime attestation probe",
    "citation": "scripts/managed-runtime-attestation-probe.mjs",
    "taggedNames": [
      "attestManagedBackgroundRuntime"
    ]
  }
] as const;

export const retainedEntries = [] as const;

export default {
  tags: ["-coreScanRetained"],
  // Knip 5.88.1 supports this only at top level; the launcher selects five core workspaces.
  ignoreExportsUsedInFile: true,
  // These by-path fixture declarations describe their .mjs companions; they
  // are not independent runtime exports. Keep the .mjs exports analyzed.
  ignoreIssues: {
    "packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts": ["exports"],
    "packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts": ["exports"],
  },
  workspaces: {
    ".": { paths },
    "packages/*": { paths },
    "extras/*": { paths },
    "packages/contracts": {
      paths,
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/config": {
      paths,
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/turn": {
      paths,
      entry: [
        "src/index.js!",
        "src/host/{index,config,types}.ts!",
        "src/host/sandbox/index.ts!",
        "src/host/sandbox/srt-embed-runner.mjs!",
        "src/engine/__tests__/fixtures/regenerate-projection-goldens.mjs",
      ],
      project: ["src/**/*.{js,mjs,ts,mts}!", "!src/**/__tests__/**!"],
      ignoreDependencies: ["@vscode/ripgrep"],
    },
    "packages/conversation": {
      paths,
      entry: [
        "src/index.ts!",
        "src/tool-history-writer-worker.ts!",
        "src/__tests__/fixtures/canonical-v5-fixture.d.mts",
        "src/__tests__/fixtures/managed-native-switch-fixture.d.mts",
      ],
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!"],
    },
    "packages/app": {
      paths,
      entry: [
        "src/{index,cli}.ts!",
        "scripts/smoke-subagent-stop.mjs",
        "scripts/smoke-subagent-steer.mjs",
        "src/__tests__/fixtures/managed-subagent-proof.mjs",
        "src/__tests__/fixtures/subagent-observer-srt.mjs",
        "src/__tests__/fixtures/worker-maintenance-smoke.mjs",
      ],
      project: ["src/**/*.{ts,mjs,mts}!", "!src/**/__tests__/**!", "scripts/*.mjs"],
    },
  },
};
