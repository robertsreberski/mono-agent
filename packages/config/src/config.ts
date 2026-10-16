import { resolve } from "node:path";

import { localProviderDefinitionFor } from "@mono-agent/turn/host/config";

import type { LocalProviderDefinition } from "@mono-agent/turn/host/types";

import { ALLOW_ALL_TOOLS } from "./enums.js";

import type { MonoAgentConfigJson } from "./json-types.js";

import type { MonoAgentConfig, SkillDisclosureMode, WebFetchRenderMode, WebSearchBackend } from "./types.js";

import { MonoAgentConfigError } from "./errors.js";

import { assertNoRetiredMonoAgentConfig } from "./retired-fields.js";

import {
  assertConfiguredProviderCoverage,
  collectContext1MDeclarations,
  DEFAULT_PI_AUTH_PATH,
  readConfiguredProviders,
  readPiNativeProviderConfig,
  resolveConfiguredProviders,
  subagentProviderRoutes,
} from "./parse/providers.js";

import {
  jsonChoice,
  jsonContainer,
  jsonInteger,
  jsonOptionalInteger,
  jsonString,
  jsonStringArray,
  requireJsonString,
} from "./parse/scalars.js";

import { parseModel, readModelSelection } from "./parse/model-reference.js";

import {
  assertUniqueFallbackRoutes,
  readEffort,
  readFallbacks,
  readMaxTurns,
  readRetryConfig,
  readRuntimeCompactionConfig,
  readSessionConfig,
} from "./parse/runtime.js";

import { normalizeCwd, readOptionalPath, readPath, readUserPath } from "./parse/paths.js";

import { readAgentName, readConcurrencyConfig, readPeerConfig } from "./parse/agent.js";

import {
  readArtifactRetentionConfig,
  readMemoryArtifactRetentionConfig,
  replyFileByteLimit,
} from "./parse/artifacts.js";

import { readSubagentsConfig } from "./parse/subagents.js";

import {
  readComputerUseConfig,
  readFileToolRoots,
  readOllamaWebSearchConfig,
  readOptionalTimeoutMs,
  readParallelWebConfig,
  readWebBrowserCommand,
  readWebProviderSelection,
  readWebSearchCodexModel,
  readWebSearchEndpoint,
  searchAutoRepair,
  selectedWebProvider,
} from "./parse/tools.js";

import { readSandboxConfig } from "./parse/sandbox.js";

import { readMemoryConfig } from "./parse/memory.js";

import { readTraceabilityConfig } from "./parse/traceability.js";

interface ResolveJsonMonoAgentConfigInput {
  /**
   * Parsed `mono-agent.config.json` content. The core loader reads nothing else:
   * no process environment variable influences the resolved config.
   */
  readonly json: MonoAgentConfigJson;
  readonly cwd: string;
}

