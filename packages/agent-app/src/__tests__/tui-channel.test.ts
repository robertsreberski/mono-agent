import { realpath } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { AgentMessageStream, AgentReplyPart, AgentRequestBase, AgentResponder, MonitorProjection, ProcessJobOperator, ProcessJobProjection, RunningChannel } from "@mono-agent/agent-contracts";
import { MAX_INFO_BODY_BYTES, MAX_INFO_PROVIDER_ITEMS } from "@mono-agent/agent-contracts";
import type { EffortLevel, MonoAgentConfig } from "@mono-agent/config";
import type { DiscoveredLocalModel, DiscoveredProvider, LocalProviderDefinition, ProviderDefinition } from "@mono-agent/runtime-adapter";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { TuiAdapterConfig, TuiAdapterInfo, TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/operator-adapter";
import type { DeliverWebNotificationInput } from "@mono-agent/web";
import { WebConsoleError } from "@mono-agent/web";

import type { ChannelDriver, ChannelStartInput } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";
import { MAX_DISCOVERED_INFO_MODEL_BYTES, startAppOwnedTuiChannel } from "../channel-drivers/tui.js";
import { DEFAULT_MAX_ADVERTISED_PER_PROVIDER, MAX_CATALOG_ID_BYTES, MAX_PAGE_SIZE } from "../provider-model-catalog.js";

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

const baseConfig: TuiAdapterConfig = {
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  basePath: "/gui",
  allowNonLoopback: false,
};

interface BuildInputOptions {
  readonly effort?: EffortLevel;
  /** AUTHORED reference strings. Parsed here, never hand-built — see `baseInput`. */
  readonly fallbackModels?: readonly string[];
  readonly localProviders?: readonly LocalProviderDefinition[];
  /** Canonical `providers.entries` list, for the provider-summary budget. */
  readonly providerEntries?: readonly ProviderDefinition[];
}

/**
 * A COMPLETE, fully typed `MonoAgentConfig`. No cast.
 *
 * This fixture used to be `{...} as never`, and that cast was not innocent: it waived checking
 * on the fields the fixture DOES supply, which is how references like `{ provider, model,
 * reference }` carrying a 200,009- or 400,007-byte model half — values
 * `parseRuntimeModelReference` cannot produce and no loader could ever hand this driver — got
 * in and left two of these cases asserting nothing. Supplying the handful of fields the driver
 * never reads (`artifacts`, `traceability`, `runtime.session`) costs five lines and buys the
 * compiler back.
 */
function baseCoreConfig(options: BuildInputOptions): MonoAgentConfig {
  return {
    runtime: {
      model: parseMonoRuntimeModelReference("anthropic:claude-fable-5"),
      workspace: "/tmp",
      session: { mode: "continuous", idleTimeoutMs: 300_000 },
      ...(options.effort === undefined ? {} : { effort: options.effort }),
      ...(options.fallbackModels === undefined ? {} : {
        // Through the REAL parser, exactly as the config loader builds these. A fixture
        // naming something the parser refuses now fails at construction instead of quietly
        // testing a route no operator could ever have configured.
        fallbacks: options.fallbackModels.map((reference) => ({
          model: parseMonoRuntimeModelReference(reference),
        })),
      }),
    },
    context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
    tools: { allowedTools: ["*"], disallowedTools: [] },
    artifacts: {
      dir: "/tmp/artifacts",
      retention: { maxAgeDays: 7, maxCount: 100, dryRun: false },
      memoryRetention: { maxAgeDays: 7, maxCount: 100, dryRun: false },
    },
    traceability: { registryDir: "/tmp/trace-sources" },
    ...(options.providerEntries !== undefined
      ? { providers: { entries: options.providerEntries } }
      : options.localProviders === undefined
        ? {}
        : { providers: { local: options.localProviders } }),
  };
}

function baseInput(options: BuildInputOptions = {}): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: baseCoreConfig(options),
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: baseConfig,
  };
}

interface StartOptions extends BuildInputOptions {
  readonly discoverModels?: (
    providers: readonly LocalProviderDefinition[] | undefined,
  ) => Promise<readonly DiscoveredLocalModel[]>;
  readonly discoverProviders?: () => Promise<readonly DiscoveredProvider[]>;
}

/**
 * Both discovery paths are stubbed off by default. The zero-config probe
 * reaches localhost:11434/1234 for real, so leaving it live would make these
 * assertions depend on whether the developer happens to be running Ollama.
 */
const NOOP_MODEL_DISCOVERY = {
  discoverModels: async () => [],
  discoverProviders: async () => [],
};

const FABLE_MODEL_OPTIONS = {
  label: "Claude Fable 5",
  reasoning: true,
  reasoningMode: "effort" as const,
  effortLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
  contextWindow: 1_000_000,
  provider: "anthropic",
  providerLabel: "Anthropic",
};

async function startCapturingTui(options: StartOptions = {}): Promise<TuiAdapterOptions> {
  let captured: TuiAdapterOptions | undefined;
  const driver = createTuiChannelDriver({
    adapterFactory: (adapterOptions): Promise<TuiAdapterStartResult> => {
      captured = adapterOptions;
      return Promise.resolve({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/gui",
        infoUrl: "http://127.0.0.1:0/gui/v1/info",
        turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: () => Promise.resolve(),
      });
    },
    ...NOOP_MODEL_DISCOVERY,
    ...(options.discoverModels === undefined ? {} : { discoverModels: options.discoverModels }),
    ...(options.discoverProviders === undefined ? {} : { discoverProviders: options.discoverProviders }),
  });

  await driver.start(baseInput(options));
  if (captured === undefined) {
    throw new Error("TUI adapter was not started.");
  }
  return captured;
}

/** `captured.info` is always an info PROVIDER (see design note on createTuiChannelDriver); resolve it. */
async function resolveInfo(captured: TuiAdapterOptions): Promise<TuiAdapterInfo> {
  if (typeof captured.info !== "function") {
    throw new Error("Expected info to be a provider function.");
  }
  return await captured.info();
}

/**
 * A realistically long canonical reference — a SIZE, not a bound.
 *
 * The parser has no length rule at all: `requireQuotableReference` (agent-runtime's
 * `model-refs.js`) refuses control and formatting code points and nothing else, because what a
 * model may be called is decided by providers, not by a grammar layer. Two rounds tried a byte
 * ceiling here and both numbers refused a model that really exists.
 *
 * So these fixtures cannot sit "at the ceiling"; there is none. They sit at a size real
 * references really reach — `ollama:<model>:<tag>`, whose two halves Ollama validates at 80
 * bytes each — and they push on the producer's budgets by COUNT, which is the axis nothing
 * bounds: a local `/v1/models` answer is arbitrarily long, and `runtime.fallbacks` is validated
 * for uniqueness, not for length.
 *
 * Written as a literal on purpose. The previous round's fixtures derived their sizes from the
 * very bound they were checking, which is exactly why they survived changing it. What this
 * producer does when a SINGLE reference is enormous — now possible at any size — is a separate
 * question, and it has its own cases below, driven at sizes no bound here could have produced.
 */
const LONG_REFERENCE_BYTES = 168;

function longRef(head: string, filler = "x"): string {
  const headBytes = Buffer.byteLength(head, "utf8");
  if (headBytes > LONG_REFERENCE_BYTES) {
    throw new Error(`fixture head is already longer than the fixture size: ${head}`);
  }
  if (Buffer.byteLength(filler, "utf8") !== 1) {
    throw new Error("fixture filler must be one UTF-8 byte so the size is exact");
  }
  return `${head}${filler.repeat(LONG_REFERENCE_BYTES - headBytes)}`;
}

