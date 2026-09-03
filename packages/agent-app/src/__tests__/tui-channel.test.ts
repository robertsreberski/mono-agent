import { realpath } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { AgentMessageStream, AgentReplyPart, AgentRequestBase, AgentResponder, ProcessJobOperator, ProcessJobProjection, RunningChannel } from "@mono-agent/agent-contracts";
import { MAX_INFO_BODY_BYTES, MAX_INFO_PROVIDER_ITEMS } from "@mono-agent/agent-contracts";
import { MAX_MODEL_REFERENCE_BYTES } from "@mono-agent/agent-runtime/ai/runtime/model-refs.js";
import type { DiscoveredLocalModel, DiscoveredProvider, LocalProviderDefinition } from "@mono-agent/runtime-adapter";
import type { TuiAdapterConfig, TuiAdapterInfo, TuiAdapterOptions, TuiAdapterStartResult } from "@mono-agent/operator-adapter";
import type { DeliverWebNotificationInput } from "@mono-agent/web";
import { WebConsoleError } from "@mono-agent/web";

import type { ChannelDriver, ChannelStartInput } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";
import { MAX_DISCOVERED_INFO_MODEL_BYTES, startAppOwnedTuiChannel } from "../channel-drivers/tui.js";
import { DEFAULT_MAX_ADVERTISED_PER_PROVIDER, MAX_PAGE_SIZE } from "../provider-model-catalog.js";

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
  readonly effort?: string;
  readonly fallbackModels?: readonly { provider: string; model: string }[];
  readonly localProviders?: readonly LocalProviderDefinition[];
  /** Canonical `providers.entries` list, for the provider-summary budget. */
  readonly providerEntries?: readonly { id: string }[];
}

