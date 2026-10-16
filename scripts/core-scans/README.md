# Core source scans

From the repository root, with the supported Node/pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm run scan:core
```

Or run `pnpm run scan:dead-code` and `pnpm run scan:cycles` independently.
The dead-code scan runs Knip **5.88.1** in default, production, and
`--include-entry-exports` modes. The cycle scan runs Madge **8.0.0** separately on
contracts, config, turn, conversation, and app. Tools are pinned in the launcher
and fetched with `pnpm dlx`; neither is a workspace dependency or CI guard.
No package build is needed. First use needs registry access (or a warm dlx cache).

Both commands finish all scans even when findings exist. Exit codes are **0**
(clean), **1** (findings), and **2** (tool/configuration failure). A red scan is
not proof that a declaration is safe to delete. Reports and tool diagnostics are
replaced on each run under `node_modules/.cache/core-scans/`:

- `knip-{default,production,entry-exports}.json` and matching `.stderr.txt` files;
- `madge-{contracts,config,turn,conversation,app}.json` and matching `.stderr.txt` files.

Knip prints per-package file, value-export, type-export, and other-issue counts.
Compare symbols/paths, not just totals; production-minus-default identifies
**test-only leads**, not necessarily dead implementations. An internal export
can be a necessary test seam while its implementation remains live in production.
“No dead code” means no findings in **all three** modes, apart from the exact
exceptions below. Existing findings are deliberately not grandfathered in.

## Discovery and resolution

- Knip workspace selectors report only the five core packages. Other workspace
  packages and root tooling remain consumers, so their imports count as usage;
  the launcher rejects reports containing findings outside the selected scope.
- Manifest exports/bins and Vitest test entries are discovered by Knip. Source
  projects are bounded to `src/` (plus app's proof scripts); build outputs are
  outside discovery, not exceptions. Test directories are non-production inputs,
  so production discovery excludes `src/**/__tests__/` including their helpers.
- Existing package tsconfigs map normal `dist` exports back to source. Turn's
  mixed layout has source JS exports and four compiled `dist/host` entries but
  no `tsconfig.json`. `knip.ts` maps those **four exact package specifiers** to
  their TS sources in every workspace, and registers the host entries. This
  avoids a temporary turn tsconfig and works in an unbuilt checkout. Update
  those mappings alongside any future turn artifact/export-map migration.
- Madge scans production source (`ts,js,mjs,mts`) with `__tests__` excluded.
  Type-only edges are included. It follows reachable source dependencies across
  core packages: repeated cycles with `../../` prefixes are expected. Do not
  sum package counts as unique cycles. Madge emits representative cycles, not
  every possible traversal of a strongly connected component; including tests
  can change that representative list. Keep warnings in view: unresolved edges
  are a static-analysis limitation, not proof of an acyclic graph.

## Exact exception register

Entries here are modeled as roots rather than hidden wholesale. Only the two
fixture declarations' `exports` issue type and the one string-loaded dependency
are suppressed. There are no package-wide, all-types, or public-barrel ignores.

| Exact path / dependency | Reason and treatment |
| --- | --- |
| `packages/turn/src/engine/__tests__/fixtures/regenerate-projection-goldens.mjs` | By-path proof tool; regeneration workflow in [PROJECTION-GOLDENS.md](../../packages/turn/src/engine/__tests__/fixtures/PROJECTION-GOLDENS.md). Non-production entry. |
| `packages/turn/src/host/srt-embed-runner.mjs` | Worker loaded with `new URL` in `src/host/sandbox.ts`; production entry. |
| `packages/turn/package.json`: `@vscode/ripgrep` | String-resolved dependency in `src/agent/tools/shared/ripgrep.js` via `createRequire().resolve`; exact dependency exception, not an unused package. |
| `packages/conversation/src/tool-history-writer-worker.ts` | Worker loaded with `new URL` in `src/tool-history-store.ts`; production entry. |
| `packages/conversation/src/__tests__/fixtures/canonical-v5-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; non-production entry, with only declaration exports exempted (they describe JS, not independent runtime values). |
| `packages/conversation/src/__tests__/fixtures/managed-native-switch-fixture.d.mts` | By-path fixture declaration companion to imported `.mjs`; same narrow treatment. |
| `packages/app/scripts/smoke-subagent-stop.mjs` | By-path proof program; non-production entry. Purpose and invocation in the [app smoke index](../../packages/app/scripts/README.md). |
| `packages/app/scripts/smoke-subagent-steer.mjs` | By-path proof program; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/managed-subagent-proof.mjs` | By-path proof program; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/subagent-observer-srt.mjs` | By-path proof program requiring real SRT; non-production entry; see app smoke index. |
| `packages/app/src/__tests__/fixtures/worker-maintenance-smoke.mjs` | By-path proof program; non-production entry; see app smoke index. |

