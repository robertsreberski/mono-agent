import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentMessageStream, ProcessJobOperator } from "@mono-agent/agent-contracts";
import { resolveConfiguredProviders } from "@mono-agent/config";

import type {
  TuiAdapterConfig,
  TuiAdapterInfo,
  TuiAdapterOptions,
  TuiAdapterStartResult,
  TuiModelCatalogProvider,
} from "@mono-agent/operator-adapter";
import {
  discoverLocalProviderModels,
  modelReferenceKey,
} from "@mono-agent/runtime-adapter";
import type {
  DiscoveredLocalModel,
  LocalProviderDefinition,
} from "@mono-agent/runtime-adapter";
import {
  ACP_BRIDGE_SOURCE_SCHEMA,
  ACP_BRIDGE_VERSION,
  ACP_PROTOCOL_VERSION,
  deliverWebNotification,
} from "@mono-agent/web";

import { buildChannelConfigView } from "../channel-config-view.js";
import type { ChannelDriver, ChannelStartInput, RunningChannel } from "../channels.js";
import { agentAppPackageVersion } from "../package-version.js";
import { buildProviderModelCatalog } from "../provider-model-catalog.js";
import { configuredRuntimeModels } from "../runtime-routes.js";
import { createSkillRegistryMonitor } from "../skill-registry.js";
import type { CronOperatorRegistry } from "../cron-operator-service.js";

type TuiAdapterModule = typeof import("@mono-agent/operator-adapter");

let tuiModule: TuiAdapterModule | undefined;
const loadTuiModule = async (): Promise<TuiAdapterModule> =>
  (tuiModule ??= await import("@mono-agent/operator-adapter"));

export interface TuiChannelOverrides {
  readonly adapterFactory?: (options: TuiAdapterOptions) => Promise<TuiAdapterStartResult>;
  /** Test seam: replaces the real local-provider model discovery call. */
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
  /** Test/embedding seam for the owner-private local web ingress. */
  readonly deliverNotification?: typeof deliverWebNotification;
}

const APP_OWNED_TUI_START = Symbol("app-owned-tui-start");

interface AppOwnedTuiChannelDriver extends ChannelDriver<TuiAdapterConfig> {
  [APP_OWNED_TUI_START](
    input: ChannelStartInput<TuiAdapterConfig>,
    processJobs: ProcessJobOperator | undefined,
  ): Promise<RunningChannel>;
}

const appOwnedTuiDrivers = new WeakSet<ChannelDriver>();

/**
 * Start only a driver created by this module with app-owner capabilities. The
 * private symbol plus exact object identity prevents a plugin or arbitrary
 * driver named `tui` from opting into the owner path.
 */
export function startAppOwnedTuiChannel(
  driver: ChannelDriver,
  input: ChannelStartInput<unknown>,
  processJobs: ProcessJobOperator | undefined,
): Promise<RunningChannel> | undefined {
  if (!appOwnedTuiDrivers.has(driver)) return undefined;
  return (driver as AppOwnedTuiChannelDriver)[APP_OWNED_TUI_START](
    input as ChannelStartInput<TuiAdapterConfig>,
    processJobs,
  );
}

/**
 * The TUI stream endpoint deviates from the channels-off convention: with no
 * `tui` section it is enabled on loopback with an ephemeral port. An explicit
 * `"tui": {"enabled": false}` opts out.
 */