function baseInput(options: BuildInputOptions = {}): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { provider: "anthropic", model: "claude-fable-5", reference: "anthropic:claude-fable-5" },
        workspace: "/tmp",
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        ...(options.fallbackModels === undefined ? {} : {
          fallbacks: options.fallbackModels.map((model) => ({
            model: { ...model, reference: `${model.provider}:${model.model}` },
          })),
        }),
      },
      context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
      tools: { disallowedTools: [] },
      ...(options.providerEntries !== undefined
        ? { providers: { entries: options.providerEntries } }
        : options.localProviders === undefined
          ? {}
          : { providers: { local: options.localProviders } }),
    } as never,
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
 * A canonical reference of exactly {@link MAX_MODEL_REFERENCE_BYTES} bytes —
 * the longest one that can now exist anywhere in the system.
 *
 * `requireQuotableReference` (agent-runtime's `model-refs.js`) rejects any
 * longer reference at parse, which is what the `/v1/info` budget fixtures below
 * are built on. LENGTH is no longer the axis a payload budget can be pushed
 * along: every fixture that used to reach for a 70,000- or 257-byte id now sits
 * at this ceiling and scales by COUNT instead, which nothing bounds — a local
 * `/v1/models` answer is arbitrarily long, and `runtime.fallbacks` is validated
 * for uniqueness, not for length.
 *
 * Derived from the constant rather than written as 96, so that if the parser's
 * ceiling moves these fixtures move with it instead of quietly testing a
 * reference the grammar no longer accepts.
 */
function refAtCeiling(head: string, filler = "x"): string {
  const headBytes = Buffer.byteLength(head, "utf8");
  if (headBytes > MAX_MODEL_REFERENCE_BYTES) {
    throw new Error(`fixture head is already past the reference ceiling: ${head}`);
  }
  if (Buffer.byteLength(filler, "utf8") !== 1) {
    throw new Error("fixture filler must be one UTF-8 byte so the ceiling is exact");
  }
  return `${head}${filler.repeat(MAX_MODEL_REFERENCE_BYTES - headBytes)}`;
}

/** An `openrouter:` route whose canonical reference sits exactly at the ceiling. */
function routeModelAtCeiling(index: number): string {
  const prefix = "openrouter:";
  return refAtCeiling(`${prefix}route-${String(index).padStart(6, "0")}-`, "m").slice(prefix.length);
}

/** An `lmstudio:` discovered ref sitting exactly at the ceiling. */
function discoveredRefAtCeiling(index: number, filler = "x"): string {
  return refAtCeiling(`lmstudio:model-${String(index).padStart(6, "0")}-`, filler);
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
        installedVersion: "0.20.11",
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
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "anthropic", model: "claude-fable-5" },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", "openai-codex:gpt-5.5"]);
  });

  it("publishes known provider context windows, preferring configured local capabilities", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [
        { provider: "openai-codex", model: "gpt-5.6-sol" },
        { provider: "openai-codex", model: "gpt-5.5" },
        { provider: "openai-codex", model: "gpt-5.6-terra" },
        { provider: "openai-codex", model: "gpt-5.4" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "unknown-provider", model: "unknown-model" },
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
    // A local endpoint's `/v1/models` answer is arbitrary text that no operator
    // authored and nothing upstream of `parseMonoRuntimeModelReference` bounds.
    // Two shapes can no longer BE a reference, and neither may reach a surface
    // that quotes what it is handed:
    //  - one byte past MAX_MODEL_REFERENCE_BYTES, so no operator surface could
    //    echo it whole (the ceiling IS the diagnostics echo budget);
    //  - a raw control character, which restyles or extends the line quoting it.
    //
    // What this case used to be: a 257-byte id -- one past the catalog's paging
    // bound -- kept in `models` while the catalog page dropped it, on the
    // premise that "a 257-byte model id parses, routes and runs exactly like a
    // 20-byte one". That premise is now false by construction: 96 bytes cap the
    // WHOLE reference, so the catalog's 256-byte id bound is unreachable for
    // anything that reaches `models` at all and the split it described cannot
    // occur. The claim it was bought for -- `/v1/info.models` is not gated on
    // catalog membership -- is now carried by the 600-model case below, on the
    // divergence that IS still reachable: the per-provider advertised cap.
    const overCeiling = `lmstudio:${"z".repeat(MAX_MODEL_REFERENCE_BYTES - "lmstudio:".length + 1)}`;
    // ESC: the exact code point that lets a model id repaint the line a daemon
    // log, `doctor` or the console prints it on.
    const controlCharacter = `lmstudio:qwen${String.fromCharCode(27)}[31m-3-8b`;
    expect(Buffer.byteLength(overCeiling, "utf8")).toBe(MAX_MODEL_REFERENCE_BYTES + 1);

    const discoverModels = vi.fn().mockResolvedValue([
      { ref: overCeiling, label: "over-ceiling", providerId: "lmstudio" },
      { ref: controlCharacter, label: "control", providerId: "lmstudio" },
      { ref: "lmstudio:llama-3.1", label: "llama-3.1", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[]);

    const captured = await startCapturingTui({ localProviders: LMSTUDIO, discoverModels });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual(["anthropic:claude-fable-5", "lmstudio:llama-3.1"]);
    expect(Object.keys(info.modelOptions ?? {}))
      .toEqual(["anthropic:claude-fable-5", "lmstudio:llama-3.1"]);
    // Asserted against the SERIALIZED body, not against `models` alone: a ref
    // that cannot be quoted must not appear in any field of the payload every
    // console renders, whichever one a future projection puts it in.
    const body = JSON.stringify(info);
    for (const rejected of [overCeiling, controlCharacter]) {
      expect(body).not.toContain(JSON.stringify(rejected).slice(1, -1));
    }
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
      ref: discoveredRefAtCeiling(index),
      label: "flood",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];
    expect(Buffer.byteLength(flood[0]!.ref, "utf8")).toBe(MAX_MODEL_REFERENCE_BYTES);

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
    // ordinary local install has, with every id as long as one can now be. They
    // serialize to ~174 KB across both /v1/info projections, well inside the
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
      ref: refAtCeiling(`lmstudio:hf.co/bartowski/Qwen3-${String(index).padStart(3, "0")}B-Instruct-`, "G"),
      label: "local",
      providerId: "lmstudio",
    })) satisfies DiscoveredLocalModel[];
    expect(Buffer.byteLength(catalog[0]!.ref, "utf8")).toBe(MAX_MODEL_REFERENCE_BYTES);

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
    // whose only reader is the picker. This is the reachable half of the claim
    // the 257-byte case used to carry: a discovered ref can no longer exceed
    // the catalog's 256-byte id bound, but it can still fall outside the page.
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

  it("skips only the oversized discovered row and keeps every ref behind it", async () => {
    const localProviders: readonly LocalProviderDefinition[] = [
      { id: "lmstudio", type: "lmstudio", baseUrl: "http://localhost:1234", enabled: true },
    ];
    // Heterogeneous costs on purpose. One pathological id must cost only
    // itself: `break` here would delete four runnable, selectable models
    // because a fifth one was too big, and /v1/info.models is the only list
    // the TUI's picker reads.
    const rows = [
      { ref: "lmstudio:small-0", label: "s0", providerId: "lmstudio" },
      { ref: "lmstudio:small-1", label: "s1", providerId: "lmstudio" },
      { ref: `lmstudio:${"x".repeat(200_000)}`, label: "huge", providerId: "lmstudio" },
      { ref: "lmstudio:small-2", label: "s2", providerId: "lmstudio" },
      { ref: "lmstudio:small-3", label: "s3", providerId: "lmstudio" },
    ] satisfies DiscoveredLocalModel[];

    const captured = await startCapturingTui({
      localProviders,
      discoverModels: async () => rows,
    });
    const info = await resolveInfo(captured);

    const expected = [
      "anthropic:claude-fable-5",
      "lmstudio:small-0",
      "lmstudio:small-1",
      "lmstudio:small-2",
      "lmstudio:small-3",
    ];
    expect(info.models).toEqual(expected);
    expect(Object.keys(info.modelOptions ?? {}).sort()).toEqual([...expected].sort());
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
    }] as unknown as readonly LocalProviderDefinition[];

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
    }] as unknown as readonly LocalProviderDefinition[];

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

  it("publishes a configured route no producer-side slice could have held", async () => {
    // ~800 KB across the two projections: more than any slice that also leaves
    // room for providers and skills, and yet a route a turn really would run
    // inside a body that still fits the shared 1 MiB cap. Round 3 dropped it at
    // a 128 KiB slice and round 4 dropped it again at 512 KiB; a slice bounds a
    // total, it does not rule on which authored content deserves to ship.
    const long = "m".repeat(400_000);
    const captured = await startCapturingTui({
      fallbackModels: [
        { provider: "openrouter", model: "gpt-5.6-sol" },
        { provider: "openrouter", model: long },
      ],
    });
    const info = await resolveInfo(captured);

    expect(info.models).toEqual([
      "anthropic:claude-fable-5",
      "openrouter:gpt-5.6-sol",
      `openrouter:${long}`,
    ]);
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
    // `requireQuotableReference` caps a reference at 96 bytes, so no single
    // route can weigh that much any more and the original vehicle is gone. The
    // guarantee it bought is not: a configured route is authored, so no
    // producer-side slice may drop one. With per-item size bounded, the only
    // way configured routes can press on a budget is by COUNT -- so that is what
    // this drives. Each route costs ~220 bytes across the two projections (the
    // ref twice, plus its option object), so 800 of them spend ~176 KB: past
    // the 128 KiB slice the old rule charged configured routes against, and
    // past any per-contributor ceiling short of the wire cap. Every one must
    // still ship.
    const configured = Array.from({ length: 800 }, (_unused, index) => ({
      provider: "openrouter",
      model: `route-${String(index).padStart(4, "0")}-${"m".repeat(60)}`,
    }));
    const flood = Array.from({ length: 5_000 }, (_unused, index) => ({
      ref: `lmstudio:model-${String(index).padStart(6, "0")}-${"x".repeat(60)}`,
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
    for (const route of configured) {
      expect(info.models).toContain(`${route.provider}:${route.model}`);
    }
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
      fallbackModels: [{ provider: "ollama", model: "qwen3.6:latest" }],
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
      fallbackModels: [{ provider: "openrouter", model: "gpt-5.6-sol" }],
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
      }] as unknown as readonly DiscoveredProvider[],
    });
    const info = await resolveInfo(captured);

    expect(info.providers?.map((provider) => provider.id)).toContain("ollama");
    const page = captured.modelCatalog?.({ provider: "ollama", limit: 10 });
    expect(page?.models.map((model) => model.id)).toContain("gemma4:31b");
  });

  it("keeps the serialized /v1/info payload under the byte budget with openrouter configured", async () => {
    const captured = await startCapturingTui({
      fallbackModels: [{ provider: "openrouter", model: "gpt-5.6-sol" }],
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
        { provider: "openai-codex", model: "gpt-5.6-terra" },
        { provider: "anthropic", model: "claude-sonnet-4-6" },
        { provider: "unknown-provider", model: "gemini" },
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
      fallbackModels: [{ provider: "openai-codex", model: "gpt-5.6-terra" }],
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

    expect(startAppOwnedTuiChannel(impostor, baseInput(), processJobs)).toBeUndefined();
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
    }, processJobs);
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
    const boundedText = deliverNotification.mock.calls.at(-1)?.[0].text;
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
  });
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
