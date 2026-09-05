import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentMessageStream, MonitorOperator, ProcessJobOperator } from "@mono-agent/agent-contracts";
import { MAX_INFO_BODY_BYTES, MAX_INFO_PROVIDER_ITEMS } from "@mono-agent/agent-contracts";
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
import { createSkillRegistryMonitor, MAX_SKILL_REGISTRY_BYTES } from "../skill-registry.js";
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
 * `/v1/info` shares ONE 1 MiB body cap ({@link MAX_INFO_BODY_BYTES}) across
 * every field it carries, and `sendBoundedInfo` in the operator adapter is what
 * enforces it: it measures the exact string it is about to send, sheds whole
 * optional fields largest-first, logs the shed at error level, and falls back to
 * a fixed liveness body. That fence is TOTAL — no body leaves this process over
 * the cap whatever these numbers say — so the fence, and only the fence, is what
 * decides that something genuinely cannot ship.
 *
 * What a budget HERE is for is bounding the AGGREGATE growth of a contributor
 * whose size nobody authored, so one such contributor cannot flood the body and
 * cost an unrelated field its place at the fence:
 *
 *     discovered model refs   384 KiB  advisory: whatever a local endpoint said
 *     provider summary        128 KiB  advisory tail behind the declared vendors
 *     skills                  256 KiB  `MAX_SKILL_REGISTRY_BYTES`, skill-registry.ts
 *
 * Configured routes get NO budget here, and that is the correction to a defect
 * this file carried through three review rounds. A budget is not an opinion
 * about which content deserves to ship, and a fixed per-contributor slice
 * becomes exactly that the moment one VALID item is bigger than the slice.
 * Round 3 bounded the model projection at 128 KiB and dropped a valid
 * configured fallback; round 4 kept the rule and raised the constant to
 * 512 KiB, and a then-valid 270,000-byte OpenRouter fallback was still dropped —
 * from a body that would have been 540,778 bytes against a 1,048,576-byte cap.
 * No constant was the right one; the shape was wrong. Dropping an authored
 * route served neither purpose a budget has (the body fit, and nothing was
 * being starved), and it cost real function: the TUI never calls `/v1/models`
 * and rebuilds its picker from `info.models` alone, so a withheld route is an
 * unselectable primary or fallback in the operator's own console.
 *
 * Nor is a single reference bounded. Two rounds put a byte ceiling in the
 * reference parser so that no ONE item could be pathological, and both numbers
 * refused a model that really exists — 96 bytes a Hugging Face GGUF repo Ollama
 * serves, 160 bytes an `ollama:<model>:<tag>` reference whose two halves Ollama
 * itself validates at 80 bytes each. A grammar layer does not get to decide what
 * a provider calls a model, so the ceiling is gone and a single reference can be
 * any size again. That changes nothing here, because the rule was never about
 * item size: nothing bounds how MANY routes an operator may declare or how many
 * rows a local `/v1/models` may report either, so a per-contributor slice would
 * still be an opinion about authored content, and configured routes still get
 * none. What it does mean is that the fence below is load-bearing for a case it
 * briefly was not — one authored route larger than the whole cap — which
 * `tui-info-wire.test.ts` drives over a real socket.
 *
 * So every configured route is admitted, and a result that cannot fit is the
 * fence's call, made loudly. Advisory discovery then spends its own aggregate
 * budget on top — but never room the body no longer has
 * ({@link INFO_NON_MODEL_RESERVE_BYTES}) — so discovery can never be the reason
 * the fence fires.
 *
 * The discovery budget is exported because it is the whole contract between
 * authored routes and advisory content, and a test that keeps its own copy of a
 * constant cannot notice that constant changing.
 */
export const MAX_DISCOVERED_INFO_MODEL_BYTES = 384 * 1024;
const MAX_INFO_PROVIDER_BYTES = 128 * 1024;