export function createTuiChannelDriver(
  overrides: TuiChannelOverrides = {},
  cronOperator?: CronOperatorRegistry,
): ChannelDriver<TuiAdapterConfig> {
  const driver: AppOwnedTuiChannelDriver = {
    id: "tui",
    label: "TUI",
    processJobs: { conversationScheme: "web" },
    async configView(input) {
      const adapter = await loadTuiModule();
      return await buildChannelConfigView(this, adapter.TUI_CONFIG_FIELDS, input, { jsonKey: "tui" });
    },
    async loadConfig(input) {
      const adapter = await loadTuiModule();
      return await adapter.loadTuiAdapterConfig({ env: input.env, jsonPath: input.configPath });
    },
    isConfigError(error) {
      return tuiModule !== undefined && error instanceof tuiModule.TuiAdapterError;
    },
    disabledReason(config) {
      return config.enabled ? undefined : "TUI stream endpoint is disabled.";
    },
    async start(input) {
      return await this[APP_OWNED_TUI_START](input, undefined);
    },
    async [APP_OWNED_TUI_START](input, processJobs) {
      const adapterModule = await loadTuiModule();
      const adapterFactory = overrides.adapterFactory ?? adapterModule.startTuiAdapter;
      const deliverNotification = overrides.deliverNotification ?? deliverWebNotification;
      const discoverModels = overrides.discoverModels ?? discoverLocalProviderModels;
      const localProviders = input.coreConfig.providers?.local;
      const skillRegistry = createSkillRegistryMonitor({
        ...(input.coreConfig.context.skillsRoot === undefined
          ? {}
          : { skillsRoot: input.coreConfig.context.skillsRoot }),
        selectedSkills: input.coreConfig.context.selectedSkills,
        ...(input.coreConfig.context.skillDisclosure === undefined
          ? {}
          : { skillDisclosure: input.coreConfig.context.skillDisclosure }),
        disallowedTools: input.coreConfig.tools.disallowedTools,
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      // Establish a complete first snapshot before the adapter starts listening.
      // Subsequent /v1/info reads are memory-only and cannot block on skill I/O.
      await skillRegistry.prime();

      const configuredRefs = [...configuredRuntimeModels(input.coreConfig.runtime)];
      const configModelKeys: string[] = [];
      for (const ref of configuredRefs) {
        const key = modelReferenceKey(ref);
        if (!configModelKeys.includes(key)) {
          configModelKeys.push(key);
        }
      }
      let discoveredModels: readonly DiscoveredLocalModel[] = [];
      try {
        discoveredModels = await discoverModels(localProviders);
      } catch {
        // Provider discovery is advisory. A failed startup snapshot must not
        // make /v1/info block or expand unknown capabilities later.
      }

      // The provider-widened catalog is precomputed once here. `/v1/info` reads
      // the frozen provider list and the configured-route shortlist from memory
      // only; the lazy `/v1/models` endpoint slices already-frozen pages.
      const catalog = buildProviderModelCatalog({
        providers: resolveConfiguredProviders(input.coreConfig).entries,
        ...(localProviders === undefined ? {} : { localProviders }),
        configuredRoutes: configuredRefs,
        discoveredModels,
      });

      // Resolve both /v1/info projections once, here. `/v1/info` is polled every
      // 5s per connected console, and a throwing or slow info provider returns
      // 500 for the WHOLE response — showing the agent offline rather than
      // degraded. Neither projection may run per request.
      const infoModelOptions = catalog.describe(configuredRefs);
      const infoProviders = catalog.listProviders();

      const modelCatalog: TuiModelCatalogProvider = (request) => {
        if (request.provider !== undefined) {
          return catalog.listModels(request.provider, {
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
            limit: request.limit,
          });
        }
        if (request.query !== undefined) {
          return {
            models: catalog.searchModels(request.query, request.limit),
            truncated: false,
          };
        }
        return { models: [], truncated: false };
      };

      const buildInfo = async (): Promise<TuiAdapterInfo> => {
        return {
          model: modelReferenceKey(input.coreConfig.runtime.model),
          ...(input.coreConfig.runtime.effort === undefined ? {} : { effort: input.coreConfig.runtime.effort }),
          models: configModelKeys,
          modelOptions: infoModelOptions,
          providers: infoProviders,
          skills: skillRegistry.snapshot(),
        };
      };

      if (input.interaction !== undefined) {
        input.interaction.registerSink("web", {
          presentAsk: async () => undefined,
          updateAsk: async () => undefined,
          postStatus: async () => undefined,
        });
      }
      const adapter = await adapterFactory({
        host: input.config.host,
        port: input.config.port,
        basePath: input.config.basePath,
        allowNonLoopback: input.config.allowNonLoopback,
        ...(input.config.apiKey === undefined ? {} : { apiKey: input.config.apiKey }),
        ...(input.config.requestToolEnvironment === undefined
          ? {}
          : { requestToolEnvironment: input.config.requestToolEnvironment }),
        responder: input.responder,
        ...(processJobs === undefined
          ? {}
          : { processJobs, processJobsBearer: processJobs.operatorToken }),
        ...(input.interaction === undefined ? {} : { interaction: input.interaction }),
        ...(cronOperator?.configured === true ? { cron: cronOperator } : {}),
        info: buildInfo,
        modelCatalog,
        onServerError: (reason) => input.onFailure(reason),
        ...(input.logger === undefined ? {} : { logger: input.logger }),
      });
      skillRegistry.start();
      const workspacePath = await canonicalPath(input.coreConfig.runtime.workspace);
      return {
        summary: {
          baseUrl: adapter.baseUrl,
          acpBridge: {
            schema: ACP_BRIDGE_SOURCE_SCHEMA,
            bridgeVersion: ACP_BRIDGE_VERSION,
            protocolVersion: ACP_PROTOCOL_VERSION,
            installedVersion: agentAppPackageVersion() ?? "unknown",
            workspacePath,
          },
        },
        stop: async () => {
          skillRegistry.stop();
          await adapter.stop();
        },
        processJobs: {
          update: async ({ conversationId, deliveryKey, processJob }) => {
            const threadId = webThreadId(conversationId);
            if (input.sourceId === undefined
              || threadId === undefined
              || processJob.origin.channel !== "web"
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the web destination.",
                retryable: false,
              };
            }
            await deliverNotification({
              sourceId: input.sourceId,
              triggerKind: "job",
              deliveryKey,
              threadId,
              processJob,
            });
            return { delivered: true, code: "delivered", channelId: "tui" };
          },
          wake: async ({ conversationId, text, deliveryKey, processJob }) => {
            if (processJob.origin.channel !== "web"
              || conversationId !== baseConversationId(processJob.origin.conversationId)) {
              return {
                delivered: false,
                code: "process_job_origin_mismatch",
                reason: "The process-job origin does not match the web destination.",
                retryable: false,
              };
            }
            const threadId = webThreadId(conversationId);
            if (input.sourceId === undefined || threadId === undefined) {
              return {
                delivered: false,
                code: "process_job_wake_failed",
                reason: "The web job destination is unavailable.",
                retryable: false,
              };
            }
            // The console re-runs the wake turn on every accepted call — its
            // dedupe covers the job card, not the wake — so only a failure that
            // provably delivered nothing may be replayed. Everything else is
            // ambiguous and stays permanent rather than risking a second
            // completion turn for the same job.
            let delivered;
            try {
              delivered = await deliverNotification({
                sourceId: input.sourceId,
                triggerKind: "job",
                deliveryKey,
                threadId,
                processJob,
                wakePrompt: text,
              });
            } catch (error) {
              if (webConsoleErrorCode(error) === "notification_ingress_unavailable") {
                return {
                  delivered: false,
                  code: "destination_channel_unavailable",
                  reason: "The web console notification ingress is unavailable.",
                  retryable: true,
                  channelId: "tui",
                };
              }
              return {
                delivered: false,
                code: "process_job_wake_failed",
                reason: error instanceof Error ? error.message : String(error),
                retryable: false,
                ambiguous: true,
                channelId: "tui",
              };
            }
            const receipt = delivered.delivery;
            if (receipt === undefined) {
              return {
                delivered: false,
                code: "process_job_wake_failed",
                reason: "The web console returned no process-job wake receipt.",
                retryable: false,
                ambiguous: true,
                channelId: "tui",
              };
            }
            return {
              ...receipt,
              ...(receipt.delivered ? { code: "delivered" } : {}),
              channelId: "tui",
              ...(receipt.delivered ? { historyRecorded: true } : {}),
            };
          },
        },
        notify: async ({ conversationId, text, verbatim, deliveryKey, processJob }) => {
          if (verbatim === true
            || deliveryKey === undefined
            || processJob === undefined
            || !conversationId.startsWith("web:")
            || conversationId === "web:new") {
            return {
              delivered: false,
              code: "background_unsupported_channel",
              reason: "The TUI driver accepts process-job wakes only for an existing web thread.",
              retryable: false,
            };
          }
          if (processJob.origin.channel !== "web"
            || conversationId !== baseConversationId(processJob.origin.conversationId)) {
            return {
              delivered: false,
              code: "process_job_origin_mismatch",
              reason: "The process-job origin does not match the web destination.",
              retryable: false,
            };
          }
          const controller = new AbortController();
          try {
            const response = await input.responder.respond({
              conversationId,
              text,
              abortSignal: controller.signal,
              metadata: { source: "web", web: { trigger: "job" } },
            }, NULL_MESSAGE_STREAM);
            const hasText = response.text !== undefined && response.text.trim().length > 0;
            const hasParts = response.parts !== undefined && response.parts.length > 0;
            if (!hasText && !hasParts) {
              return { delivered: false, code: "empty_response", reason: "The process-job wake produced no answer.", retryable: false };
            }
            const threadId = webThreadId(conversationId);
            if (input.sourceId === undefined || threadId === undefined) {
              return {
                delivered: false,
                code: "process_job_wake_failed",
                reason: "The web job card destination is unavailable.",
                retryable: false,
              };
            }
            await deliverNotification({
              sourceId: input.sourceId,
              triggerKind: "job",
              deliveryKey,
              threadId,
              processJob,
              ...(hasText ? { text: boundedProcessJobResponse(response.text!) } : {}),
              ...(response.parts === undefined ? {} : { parts: response.parts }),
            });
            return { delivered: true, code: "delivered", channelId: "tui", historyRecorded: true };
          } catch (error) {
            return {
              delivered: false,
              code: "process_job_wake_failed",
              reason: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
          }
        },
      };
    },
  };
  appOwnedTuiDrivers.add(driver);
  return driver;
}

function webThreadId(conversationId: string): string | undefined {
  const base = baseConversationId(conversationId);
  if (base === undefined || !base.startsWith("web:") || base === "web:new") return undefined;
  const threadId = base.slice("web:".length).trim();
  return threadId.length === 0 ? undefined : threadId;
}

/** Read the stable `code` off a thrown WebConsoleError without trusting its shape. */
function webConsoleErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function baseConversationId(conversationId: string): string {
  return conversationId.split("#", 1)[0] ?? conversationId;
}

function boundedProcessJobResponse(value: string): string {
  const marker = "\n… [response truncated]";
  return value.length <= 8_000
    ? value
    : `${value.slice(0, 8_000 - marker.length)}${marker}`;
}

const NULL_MESSAGE_STREAM: AgentMessageStream = {
  status: async () => undefined,
  append: async () => undefined,
  replace: async () => undefined,
  event: async () => undefined,
  finish: async () => undefined,
};

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}