/** An `openrouter:` route whose canonical reference is `LONG_REFERENCE_BYTES` long. */
function longRouteRef(index: number): string {
  return longRef(`openrouter:route-${String(index).padStart(6, "0")}-`, "m");
}

/** An `lmstudio:` discovered ref of the same length. */
function longDiscoveredRef(index: number, filler = "x"): string {
  return longRef(`lmstudio:model-${String(index).padStart(6, "0")}-`, filler);
}

const LMSTUDIO: readonly LocalProviderDefinition[] = [
  { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
];

/**
 * What the `models` + `modelOptions` pair really costs on the wire.
 *
 * Measured off the resolved info rather than accumulated alongside the producer,
 * so an accounting bug in `infoModelEntryBytes` cannot hide inside the
 * assertion that is supposed to catch it.
 */
function modelProjectionBytes(info: TuiAdapterInfo): number {
  return Buffer.byteLength(
    JSON.stringify({ models: info.models, modelOptions: info.modelOptions }),
    "utf8",
  );
}

describe("tui channel driver — info composition", () => {
  it("publishes a secret-free ACP bridge compatibility summary", async () => {
    const driver = createTuiChannelDriver({
      adapterFactory: async (): Promise<TuiAdapterStartResult> => ({
        url: "http://127.0.0.1:0",
        baseUrl: "http://127.0.0.1:0/gui",
        infoUrl: "http://127.0.0.1:0/gui/v1/info",
        turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
        host: "127.0.0.1",
        port: 0,
        stop: async () => {},
      }),
      ...NOOP_MODEL_DISCOVERY,
      discoverModels: async () => [],
    });

    const started = await driver.start(baseInput());

    expect(started.summary).toEqual({
      baseUrl: "http://127.0.0.1:0/gui",
      acpBridge: {
        schema: "mono-agent.acp-source.v1",
        bridgeVersion: 1,
        protocolVersion: 1,
        installedVersion: "0.20.14",
        workspacePath: await realpath("/tmp"),
      },
    });
    expect(JSON.stringify(started.summary)).not.toMatch(/apiKey|credential|configPath/u);
  });

  it("passes the configured runtime effort through to the adapter's info", async () => {
    const captured = await startCapturingTui({ effort: "high" });
    const info = await resolveInfo(captured);

    expect(info).toMatchObject({
      model: "anthropic:claude-fable-5",
      effort: "high",
      models: ["anthropic:claude-fable-5"],
      modelOptions: { "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS },
      skills: { status: "ready", items: [], total: 0 },
    });
    expect(info.providers?.find((provider) => provider.id === "anthropic"))
      .toMatchObject({ id: "anthropic", label: "Anthropic", source: "builtin", configured: true });
  });

  it("publishes a configured model display name through /v1/info", async () => {
    const captured = await startCapturingTui({
      providerEntries: [{
        id: "anthropic",
        models: [{ name: "claude-fable-5", displayName: "Fable for Robert" }],
      }],
    });
    const info = await resolveInfo(captured);

    expect(info.modelOptions?.["anthropic:claude-fable-5"]?.label)
      .toBe("Fable for Robert");
    expect(captured.modelCatalog?.({ provider: "anthropic", limit: 10 }).models[0]?.name)
      .toBe("Fable for Robert");
  });

  it("omits effort from info when the runtime has none configured", async () => {
    const captured = await startCapturingTui();
    const info = await resolveInfo(captured);

    expect(info).toMatchObject({
      model: "anthropic:claude-fable-5",
      models: ["anthropic:claude-fable-5"],
      modelOptions: { "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS },
      skills: { status: "ready", items: [], total: 0 },
    });
    expect(info.effort).toBeUndefined();
  });

  it("lists the primary then fallback models as candidate models, de-duplicated", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        "openai-codex:gpt-5.5",
        "anthropic:claude-fable-5",
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", "openai-codex:gpt-5.5"]);
  });

  it("publishes known provider context windows, preferring configured local capabilities", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        "openai-codex:gpt-5.6-sol",
        "openai-codex:gpt-5.5",
        "openai-codex:gpt-5.6-terra",
        "openai-codex:gpt-5.4",
        "anthropic:claude-sonnet-4-6",
        "unknown-provider:unknown-model",
      ],
      localProviders: [{
        id: "openai-codex",
        type: "openai_compat",
        baseUrl: "http://localhost:1234",
        enabled: true,
        models: [
          {
            name: "gpt-5.5",
            capabilities: { context_window: 16_384, num_ctx: 8_192 },
          },
          {
            name: "gpt-5.6-terra",
            capabilities: { num_ctx: 32_768 },
          },
          {
            name: "gpt-5.4",
            capabilities: { context_window: 0, num_ctx: -1 },
          },
        ],
      }],
      discoverModels: async () => [],
    });
    const info = await resolveInfo(captured);

    // Sourced from pi's generated catalog, corrected to 272_000 in pi-ai 0.83.0.
    expect(info.modelOptions?.["openai-codex:gpt-5.6-sol"]?.contextWindow).toBeUndefined();
    expect(info.modelOptions?.["openai-codex:gpt-5.5"]?.contextWindow).toBe(16_384);
    expect(info.modelOptions?.["openai-codex:gpt-5.6-terra"]?.contextWindow).toBe(32_768);
    expect(info.modelOptions?.["openai-codex:gpt-5.4"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["anthropic:claude-sonnet-4-6"]?.contextWindow).toBe(1_000_000);
    expect(info.modelOptions?.["unknown-provider:unknown-model"]).not.toHaveProperty("contextWindow");
    expect(info.modelOptions?.["anthropic:claude-fable-5"]?.contextWindow).toBe(1_000_000);
  });

  it("degrades to no discovered models/no local modelOptions detail when no local providers are configured", async () => {
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5"]);
    expect(info.modelOptions).toEqual({ "anthropic:claude-fable-5": FABLE_MODEL_OPTIONS });
  });

  it("keeps live-discovered models in info.models and also serves them via the catalog", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "lmstudio:qwen/qwen3-8b", label: "qwen/qwen3-8b", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    // Discovered local models stay in `models`, and ALSO appear in the bounded
    // provider catalog. Dropping them from `models` would be a subtractive wire
    // change at an unchanged TUI_WIRE_SCHEMA: a console that reads only
    // `models` -- every client predating /v1/models -- would silently lose the
    // lmstudio entries it used to offer, with no skew error to explain it.
    expect(info.models).toEqual([
      "anthropic:claude-fable-5",
      "lmstudio:qwen/qwen3-8b",
      "lmstudio:llama-3.1",
    ]);
    expect(info.modelOptions?.["anthropic:claude-fable-5"]).toEqual(FABLE_MODEL_OPTIONS);
    expect(Object.keys(info.modelOptions ?? {})).toEqual(expect.arrayContaining([
      "lmstudio:qwen/qwen3-8b",
      "lmstudio:llama-3.1",
    ]));
    expect(info.providers?.find((provider) => provider.id === "lmstudio")).toMatchObject({
      id: "lmstudio",
      source: "custom",
      modelCount: 2,
    });
    const page = captured.modelCatalog?.({ provider: "lmstudio", limit: 100 });
    expect(page?.models.map((model) => model.id)).toEqual(["llama-3.1", "qwen/qwen3-8b"]);
    expect(page?.truncated).toBe(false);
    expect(discoverModels).toHaveBeenCalledWith(localProviders);
  });

  it("withholds from /v1/info every discovered ref the reference grammar rejects", async () => {
    // A local endpoint's `/v1/models` answer is arbitrary text that no operator authored and
    // nothing upstream of `parseMonoRuntimeModelReference` bounds. Exactly one shape can no
    // longer BE a reference — one carrying a control or formatting code point, which restyles
    // or extends the line quoting it — and it must not reach a surface that quotes what it is
    // handed.
    //
    // This case used to carry a second shape, "one byte past the parse ceiling". There is no
    // parse ceiling any more: a grammar layer does not get to decide how long a provider may
    // name a model, and both numbers tried refused a model that really exists. An oversized
    // ref is now a BUDGET question rather than a validity one, and the two cases below own it.
    //
    // ESC: the exact code point that lets a model id repaint the line a daemon log, `doctor`
    // or the console prints it on.
    const controlCharacter = `lmstudio:qwen${String.fromCharCode(27)}[31m-3-8b`;

    const discoverModels = vi.fn().mockResolvedValue([
      { ref: controlCharacter, label: "control", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders: LMSTUDIO, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", "lmstudio:llama-3.1"]);
    expect(Object.keys(info.modelOptions ?? {}))
      .toEqual(["anthropic:claude-fable-5", "lmstudio:llama-3.1"]);
    // Asserted against the SERIALIZED body, not against `models` alone: a ref that cannot be
    // quoted must not appear in any field of the payload every console renders, whichever one a
    // future projection puts it in.
    expect(JSON.stringify(info)).not.toContain(JSON.stringify(controlCharacter).slice(1, -1));
  });

  it("keeps an oversized discovered ref out of the /v1/info body, and charges it to nobody else", async () => {
    // The state the retired parse ceiling made unreachable, and which is reachable again: a
    // local endpoint reporting a model id of half a megabyte. It parses now — there is nothing
    // in the grammar to stop it — so the guarantee has to hold HERE, at the layer that owns the
    // `/v1/info` budget, which is where it always actually belonged.
    //
    // Two things must be true at once, and only measurement of the real payload gives both:
    // the body must stay under the shared cap (over it the console shows the agent OFFLINE, not
    // degraded), and the oversized row must cost only ITSELF — `admitInfoModels` uses
    // `continue`, not `break`, because the TUI builds its picker from `/v1/info.models` alone
    // and a withheld ref is unselectable rather than merely un-paginated.
    const oversized = `lmstudio:${"z".repeat(500_000)}`;
    expect(parseMonoRuntimeModelReference(oversized).reference).toBe(oversized);

    const discoverModels = vi.fn().mockResolvedValue([
      { ref: oversized, label: "oversized", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders: LMSTUDIO, discoverModels });
    const info = await resolveInfo(captured);

    // Refused a place by the budget, not by the grammar...
    expect(info.models).not.toContain(oversized);
    expect(JSON.stringify(info)).not.toContain(oversized);
    // ...and everything queued behind it still ships.
    expect(info.models).toEqual([
      "anthropic:claude-fable-5",
      "lmstudio:llama-3.1",
      "lmstudio:qwen3-8b",
    ]);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(MAX_INFO_BODY_BYTES);
  });

  it("publishes a discovered ref the catalog's own id bound drops, because the picker reads /v1/info", async () => {
    // Restored coverage. A 257-byte model id is past `MAX_CATALOG_ID_BYTES`, so `/v1/models`
    // pages cannot carry it — and while the parser had a 160-byte ceiling this state was
    // unreachable and the case was deleted as vacuous. Removing the ceiling makes it real
    // again, and the divergence matters: `/v1/info.models` deliberately does NOT inherit the
    // catalog's display bounds, because the TUI has no `/v1/models` call site at all and
    // rebuilds its model picker from `/v1/info.models`. Gating one on the other would make this
    // model unselectable in the operator's own console.
    //
    // Derived from `MAX_CATALOG_ID_BYTES` on purpose, and unlike the retired ceiling fixtures
    // that is the right call here: what is pinned is the RELATIONSHIP between the two layers,
    // not the number. Wherever the catalog moves its display bound, the ref this builds is one
    // byte past it and must still be published.
    const longModelId = "q".repeat(MAX_CATALOG_ID_BYTES + 1);
    const ref = `lmstudio:${longModelId}`;
    expect(Buffer.byteLength(ref, "utf8")).toBeGreaterThan(MAX_CATALOG_ID_BYTES);

    const captured = await startCapturingTui({
      localProviders: LMSTUDIO,
      discoverModels: async () => [
        { ref, label: "long-id", providerId: "lmstudio" },
        { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
      ] satisfies DiscoveredLocalModel[],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toContain(ref);
    expect(Object.keys(info.modelOptions ?? {})).toContain(ref);
    // The catalog page drops it on its own display bound, and keeps the rest.
    const page = captured.modelCatalog?.({ provider: "lmstudio", limit: MAX_PAGE_SIZE });
    expect(page?.models.map((model) => model.id)).toEqual(["llama-3.1"]);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(MAX_INFO_BODY_BYTES);
  });

  it("stops publishing discovered refs at the /v1/info discovery budget", async () => {
    // A local endpoint's `/v1/models` answer is still unbounded -- but along
    // COUNT now, not length. Each ref here sits exactly at the reference
    // ceiling, the largest one that can exist, and 5,000 of them still
    // serialize far past the discovery slice. Publishing all of them would eat
    // the room the ONE 1 MiB body /v1/info shares with skills, providers and
    // capabilities -- and an over-cap body does not degrade, it sheds a whole
    // field at `sendBoundedInfo`'s fence.
    const flood = Array.from({ length: 5_000 }, (_unused, index) => ({
      ref: longDiscoveredRef(index),
      label: "flood",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];
    expect(Buffer.byteLength(flood[0]!.ref, "utf8")).toBe(LONG_REFERENCE_BYTES);

    const captured = await startCapturingTui({
      localProviders: LMSTUDIO,
      discoverModels: async () => flood,
    });
    const info = await resolveInfo(captured);
    const configuredOnly = await startCapturingTui().then(resolveInfo);

    expect(info.models?.length).toBeGreaterThan(1);
    expect(info.models?.length).toBeLessThan(flood.length);
    // Bounded by the DISCOVERY slice, not merely by the wire cap. Asserting
    // only "the body fits" would still pass with the slice removed: the reserve
    // clamp alone leaves discovery ~576 KiB, which fits 1 MiB fine. Measured as
    // the increment over the same routes with no discovery at all, so this
    // tracks the exported constant rather than a copy of it.
    expect(modelProjectionBytes(info) - modelProjectionBytes(configuredOnly))
      .toBeLessThanOrEqual(MAX_DISCOVERED_INFO_MODEL_BYTES);
    // A tail cut in discovery order, never a reorder: everything published
    // after the configured primary is a prefix of what discovery reported.
    const published = info.models ?? [];
    expect(published.slice(1)).toEqual(flood.slice(0, published.length - 1).map((model) => model.ref));
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(MAX_INFO_BODY_BYTES);
  });

  it("publishes every ref of a realistic 600-model local catalog the catalog itself cannot page", async () => {
    // 600 refs, each at the reference ceiling: the shape a large but entirely
    // ordinary local install has, with every id as long as one can now be —
    // `lmstudio:hf.co/<org>/<repo>-<quant>` is the real long-tail form, and the
    // ceiling is derived from exactly that. They serialize to well under the
    // discovery slice. The old per-ref ESTIMATE (`bytes * 4 + 512` against a
    // 256 KiB slice) charged 1,472 bytes each and admitted only 178.
    //
    // Those dropped refs were not merely un-paginated: the TUI has no
    // /v1/models call site at all (`applyAgentInfo` builds its picker from
    // /v1/info.models alone), so each one was UNSELECTABLE -- a subtractive
    // change at a wire schema the console compares with `!==`.
    const catalog = Array.from({ length: 600 }, (_unused, index) => ({
      // Shaped like the longest form local discovery really returns: a Hugging
      // Face GGUF path carrying a quant tag.
      ref: longRef(`lmstudio:hf.co/bartowski/Qwen3-${String(index).padStart(3, "0")}B-Instruct-`, "G"),
      label: "local",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];
    expect(Buffer.byteLength(catalog[0]!.ref, "utf8")).toBe(LONG_REFERENCE_BYTES);

    const captured = await startCapturingTui({
      localProviders: LMSTUDIO,
      discoverModels: async () => catalog,
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual([
      "anthropic:claude-fable-5",
      ...catalog.map((model) => model.ref),
    ]);
    expect(Object.keys(info.modelOptions ?? {})).toHaveLength(601);
    // And published INDEPENDENTLY of catalog membership. The catalog advertises
    // at most DEFAULT_MAX_ADVERTISED_PER_PROVIDER of a provider's discovered
    // rows, so gating `models` on `catalog.resolve()` would strand 500 refs
    // whose only reader is the picker. The per-provider cap is one of the two
    // ways a published ref can fall outside the catalog page; the other -- an id
    // past `MAX_CATALOG_ID_BYTES` -- is reachable again now that the parser has
    // no length rule, and has its own case above.
    const page = captured.modelCatalog?.({ provider: "lmstudio", limit: MAX_PAGE_SIZE });
    expect(page?.models).toHaveLength(DEFAULT_MAX_ADVERTISED_PER_PROVIDER);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(MAX_INFO_BODY_BYTES);
  });

  it("never publishes a control-byte ref, because the parser refuses one", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    // This began as a budget test: each C0 byte serializes to six (`\u0000`),
    // and the ref appears at full escaped length TWICE -- once as a `models`
    // element, once as the `modelOptions` key -- so an estimate over the RAW
    // ref admitted 23 of these and emitted 1.1 MB, over the cap that takes the
    // agent offline.
    //
    // `requireQuotableReference` now refuses a reference carrying a control or
    // formatting code point, so that arithmetic is unreachable and asserting it
    // would prove nothing. What is worth pinning instead is the reason it is
    // unreachable: a local endpoint can report whatever it likes, and none of it
    // reaches the wire. The projection carries the configured route and nothing
    // the endpoint invented.
    const escaped = Array.from({ length: 30 }, (_unused, index) => ({
      ref: `lmstudio:${String(index).padStart(3, "0")}${"\u0000".repeat(4_000)}`,
      label: "escaped",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];

    const captured = await startCapturingTui({
      localProviders,
      discoverModels: async () => escaped,
    });
    const info = await resolveInfo(captured);

    const projections = Buffer.byteLength(
      JSON.stringify({ models: info.models, modelOptions: info.modelOptions }),
      "utf8",
    );
    // One shared 512 KiB slice for `models` + `modelOptions`.
    expect(projections).toBeLessThanOrEqual(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(1024 * 1024);
    // None of the 30 reported refs survives, and the configured route is
    // untouched -- the endpoint cannot cost the operator their own route.
    expect(info.models).toEqual(["anthropic:claude-fable-5"]);
    for (const key of Object.keys(info.modelOptions ?? {})) {
      expect(key).not.toContain("\u0000");
    }
  });

  it("skips only the row the discovery budget cannot take and keeps every ref behind it", async () => {
    // `admitInfoModels` uses `continue`, not `break`, where a budget applies:
    // one expensive entry must cost only itself, because /v1/info.models is the
    // only list the TUI's picker reads and a withheld ref is UNSELECTABLE, not
    // merely un-paginated.
    //
    // The version of this case that shipped last round could no longer tell the
    // two apart. Its "huge" row was a 200,009-byte id, which the parser refuses
    // BEFORE admission runs, so the rows behind it were never behind a budget
    // rejection at all and `break` would have passed the test just as happily.
    // A fixture that fabricates state the system cannot reach proves nothing.
    //
    // Reaching the distinction now means a row whose COST is heterogeneous
    // while its length stays legal. Two things vary: the reference (short vs at
    // the ceiling) and the materialized option — `effortLevels` comes from a
    // local provider's declared `capabilities.reasoning_levels`, bounded to
    // 32 x 64 bytes but no smaller. The expensive row below costs about 2 KB
    // against a short row's ~110 bytes, and both parse.
    //
    // Where the budget edge falls is MEASURED off the real producer rather than
    // recomputed here: a probe floods discovery with identically priced ceiling
    // refs, and the number the producer publishes IS the edge for that row
    // cost. Filling to one row short of it leaves a gap of at least one uniform
    // row and strictly less than two — far too small for the expensive row,
    // comfortably larger than the two short rows behind it. The skip and the
    // admissions behind it are both forced, and this test keeps no copy of the
    // producer's accounting.
    const expensiveModelName = "expensive-effort-ladder";
    const localProviders = [{
      id: "lmstudio",
      type: "lmstudio",
      baseUrl: "http://localhost:1234",
      enabled: true,
      models: [{
        name: expensiveModelName,
        capabilities: {
          reasoning: true,
          // 32 levels of 58 bytes: the largest ladder `boundedEffortLevels`
          // will pass through whole (MAX_ADVERTISED_EFFORT_LEVELS x
          // MAX_ADVERTISED_EFFORT_LEVEL_BYTES), so this row is expensive by the
          // producer's own published bound rather than by an oversize value.
          reasoning_levels: Array.from(
            { length: 32 },
            (_unused, index) => `level-${String(index).padStart(2, "0")}-${"e".repeat(48)}`,
          ),
        },
      }],
    }] satisfies readonly LocalProviderDefinition[];

    const uniformRows = (count: number): DiscoveredLocalModel[] =>
      Array.from({ length: count }, (_unused, index) => ({
        ref: longDiscoveredRef(index),
        label: "uniform",
        providerId: "lmstudio",
      }));

    const probe = await resolveInfo(await startCapturingTui({
      localProviders,
      discoverModels: async () => uniformRows(5_000),
    }));
    // Minus the configured primary, which is admitted unbudgeted ahead of them.
    const edge = (probe.models?.length ?? 0) - 1;
    // Guard against the probe going vacuous at either end: the budget must
    // really have cut the flood, and must have left room for more than the rows
    // this case then places behind the skip.
    expect(edge).toBeGreaterThan(2);
    expect(edge).toBeLessThan(5_000);

    const expensive: DiscoveredLocalModel = {
      ref: `lmstudio:${expensiveModelName}`,
      label: "expensive",
      providerId: "lmstudio",
    };
    // It is a perfectly legal reference. It is refused for its COST, which is
    // the only way this case can distinguish `continue` from `break` at all.
    expect(() => parseMonoRuntimeModelReference(expensive.ref)).not.toThrow();
    const behind: DiscoveredLocalModel[] = [
      { ref: "lmstudio:s0", label: "s0", providerId: "lmstudio" },
      { ref: "lmstudio:s1", label: "s1", providerId: "lmstudio" },
    ];
    const rows = [...uniformRows(edge - 1), expensive, ...behind];

    const info = await resolveInfo(await startCapturingTui({
      localProviders,
      discoverModels: async () => rows,
    }));

    expect(info.models).toEqual([
      "anthropic:claude-fable-5",
      ...uniformRows(edge - 1).map((row) => row.ref),
      ...behind.map((row) => row.ref),
    ]);
    // The distinction in one line: what shipped is NOT a prefix of what
    // discovery reported, and a `break` can only ever produce a prefix.
    const reported = rows.map((row) => row.ref);
    const shipped = (info.models ?? []).slice(1);
    expect(shipped).not.toEqual(reported.slice(0, shipped.length));
    expect(shipped).not.toContain(expensive.ref);
    expect(Object.keys(info.modelOptions ?? {})).not.toContain(expensive.ref);
  });

  it("bounds an unbounded local effort ladder instead of dropping the model", async () => {
    // `capabilities.reasoning_levels` reaches /v1/info from config verbatim:
    // `resolveModelEffortLevels` returns it unfiltered, and config validates it
    // for neither element length nor count. A single 1.1 MB level was charged
    // 556 bytes by the old estimate and emitted a 1.1 MB info object.
    const localProviders: readonly LocalProviderDefinition[] = [{
      id: "lmstudio",
      type: "lmstudio",
      baseUrl: "http://localhost:1234",
      enabled: true,
      models: [{
        name: "big-effort",
        capabilities: { reasoning: true, reasoning_levels: ["z".repeat(1_100_000)] },
      }],
    }] satisfies readonly LocalProviderDefinition[];

    const captured = await startCapturingTui({
      localProviders,
      discoverModels: async () => [
        { ref: "lmstudio:big-effort", label: "big", providerId: "lmstudio" },
      ],
    });
    const info = await resolveInfo(captured);

    // The model stays SELECTABLE. Dropping the ladder costs the picker its
    // graded levels and it falls back to the global effort enum; dropping the
    // ref would cost the operator the model itself.
    expect(info.models).toContain("lmstudio:big-effort");
    expect(info.modelOptions?.["lmstudio:big-effort"]).toEqual({
      label: "big-effort",
      reasoning: true,
      reasoningMode: "effort",
      provider: "lmstudio",
      providerLabel: "lmstudio",
    });
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("caps how many effort levels one model may advertise", async () => {
    const levels = Array.from({ length: 5_000 }, (_unused, index) => `e${String(index)}`);
    const localProviders: readonly LocalProviderDefinition[] = [{
      id: "lmstudio",
      type: "lmstudio",
      baseUrl: "http://localhost:1234",
      enabled: true,
      models: [{
        name: "many-levels",
        capabilities: { reasoning: true, reasoning_levels: levels },
      }],
    }] satisfies readonly LocalProviderDefinition[];

    const captured = await startCapturingTui({
      localProviders,
      discoverModels: async () => [
        { ref: "lmstudio:many-levels", label: "many", providerId: "lmstudio" },
      ],
    });
    const info = await resolveInfo(captured);

    // Individually valid, collectively unbounded: count is capped too.
    expect(info.modelOptions?.["lmstudio:many-levels"]?.effortLevels).toEqual(levels.slice(0, 32));
  });

  it("bounds the provider summary and orders routes into the console's window", async () => {
    // The consumer stops parsing at the first MAX_INFO_PROVIDER_ITEMS entries;
    // the producer capped none, so 20,000 configured entries generated a
    // 1.68 MB body and took the agent offline. `providers` gets its own
    // measured 128 KiB slice.
    const providerEntries = Array.from({ length: 3_000 }, (_unused, index) => ({
      id: `vendor-${String(index).padStart(5, "0")}`,
    }));

    const captured = await startCapturingTui({ providerEntries });
    const info = await resolveInfo(captured);

    const providerBytes = Buffer.byteLength(JSON.stringify(info.providers), "utf8");
    expect(providerBytes).toBeLessThanOrEqual(128 * 1024);
    expect(info.providers?.length).toBeGreaterThan(MAX_INFO_PROVIDER_ITEMS);
    expect(info.providers?.length).toBeLessThan(providerEntries.length);
    // The provider the agent actually routes through survives the cut AND
    // lands inside the window the console parses. It is LAST in catalog order
    // (declared entries first, then route providers), so BOTH prefix cuts —
    // this slice and the console's item window — would otherwise drop exactly
    // the provider the picker cannot work without and keep a thousand the
    // operator merely listed. Admitting it and then emitting it at position
    // 3,001 is not admitting it; see `tui-info-wire.test.ts` for the same
    // claim proved across the real producer -> consumer boundary.
    const ids = info.providers?.map((provider) => provider.id) ?? [];
    expect(ids.slice(0, MAX_INFO_PROVIDER_ITEMS)).toContain("anthropic");
    // Reordered only where it must be: routes first, catalog order behind them.
    expect(ids[0]).toBe("anthropic");
    expect(ids[1]).toBe("vendor-00000");
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("leaves a catalog that fits both cuts in the catalog's own order and identity", async () => {
    // Reordering is only ever a response to a cut. A summary the console can
    // parse whole must arrive exactly as the catalog built it -- including the
    // frozen array identity /v1/info hands back on every 5 s poll.
    const providerEntries = Array.from({ length: 8 }, (_unused, index) => ({
      id: `vendor-${String(index).padStart(5, "0")}`,
    }));

    const captured = await startCapturingTui({ providerEntries });
    const info = await resolveInfo(captured);

    expect(info.providers?.map((provider) => provider.id))
      .toEqual([...providerEntries.map((entry) => entry.id), "anthropic"]);
  });

  it("publishes a configured chain no producer-side slice could have held", async () => {
    // ~800 KB across the two projections: more than any slice that also leaves
    // room for providers and skills, and yet every entry is a route a turn
    // really would run, inside a body that still fits the shared 1 MiB cap.
    // Round 3 dropped an authored route at a 128 KiB slice and round 4 dropped
    // it again at 512 KiB; a slice bounds a total, it does not rule on which
    // authored content deserves to ship.
    //
    // The old vehicle was a single 400,007-byte reference, which the parser can
    // no longer produce — a fixture the system cannot reach tests nothing. The
    // pressure is applied by COUNT instead, which nothing bounds: `runtime.
    // fallbacks` is validated for uniqueness, not for length.
    const routes = [
      "openrouter:gpt-5.6-sol",
      ...Array.from({ length: 2_000 }, (_unused, index) => longRouteRef(index)),
    ];
    const captured = await startCapturingTui({ fallbackModels: routes });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", ...routes]);
    // Past every per-contributor slice this file has seen proposed, and still
    // inside the one cap that is real.
    expect(modelProjectionBytes(info)).toBeGreaterThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("keeps every configured route ahead of a discovery flood", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    // This began as one 70,000-byte route: charged against a 128 KiB
    // configured-only slice it cost ~140 KB and was dropped, while the complete
    // body it belonged to measured 140,731 bytes -- a seventh of the cap.
    //
    // A single reference of that size is possible again -- the parse ceiling
    // that briefly made it unreachable is gone -- but it is the wrong vehicle
    // for THIS guarantee, because one huge route cannot show that a slice is
    // adjudicating between authored routes. A configured route is authored, so
    // no producer-side slice may drop one, and the way to press on a slice
    // without any single item being pathological is COUNT. 800 ordinary-sized
    // routes spend well past the 128 KiB
    // slice the old rule charged configured routes against, and past any
    // per-contributor ceiling short of the wire cap. Every one must still ship.
    const configured = Array.from(
      { length: 800 },
      (_unused, index) => longRouteRef(index),
    );
    const flood = Array.from({ length: 5_000 }, (_unused, index) => ({
      ref: longDiscoveredRef(index),
      label: "flood",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];

    const captured = await startCapturingTui({
      fallbackModels: configured,
      localProviders,
      discoverModels: async () => flood,
    });
    const info = await resolveInfo(captured);

    // Every authored route ships. Not "most", not "the ones that fit": all of
    // them, plus the primary. This is the assertion a per-item or aggregate
    // configured ceiling cannot satisfy.
    const published = new Set(info.models ?? []);
    expect(configured.filter((route) => !published.has(route))).toEqual([]);
    expect(info.models?.length).toBeGreaterThan(configured.length);
    // Discovery still fills in behind them, and still cannot spend more than
    // its own aggregate budget on top of whatever the authored routes took.
    expect(info.models?.length).toBeLessThan(configured.length + flood.length);
    const configuredOnly = await startCapturingTui({
      fallbackModels: configured,
    }).then(resolveInfo);
    const projectionBytes = (source: typeof info): number => Buffer.byteLength(
      JSON.stringify({ models: source.models, modelOptions: source.modelOptions }),
      "utf8",
    );
    // Measured against what the SAME routes cost with no discovery at all, so
    // this tracks the rule rather than a copy of whatever the routes happen to
    // weigh today.
    expect(projectionBytes(info) - projectionBytes(configuredOnly))
      .toBeLessThanOrEqual(MAX_DISCOVERED_INFO_MODEL_BYTES);
    expect(Buffer.byteLength(JSON.stringify(info), "utf8")).toBeLessThan(1024 * 1024);
  });

  it("resolves toggle reasoning for a configured Ollama route through describe", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
    ];

    const captured = await startCapturingTui({
      fallbackModels: ["ollama:qwen3.6:latest"],
      localProviders,
      discoverModels: async () => [],
    });
    const info = await resolveInfo(captured);

    // Toggle model carries the mode but NO graded effortLevels.
    expect(info.modelOptions?.["ollama:qwen3.6:latest"]).toEqual({
      reasoning: true,
      reasoningMode: "toggle",
      provider: "ollama",
      providerLabel: "ollama",
    });
  });

  it("withholds embedding routes and aliases from both info and paged chat models", async () => {
    const captured = await startCapturingTui({
      fallbackModels: ["desk:pretty-vector", "desk:chat"],
      localProviders: [{ id: "desk", type: "lmstudio", baseUrl: "http://localhost:1234",
        models: [{ name: "vector", alias: "pretty-vector" }, { name: "chat" }] }],
      discoverModels: async () => [
        { ref: "desk:vector", label: "Vector", providerId: "desk", embeddingOnly: true },
        { ref: "desk:chat", label: "Chat", providerId: "desk" },
      ],
    });
    const info = await resolveInfo(captured);
    expect(info.models).toContain("desk:chat");
    expect(info.models).not.toContain("desk:vector");
    expect(info.models).not.toContain("desk:pretty-vector");
    expect(info.modelOptions).not.toHaveProperty("desk:pretty-vector");
    expect(captured.modelCatalog?.({ provider: "desk", limit: 100 }).models.map((m) => m.id))
      .toEqual(["chat"]);
  });

  it("dedups discovered models within a provider's catalog page", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b", providerId: "lmstudio" },
      { ref: "lmstudio:qwen3-8b", label: "qwen3-8b (duplicate)", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.providers?.find((provider) => provider.id === "lmstudio")?.modelCount).toBe(1);
    expect(captured.modelCatalog?.({ provider: "lmstudio", limit: 100 }).models.map((m) => m.id))
      .toEqual(["qwen3-8b"]);
  });

  it("captures local model discovery once at startup and serves /v1/info from memory", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    const discoverModels = vi.fn().mockResolvedValue([]);
    const captured = await startCapturingTui({ localProviders, discoverModels });

    await resolveInfo(captured);
    await resolveInfo(captured);
    await resolveInfo(captured);

    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("does not refresh local discovery after the former TTL window elapses", async () => {
    vi.useFakeTimers();
    try {
      const localProviders: readonly LocalProviderDefinition[] = [
        { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
      ];
      const discoverModels = vi.fn().mockResolvedValue([]);
      const captured = await startCapturingTui({ localProviders, discoverModels });

      await resolveInfo(captured);
      vi.advanceTimersByTime(30_001);
      await resolveInfo(captured);

      expect(discoverModels).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves /v1/info from memory: repeated polls do not re-read the Pi catalog", async () => {
    const captured = await startCapturingTui({
      fallbackModels: ["openrouter:gpt-5.6-sol"],
    });

    const first = await resolveInfo(captured);
    const second = await resolveInfo(captured);
    const third = await resolveInfo(captured);

    // The console polls /v1/info every 5s per connection, and a throwing or
    // slow info provider returns 500 for the WHOLE response — the agent shows
    // offline, not degraded. Both projections are precomputed at channel start,
    // so repeated polls hand back the very same frozen objects.
    expect(second.providers).toBe(first.providers);
    expect(third.providers).toBe(first.providers);
    expect(second.modelOptions).toBe(first.modelOptions);
    expect(third.modelOptions).toBe(first.modelOptions);
  });

  it("advertises zero-config local providers that no `providers` entry declares", async () => {
    // The gap this covers: `discoverLocalProviderModels` returns [] when
    // `providers.local` is absent, so before the zero-config probe was wired a
    // config whose only route was `ollama:*` validated, advertised nothing, and
    // died at turn time with `pi model not found`.
    const captured = await startCapturingTui({
      discoverProviders: async () => [{
        id: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        enabled: true,
        models: [{ name: "gemma4:31b" }],
      }] satisfies readonly DiscoveredProvider[],
    });
    const info = await resolveInfo(captured);

    expect(info.providers?.map((provider) => provider.id)).toContain("ollama");
    const page = captured.modelCatalog?.({ provider: "ollama", limit: 10 });
    expect(page?.models.map((model) => model.id)).toContain("gemma4:31b");
  });

  it("keeps the serialized /v1/info payload under the byte budget with openrouter configured", async () => {
    const captured = await startCapturingTui({
      fallbackModels: ["openrouter:gpt-5.6-sol"],
    });
    const info = await resolveInfo(captured);

    // Regression fence: the provider summary must stay bounded on /v1/info; the
    // model lists themselves ride the lazy /v1/models endpoint. Exceeding the
    // 1 MiB body cap takes the agent offline rather than degrading it.
    expect(JSON.stringify(info).length).toBeLessThan(8_192);
    // `providers` is a support gate: the agent advertises the provider its
    // route uses plus the one the fallback declares, not all 39 Pi built-ins.
    expect(info.providers?.map((provider) => provider.id).sort())
      .toEqual(["anthropic", "openrouter"]);
  });

  it("advertises exact Pi effort levels while unknown provider refs fail closed", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        "openai-codex:gpt-5.6-terra",
        "anthropic:claude-sonnet-4-6",
        "unknown-provider:gemini",
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.modelOptions?.["anthropic:claude-fable-5"]).toEqual(FABLE_MODEL_OPTIONS);
    expect(info.modelOptions?.["openai-codex:gpt-5.6-terra"]).toMatchObject({
      reasoning: true,
      contextWindow: 272_000,
    });
    expect(info.modelOptions?.["anthropic:claude-sonnet-4-6"]?.effortLevels?.length).toBeGreaterThan(0);
    expect(info.modelOptions?.["unknown-provider:gemini"]).toEqual({
      reasoning: true,
      provider: "unknown-provider",
      providerLabel: "unknown-provider",
    });
  });

  it("fail-closes local capability discovery without blocking later /v1/info reads", async () => {
    const discoverModels = vi.fn(async () => {
      throw new Error("local catalog unavailable");
    });
    const captured = await startCapturingTui({
      fallbackModels: ["openai-codex:gpt-5.6-terra"],
      discoverModels,
    });

    const first = await resolveInfo(captured);
    const second = await resolveInfo(captured);

    expect(first.modelOptions?.["anthropic:claude-fable-5"]).toEqual(FABLE_MODEL_OPTIONS);
    expect(first.modelOptions?.["openai-codex:gpt-5.6-terra"]).toMatchObject({
      reasoning: true,
      contextWindow: 272_000,
    });
    expect(second).toEqual(first);
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });
});

describe("tui channel driver — process jobs", () => {
  it("does not expose process-job authority through the generic driver start contract", async () => {
    const captured = await startCapturingTui();
    expect(captured.processJobs).toBeUndefined();
    expect(captured.processJobsBearer).toBeUndefined();
  });

  it("rejects an arbitrary driver that merely claims the TUI id from the owner path", () => {
    const start = vi.fn(async () => ({ summary: {}, stop: async () => undefined }));
    const impostor = {
      id: "tui",
      label: "third-party impostor",
      loadConfig: async () => baseConfig,
      isConfigError: () => false,
      start,
    } satisfies ChannelDriver<TuiAdapterConfig>;
    const processJobs: ProcessJobOperator = {
      operatorToken: "must-not-leak",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("must not run"); },
    };

    expect(startAppOwnedTuiChannel(impostor, baseInput(), processJobs, undefined, undefined)).toBeUndefined();
    expect(start).not.toHaveBeenCalled();
  });

  it("passes the owner bearer and wakes one existing web thread through a normal history turn", async () => {
    let captured: TuiAdapterOptions | undefined;
    const deliverNotification = vi.fn(async (_input: DeliverWebNotificationInput) => ({ threadId: "thread-1", duplicate: false }));
    const driver = createTuiChannelDriver({
      adapterFactory: async (options): Promise<TuiAdapterStartResult> => {
        captured = options;
        return {
          url: "http://127.0.0.1:0",
          baseUrl: "http://127.0.0.1:0/gui",
          infoUrl: "http://127.0.0.1:0/gui/v1/info",
          turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
          host: "127.0.0.1",
          port: 0,
          stop: async () => undefined,
        };
      },
      ...NOOP_MODEL_DISCOVERY,
      discoverModels: async () => [],
      deliverNotification,
    });
    const respond = vi.fn<AgentResponder["respond"]>(async (_request: AgentRequestBase, _stream: AgentMessageStream) => ({ text: "Job finished safely." }));
    const deliverVerbatim = vi.fn(async () => undefined);
    const processJobs: ProcessJobOperator = {
      operatorToken: "owner-token",
      list: async () => [],
      get: async () => undefined,
      cancel: async () => { throw new Error("not used"); },
    };
    const start = startAppOwnedTuiChannel(driver, {
      ...baseInput(),
      responder: { respond, deliverVerbatim },
      sourceId: "agent-one",
    }, processJobs, undefined, undefined);
    if (start === undefined) throw new Error("expected the app-owned TUI start path");
    const running = await start;
    expect(captured?.processJobs).toBe(processJobs);
    expect(captured?.processJobsBearer).toBe("owner-token");

    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      processJob: PROCESS_JOB,
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      metadata: { source: "web", web: { trigger: "job" } },
    });
    expect(deliverVerbatim).not.toHaveBeenCalled();
    expect(deliverNotification).toHaveBeenCalledWith({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      threadId: "thread-1",
      processJob: PROCESS_JOB,
      text: "Job finished safely.",
    });

    respond.mockResolvedValueOnce({ parts: RICH_REPLY_PARTS });
    const partOnlyDeliveryKey = `${PROCESS_JOB.wake.deliveryKey}:part-only`;
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "render rich answer",
      deliveryKey: partOnlyDeliveryKey,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: partOnlyDeliveryKey },
      },
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(deliverNotification).toHaveBeenLastCalledWith({
      sourceId: "agent-one",
      triggerKind: "job",
      deliveryKey: partOnlyDeliveryKey,
      threadId: "thread-1",
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: partOnlyDeliveryKey },
      },
      parts: RICH_REPLY_PARTS,
    });

    respond.mockResolvedValueOnce({ text: "Rich answer ready.", parts: RICH_REPLY_PARTS });
    const mixedDeliveryKey = `${PROCESS_JOB.wake.deliveryKey}:mixed`;
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "render mixed answer",
      deliveryKey: mixedDeliveryKey,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: mixedDeliveryKey },
      },
    })).resolves.toMatchObject({ delivered: true, historyRecorded: true });
    expect(deliverNotification).toHaveBeenLastCalledWith(expect.objectContaining({
      deliveryKey: mixedDeliveryKey,
      text: "Rich answer ready.",
      parts: RICH_REPLY_PARTS,
    }));

    await expect(running.notify?.({
      conversationId: "web:thread-1#wrong-bucket",
      text: "wrong bucket",
      deliveryKey: PROCESS_JOB.wake.deliveryKey,
      processJob: PROCESS_JOB,
    })).resolves.toMatchObject({ delivered: false, code: "process_job_origin_mismatch" });
    expect(respond).toHaveBeenCalledTimes(3);

    respond.mockResolvedValueOnce({ text: "x".repeat(8_100) });
    await expect(running.notify?.({
      conversationId: "web:thread-1",
      text: "bounded untrusted wake",
      deliveryKey: `${PROCESS_JOB.wake.deliveryKey}:bounded`,
      processJob: {
        ...PROCESS_JOB,
        wake: { ...PROCESS_JOB.wake, deliveryKey: `${PROCESS_JOB.wake.deliveryKey}:bounded` },
      },
    })).resolves.toMatchObject({ delivered: true });
    const boundedNotification = deliverNotification.mock.calls.at(-1)?.[0];
    const boundedText = boundedNotification?.triggerKind === "job"
      ? boundedNotification.text
      : undefined;
    expect(boundedText).toHaveLength(8_000);
    expect(boundedText).toMatch(/… \[response truncated\]$/u);

    await expect(running.notify?.({ conversationId: "tui:direct", text: "wake" }))
      .resolves.toMatchObject({ delivered: false, code: "background_unsupported_channel" });
    expect(respond).toHaveBeenCalledTimes(4);
  });
});

const RICH_REPLY_PARTS = [
  {
    type: "attachment",
    id: "wake-attachment",
    reference: { scheme: "mono-agent-artifact", id: "wake-artifact" },
    name: "report.txt",
    mediaType: "text/plain",
    sizeBytes: 12,
    integrityId: `sha256:${"a".repeat(64)}`,
  },
  {
    type: "mcp_app",
    id: "11111111-1111-4111-8111-111111111111",
    invocationId: "11111111-1111-4111-8111-111111111111",
    connectionId: "wake-connection",
    serverName: "widgets",
    toolName: "show_chart",
    resourceUri: "ui://widgets/chart",
    mediaType: "text/html;profile=mcp-app",
    protocolVersion: "2026-01-26",
    title: "Wake chart",
  },
  {
    type: "failure",
    id: "wake-failure",
    code: "artifact_missing",
    message: "One optional artifact expired.",
  },
] as const satisfies readonly AgentReplyPart[];

const PROCESS_JOB: ProcessJobProjection = {
  schema: "mono-agent.process-job-projection.v1",
  jobId: "11111111-1111-4111-8111-111111111111",
  tool: "Exec",
  state: "succeeded",
  summary: "worker",
  origin: {
    conversationId: "web:thread-1#2026-07-21",
    channel: "web",
    runId: "run-1",
    historyBoundary: "web:thread-1",
    bucket: "2026-07-21",
  },
  timestamps: {
    admittedAt: "2026-07-21T09:00:00.000Z",
    queueDeadlineAt: "2026-07-21T09:05:00.000Z",
    startedAt: "2026-07-21T09:00:01.000Z",
    runtimeDeadlineAt: "2026-07-21T09:30:01.000Z",
    completedAt: "2026-07-21T09:00:02.000Z",
  },
  limits: { maxRuntimeMs: 1_800_000, maxOutputBytes: 1_048_576, previewChars: 2_000, chainDepth: 0 },
  output: { stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: null, stderrRef: null },
  wake: {
    state: "pending",
    attempts: 1,
    deliveryKey: "process-job:11111111-1111-4111-8111-111111111111",
    lastAttemptAt: "2026-07-21T09:00:03.000Z",
  },
  exitCode: 0,
  signal: null,
  durationMs: 1_000,
  cancelRequested: false,
  lastError: null,
};

const MONITOR: MonitorProjection = {
  schema: "mono-agent.monitor-projection.v1",
  monitorId: "22222222-2222-4222-8222-222222222222",
  state: "running",
  description: "Watching a local process",
  persistent: false,
  origin: {
    conversationId: "web:thread-1#2026-09-04",
    channel: "web",
    runId: "run-1",
    bucket: "2026-09-04",
  },
  timestamps: {
    startedAt: "2026-09-04T09:00:00.000Z",
    runtimeDeadlineAt: "2026-09-04T09:30:00.000Z",
    lastEventAt: "2026-09-04T09:00:01.000Z",
    completedAt: null,
  },
  limits: { maxRuntimeMs: 1_800_000, coalesceMs: 200, maxBatchLines: 200, maxBatchBytes: 65_536, chainDepth: 0 },
  counters: { seq: 3, batchesDelivered: 2, linesObserved: 4, linesDelivered: 3, droppedLines: 0, pendingLines: 0 },
  exitCode: null,
  signal: null,
  cancelRequested: false,
  lastError: null,
};


async function runningWebChannel(
  deliverNotification: (input: DeliverWebNotificationInput) => Promise<unknown>,
): Promise<RunningChannel> {
  const driver = createTuiChannelDriver({
    adapterFactory: async (): Promise<TuiAdapterStartResult> => ({
      url: "http://127.0.0.1:0",
      baseUrl: "http://127.0.0.1:0/gui",
      infoUrl: "http://127.0.0.1:0/gui/v1/info",
      turnsUrl: "http://127.0.0.1:0/gui/v1/turns",
      host: "127.0.0.1",
      port: 0,
      stop: async () => undefined,
    }),
    ...NOOP_MODEL_DISCOVERY,
    discoverModels: async () => [],
    deliverNotification: deliverNotification as never,
  });
  const start = startAppOwnedTuiChannel(driver, {
    ...baseInput(),
    responder: {
      respond: async () => ({ text: "Job finished safely." }),
      deliverVerbatim: async () => undefined,
    },
    sourceId: "agent-one",
  }, {
    operatorToken: "owner-token",
    list: async () => [],
    get: async () => undefined,
    cancel: async () => { throw new Error("not used"); },
  }, undefined, undefined);
  if (start === undefined) throw new Error("expected the app-owned TUI start path");
  return await start;
}

describe("web process-job wake classification", () => {
  const wakeInput = {
    conversationId: "web:thread-1",
    text: "bounded untrusted wake",
    deliveryKey: PROCESS_JOB.wake.deliveryKey,
    processJob: PROCESS_JOB,
  };

  it("retries only a failure that provably delivered nothing", async () => {
    // The console re-runs the wake turn on every accepted call, so a connect
    // failure is the one case safe to replay. Previously EVERY non-delivery was
    // permanent on attempt 1 and the completion turn was simply lost.
    const running = await runningWebChannel(async () => {
      throw new WebConsoleError("notification_ingress_unavailable", "console is down", 503);
    });

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "destination_channel_unavailable",
      retryable: true,
    });
  });

  it("keeps an ambiguous wake permanent so no job reports twice", async () => {
    for (const code of ["notification_ingress_timeout", "notification_delivery_failed", "invalid_notification_response"]) {
      const running = await runningWebChannel(async () => {
        throw new WebConsoleError(code, `failed: ${code}`, 502);
      });

      await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
        delivered: false,
        code: "process_job_wake_failed",
        retryable: false,
        ambiguous: true,
      });
    }
  });

  it("treats a missing wake receipt as ambiguous rather than merely failed", async () => {
    const running = await runningWebChannel(async () => ({ threadId: "thread-1", duplicate: false }));

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "process_job_wake_failed",
      retryable: false,
      ambiguous: true,
    });
  });

  it("keeps an origin mismatch non-retryable", async () => {
    const running = await runningWebChannel(async () => {
      throw new Error("must not be called");
    });

    await expect(running.processJobs?.wake({ ...wakeInput, conversationId: "web:other-thread" }))
      .resolves.toMatchObject({
        delivered: false,
        code: "process_job_origin_mismatch",
        retryable: false,
      });
  });

  it("reports a delivered wake unchanged", async () => {
    const running = await runningWebChannel(async () => ({
      threadId: "thread-1",
      duplicate: false,
      delivery: { delivered: true },
    }));

    await expect(running.processJobs?.wake(wakeInput)).resolves.toMatchObject({
      delivered: true,
      code: "delivered",
      channelId: "tui",
      historyRecorded: true,
    });
  });
});