/**
 * Room the model projections leave for the rest of the body when deciding how
 * much ADVISORY discovery may spend.
 *
 * Reserving against the other contributors' own budgets is sound here precisely
 * because it constrains discovery alone: no authored content is ever measured
 * against it, so a conservative reserve costs at worst a few discovered refs
 * nobody declared. Measuring the real rest-of-body instead is not available —
 * `skills` is re-snapshotted per request while these projections are resolved
 * once at start — and it is not needed, because the fence measures the real
 * thing.
 *
 * The trailing 64 KiB covers the `schema`/`pid`/`capabilities` half of the
 * body: a fixed shape carrying no operator-authored data beyond a short cron
 * status, so it is headroom rather than a budget anything can spend.
 */
const INFO_NON_MODEL_RESERVE_BYTES = MAX_INFO_PROVIDER_BYTES + MAX_SKILL_REGISTRY_BYTES + 64 * 1024;

/**
 * JSON framing each projection costs before a single entry is admitted, charged
 * once against the running total exactly as `boundSkillItems`
 * (`skill-registry.ts`) charges its prefix and suffix.
 */
const INFO_MODEL_FRAME_BYTES = Buffer.byteLength('"models":[],"modelOptions":{},', "utf8");
const INFO_PROVIDER_FRAME_BYTES = Buffer.byteLength('"providers":[],', "utf8");

