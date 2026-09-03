import { afterEach, describe, expect, it } from "vitest";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import { MAX_INFO_BODY_BYTES } from "@mono-agent/agent-contracts";
import type { TuiAdapterConfig } from "@mono-agent/operator-adapter";
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
  readonly fallbackModels?: readonly { provider: string; model: string }[];
  readonly providerEntries?: readonly { id: string }[];
}

function wireInput(options: WireOptions): ChannelStartInput<TuiAdapterConfig> {
  return {
    coreConfig: {
      runtime: {
        model: { provider: "anthropic", model: "claude-fable-5", reference: "anthropic:claude-fable-5" },
        workspace: "/tmp",
        ...(options.fallbackModels === undefined ? {} : {
          fallbacks: options.fallbackModels.map((model) => ({
            model: { ...model, reference: `${model.provider}:${model.model}` },
          })),
        }),
      },
      context: { identityPath: "/tmp/IDENTITY.md", selectedSkills: [] },
      tools: { disallowedTools: [] },
      ...(options.providerEntries === undefined ? {} : { providers: { entries: options.providerEntries } }),
    } as never,
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
  it("delivers a long but valid configured fallback to the console", async () => {
    // The model-reference grammar has no length bound, so this names a route a
    // turn really would run. The complete body stays far under the 1 MiB wire
    // cap, so no budget has any business dropping it.
    const model = "m".repeat(70_000);
    const { info, bodyBytes } = await readInfoOverTheWire({
      fallbackModels: [{ provider: "openrouter", model }],
    });

    expect(info.models).toContain(`openrouter:${model}`);
    // It really did ride the wire rather than being shed at the fence, and the
    // complete body is still nowhere near the cap that would show the agent
    // offline. (Measured on the parent of the budget commit: 140,731 bytes.)
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

  /** One `/v1/info` read with a single configured OpenRouter fallback of `refBytes`. */
  async function probeConfiguredRoute(refBytes: number) {
    const model = "m".repeat(refBytes);
    const { info, bodyBytes } = await readInfoOverTheWire({
      fallbackModels: [{ provider: "openrouter", model }],
    });
    return {
      refBytes,
      bodyBytes,
      present: info.models?.includes(`openrouter:${model}`) === true,
      // The fence sheds WHOLE fields. `models` present but missing this route
      // can only be the PRODUCER having adjudicated it away.
      modelsShed: info.models === undefined,
    };
  }

  /**
   * Bytes of headroom left below the shared cap by the largest probe, so the
   * sweep's top rung is unambiguously inside the cap rather than balanced on it.
   */
  const PROBE_HEADROOM_BYTES = 1024;

  it("never drops a valid configured route from a body that fits, at any size", async () => {
    // A test pinned to one size is how this defect survived two review rounds:
    // round 3 bounded the model projection and dropped a valid route, round 4
    // kept the rule and raised the constant from 128 KiB to 512 KiB, and the
    // test it shipped with — one 70,000-byte ref — went green while the next
    // size along still lost the route. So no size here is a fixture.
    //
    // Two small probes measure what the REAL producer charges per byte of ref,
    // and the largest ref whose COMPLETE body still fits the one bound both
    // halves share is extrapolated from that. Neither measurement asks the
    // producer whether it admitted anything, so the oracle cannot be fooled by
    // the behaviour under test. The sweep then runs in eighths up to that edge,
    // which is what makes it unsatisfiable by a bigger constant: any slice below
    // the cap fails the top rungs, and a slice at the cap can no longer reject
    // anything the fence would have accepted.
    const near = await probeConfiguredRoute(1_000);
    const far = await probeConfiguredRoute(100_000);
    // Calibration must itself have shipped, or the slope below is meaningless.
    expect([near.present, far.present]).toEqual([true, true]);
    const bytesPerRefByte = (far.bodyBytes - near.bodyBytes) / (far.refBytes - near.refBytes);
    // A ref rides the wire twice: once in `models`, once as a `modelOptions` key.
    expect(bytesPerRefByte).toBeGreaterThanOrEqual(2);

    const largestFittingRef = far.refBytes + Math.floor(
      (MAX_INFO_BODY_BYTES - far.bodyBytes - PROBE_HEADROOM_BYTES) / bytesPerRefByte,
    );
    const probes = [near, far];
    for (let eighth = 1; eighth <= 8; eighth += 1) {
      probes.push(await probeConfiguredRoute(Math.floor((largestFittingRef * eighth) / 8)));
    }

    // Every probe fits by construction, so the fence never had to fire...
    expect(probes.filter((probe) => probe.modelsShed)).toEqual([]);
    // ...and every probe must therefore have carried its route.
    expect(probes.filter((probe) => !probe.present)).toEqual([]);
    // And carried it on the wire, not merely in a body the fence had emptied:
    // each response is at least as large as the two copies of the ref it holds.
    expect(probes.filter((probe) => probe.bodyBytes <= probe.refBytes * 2)).toEqual([]);
    // The sweep really did reach the edge of the shared cap, so there is no room
    // left under it for a producer-side slice to have been the deciding bound.
    const edge = probes.at(-1);
    expect(edge?.bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    expect(edge?.bodyBytes).toBeGreaterThan(MAX_INFO_BODY_BYTES - PROBE_HEADROOM_BYTES * 4);
  });

  it("leaves what genuinely cannot ship to the fence, not to a producer budget", async () => {
    // Twice the shared cap in a single ref: this one truly cannot go out whole.
    const model = "m".repeat(MAX_INFO_BODY_BYTES * 2);
    const { info, bodyBytes } = await readInfoOverTheWire({
      fallbackModels: [{ provider: "openrouter", model }],
    });

    // The fence sheds whole optional fields, so the console sees `models` gone
    // — never a `models` list quietly missing one authored route while the
    // routes the producer preferred are still in it.
    expect(info.models).toBeUndefined();
    expect(bodyBytes).toBeLessThanOrEqual(MAX_INFO_BODY_BYTES);
    // Degraded, not offline: the liveness half of the body still answers.
    expect(info.schema).toBe(1);
  });
});