Other literal `new URL` workers and by-path entry modules already understood by
Knip require no suppression. In particular app's readiness, memory-health,
OAuth-login, maintenance, and adapter-send entry modules remain analyzed.
Public exports remain reported in entry-export mode: an exception for a future
extension surface must name exact symbols and cite a **curated usage document**,
not just a generated API inventory. String-based consumers must be traced before
cutting an export; for example `scripts/verify-consumers.mjs` dynamically loads
app's `consumerContractNames` and `validateConsumerContractFixture`. Those leads
remain visible; no blanket app-entry exception is applied.

## Focused verification

```bash
pnpm exec vitest run scripts/__tests__/core-scans.test.mjs
pnpm run check:architecture
git diff --check
```

Hosted exact-head CI supplies the broad gate; these commands do not run it.
Registering a proof program does not execute it or claim it passes.

## Retained conversation/app production-mode leads

These are exact, reviewed **visible findings**, not suppressions. Production
mode omits tests, so it cannot see imports of live private implementation seams,
limits and declaration shapes by their focused tests. Keep those internal module
exports, not duplicate package-root exports. The two built-module script loaders
are called out separately below. Default and entry-export modes are clean for
conversation/app; a red production scan containing only these names is accounted
for, not a claim that the scan exited zero. Remove a row when its test/loader
evidence or live implementation disappears. Declaration shapes needed by emitted
public signatures remain even when they have no separate root name.