interface InfoModelProjection {
  readonly keys: string[];
  readonly seen: Set<string>;
  readonly options: Record<string, TuiModelOption>;
  /**
   * Serialized bytes already committed to `models` + `modelOptions`, carried
   * ACROSS admission passes. One running total is what lets the discovery pass
   * see what the configured pass already spent: a per-pass counter cannot
   * express "advisory refs may not spend room the body no longer has", which is
   * the only thing either pass is still bounded by.
   */
  bytes: number;
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
 * Admit refs into the `/v1/info` model projections, measuring each candidate's
 * materialized payload against the running total.
 *
 * `budgetBytes` is a ceiling on that RUNNING TOTAL and it is OPTIONAL. Omitting
 * it admits every ref, which is what configured routes get: see the budget note
 * above — the fence adjudicates an oversized body, this function does not.
 *
 * `continue`, not `break`, where a ceiling does apply: one pathological entry
 * must cost only itself. The TUI never calls `/v1/models` — there is no call
 * site under `packages/tui/`, and `applyAgentInfo` builds the model picker from
 * `/v1/info.models` alone — so a ref withheld here is UNSELECTABLE, not merely
 * un-paginated. Breaking would delete every runnable ref sitting behind one
 * oversized row.
 */
function admitInfoModels(
  refs: readonly RuntimeModelReference[],
  describe: (ref: RuntimeModelReference) => TuiModelOption | undefined,
  into: InfoModelProjection,
  budgetBytes: number = Number.POSITIVE_INFINITY,
): void {
  for (const ref of refs) {
    const key = modelReferenceKey(ref);
    if (into.seen.has(key)) continue;
    const option = describe(ref);
    const cost = infoModelEntryBytes(key, option);
    if (into.bytes + cost > budgetBytes) continue;
    into.bytes += cost;
    into.seen.add(key);
    into.keys.push(key);
    if (option !== undefined) into.options[key] = option;
  }
}

/**
 * Project the `/v1/info` provider summary onto its own measured slice, with the
 * providers the agent's OWN routes use placed where every consumer can see
 * them.
 *
 * Two independent cuts land on this list, and the catalog's order is wrong for
 * both. Route providers sit LAST in it (declared providers, then route
 * providers, then discovered ones), while the byte slice and the console's
 * {@link MAX_INFO_PROVIDER_ITEMS} parse window are both PREFIX cuts. Admitting
 * routes first but emitting in catalog order — which is what this did — put the
 * prioritized entry at position 71 of 71 and let the console throw it away at
 * 64: a probe really did receive `anthropic` and parse 64 vendors without it.
 * Prioritizing at the producer only means something if it survives to the
 * consumer, so the priority has to be expressed as ORDER on the wire.
 *
 * Reordering is not subtractive — no entry is removed and no field changes — so
 * it is legal at a wire schema compared with `!==`. It is also confined to the
 * case that needs it: a catalog that fits both the slice and the window is
 * emitted exactly as the catalog built it, frozen identity included, because
 * `/v1/info` is polled every 5 s and hands back the very same object each time.
 *
 * Unlike the model projections, an aggregate slice is the right shape HERE: one
 * entry's id and label are bounded by the shared wire contract
 * (`MAX_INFO_PROVIDER_ID_BYTES`/`..._LABEL_BYTES`), so no single valid provider
 * can be larger than the slice and the cut can only ever fall on the advisory
 * tail — never on a route provider, which is admitted first.
 */
function projectInfoProviders(
  providers: readonly TuiProviderInfo[],
  routeProviderIds: ReadonlySet<string>,
): readonly TuiProviderInfo[] {
  const costs = providers.map(
    (provider) => Buffer.byteLength(JSON.stringify(provider), "utf8") + 1,
  );
  const total = costs.reduce((sum, cost) => sum + cost, INFO_PROVIDER_FRAME_BYTES);
  if (total <= MAX_INFO_PROVIDER_BYTES && providers.length <= MAX_INFO_PROVIDER_ITEMS) {
    return providers;
  }

  const admitted: TuiProviderInfo[] = [];
  let bytes = INFO_PROVIDER_FRAME_BYTES;
  for (const routesFirst of [true, false]) {
    for (const [index, provider] of providers.entries()) {
      if (routeProviderIds.has(provider.id) !== routesFirst) continue;
      const cost = costs[index]!;
      // `continue`, not `break`: an entry that does not fit costs only itself.
      if (bytes + cost > MAX_INFO_PROVIDER_BYTES) continue;
      bytes += cost;
      admitted.push(provider);
    }
  }
  return Object.freeze(admitted);
}

const APP_OWNED_TUI_START = Symbol("app-owned-tui-start");

interface AppOwnedTuiChannelDriver extends ChannelDriver<TuiAdapterConfig> {
  [APP_OWNED_TUI_START](
    input: ChannelStartInput<TuiAdapterConfig>,
    processJobs: ProcessJobOperator | undefined,
    monitors: MonitorOperator | undefined,
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
  monitors: MonitorOperator | undefined,
): Promise<RunningChannel> | undefined {
  if (!appOwnedTuiDrivers.has(driver)) return undefined;
  return (driver as AppOwnedTuiChannelDriver)[APP_OWNED_TUI_START](
    input as ChannelStartInput<TuiAdapterConfig>,
    processJobs,
    monitors,
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
      return await this[APP_OWNED_TUI_START](input, undefined, undefined);
    },
    async [APP_OWNED_TUI_START](input, processJobs, monitors) {
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
            const embeddingOnly = model.capabilities?.advertised_capabilities?.includes("embedding")
              && !model.capabilities.advertised_capabilities.includes("completion");
            if (byRef.has(ref)) {
              if (embeddingOnly) byRef.set(ref, { ...byRef.get(ref)!, embeddingOnly: true });
              continue;
            }
            byRef.set(ref, {
              ref,
              label: model.displayName ?? model.alias ?? model.name,
              providerId: provider.id,
              ...(embeddingOnly ? { embeddingOnly: true } : {}),
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
      // bound, not a validity bound, and the two answer different questions: a
      // reference that clears the parser is runnable whether or not any page
      // would show it, so gating `models` on `catalog.resolve()` deleted a
      // runnable model from every schema-1 client — subtractive at a schema that
      // cannot be bumped (`TUI_WIRE_SCHEMA` is compared with `!==`).
      // Both divergences are reachable: the per-provider advertised cap, which
      // strands hundreds of live rows outside the page, and an id past
      // `MAX_CATALOG_ID_BYTES`, which a local endpoint can report now that the
      // reference parser has no length rule to refuse it first. Every one of
      // those refs stays selectable here.
      // What genuinely must stay bounded is the ONE 1 MiB body `/v1/info` shares
      // across every field, and `sendBoundedInfo` is what enforces it. So the
      // only reasons a DISCOVERED ref is withheld here are that it names nothing
      // a turn could route to (it does not parse), or that advisory discovery
      // has spent its aggregate budget. A configured route is withheld for
      // neither reason: see the budget note at the top of this file.
      const discoveredRefs: RuntimeModelReference[] = [];
      for (const model of discoveredModels) {
        try {
          const ref = parseMonoRuntimeModelReference(model.ref);
          if (!catalog.isEmbeddingOnly(ref)) discoveredRefs.push(ref);
        } catch {
          // A provider that reports an unparseable ref is skipped, not fatal.
        }
      }

      // Resolve both /v1/info projections once, here. `/v1/info` is polled every
      // 5s per connected console, and a throwing or slow info provider returns
      // 500 for the WHOLE response — showing the agent offline rather than
      // degraded. Neither projection may run per request.
      const describeModelOption = (ref: RuntimeModelReference): TuiModelOption | undefined =>
        catalog.describe([ref])[modelReferenceKey(ref)];
      const projection: InfoModelProjection = {
        keys: [],
        seen: new Set(),
        options: {},
        bytes: INFO_MODEL_FRAME_BYTES,
      };
      // Every configured route, unconditionally. These are the operator's
      // declared routes; a route the picker cannot offer is a route nobody can
      // run, and no producer-side number gets to decide that a valid one is too
      // big to mention. If the whole body then will not fit, `sendBoundedInfo`
      // sheds a field and logs it — one loud, visible degradation instead of a
      // silent hole in the middle of the picker.
      admitInfoModels(configuredRefs.filter((ref) => !catalog.isEmbeddingOnly(ref)), describeModelOption, projection);
      // Advisory discovery on top: its own aggregate budget, and never room the
      // body no longer has. When authored routes have already spent past the
      // reserve this ceiling sits below the running total and discovery admits
      // nothing, which is the correct order of yielding.
      admitInfoModels(
        discoveredRefs,
        describeModelOption,
        projection,
        Math.min(
          projection.bytes + MAX_DISCOVERED_INFO_MODEL_BYTES,
          MAX_INFO_BODY_BYTES - INFO_NON_MODEL_RESERVE_BYTES,
        ),
      );
      const infoModelKeys: readonly string[] = Object.freeze(projection.keys);
      const infoModelOptions = Object.freeze(projection.options);
      const infoProviders = projectInfoProviders(
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
        ...(monitors === undefined
          ? {}
          : { monitors, monitorsBearer: monitors.operatorToken }),
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
        monitors: {
          wake: async ({ conversationId, text, deliveryKey, monitor }) => {
            const threadId = webThreadId(conversationId);
            const expectedConversationId = baseConversationId(monitor.origin.conversationId);
            const expectedDeliveryKey = `monitor:${monitor.monitorId}:${String(monitor.counters.seq)}`;
            if (monitor.origin.channel !== "web"
              || conversationId !== expectedConversationId
              || threadId === undefined
              || deliveryKey !== expectedDeliveryKey) {
              return {
                delivered: false,
                code: "monitor_origin_mismatch",
                reason: "The monitor origin does not match the web destination.",
                retryable: false,
              };
            }
            if (input.sourceId === undefined) {
              return {
                delivered: false,
                code: "destination_channel_unavailable",
                reason: "The web monitor destination is unavailable.",
                retryable: true,
                channelId: "tui",
              };
            }
            let delivered;
            try {
              delivered = await deliverNotification({
                sourceId: input.sourceId,
                triggerKind: "monitor",
                deliveryKey,
                threadId,
                monitor,
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
                code: "monitor_wake_failed",
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
                code: "monitor_wake_failed",
                reason: "The web console returned no Monitor wake receipt.",
                retryable: false,
                ambiguous: true,
                channelId: "tui",
              };
            }
            return {
              ...receipt,
              ...(receipt.delivered ? { code: "delivered", historyRecorded: true } : {}),
              channelId: "tui",
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
