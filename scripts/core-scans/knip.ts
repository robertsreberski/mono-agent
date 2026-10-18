// Scan source declarations after `pnpm run build`: cross-package consumers resolve
// through built manifest entry points. No temporary package tsconfigs required.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const turnManifest = JSON.parse(readFileSync(resolve(root, "packages/turn/package.json"), "utf8")) as {
  name: string;
  exports: Record<string, { default: string }>;
  imports: Record<string, { default: string }>;
};
const sourceTarget = (target: string) => {
  const source = resolve(root, "packages/turn", target.replace(/^\.\/dist\//u, "./src/"));
  const typed = source.replace(/\.js$/u, ".ts");
  return [existsSync(typed) ? typed : source];
};
const paths = Object.fromEntries([
  ...Object.entries(turnManifest.exports).map(([key, target]) => [
    key === "." ? turnManifest.name : `${turnManifest.name}/${key.slice(2)}`, sourceTarget(target.default),
  ]),
  ...Object.entries(turnManifest.imports).map(([key, target]) => [key, sourceTarget(target.default)]),
]);

// Exact names/citations for documented, indirect, fixture-control and deferred surfaces.
// taggedNames is enforced by the focused policy test; no file-wide export ignores.
export const retainedExports = [
  {
    "file": "packages/turn/src/contracts/model.ts",
    "names": [
      "RuntimeSdkId"
    ],
    "reason": "consumed: named by retained runtime result declarations",
    "citation": "packages/turn/src/contracts/runtime.ts",
    "taggedNames": [
      "RuntimeSdkId"
    ],
    "declarationPreserving": true
  },
  {
    "file": "packages/turn/src/contracts/runtime.ts",
    "names": [
      "AgentRuntimeInstance"
    ],
    "reason": "consumed: test-only native preparation runtime view",
    "citation": "packages/turn/src/__tests__/ai/native-prepared-dispatch.test.ts",
    "taggedNames": [
      "AgentRuntimeInstance"
    ],
    "declarationPreserving": true
  },
  {
    "file": "packages/turn/src/contracts/runtime.ts",
    "names": [
      "RuntimeBridge",
      "RuntimeBridgeDescriptor"
    ],
    "reason": "documented extension: public compatibility types via ./ai",
    "citation": "packages/turn/src/ai/index.ts",
    "taggedNames": [
      "RuntimeBridge",
      "RuntimeBridgeDescriptor"
    ],
    "declarationPreserving": true
  },

  {
    "file": "packages/turn/src/__tests__/fixtures/prepared-host-runtime.mts",
    "names": ["preparedHostFixture"],
    "reason": "indirect: authored fixture loaded through a computed Vite source URL",
    "citation": "packages/conversation/src/__tests__/host-runtime-preparation.test.ts",
    "taggedNames": ["preparedHostFixture"]
  },
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
    "file": "packages/turn/src/telemetry/cost.ts",
    "names": [
      "normalizePricing",
      "zeroPricing",
      "unknownPricing",
      "pricingHasRates",
      "isPrivateHost",
      "parseReference"
    ],
    "reason": "documented extension: custom host pricing resolvers",
    "citation": "packages/turn/src/telemetry/cost.ts:189-192",
    "taggedNames": [
      "zeroPricing",
      "pricingHasRates",
      "isPrivateHost"
    ]
  },
  {
    "file": "packages/turn/src/telemetry/observer.ts",
    "names": [
      "createMetricsObserver"
    ],
    "reason": "documented extension: metrics observer",
    "citation": "packages/turn/README.md#start-here",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/shared/tool-context.ts",
    "names": [
      "createToolContext",
      "updateToolContext"
    ],
    "reason": "documented extension: host tool context",
    "citation": "packages/turn/README.md#direct-tool-calls",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/files/read.ts",
    "names": [
      "readToolImpl"
    ],
    "reason": "documented extension: direct tool calls",
    "citation": "packages/turn/README.md#direct-tool-calls",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/runtime/bridges.ts",
    "names": [
      "resolveEngineTurnAdapter",
      "listRuntimeBridges"
    ],
    "reason": "documented extension: advanced runtime imports",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/runtime/model-reference.ts",
    "names": [
      "parseRuntimeModelReference"
    ],
    "reason": "documented extension: advanced model reference parsing",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/telemetry/failure.ts",
    "names": [
      "classifyFailure",
      "FAILURE_KINDS"
    ],
    "reason": "documented extension: advanced failure classification",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/telemetry/cost.ts",
    "names": [
      "resolvePricing",
      "estimateCost"
    ],
    "reason": "documented extension: advanced pricing resolution",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/agent/compaction.ts",
    "names": [
      "resolveAgentCompactionPolicy",
      "isLikelyContextTermination"
    ],
    "reason": "documented extension: advanced compaction policy",
    "citation": "packages/turn/README.md#advanced-exports",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/engine/index.ts",
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
    "file": "packages/turn/src/engine/sessions.ts",
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
    "file": "packages/turn/src/engine/owned-fs.ts",
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
    "file": "packages/turn/src/providers/codex/app-server-client.ts",
    "names": [
      "createCodexAppServerClient"
    ],
    "reason": "consumed: runtime Codex broker; tested client subpath retained until turn entry regrouping",
    "citation": "packages/turn/src/tools/web/codex-subscription-search.ts:7",
    "taggedNames": []
  },
  {
    "file": "packages/turn/src/tools/web/codex-subscription-search.ts",
    "names": [
      "__resetCodexSubscriptionSearchForTests"
    ],
    "reason": "test isolation control for process-global Codex broker/cache",
    "citation": "packages/turn/src/tools/web/codex-subscription-search.ts",
    "taggedNames": [
      "__resetCodexSubscriptionSearchForTests"
    ]
  },
  {
    "file": "packages/turn/src/tools/web/search-providers/shared.ts",
    "names": [
      "__resetWebSearchThrottleForTests"
    ],
    "reason": "test isolation control for process-global WebSearch throttle",
    "citation": "packages/turn/src/tools/web/search-providers/shared.ts",
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
    "file": "packages/turn/src/tools/web/web-controller.ts",
    "names": [
      "__resetSharedSearchCacheForTests"
    ],
    "reason": "test isolation control for process-global shared search cache",
    "citation": "packages/turn/src/tools/web/web-controller.ts",
    "taggedNames": [
      "__resetSharedSearchCacheForTests"
    ]
  },
  {
    "file": "packages/turn/src/providers/pi/transport-errors.ts",
    "names": [
      "resetTransportErrorProbeForTests",
      "recordTransportErrorForTests"
    ],
    "reason": "test isolation control for process-global transport error probe",
    "citation": "packages/turn/src/providers/pi/transport-errors.ts",
    "taggedNames": [
      "resetTransportErrorProbeForTests",
      "recordTransportErrorForTests"
    ]
  },
  {
    "file": "packages/turn/src/runtime/session-fanout.ts",
    "names": [
      "createSessionRegistry"
    ],
    "reason": "test isolation control for process-global runtime registry fan-out",
    "citation": "packages/turn/src/runtime/session-fanout.ts",
    "taggedNames": [
      "createSessionRegistry"
    ]
  },
  {
    "file": "packages/app/src/config-reference/config-reference.ts",
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
    "file": "packages/app/src/service/managed-runtime/background-runtime.ts",
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
        ...Object.values(turnManifest.exports).flatMap((target) => sourceTarget(target.default))
          .map((path) => `${relative(resolve(root, "packages/turn"), path)}!`),
        "src/host/sandbox/srt-embed-runner.mts!",
        "src/engine/__tests__/fixtures/regenerate-projection-goldens.mts",
        "src/engine/__tests__/fixtures/projection-parity-worker.mts",
        "src/__tests__/fixtures/prepared-host-runtime.mts",
        "src/__tests__/ai/fixtures/native-journal-storage-worker.mts",
        "src/__tests__/ai/fixtures/native-lifecycle-storage-worker.mts",
        "src/__tests__/ai/fixtures/native-writer-holder.mts",
        "src/engine/__tests__/fixtures/append-worker.mts",
        "src/engine/__tests__/fixtures/checkpoint-worker.mts",
        "src/engine/__tests__/fixtures/effect-worker.mts",
        "src/engine/__tests__/fixtures/import-worker.mts",
        "src/engine/__tests__/fixtures/lock-worker.mts",
        "src/engine/__tests__/fixtures/native-create-worker.mts",
        "src/engine/__tests__/fixtures/store-owner-worker.mts",
        "src/engine/__tests__/fixtures/turn-evidence-worker.mts",
      ],
      project: ["src/**/*.{js,mjs,ts,mts}!", "!src/**/__tests__/**!"],
      ignoreDependencies: ["@vscode/ripgrep"],
    },
    "packages/conversation": {
      paths,
      entry: [
        "src/index.ts!",
        "src/tool-history/writer-worker.ts!",
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