| Owning module | Exact retained names (values and types) | Reason / witness |
| --- | --- | --- |
| `packages/app/src/app-config.ts` | `isPathUnderTmpdir` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/app-config.test.ts:8`. |
| `packages/app/src/configured-agent.ts` | `buildSubagentsOptions`, `createSubagentsRuntimeExtension`, `lazyConfiguredToolHistory`, `ConfiguredAgentRuntimeOptions` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background-subagents.test.ts:12`, `packages/app/src/__tests__/subagent-durable-session.test.ts:9`, `packages/app/src/__tests__/configured-tool-history.test.ts:8`. |
| `packages/app/src/channels.ts` | `createTuiChannelDriver`, `slackTargetFromConversation`, `telegramChatIdFromConversation` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/app-controller-channels.test.ts:11`, `packages/app/src/__tests__/destination-parse.test.ts:5`. |
| `packages/app/src/cli-commands.ts` | `shouldLoadCommandDotenv` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-args.test.ts:21`. |
| `packages/app/src/adapter-send-tools.ts` | `ADAPTER_SEND_TOOLS_MCP_SERVER_NAME`, `adapterSendToolsMcpEnv`, `adapterSendToolsMcpServerSpec`, `SlackSendToolSettings`, `TelegramSendToolSettings`, `AskUserToolSettings`, `AdapterSendToolsSettings` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/adapter-send-tools.test.ts:35`. |
| `packages/app/src/agent-root-coordinator.ts` | `AGENT_ROOT_OWNED_ELSEWHERE_ERROR`, `AGENT_ROOT_REQUIRED_ERROR`, `AGENT_ROOT_WORKSPACE_REQUIRED_ERROR`, `PROCESS_JOBS_GENERATION_CHANGED_ERROR`, `PROCESS_JOBS_GENERATION_DRAIN_TIMEOUT_ERROR`, `agentRootLeasePath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/agent-root-coordinator.test.ts:25`, `packages/app/src/__tests__/configured-runtime-protection.test.ts:44`. |
| `packages/app/src/config-reference.ts` | `MONO_AGENT_CONFIG_SCHEMA_URL`, `allConfigReferenceFields`, `buildMonoAgentConfigSchema`, `buildGeneratedConfigReferenceMarkdown`, `findUnknownAppConfigPaths`, `schemaForField`, `ConfigReferenceType` | Config/schema implementation and tests; `scripts/generate-config-reference.mjs` loads built generation exports: `packages/app/src/__tests__/config-reference.test.ts:17`. |
| `packages/app/src/channel-drivers/tui.ts` | `MAX_DISCOVERED_INFO_MODEL_BYTES` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/tui-channel.test.ts:16`. |
| `packages/app/src/process-jobs-protection.ts` | `PROCESS_JOBS_UNSAFE_HOST_WARNING`, `processJobsProtectionStatus` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-protection.test.ts:8`. |
| `packages/app/src/continuation-config.ts` | `DEFAULT_CONTINUATION_SERVICE_PORT` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/continuation-config.test.ts:8`. |
| `packages/app/src/artifact-retention.ts` | `DEFAULT_ARTIFACT_RETENTION_SWEEP_INTERVAL_MS`, `runArtifactRetentionPass` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/artifact-retention.test.ts:9`. |
| `packages/app/src/process-jobs-config.ts` | `PROCESS_JOBS_DEFAULTS` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-config.test.ts:15`. |
| `packages/app/src/process-jobs-root-registry.ts` | `PROCESS_JOBS_ROOT_REGISTRY_DIRECTORY`, `PROCESS_JOBS_ROOT_REGISTRY_FILE`, `PROCESS_JOBS_ROOT_REGISTRY_RECOVERY_DIRECTORY`, `PROCESS_JOBS_ROOT_REGISTRY_PREVIOUS_FILE`, `PROCESS_JOBS_ROOT_REGISTRY_FAILED_FILE`, `PROCESS_JOBS_ROOT_REGISTRY_MAX_RECOVERY_ENTRIES`, `PROCESS_JOBS_ROOT_REGISTRY_MAX_ROOTS`, `PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENTS`, `PROCESS_JOBS_ROOT_REGISTRY_MAX_SEGMENT_BYTES`, `PROCESS_JOBS_ROOT_REGISTRY_MAX_BYTES`, `PROCESS_JOBS_REGISTRY_UNAVAILABLE_ERROR`, `processJobsRootRegistryPaths` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-root-registry.test.ts:45`. |
| `packages/app/src/process-jobs-store.ts` | `PROCESS_JOB_MANIFEST_FILE`, `PROCESS_JOB_TRANSACTION_FILE`, `PROCESS_JOB_ORPHAN_RECONCILIATION_INTERVAL`, `PROCESS_JOB_STORE_MAX_RECORD_ENTRIES`, `ProcessJobStoreWorkCounter` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-service.test.ts:27`, `packages/app/src/__tests__/background-subagents.test.ts:23`. |
| `packages/app/src/app-controller-process-jobs.ts` | `publishProcessJobsHealth`, `ProcessJobsControllerPort` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-runtime.test.ts:26`, `packages/app/src/__tests__/app-controller-process-jobs.test.ts:15`. |
| `packages/app/src/suggest-replies.ts` | `SUGGEST_REPLIES_SERVER_NAME`, `SUGGEST_REPLIES_TOOL_NAME` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/suggest-replies.test.ts:5`. |
| `packages/app/src/provider-usage-tool.ts` | `PROVIDER_USAGE_INPUT`, `isProviderUsageToolAllowed` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/provider-usage-integration.test.ts:15`. |
| `packages/app/src/console-projects.ts` | `CONSOLE_PROJECT_SCHEMAS`, `isConsoleProjectToolAllowed` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/console-projects.test.ts:7`. |
| `packages/app/src/background-snapshot.ts` | `fingerprintBackgroundRegularFile`, `sameBackgroundRegularFileVersion` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background-snapshot.test.ts:25`. |
| `packages/app/src/conversation-title.ts` | `SET_CONVERSATION_TITLE_MCP_SERVER_NAME`, `SET_CONVERSATION_TITLE_TOOL_NAME` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/conversation-title.test.ts:9`. |
| `packages/app/src/restart-proposal.ts` | `PROPOSE_RESTART_SERVER_NAME`, `PROPOSE_RESTART_TOOL_NAME` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/restart-proposal.test.ts:5`. |
| `packages/app/src/project-skills.ts` | `PROJECT_SKILL_VERSION`, `PROJECT_SKILL_MANIFEST_PATH` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/project-skills.test.ts:14`. |
| `packages/app/src/run-history.ts` | `RUN_HISTORY_MCP_SERVER_NAME`, `RUN_HISTORY_TOOL_NAME`, `createRunHistoryServer` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/run-history.test.ts:19`, `packages/app/src/__tests__/memory-journal.test.ts:26`. |
| `packages/app/src/session-history.ts` | `SESSION_HISTORY_MCP_SERVER_NAME`, `SESSION_HISTORY_TOOL_NAME`, `createSessionHistoryServer` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/session-history.test.ts:23`, `packages/app/src/__tests__/memory-journal.test.ts:27`. |
| `packages/app/src/reply-artifacts.ts` | `REPLY_ARTIFACT_MCP_SERVER_NAME`, `PUBLISH_REPLY_FILE_TOOL_NAME`, `ReplyArtifactService` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/reply-artifacts.test.ts:31`. |
| `packages/app/src/runtime-routes.ts` | `hasConfiguredRuntimeFallbacks` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/runtime-routes.test.ts:7`. |
| `packages/app/src/app-controller-responder.ts` | `sessionRolloverForChannel`, `ResponderControllerPort` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/console-session-rollover.test.ts:10`, `packages/app/src/__tests__/app-controller-responder.test.ts:17`. |
| `packages/app/src/provider-usage.ts` | `PROVIDER_USAGE_CACHE_MS` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/provider-usage.test.ts:5`. |
| `packages/app/src/background-runtime.ts` | `defaultManagedBackgroundRuntimeDeps`, `attestManagedBackgroundRuntime`, `deduplicateSourceReuseProofLinks`, `ManagedRuntimeInstallInput`, `ManagedBackgroundRuntimeDeps` | Runtime implementation and tests; `scripts/managed-runtime-attestation-probe.mjs` dynamically calls `attestManagedBackgroundRuntime`: `packages/app/src/__tests__/background-runtime.test.ts:11`. |
| `packages/app/src/app-controller.ts` | `MonoAgentAppController` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/app-startup-cleanup.test.ts:66`. |
| `packages/app/src/approved-background-snapshot.ts` | `approvedBackgroundSnapshotPath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/approved-background-snapshot.test.ts:6`. |
| `packages/app/src/background-environment.ts` | `BACKGROUND_OPERATIONAL_ENV_NAMES` | Live implementation/limits or declaration shapes; internal test imports. |
| `packages/app/src/launchd.ts` | `LAUNCHD_MAINTENANCE_DISPERSION_SECONDS`, `escapeXml`, `buildLaunchdProgramArguments`, `buildLaunchdMaintenanceProgramArguments`, `buildWebMaintenanceProgramArguments`, `buildWebLaunchdProgramArguments`, `domainTarget`, `serviceTarget`, `parseLaunchdWebMaintenanceDefinition`, `parseLaunchdManagedWorkerDefinition`, `parseLaunchdServicePid`, `PlistInput`, `MaintenancePlistInput`, `WebMaintenancePlistInput`, `WebPlistInput` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/launchd.test.ts:7`. |
| `packages/app/src/launchd-maintenance-activity.ts` | `MAINTENANCE_MAX_DEFERRAL_MS`, `writeLaunchdMaintenanceActivityStatus`, `MaintenanceEpisode`, `MaintenanceDecisionRecord`, `LaunchdMaintenanceActivityStatus` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/launchd-maintenance-activity.test.ts:4`. |
| `packages/app/src/launchd-logs.ts` | `LAUNCHD_LOG_ROTATION_COUNT`, `defaultLaunchdLogDependencies`, `LaunchdLogPolicy`, `LaunchdLogFileState`, `LaunchdLogRotationResult`, `LaunchdLogDependencies` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/launchd-logs.test.ts:25`. |
| `packages/app/src/background.ts` | `managedLaunchdLogMaintenanceEnvironment`, `unattendedLogDeps`, `pollInstanceReady`, `printInstanceInfo`, `describeChannel`, `BackgroundCliArgs`, `ResolveInstanceTargetInput`, `ReadyPollOptions`, `LaunchdControllerOptions`, `StatusBackgroundOptions`, `LogOptions` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background.test.ts:18`, `packages/app/src/__tests__/channel-fact-format.test.ts:3`. |
| `packages/app/src/ui.ts` | `computeColorEnabled` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/ui.test.ts:3`. |
| `packages/app/src/background-log-maintenance.ts` | `createManagedLaunchdLogWakeState`, `requestLaunchdLogMaintenanceIfNeeded` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/managed-launchd-log-monitor.test.ts:4`. |
| `packages/app/src/background-snapshot-key.ts` | `backgroundSnapshotKeyPath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background-snapshot-key.test.ts:10`. |
| `packages/app/src/background-worker-lease.ts` | `backgroundWorkerLeasePath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background-worker-lease.test.ts:21`. |
| `packages/app/src/managed-runtime-publication.ts` | `managedRuntimePublicationBarrierPath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/managed-runtime-publication.test.ts:9`. |
| `packages/app/src/launchd-lifecycle-lock.ts` | `sharedLaunchdLogLockTarget` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/background.test.ts:19`. |
| `packages/app/src/channel-plugins.ts` | `ChannelPluginConfigError` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/channel-plugins.test.ts:10`. |
| `packages/app/src/provider-model-catalog.ts` | `MAX_PAGE_SIZE`, `MAX_CATALOG_ID_BYTES`, `DEFAULT_MAX_ADVERTISED_PER_PROVIDER` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/tui-channel.test.ts:17`. |
| `packages/app/src/cli-args.ts` | `PUBLIC_COMMANDS`, `JSON_CAPABLE_COMMANDS` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-help-parity.test.ts:3`, `packages/app/src/__tests__/cli-args.test.ts:16`. |
| `packages/app/src/supervised-restart-latch.ts` | `AGENT_RESTART_EXIT_FALLBACK_MS` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/supervised-restart-latch.test.ts:3`. |
| `packages/app/src/doctor.ts` | `launchdLogsSectionFromInspection` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/doctor.test.ts:13`. |
| `packages/app/src/cli-help.ts` | `HELP_COMMANDS`, `HELP_ALIASES` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-help-parity.test.ts:4`. |
| `packages/app/src/cli-validate-config-command.ts` | `renderPresetList`, `renderPresetShow`, `presetShowData`, `renderConfigView` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-presets.test.ts:9`, `packages/app/src/__tests__/cli-config.test.ts:7`. |
| `packages/app/src/cli-init-command.ts` | `shouldRunInitWizard`, `runProviderSetupBeforeInit`, `readApiKeyFromStdin`, `resolvePiAuthPathForLogin`, `initChangeDisplayRows`, `identityRoleDisplayLine`, `secretChecklistDisplayRows`, `BROWSER_CONSOLE_HOST`, `BROWSER_CONSOLE_PORT` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-presets.test.ts:10`, `packages/app/src/__tests__/cli-auth.test.ts:29`, `packages/app/src/__tests__/cli-init-output.test.ts:7`. |
| `packages/app/src/memory-command.ts` | `classifyMemoryBundleExportFailure`, `classifyImportPrepareFailure`, `classifyImportApplyFailure`, `isFtsFallbackEligible`, `curateRecoveredFailureReason` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-command.test.ts:10`, `packages/app/src/__tests__/cli-memory.test.ts:25`. |
| `packages/app/src/web-command.ts` | `WEB_LAUNCHD_LABEL`, `DEFAULT_WEB_HOST`, `DEFAULT_WEB_PORT`, `LEGACY_DEFAULT_WEB_HOST`, `webPaths`, `ensureTailscaleServe`, `tailscaleProxyTarget`, `removeOwnedTailscaleServe`, `chooseTailscaleHttpsPort`, `CommandResult`, `CommandRunner`, `RunWebCommandDeps`, `WebPaths` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/web-command.test.ts:20`. |
| `packages/app/src/jobs-command.ts` | `operatorEndpointOf` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/jobs-command.test.ts:10`. |
| `packages/app/src/readiness-probe.ts` | `readinessProbeEnvironment` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/readiness-probe.test.ts:10`. |
| `packages/app/src/init.ts` | `SecretEnvConcurrentModificationError`, `mergeSecretEnvFile`, `resolveSafeSecretEnvTarget`, `secretEnvLockPathForCanonical` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/secret-env.test.ts:22`, `packages/app/src/__tests__/init.test.ts:9`. |
| `packages/app/src/provider-setup.ts` | `resolvePiCliPath` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/wizard-prompts.test.ts:15`. |
| `packages/app/src/sandbox-manager.ts` | `MANAGED_SRT_PACKAGE`, `MANAGED_SRT_LOCK_SHA256`, `MANAGED_SRT_MARKER`, `managedSrtInstallRoot`, `ManagedSrtHooks`, `SandboxManagerOptions` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/sandbox-manager.test.ts:37`. |
| `packages/app/src/wizard/answers.ts` | `moduleOverrides` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/wizard-compose.test.ts:17`. |
| `packages/app/src/wizard/run.ts` | `guidedModelRefProblem` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/wizard-run.test.ts:186`. |
| `packages/app/src/computer-use.ts` | `resolveCuaDriverCommand` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/computer-use.test.ts:10`. |
| `packages/app/src/subagent-instances.ts` | `SUBAGENT_REGISTRY_MAX_BYTES`, `SUBAGENT_TERMINAL_MAX_COUNT`, `subagentConversationRoot`, `subagentInstanceSessionId` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/subagent-instances.test.ts:7`. |
| `packages/app/src/memory-journal.ts` | `MEMORY_JOURNAL_MCP_SERVER_NAME`, `MEMORY_JOURNAL_TOOL_NAME`, `MEMORY_JOURNAL_MAX_RANGE_DAYS`, `MEMORY_JOURNAL_DEFAULT_PAGE_SIZE`, `MEMORY_JOURNAL_MAX_PAGE_SIZE`, `MEMORY_JOURNAL_MAX_SNAPSHOTS`, `MEMORY_JOURNAL_ENTRY_TEXT_MAX_BYTES`, `MEMORY_JOURNAL_PAGE_MAX_BYTES`, `createMemoryJournalServerWithState`, `resolveMemoryJournalRange`, `createMemoryJournalRequestState`, `MemoryJournalCapableStore`, `MemoryJournalRuntimeExtensionOptions`, `MemoryJournalBinding`, `MemoryJournalErrorCode`, `ResolvedMemoryJournalRange` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-journal.test.ts:19`. |
| `packages/app/src/peer-agent.ts` | `withoutLocalPaths` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/peer-agent.test.ts:36`. |
| `packages/app/src/memory-remember.ts` | `MEMORY_REMEMBER_MCP_SERVER_NAME`, `REMEMBER_TOOL_NAME`, `createMemoryRememberServer`, `RememberCapableStore` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-remember.test.ts:18`. |
| `packages/app/src/skill-registry.ts` | `MAX_SKILL_REGISTRY_ITEMS`, `MAX_SKILL_DESCRIPTION_BYTES`, `buildSkillRegistry` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/skill-registry.test.ts:10`. |
| `packages/app/src/cron-control-store.ts` | `resolveCronControlPaths`, `CronControlInitializationCheckpoint`, `OpenCronControlStoreOptions` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cron-control-store.test.ts:27`. |
| `packages/app/src/cron-preflight.ts` | `MAX_CRON_PREFLIGHT_STDOUT_BYTES`, `MAX_CRON_PREFLIGHT_STDERR_LOG_BYTES`, `CRON_PREFLIGHT_KILL_GRACE_MS`, `CronPreflightChild`, `CronPreflightSpawnOptions`, `CronPreflightSpawn` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cron-preflight.test.ts:9`. |
| `packages/app/src/subagent-execution-ownership.ts` | `isSubagentOwnedCommand` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/subagent-execution-ownership.test.ts:4`. |
| `packages/app/src/memory-guidance.ts` | `ageAt` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-guidance.test.ts:5`. |
| `packages/app/src/process-job-subagent-progress.ts` | `redactSubagentArgumentPreview` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-job-subagent-progress.test.ts:3`. |
| `packages/app/src/subagent-command-receipts.ts` | `SUBAGENT_COMMAND_RECEIPTS_MAX_BYTES` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/subagent-command-receipts.test.ts:4`. |
| `packages/app/src/systemd.ts` | `systemdUnitPath`, `renderSystemdUnit` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/systemd.test.ts:8`. |
| `packages/app/src/modules/catalog.ts` | `CAPABILITY_MODULES` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/modules-catalog.test.ts:6`. |
| `packages/app/src/wizard/model-discovery.ts` | `rankWizardModelCandidates` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/wizard-prompts.test.ts:12`. |
| `packages/conversation/src/harness.ts` | `requestOverridesModel`, `runSourceFromRequest`, `MonoAgentHarness` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/harness-run-config.test.ts:13`, `packages/conversation/src/__tests__/configured-model-switch.test.ts:10`. |
| `packages/conversation/src/durable-history.ts` | `DurableConversationHistoryStore`, `DurableHistoryStoreOptions`, `DurableHistoryStoreStats` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/durable-history.test.ts:72`, `packages/conversation/src/__tests__/durable-history-v5.test.ts:8`. |
| `packages/conversation/src/tool-history-store.ts` | `TOOL_HISTORY_PERSISTENCE_CEILING_MS`, `assertToolHistoryWorkerBuildFresh` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/tool-history-store.test.ts:22`. |
| `packages/conversation/src/responder.ts` | `assistantTextFromRuntimeEvent`, `streamEventFromRuntimeEvent`, `bucketConversationId` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/responder.test.ts:12`. |
| `packages/conversation/src/skills/skills.ts` | `SkillActivationError` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/skills/__tests__/skills.test.ts:7`. |
| `packages/conversation/src/tool-history-busy-wait.ts` | `TOOL_HISTORY_BUSY_RETRY_DELAYS_MS`, `ToolHistoryBusyWaitClock` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/tool-history-busy-wait.test.ts:12`. |
| `packages/conversation/src/durable-turn-contract.ts` | `createPendingTurnInput` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/durable-turn-contract.test.ts:5`. |
| `packages/conversation/src/durable-turn-payloads.ts` | `pendingCoordinates`, `PendingPayloadPhase`, `PendingPayloadOwner` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/durable-turn-payloads.test.ts:8`. |
| `packages/conversation/src/harness/turn-continuity.ts` | `TURN_CONTINUITY_MAX_BYTES`, `TURN_CONTINUITY_ASSISTANT_MAX_BYTES` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/cancelled-turn-continuity.test.ts:16`. |
| `packages/conversation/src/semaphore.ts` | `SemaphoreAcquireAbortedError` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/semaphore.test.ts:3`. |
| `packages/conversation/src/harness/memory-persistence.ts` | `composeUserMemoryText` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/harness.test.ts:8`. |
| `packages/conversation/src/harness/model-switch-preparation.ts` | `explicitSwitchMessageDigest` | Live implementation/limits or declaration shapes; internal test imports: `packages/conversation/src/__tests__/model-switch-preparation.test.ts:14`. |
| `packages/app/src/app.ts` | `TraceabilityStatus` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-status.test.ts:6`. |
| `packages/app/src/consumer-contract.ts` | `ConsumerContractName` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/consumer-contract.test.ts:19`. |
| `packages/app/src/process-jobs-service.ts` | `ProcessJobWakeInput`, `OpenProcessJobsServiceOptions` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/process-jobs-service.test.ts:17`, `packages/app/src/__tests__/app-controller-process-jobs.test.ts:28`. |
| `packages/app/src/app-controller-channels.ts` | `ChannelsControllerPort` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/app-controller-channels.test.ts:10`. |
| `packages/app/src/memory-rituals.ts` | `MemoryRitualSchedule`, `StartMemoryRitualsInput` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-rituals.test.ts:4`. |
| `packages/app/src/memory-retrieval.ts` | `SharedRecallStore` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-retrieval.test.ts:15`. |
| `packages/app/src/app-controller-memory.ts` | `MemoryControllerPort` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/memory-context.test.ts:10`. |
| `packages/app/src/runtime-option-extensions.ts` | `RuntimeOptionsCompositionOptions` | Live implementation/limits or declaration shapes; internal test imports. |
| `packages/app/src/cli-sandbox-command.ts` | `SandboxCommandDependencies` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/cli-sandbox.test.ts:3`. |
| `packages/app/src/docs-mcp-pairing.ts` | `DocsMcpEntry`, `DocsMcpHarnessAdapter`, `DocsMcpPairingDependencies` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/docs-mcp-pairing.test.ts:11`. |
| `packages/app/src/peer-acp-client.ts` | `PeerAcpTurn` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/peer-acp-client.test.ts:139`. |
| `packages/app/src/subagent-ownership-recovery.ts` | `SubagentOwnershipRecoveryCapabilities` | Live implementation/limits or declaration shapes; internal test imports: `packages/app/src/__tests__/subagent-ownership-recovery.test.ts:3`. |
| `packages/conversation/src/types.ts` | `AgentSessionMode` | Live implementation/limits or declaration shapes; internal test imports. |

Public extension names are the curated maps and generated entry inventories in
[conversation](../../packages/conversation/README.md#public-api) and
[app](../../packages/app/README.md#public-api). In particular app retains the four
properties read through the dynamic import in `scripts/verify-consumers.mjs`:
`resolveAppArtifactDir`, `resolveAppTraceStaleAfterMs`, `consumerContractNames`,
and `validateConsumerContractFixture`. Neither root is ignored wholesale.