describe("web Monitor wake classification", () => {
  const wakeInput = {
    conversationId: "web:thread-1",
    text: "bounded fenced Monitor envelope",
    deliveryKey: `monitor:${MONITOR.monitorId}:3`,
    monitor: MONITOR,
  };

  it("delivers the exact origin and key through the owner-authenticated web ingress", async () => {
    const deliver = vi.fn(async () => ({
      threadId: "thread-1",
      duplicate: false,
      delivery: { delivered: true as const, disposition: "follow_up" as const },
    }));
    const running = await runningWebChannel(deliver);

    await expect(running.monitors?.wake(wakeInput)).resolves.toMatchObject({
      delivered: true,
      code: "delivered",
      disposition: "follow_up",
      channelId: "tui",
      historyRecorded: true,
    });
    expect(deliver).toHaveBeenCalledWith({
      sourceId: "agent-one",
      triggerKind: "monitor",
      deliveryKey: wakeInput.deliveryKey,
      threadId: "thread-1",
      monitor: MONITOR,
      wakePrompt: wakeInput.text,
    });
  });

  it("retries only when the local ingress provably received nothing", async () => {
    const unavailable = await runningWebChannel(async () => {
      throw new WebConsoleError("notification_ingress_unavailable", "console is down", 503);
    });
    await expect(unavailable.monitors?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "destination_channel_unavailable",
      retryable: true,
    });

    for (const code of ["notification_ingress_timeout", "notification_delivery_failed", "invalid_notification_response"]) {
      const ambiguous = await runningWebChannel(async () => {
        throw new WebConsoleError(code, `failed: ${code}`, 502);
      });
      await expect(ambiguous.monitors?.wake(wakeInput)).resolves.toMatchObject({
        delivered: false,
        code: "monitor_wake_failed",
        retryable: false,
        ambiguous: true,
      });
    }
  });

  it("treats a missing receipt as ambiguous and rejects mismatched ownership before ingress", async () => {
    const deliver = vi.fn(async () => ({ threadId: "thread-1", duplicate: false }));
    const running = await runningWebChannel(deliver);
    await expect(running.monitors?.wake(wakeInput)).resolves.toMatchObject({
      delivered: false,
      code: "monitor_wake_failed",
      retryable: false,
      ambiguous: true,
    });

    await expect(running.monitors?.wake({ ...wakeInput, conversationId: "web:thread-2" }))
      .resolves.toMatchObject({ delivered: false, code: "monitor_origin_mismatch", retryable: false });
    await expect(running.monitors?.wake({ ...wakeInput, deliveryKey: `monitor:${MONITOR.monitorId}:2` }))
      .resolves.toMatchObject({ delivered: false, code: "monitor_origin_mismatch", retryable: false });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
