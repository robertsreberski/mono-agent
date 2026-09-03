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
  TuiModelOption,
  TuiProviderInfo,
} from "@mono-agent/operator-adapter";
import {
  discoverLocalProviderModels,
  discoverLocalProviders,
  modelReferenceKey,
  parseMonoRuntimeModelReference,
} from "@mono-agent/runtime-adapter";
import type {
  DiscoveredLocalModel,
  LocalProviderDefinition,
  RuntimeModelReference,
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
  /**
   * Test seam: replaces the zero-config local-provider probe. This one MUST be
   * injectable — the real implementation reaches localhost:11434 and
   * localhost:1234, so a developer with Ollama running would otherwise get
   * different test results from one who does not.
   */
  readonly discoverProviders?: typeof discoverLocalProviders;
  /** Test/embedding seam for the owner-private local web ingress. */
  readonly deliverNotification?: typeof deliverWebNotification;
}

/**
 * Producer-side payload budgets for `/v1/info`.
 *
 * `/v1/info` shares ONE 1 MiB body cap (`MAX_INFO_BODY_BYTES`, enforced in
 * `@mono-agent/web`'s operator client) across every field it carries. A body
 * over that cap does not degrade: `info()` rejects it wholesale and the console
 * shows the agent OFFLINE, on a 5 s poll, behind a debug-level log. Every
 * contributor therefore gets an explicit slice, and they sum under the cap:
 *
 *     configured routes   128 KiB      providers    128 KiB
 *     skills              256 KiB      caps/misc     64 KiB
 *     discovered models   384 KiB   -> 960 KiB total, 64 KiB headroom
 *
 * `skills` is enforced by `MAX_SKILL_REGISTRY_BYTES` in `skill-registry.ts`;
 * `models`/`modelOptions`/`providers` are enforced here, at the only place the
 * projections are built. The caps/misc slice is not separately enforced: the
 * `schema`/`pid`/`capabilities` half of the body is a fixed shape carrying no
 * operator-authored data beyond a short cron status, so 64 KiB is headroom, not
 * a budget anything can spend. `sendBoundedInfo` in the operator adapter is the
 * last-resort fence behind all of them, so that the PRODUCER, not the consumer,
 * is what keeps an agent online.
 */
const MAX_CONFIGURED_INFO_MODEL_BYTES = 128 * 1024;
const MAX_DISCOVERED_INFO_MODEL_BYTES = 384 * 1024;
const MAX_INFO_PROVIDER_BYTES = 128 * 1024;

/**
 * JSON framing each projection costs before a single entry is admitted, charged
 * once per budget exactly as `boundSkillItems` (`skill-registry.ts`) charges
 * its prefix and suffix.
 */
const INFO_MODEL_FRAME_BYTES = Buffer.byteLength('"models":[],"modelOptions":{},', "utf8");
const INFO_PROVIDER_FRAME_BYTES = Buffer.byteLength('"providers":[],', "utf8");

interface InfoModelProjection {
  readonly keys: string[];
  readonly seen: Set<string>;
  readonly options: Record<string, TuiModelOption>;
}

/**
 * The REAL serialized cost of publishing one ref in BOTH `/v1/info` model
 * projections: its JSON string as a `models` element, and its `modelOptions`
 * entry (that same string again as a key, a colon, the materialized option),
 * plus one separating comma in each collection.
 *
 * Measured from the payload that will actually be sent, never estimated ahead
 * of it. An arithmetic estimate over the raw ref is not an upper bound here for
 * two independent, separately proven reasons:
 *  - JSON escaping is invisible to it. One C0 byte serializes to six (`\u0000`)
 *    in both projections, so a ref of control bytes costs 12x its length while
 *    a `4 x length + 512` estimate charges roughly 4x.
 *  - The option is not materialized yet. `effortLevels` comes from a local
 *    provider's `capabilities.reasoning_levels`; the catalog now bounds it, but
 *    only measurement can charge what the bound actually left behind.
 */
function infoModelEntryBytes(key: string, option: TuiModelOption | undefined): number {
  const keyBytes = Buffer.byteLength(JSON.stringify(key), "utf8");
  // `models` element + comma.
  const arrayBytes = keyBytes + 1;
  // `modelOptions` key + colon + value + comma.
  const optionBytes = option === undefined
    ? 0
    : keyBytes + 1 + Buffer.byteLength(JSON.stringify(option), "utf8") + 1;
  return arrayBytes + optionBytes;
}

