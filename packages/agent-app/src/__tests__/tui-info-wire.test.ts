import { afterEach, describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { MAX_INFO_BODY_BYTES } from "@mono-agent/agent-contracts";
import type { MonoAgentConfig } from "@mono-agent/config";
import type { TuiAdapterConfig } from "@mono-agent/operator-adapter";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { OperatorClient } from "@mono-agent/web";

import type { ChannelStartInput, RunningChannel } from "../channels.js";
import { createTuiChannelDriver } from "../channels.js";

/**
 * The `/v1/info` producer and its console consumer, wired end to end over a
 * real loopback HTTP server.
 *
 * Every other `/v1/info` test in this package stops at the producer's info
 * builder. That is exactly the seam the previous round's provider test missed:
 * it constructed the 71-provider shape that breaks and passed, because nothing
 * ever parsed the body the way the console does. A wire contract is only proven
 * where both halves meet, so these cases go through `startTuiAdapter` and a
 * real `OperatorClient`.
 */

const noopResponder: AgentResponder = {
  async respond() {
    return {};
  },
};

interface WireOptions {
  /** AUTHORED reference strings. Parsed here, never hand-built — see `wireInput`. */
  readonly fallbackModels?: readonly string[];
  readonly providerEntries?: readonly { id: string }[];
}

/**
 * A realistically long canonical reference — a SIZE, not a bound.
 *
 * The parser imposes no length rule (`requireQuotableReference`, agent-runtime's
 * `model-refs.js`): what a model may be called is decided by providers. So the fixtures here
 * sit at a length real references reach — `ollama:<model>:<tag>`, whose two halves Ollama
 * validates at 80 bytes each — written as a literal rather than derived from any constant the
 * producer enforces, because a fixture computed from the bound under test survives changing it.
 *
 * Every size fixture in this file scales by COUNT off this. The cases here once carried
 * 70,000- and 2,097,152-byte model ids in a config the loader could not have produced, which
 * proved nothing about the producer's behaviour on state it can reach. The number of configured
 * routes is the axis that is genuinely unbounded — `runtime.fallbacks` is validated for
 * uniqueness, not for count — so that is the axis the sweep uses. A single ENORMOUS reference
 * is reachable again now that the ceiling is gone, and it gets its own case at the end, where
 * what it proves is about the fence rather than about the sweep.
 */
const LONG_REFERENCE_BYTES = 168;

function longRouteReference(index: number): string {
  const head = `openrouter:route-${String(index).padStart(6, "0")}-`;
  const headBytes = Buffer.byteLength(head, "utf8");
  return `${head}${"m".repeat(LONG_REFERENCE_BYTES - headBytes)}`;
}

function longRouteReferences(count: number): readonly string[] {
  return Array.from({ length: count }, (_unused, index) => longRouteReference(index));
}

/**
 * A COMPLETE, fully typed `MonoAgentConfig`. No cast.
 *
 * This fixture used to be `{...} as never`, and that cast was not innocent: it waived checking
 * on the fields the fixture DOES supply, which is how references like `{ provider, model,
 * reference }` with a 70,000-byte model half — a value `parseRuntimeModelReference` cannot
 * produce and no loader could ever hand this driver — got in and made two of these cases
 * assert nothing. Supplying the handful of fields the driver never reads (`artifacts`,
 * `traceability`, `runtime.session`) costs five lines and buys the compiler back.
 */
function wireCoreConfig(options: WireOptions): MonoAgentConfig {
  return {
    runtime: {
      model: parseMonoRuntimeModelReference("anthropic:claude-fable-5"),
      workspace: "/tmp",
      session: { mode: "continuous", idleTimeoutMs: 300_000 },
      ...(options.fallbackModels === undefined ? {} : {
        // Through the REAL parser, exactly as the config loader builds these. A fixture that
        // names something the parser refuses now fails at construction instead of quietly
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
    ...(options.providerEntries === undefined ? {} : { providers: { entries: options.providerEntries } }),
  };
}

function wireInput(options: WireOptions): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: wireCoreConfig(options),
    responder: noopResponder,
    cwd: "/tmp",
    onFailure: () => {},
    config: {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/gui",
      allowNonLoopback: false,
    },
  };
}

const running: RunningChannel[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
});

/**
 * Start the REAL adapter and read `/v1/info` twice: once as bytes on the wire,
 * once through the REAL console client. Both halves of every assertion below
 * come from the same running server.
 */
async function readInfoOverTheWire(options: WireOptions) {
  const driver = createTuiChannelDriver({
    discoverModels: async () => [],
    discoverProviders: async () => [],
  });
  const channel = await driver.start(wireInput(options));
  running.push(channel);
  const baseUrl = channel.summary?.baseUrl;
  if (typeof baseUrl !== "string") throw new Error("The TUI adapter reported no base URL.");
  const text = await (await fetch(`${baseUrl}/v1/info`)).text();
  const bodyBytes = Buffer.byteLength(text, "utf8");
  const sent = JSON.parse(text) as { readonly providers?: readonly { readonly id: string }[] };
  const sentProviderIds = (sent.providers ?? []).map((provider) => provider.id);
  const info = await new OperatorClient({ baseUrl }).info();
  return { info, bodyBytes, sentProviderIds };
}

describe("/v1/info over the real producer -> consumer wire", () => {
  it("delivers a large but entirely valid configured fallback chain to the console", async () => {
    // Every one of these is a route a turn really would run: a distinct
    // `openrouter:` reference, at the parse ceiling, through the same parser the
    // config loader uses. The complete body lands far under the 1 MiB wire cap,
    // so no producer budget has any business dropping one.
    const routes = longRouteReferences(400);
    const { info, bodyBytes } = await readInfoOverTheWire({ fallbackModels: routes });

    const published = new Set(info.models ?? []);
    expect(routes.filter((route) => !published.has(route))).toEqual([]);
    // It really did ride the wire rather than being shed at the fence, and the
    // complete body is still nowhere near the cap that would show the agent
    // offline. (The 70,000-byte single-ref version of this case measured 140,731
    // bytes on the parent of the budget commit; the same order of magnitude is
    // reached here by count, which is the axis that is still unbounded.)
    expect(bodyBytes).toBeGreaterThan(140_000);
    expect(bodyBytes).toBeLessThan(1024 * 1024);
  });

  it("delivers the configured route's provider when the catalog overflows the console's window", async () => {
    // 70 declared vendors plus the route provider the catalog appends last:
    // 71 entries, comfortably inside every byte budget, and one past the
    // console's 64-entry parse window. A producer that emits in catalog order
    // hands the console 64 vendors and no `anthropic`.
    const providerEntries = Array.from({ length: 70 }, (_unused, index) => ({
      id: `vendor-${String(index).padStart(5, "0")}`,
    }));

    const { info, sentProviderIds } = await readInfoOverTheWire({ providerEntries });

    // Guard against the case going vacuous: the producer must still be sending
    // more entries than the console will parse, or this proves nothing.
    expect(sentProviderIds.length).toBeGreaterThan(64);
    expect(sentProviderIds).toContain("anthropic");
    expect(info.providers?.map((provider) => provider.id)).toContain("anthropic");
  });

  it("agrees with the console on how long a provider id may be", async () => {
    // 129 bytes: one over the console's id bound, well inside the producer's.
    // Either both halves publish it or neither does; a slot spent on an entry
    // the consumer throws away is a provider the operator silently loses.
    const longId = `vendor-${"i".repeat(122)}`;
    expect(Buffer.byteLength(longId, "utf8")).toBe(129);

    const { info, sentProviderIds } = await readInfoOverTheWire({
      providerEntries: [{ id: longId }],
    });

    expect(sentProviderIds).toContain(longId);
    // Nothing the producer put inside the window is discarded on arrival.
    expect(info.providers?.map((provider) => provider.id)).toEqual(sentProviderIds);
  });

  /** One `/v1/info` read with `routeCount` configured OpenRouter fallbacks, each at the ceiling. */
  async function probeConfiguredRoutes(routeCount: number) {
    const routes = longRouteReferences(routeCount);
    const { info, bodyBytes } = await readInfoOverTheWire({ fallbackModels: routes });
    const published = new Set(info.models ?? []);
    return {
      routeCount,
      bodyBytes,
      present: routes.every((route) => published.has(route)),
      // The fence sheds WHOLE fields. `models` present but missing one of these
      // routes can only be the PRODUCER having adjudicated it away.
      modelsShed: info.models === undefined,
    };
  }

  /**
   * Bytes of headroom left below the shared cap by the largest probe, so the
   * sweep's top rung is unambiguously inside the cap rather than balanced on it.
   */
  const PROBE_HEADROOM_BYTES = 1024;

  it("never drops a valid configured route from a body that fits, at any chain size", async () => {
    // A test pinned to one size is how this defect survived two review rounds:
    // round 3 bounded the model projection and dropped a valid route, round 4
    // kept the rule and raised the constant from 128 KiB to 512 KiB, and the
    // test it shipped with — one 70,000-byte ref — went green while the next
    // size along still lost the route. So no size here is a fixture.
    //
    // The sweep runs along the axis a producer budget can actually be pushed
    // along without any single item being pathological: COUNT. A chain of valid
    // distinct routes is precisely what the operator authored and what no budget
    // may adjudicate away, and it is the shape that distinguishes "the slice is
    // too small" from "one entry is too big".
    //
    // Two small probes measure what the REAL producer charges per route, and the
    // largest chain whose COMPLETE body still fits the one bound both halves
    // share is extrapolated from that. Neither measurement asks the producer
    // whether it admitted anything, so the oracle cannot be fooled by the
    // behaviour under test. The sweep then runs in eighths up to that edge,
    // which is what makes it unsatisfiable by a bigger constant: any slice below
    // the cap fails the top rungs, and a slice at the cap can no longer reject
    // anything the fence would have accepted.
    const near = await probeConfiguredRoutes(100);
    const far = await probeConfiguredRoutes(1_000);
    // Calibration must itself have shipped, or the slope below is meaningless.
    expect([near.present, far.present]).toEqual([true, true]);
    const bytesPerRoute = (far.bodyBytes - near.bodyBytes) / (far.routeCount - near.routeCount);
    // A ref rides the wire twice: once in `models`, once as a `modelOptions` key.
    expect(bytesPerRoute).toBeGreaterThanOrEqual(2 * LONG_REFERENCE_BYTES);

    const largestFittingChain = far.routeCount + Math.floor(
      (MAX_INFO_BODY_BYTES - far.bodyBytes - PROBE_HEADROOM_BYTES) / bytesPerRoute,
    );
    const probes = [near, far];
    for (let eighth = 1; eighth <= 8; eighth += 1) {
      probes.push(await probeConfiguredRoutes(Math.floor((largestFittingChain * eighth) / 8)));
    }

    // Every probe fits by construction, so the fence never had to fire...
    expect(probes.filter((probe) => probe.modelsShed)).toEqual([]);
    // ...and every probe must therefore have carried EVERY route it declared.
    expect(probes.filter((probe) => !probe.present)).toEqual([]);
    // And carried them on the wire, not merely in a body the fence had emptied:
    // each response is at least as large as the two copies of each ref it holds.
    expect(probes.filter((probe) =>
      probe.bodyBytes <= probe.routeCount * LONG_REFERENCE_BYTES * 2)).toEqual([]);
    // The sweep really did reach the edge of the shared cap, so there is no room
    // left under it for a producer-side slice to have been the deciding bound.
    const edge = probes.at(-1);
    expect(edge?.bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    expect(edge?.bodyBytes).toBeGreaterThan(MAX_INFO_BODY_BYTES - PROBE_HEADROOM_BYTES * 4);
  });

  it("leaves what genuinely cannot ship to the fence, not to a producer budget", async () => {
    // A chain whose serialized projections are several times the shared cap.
    // Nothing bounds how many routes an operator may declare, so this body truly
    // cannot go out whole — and it is still made of nothing but valid, runnable
    // routes, which is what makes shedding the only honest answer.
    const routes = longRouteReferences(
      Math.ceil((MAX_INFO_BODY_BYTES * 2) / (LONG_REFERENCE_BYTES * 2)),
    );
    const { info, bodyBytes } = await readInfoOverTheWire({ fallbackModels: routes });

    // The fence sheds whole optional fields, so the console sees `models` gone
    // — never a `models` list quietly missing some authored routes while the
    // routes the producer preferred are still in it.
    expect(info.models).toBeUndefined();
    expect(bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    // Degraded, not offline: the liveness half of the body still answers.
    expect(info.schema).toBe(1);
  });

  it("bounds the wire body when ONE configured route is larger than the whole cap", async () => {
    // The property the retired parse ceiling was standing in for, asserted at the layer that
    // actually owns it. While the ceiling existed this state was unreachable and nothing here
    // had to hold; the ceiling is gone — a grammar layer does not get to decide what a provider
    // calls a model — so an operator can now configure a route whose reference alone dwarfs the
    // `/v1/info` cap, and the producer must still not put an over-cap body on the wire.
    //
    // Over the cap the console does not degrade, it shows the agent OFFLINE, so "the fence
    // catches it" is the difference between a lossy picker and an agent that looks dead.
    // Configured routes deliberately get NO producer-side slice — a slice would be an opinion
    // about which authored route deserves to ship — so the fence is the only thing between this
    // body and the wire, and this is the case that proves the fence is really total.
    const enormous = `openrouter:${"m".repeat(2 * 1024 * 1024)}`;
    expect(parseMonoRuntimeModelReference(enormous).reference).toBe(enormous);
    // Guard against the case going vacuous. The reference ALONE is twice the whole
    // cap, so no body carrying it could ever have fitted: `models` is absent below
    // because the fence fired, not because the producer had nothing to publish. The
    // case after this one shows the same producer publishing an ordinary chain.
    expect(Buffer.byteLength(enormous, "utf8")).toBeGreaterThan(MAX_INFO_BODY_BYTES);

    const { info, bodyBytes } = await readInfoOverTheWire({ fallbackModels: [enormous] });

    expect(bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    // Shed whole, never a `models` list quietly truncated in the middle of a reference.
    expect(info.models).toBeUndefined();
    expect(info.modelOptions).toBeUndefined();
    // And the agent is still reachable and still negotiating capabilities honestly.
    expect(info.schema).toBe(1);
  });

  it("still delivers ordinary routes configured alongside an oversized one", async () => {
    // The other half: a fence that answered an oversized route by emptying the picker for
    // everyone would be bounded and useless. `models` is shed as a whole field only when it
    // genuinely cannot fit, so a chain that fits WITH the oversized route removed from the
    // config must arrive complete.
    const routes = longRouteReferences(50);
    const { info, bodyBytes } = await readInfoOverTheWire({ fallbackModels: routes });

    expect(bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    const published = new Set(info.models ?? []);
    expect(routes.filter((route) => !published.has(route))).toEqual([]);
  });
});