export function resolveJsonMonoAgentConfig(input: ResolveJsonMonoAgentConfigInput): MonoAgentConfig {
  assertNoRetiredMonoAgentConfig(input.json);
  const cwd = normalizeCwd(input.cwd);
  const json = input.json;
  const runtimeJson = jsonContainer(json.runtime);
  const contextJson = jsonContainer(json.context);
  const toolsJson = jsonContainer(json.tools);
  const webJson = jsonContainer(toolsJson?.web);
  const agentName = readAgentName(jsonString(jsonContainer(json.agent)?.name, "agent.name"));
  const model = parseModel(readModelSelection(runtimeJson?.model, "runtime.model"), "runtime.model");
  const fallbacks = readFallbacks(runtimeJson?.fallbacks);
  const retry = readRetryConfig(runtimeJson);
  assertUniqueFallbackRoutes(model, fallbacks);
  const maxTurns = readMaxTurns(runtimeJson?.maxTurns);
  const compaction = readRuntimeCompactionConfig(runtimeJson?.compaction);
  const workspace = readPath(jsonString(runtimeJson?.workspace, "runtime.workspace"), cwd, cwd);
  const session = readSessionConfig(runtimeJson?.session, cwd);
  const identityPath = readPath(requireJsonString(contextJson?.identityPath, "context.identityPath"), cwd);
  const soulPath = readOptionalPath(jsonString(contextJson?.soulPath, "context.soulPath"), cwd);
  const skillsRoot = readOptionalPath(jsonString(contextJson?.skillsRoot, "context.skillsRoot"), cwd);
  const selectedSkills = jsonStringArray(contextJson?.selectedSkills, "context.selectedSkills");
  // The skills loader rejects caps below 256 bytes; validate at the same floor.
  const skillMaxBytes = jsonOptionalInteger(contextJson?.skillMaxBytes, "context.skillMaxBytes", { min: 256, max: 1_000_000 });
  // Unset stays undefined so the harness default ("full" legacy) is preserved
  // byte-for-byte; only validate the choice when an operator opts in explicitly.
  const skillDisclosure = contextJson?.skillDisclosure === undefined
    ? undefined
    : jsonChoice<SkillDisclosureMode>(contextJson.skillDisclosure, "context.skillDisclosure", ["index", "full"], "full");
  const memory = readMemoryConfig(json.memory, cwd);
  const conversationSearchJson = toolsJson?.conversationSearch;
  if (conversationSearchJson !== undefined && (typeof conversationSearchJson !== "object" || conversationSearchJson === null
    || Array.isArray(conversationSearchJson) || Object.keys(conversationSearchJson).some((key) => key !== "datedSnippets"))) {
    throw new MonoAgentConfigError("invalid_json", "conversation_search_invalid_config");
  }
  const rawDatedSnippets = (conversationSearchJson as Record<string, unknown> | undefined)?.datedSnippets;
  if (rawDatedSnippets !== undefined && typeof rawDatedSnippets !== "boolean") {
    throw new MonoAgentConfigError("invalid_json", "conversation_search_invalid_config");
  }
  const datedSnippets = rawDatedSnippets === true;
  if (datedSnippets && (memory?.mode !== "bujo" || memory.backend !== "bujo")) {
    throw new MonoAgentConfigError("invalid_json", "conversation_search_requires_bujo");
  }
  const computerUse = readComputerUseConfig(toolsJson?.computerUse, cwd);
  const mcpConfigPath = readOptionalPath(jsonString(toolsJson?.mcpConfigPath, "tools.mcpConfigPath"), cwd);
  const mcpRequestContextServers = jsonStringArray(toolsJson?.mcpRequestContextServers, "tools.mcpRequestContextServers");
  const continuationServers = jsonStringArray(toolsJson?.continuationServers, "tools.continuationServers");
  const sandbox = readSandboxConfig(json.sandbox, workspace);
  const artifactsJson = jsonContainer(json.artifacts);
  const artifactDir = readPath(jsonString(artifactsJson?.dir, "artifacts.dir"), cwd, resolve(cwd, ".mono-agent", "artifacts"));
  const replyFilesJson = jsonContainer(artifactsJson?.replyFiles);
  const maxStorageValue = replyFilesJson?.maxStorageBytes;
  const maxStorageBytes = maxStorageValue === "unlimited" ? "unlimited" :
    replyFileByteLimit(maxStorageValue, "artifacts.replyFiles.maxStorageBytes", 2 * 1024 * 1024 * 1024, Number.MAX_SAFE_INTEGER);
  const maxFileBytes = replyFileByteLimit(replyFilesJson?.maxFileBytes, "artifacts.replyFiles.maxFileBytes", 20 * 1024 * 1024, 20 * 1024 * 1024);
  const artifactRetention = readArtifactRetentionConfig(artifactsJson?.retention);
  const memoryArtifactRetention = readMemoryArtifactRetentionConfig(artifactsJson?.memoryRetention, artifactRetention);
  const traceability = readTraceabilityConfig(json.traceability, cwd, agentName);
  // Pi's auth path is routinely documented with a home-relative `~` prefix.
  // `path.resolve()` treats that prefix as a literal directory, so keep the
  // expansion explicit and limited to this user-owned credential path.
  const providerEnvelope = readConfiguredProviders(json.providers);
  const piAuthPath = readUserPath(providerEnvelope.piAuthPath, cwd, DEFAULT_PI_AUTH_PATH);
  const piNative = readPiNativeProviderConfig(providerEnvelope.piNative);
  const localProviders = providerEnvelope.entries
    .map((provider) => localProviderDefinitionFor(provider))
    .filter((provider): provider is LocalProviderDefinition => provider !== undefined);

  const effort = readEffort(jsonString(runtimeJson?.effort, "runtime.effort"));
  const concurrency = readConcurrencyConfig(json.concurrency);
  const peers = readPeerConfig(json.peers);
  const subagents = readSubagentsConfig(json.subagents, cwd);
  const subagentRoutes = subagentProviderRoutes(subagents);
  const runtime: MonoAgentConfig["runtime"] = {
    model,
    ...(fallbacks.length === 0 ? {} : { fallbacks }),
    retry,
    ...(maxTurns === undefined ? {} : { maxTurns }),
    compaction,
    workspace,
    session,
    ...(effort === undefined ? {} : { effort }),
  };

  const context: MonoAgentConfig["context"] = {
    identityPath,
    selectedSkills,
    ...(soulPath === undefined ? {} : { soulPath }),
    ...(skillsRoot === undefined ? {} : { skillsRoot }),
    ...(skillMaxBytes === undefined ? {} : { skillMaxBytes }),
    ...(skillDisclosure === undefined ? {} : { skillDisclosure }),
  };

  const mcpCallTimeoutMs = readOptionalTimeoutMs(jsonString(toolsJson?.mcpCallTimeoutMs, "tools.mcpCallTimeoutMs"), "tools.mcpCallTimeoutMs");
  const mcpCallMaxTotalTimeoutMs = readOptionalTimeoutMs(
    jsonString(toolsJson?.mcpCallMaxTotalTimeoutMs, "tools.mcpCallMaxTotalTimeoutMs"),
    "tools.mcpCallMaxTotalTimeoutMs",
  );
  const searchJson = jsonContainer(webJson?.search);
  const fetchJson = jsonContainer(webJson?.fetch);
  const webSearchBackend = readWebProviderSelection<WebSearchBackend>(
    searchJson?.backend, "tools.web.search.backend",
    ["searxng", "ollama", "codex", "keyless", "duckduckgo", "startpage", "parallel", "local"],
    ["parallel", "ollama"], searchAutoRepair(searchJson),
    { hound: "`tools.web.search.backend` value `hound` was renamed to `local`; use `local` instead." },
  );
  const legacyWebSearchEndpoint = readWebSearchEndpoint(
    jsonString(searchJson?.endpoint, "tools.web.search.endpoint"),
    "tools.web.search.endpoint",
  );
  const canonicalWebSearchEndpoint = readWebSearchEndpoint(
    jsonString(jsonContainer(searchJson?.searxng)?.endpoint, "tools.web.search.searxng.endpoint"),
    "tools.web.search.searxng.endpoint",
  );
  if (
    legacyWebSearchEndpoint !== undefined
    && canonicalWebSearchEndpoint !== undefined
    && legacyWebSearchEndpoint !== canonicalWebSearchEndpoint
  ) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.endpoint and tools.web.search.searxng.endpoint disagree; keep only the canonical SearXNG setting.",
      { path: "tools.web.search.searxng.endpoint" },
    );
  }
  const webSearchEndpoint = canonicalWebSearchEndpoint ?? legacyWebSearchEndpoint;
  const webSearchOllama = readOllamaWebSearchConfig(searchJson?.ollama, webSearchBackend);
  const webSearchCodexModel = readWebSearchCodexModel(jsonString(jsonContainer(searchJson?.codex)?.model, "tools.web.search.codex.model"));
  const webSearchMaxRequestsPerRun = jsonInteger(
    searchJson?.maxRequestsPerRun,
    "tools.web.search.maxRequestsPerRun",
    4,
    { min: 1, max: 20 },
  );
  if (selectedWebProvider(webSearchBackend, "searxng") && webSearchEndpoint === undefined) {
    throw new MonoAgentConfigError(
      "invalid_json",
      "tools.web.search.searxng.endpoint (or legacy tools.web.search.endpoint) is required when tools.web.search.backend selects searxng.",
      { path: "tools.web.search.searxng.endpoint" },
    );
  }
  const webSearchParallel = readParallelWebConfig(searchJson?.parallel, "tools.web.search.parallel.apiKeyEnv");
  const webFetchParallel = readParallelWebConfig(fetchJson?.parallel, "tools.web.fetch.parallel.apiKeyEnv");
  const webFetchProvider = readWebProviderSelection<"local" | "parallel">(
    fetchJson?.provider, "tools.web.fetch.provider", ["local", "parallel"], "local", undefined,
    { hound: "`tools.web.fetch.provider` value `hound` was renamed to `local`, which is not equivalent: `local` uses the standard fetch retry policy, performs no robots preflight, and honors the configured render mode instead of forcing document-only/render-never. Update the selection to `local` only if that posture is acceptable." },
  );
  const webFetchRender = jsonChoice<WebFetchRenderMode>(
    jsonContainer(webJson?.fetch)?.render,
    "tools.web.fetch.render",
    ["never", "auto"],
    "never",
  );
  if (webFetchRender === "auto" && !selectedWebProvider(webFetchProvider, "local")) {
    throw new MonoAgentConfigError("invalid_json", 'tools.web.fetch.render "auto" requires the local fetch provider.', { path: "tools.web.fetch.provider" });
  }
  const webBrowserCommand = readWebBrowserCommand(jsonString(fetchJson?.browserCommand, "tools.web.fetch.browserCommand"));
  const filesystemJson = jsonContainer(toolsJson?.filesystem);
  const fileToolReadableRoots = readFileToolRoots(
    filesystemJson?.readableRoots,
    "tools.filesystem.readableRoots",
  )
    .map((path) => readPath(path, cwd));
  const fileToolWritableRoots = readFileToolRoots(
    filesystemJson?.writableRoots,
    "tools.filesystem.writableRoots",
  )
    .map((path) => readPath(path, cwd));
  const tools: MonoAgentConfig["tools"] = {
    // Omitted `tools.allowedTools` → allow-all default; an explicit empty
    // list ([]) means chat-only.
    allowedTools:
      toolsJson?.allowedTools === undefined
        ? [ALLOW_ALL_TOOLS]
        : jsonStringArray(toolsJson.allowedTools, "tools.allowedTools"),
    disallowedTools: jsonStringArray(toolsJson?.disallowedTools, "tools.disallowedTools"),
    ...(fileToolReadableRoots.length === 0 && fileToolWritableRoots.length === 0
      ? {}
      : {
          filesystem: {
            readableRoots: fileToolReadableRoots,
            writableRoots: fileToolWritableRoots,
          },
        }),
    ...(datedSnippets ? { conversationSearch: { datedSnippets: true } } : {}),
    ...(computerUse === undefined ? {} : { computerUse }),
    ...(mcpConfigPath === undefined ? {} : { mcpConfigPath }),
    ...(mcpRequestContextServers.length === 0 ? {} : { mcpRequestContextServers }),
    ...(continuationServers.length === 0 ? {} : { continuationServers }),
    ...(mcpCallTimeoutMs === undefined ? {} : { mcpCallTimeoutMs }),
    ...(mcpCallMaxTotalTimeoutMs === undefined ? {} : { mcpCallMaxTotalTimeoutMs }),
    web: {
      coordination: jsonChoice(webJson?.coordination, "tools.web.coordination", ["process", "host"] as const, "process"),
      search: {
        backend: webSearchBackend,
        ...(webSearchParallel === undefined ? {} : { parallel: webSearchParallel }),
        maxRequestsPerRun: webSearchMaxRequestsPerRun,
        ...(webSearchEndpoint === undefined ? {} : { searxng: { endpoint: webSearchEndpoint } }),
        ...(webSearchOllama === undefined ? {} : { ollama: webSearchOllama }),
        codex: { model: webSearchCodexModel },
      },
      fetch: {
        provider: webFetchProvider,
        ...(webFetchParallel === undefined ? {} : { parallel: webFetchParallel }),
        render: webFetchRender,
        browserCommand: webBrowserCommand,
      },
    },
  };

  const providers: NonNullable<MonoAgentConfig["providers"]> = {
    piAuthPath,
    ...(providerEnvelope.entries.length === 0 ? {} : { entries: providerEnvelope.entries }),
    ...(localProviders.length === 0 ? {} : { local: localProviders }),
    ...(piNative === undefined ? {} : { piNative }),
  };
  if (session.modelSwitch?.enabled && !session.root) throw new MonoAgentConfigError(
    "invalid_json", "Model switching requires runtime.session.root.", { path: "runtime.session.root" });
  const configuredProviders = resolveConfiguredProviders({ providers });
  const context1MModels = collectContext1MDeclarations(input.json ?? {}, configuredProviders);
  assertConfiguredProviderCoverage(model, fallbacks, configuredProviders, subagentRoutes);

  const config: MonoAgentConfig = {
    ...(agentName === undefined ? {} : { agent: { name: agentName } }),
    runtime: Object.keys(context1MModels).length === 0 ? runtime : { ...runtime, context1MModels },
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(peers === undefined ? {} : { peers }),
    ...(subagents === undefined ? {} : { subagents }),
    context,
    tools,
    ...(sandbox === undefined ? {} : { sandbox }),
    artifacts: {
      dir: artifactDir,
      replyFiles: { maxStorageBytes, maxFileBytes },
      retention: artifactRetention,
      memoryRetention: memoryArtifactRetention,
    },
    traceability,
    providers,
  };

  if (memory !== undefined) {
    return { ...config, memory };
  }
  return config;
}