/**
 * Admit refs into the `/v1/info` model projections until `budgetBytes` is
 * exhausted, measuring each candidate's materialized payload.
 *
 * `continue`, not `break`: one pathological entry must cost only itself. The
 * TUI never calls `/v1/models` — there is no call site under `packages/tui/`,
 * and `applyAgentInfo` builds the model picker from `/v1/info.models` alone —
 * so a ref withheld here is UNSELECTABLE, not merely un-paginated. Breaking
 * would delete every runnable ref sitting behind one oversized row.
 */
function admitInfoModels(
  refs: readonly RuntimeModelReference[],
  describe: (ref: RuntimeModelReference) => TuiModelOption | undefined,
  budgetBytes: number,
  into: InfoModelProjection,
): void {
  let bytes = INFO_MODEL_FRAME_BYTES;
  for (const ref of refs) {
    const key = modelReferenceKey(ref);
    if (into.seen.has(key)) continue;
    const option = describe(ref);
    const cost = infoModelEntryBytes(key, option);
    if (bytes + cost > budgetBytes) continue;
    bytes += cost;
    into.seen.add(key);
    into.keys.push(key);
    if (option !== undefined) into.options[key] = option;
  }
}

/**
 * Bound the `/v1/info` provider summary on its own measured slice. Entry ids
 * and labels are already length-bounded by the catalog
 * (`MAX_CATALOG_ID_BYTES`/`MAX_CATALOG_LABEL_BYTES`), so every entry costs
 * about the same and the only unbounded dimension left is COUNT — a config may
 * declare thousands, and the producer previously capped none of them (the
 * consumer stops parsing at 64, but only after the whole body has already blown
 * the 1 MiB cap and taken the agent offline).
 *
 * When the budget binds, the providers the agent's OWN routes use are admitted
 * first. They sit LAST in the catalog's order (declared providers, then route
 * providers, then discovered ones), so a plain prefix cut would drop exactly
 * the provider the console needs most and keep a thousand the operator merely
 * listed. Emission still follows the catalog's order, so nothing is reordered
 * relative to what an unbounded body would have sent.
 */
function boundInfoProviders(
  providers: readonly TuiProviderInfo[],
  routeProviderIds: ReadonlySet<string>,
): readonly TuiProviderInfo[] {
  const costs = providers.map(
    (provider) => Buffer.byteLength(JSON.stringify(provider), "utf8") + 1,
  );
  const total = costs.reduce((sum, cost) => sum + cost, INFO_PROVIDER_FRAME_BYTES);
  // Preserve the catalog's frozen array identity when nothing has to be cut:
  // /v1/info is polled every 5 s and hands back the very same object each time.
  if (total <= MAX_INFO_PROVIDER_BYTES) return providers;

  const admitted = new Set<number>();
  let bytes = INFO_PROVIDER_FRAME_BYTES;
  for (const routesFirst of [true, false]) {
    for (const [index, provider] of providers.entries()) {
      if (routeProviderIds.has(provider.id) !== routesFirst) continue;
      const cost = costs[index]!;
      // `continue`, not `break`: an entry that does not fit costs only itself.
      if (bytes + cost > MAX_INFO_PROVIDER_BYTES) continue;
      bytes += cost;
      admitted.add(index);
    }
  }
  return Object.freeze(providers.filter((_provider, index) => admitted.has(index)));
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
      const discoverProviders = overrides.discoverProviders ?? discoverLocalProviders;
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
      let discoveredModels: readonly DiscoveredLocalModel[] = [];
      let discoveredLocalProviders: readonly LocalProviderDefinition[] = [];
      try {
        // Two discovery paths, both advisory. `discoverModels` covers every
        // explicitly configured local provider, including custom
        // openai_compat endpoints. `discoverLocalProviders` is the zero-config
        // half: it probes localhost:11434 and localhost:1234 even when nothing
        // is declared, which is the only way `runtime.model: "ollama:..."`
        // works without a `providers` entry. Without it that route validates,
        // advertises nothing, and dies at turn time with `pi model not found`.
        const [configuredModels, probed] = await Promise.all([
          discoverModels(localProviders).catch(() => []),
          discoverProviders({ configured: resolveConfiguredProviders(input.coreConfig).entries })
            .catch(() => []),
        ]);
        discoveredLocalProviders = probed.map(({ models: _models, ...definition }) => definition);
        const byRef = new Map<string, DiscoveredLocalModel>();
        for (const model of configuredModels) byRef.set(model.ref, model);
        for (const provider of probed) {
          for (const model of provider.models) {
            const ref = `${provider.id}:${model.name}`;
            if (byRef.has(ref)) continue;
            byRef.set(ref, {
              ref,
              label: model.displayName ?? model.alias ?? model.name,
              providerId: provider.id,
            });
          }
        }
        discoveredModels = [...byRef.values()];
      } catch {
        // Provider discovery is advisory. A failed startup snapshot must not
        // make /v1/info block or expand unknown capabilities later.
      }

      // The provider-widened catalog is precomputed once here. `/v1/info` reads
      // the frozen provider list and the configured-route shortlist from memory
      // only; the lazy `/v1/models` endpoint slices already-frozen pages.
      const catalog = buildProviderModelCatalog({
        providers: resolveConfiguredProviders(input.coreConfig).entries,
        ...(localProviders === undefined && discoveredLocalProviders.length === 0
          ? {}
          : { localProviders: [...(localProviders ?? []), ...discoveredLocalProviders] }),
        configuredRoutes: configuredRefs,
        discoveredModels,
      });

      // `/v1/info.models` must keep listing live-discovered local models
      // alongside the configured routes. Narrowing it to configured routes was
      // a SUBTRACTIVE wire change at an unchanged schema: a console that only
      // reads `models` (every client predating `/v1/models`) silently lost the
      // `ollama:*` entry it used to offer, with no skew error to explain it.
      //
      // Bound this projection on its OWN payload budget, never on catalog
      // membership. The catalog's `MAX_CATALOG_ID_BYTES` is a display/paging
      // bound, not a validity bound: a 257-byte model id parses, routes and runs
      // exactly like a 20-byte one, so gating `models` on `catalog.resolve()`
      // deleted a runnable model from every schema-1 client — subtractive at a
      // schema that cannot be bumped (`TUI_WIRE_SCHEMA` is compared with `!==`).
      // What genuinely must stay bounded is the ONE 1 MiB body `/v1/info` shares
      // across every field: over it, `info()` fails wholesale and the agent shows
      // OFFLINE rather than degraded. So the only reasons a discovered ref is
      // withheld here are that it names nothing a turn could route to (it does
      // not parse), or that it no longer fits the budget.
      const discoveredRefs: RuntimeModelReference[] = [];
      for (const model of discoveredModels) {
        try {
          discoveredRefs.push(parseMonoRuntimeModelReference(model.ref));
        } catch {
          // A provider that reports an unparseable ref is skipped, not fatal.
        }
      }

      // Resolve both /v1/info projections once, here. `/v1/info` is polled every
      // 5s per connected console, and a throwing or slow info provider returns
      // 500 for the WHOLE response — showing the agent offline rather than
      // degraded. Neither projection may run per request.
      //
      // Configured routes and discovered refs draw on SEPARATE budgets: a
      // configured route is authored, a discovered one is whatever a local
      // endpoint happened to report, and neither may starve the other. Both are
      // charged their measured serialized size, and the configured half goes
      // first so an authored route keeps its place in the picker.
      const describeModelOption = (ref: RuntimeModelReference): TuiModelOption | undefined =>
        catalog.describe([ref])[modelReferenceKey(ref)];
      const projection: InfoModelProjection = { keys: [], seen: new Set(), options: {} };
      admitInfoModels(configuredRefs, describeModelOption, MAX_CONFIGURED_INFO_MODEL_BYTES, projection);
      admitInfoModels(discoveredRefs, describeModelOption, MAX_DISCOVERED_INFO_MODEL_BYTES, projection);
      const infoModelKeys: readonly string[] = Object.freeze(projection.keys);
      const infoModelOptions = Object.freeze(projection.options);
      const infoProviders = boundInfoProviders(
        catalog.listProviders(),
        new Set(configuredRefs.map((ref) => ref.provider)),
      );

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
          models: infoModelKeys,
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
