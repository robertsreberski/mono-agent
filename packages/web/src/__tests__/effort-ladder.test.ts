import { join } from "node:path";

import { EFFORT_LEVELS } from "@mono-agent/config";
import { afterEach, describe, expect, it } from "vitest";

import {
  advertisedEffortLevels,
  effortLevelsForModel,
  GLOBAL_EFFORT_LEVELS,
} from "../effort-ladder.js";
import { WebService } from "../service.js";
import { fakeDiscoveredAgent, operatorFetch, temporaryRoot } from "./helpers.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

/**
 * Every reasoning shape a real producer emits, with the ladder the one rule
 * resolves it to.
 *
 * `packages/web/webapp/src/components/model-catalog.test.ts` pins this exact
 * table against the browser's helper. The webapp is its own pnpm workspace, so
 * the table cannot be imported across the boundary -- but both ends call
 * `effort-ladder.ts`, and each end's test asserts its own public helper agrees
 * with it. Re-deriving the rule on either end therefore turns that end red,
 * which is the drift this pair exists to catch: for a while the server fell
 * through to the global ladder on silence while the browser returned nothing,
 * so the picker hid grades `startTurn` was accepting.
 */
const EFFORT_RULE_CASES = [
  {
    name: "levels the page enumerated",
    advertisement: { reasoning: true, reasoningMode: "effort", effortLevels: ["low", "high"] },
    ladder: ["low", "high"],
  },
  {
    // A real Ollama provider with `reasoning_mode: "effort"` and no
    // `reasoning_levels` produces exactly this.
    name: "graded effort with no levels enumerated",
    advertisement: { reasoning: true, reasoningMode: "effort" },
    ladder: [...GLOBAL_EFFORT_LEVELS],
  },
  {
    name: "binary thinking",
    advertisement: { reasoning: true, reasoningMode: "toggle" },
    ladder: ["high", "none"],
  },
  { name: "no reasoning at all", advertisement: { reasoning: false }, ladder: [] },
  { name: "reasoning mode none", advertisement: { reasoning: true, reasoningMode: "none" }, ladder: [] },
  { name: "an explicitly empty list", advertisement: { reasoning: true, effortLevels: [] }, ladder: [] },
  { name: "reasoning with unknown grades", advertisement: { reasoning: true }, ladder: [] },
  { name: "said nothing at all", advertisement: {}, ladder: [...GLOBAL_EFFORT_LEVELS] },
] as const;

const shortlistAgent = {
  modelOptions: Object.fromEntries(
    EFFORT_RULE_CASES.map((entry, index) => [`m${String(index)}`, entry.advertisement]),
  ),
};

describe("the shared effort rule", () => {
  it("keeps the duplicated global ladder equal to the canonical one", () => {
    // `effort-ladder.ts` must not import `@mono-agent/config`: the webapp is a
    // separate workspace and could not resolve it. This is the pin that keeps
    // the copy honest.
    expect([...GLOBAL_EFFORT_LEVELS]).toEqual([...EFFORT_LEVELS]);
  });

  it.each(EFFORT_RULE_CASES)("resolves $name from a shortlist entry", ({ advertisement, ladder }) => {
    const model = Object.keys(shortlistAgent.modelOptions)
      .find((key) => shortlistAgent.modelOptions[key] === advertisement);
    expect(effortLevelsForModel(shortlistAgent, model, undefined)).toEqual(ladder);
  });

  it.each(EFFORT_RULE_CASES)("resolves $name from a catalog row", ({ advertisement, ladder }) => {
    // A catalog row reaches the rule already resolved, so the same shape must
    // land on the same ladder whichever side of `/v1/info` described it.
    expect(effortLevelsForModel(
      { modelOptions: {} },
      "unlisted",
      advertisedEffortLevels(advertisement),
    )).toEqual(ladder);
  });

  it("falls back to a legacy agent's single ladder, then to the global one", () => {
    expect(effortLevelsForModel({ efforts: ["low"] }, "anything", undefined)).toEqual(["low"]);
    expect(effortLevelsForModel({}, "anything", undefined)).toEqual([...GLOBAL_EFFORT_LEVELS]);
  });
});

describe("WebService effort validation", () => {
  const catalogModels = EFFORT_RULE_CASES.map((entry, index) => ({
    id: `c${String(index)}`,
    name: `Case ${String(index)}`,
    provider: "localx",
    providerLabel: "Local X",
    ...entry.advertisement,
  }));

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/v1/info")) {
      return Response.json({
        schema: 1,
        model: "m0",
        models: Object.keys(shortlistAgent.modelOptions),
        modelOptions: shortlistAgent.modelOptions,
        capabilities: { attachments: true },
      });
    }
    if (/\/v1\/models(?:\?|$)/u.test(url)) {
      return Response.json({ models: catalogModels, truncated: false });
    }
    return operatorFetch()(input, init);
  }) as typeof fetch;

  it("accepts exactly the grades the shared rule resolves, for shortlist and catalog alike", async () => {
    const base = await temporaryRoot();
    cleanup.push(base);
    const service = await WebService.create({
      stateDir: join(base, "state"),
      discoveryIntervalMs: 0,
      purgeIntervalMs: 0,
      discoverImpl: async () => [fakeDiscoveredAgent()],
      fetchImpl,
    });
    await service.agentModels("agent-one", { provider: "localx", limit: 50 });

    const probe = async (model: string, effort: string): Promise<"accepted" | "rejected"> => {
      const thread = service.createThread("agent-one");
      try {
        await service.startTurn(thread.id, { text: "probe", model, effort });
        return "accepted";
      } catch {
        return "rejected";
      }
    };

    for (const [index, entry] of EFFORT_RULE_CASES.entries()) {
      for (const reference of [`m${String(index)}`, `localx:c${String(index)}`]) {
        const ladder: readonly string[] = entry.ladder;
        const allowed = ladder[0];
        const denied = GLOBAL_EFFORT_LEVELS.find((level) => !ladder.includes(level));
        if (allowed !== undefined) {
          expect([reference, allowed, await probe(reference, allowed)])
            .toEqual([reference, allowed, "accepted"]);
        }
        if (denied !== undefined) {
          expect([reference, denied, await probe(reference, denied)])
            .toEqual([reference, denied, "rejected"]);
        }
      }
    }

    const deadline = Date.now() + 5_000;
    while (service.store.listActiveTurnIds().length > 0) {
      if (Date.now() >= deadline) throw new Error("Turns did not drain.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await service.stop();
  });
});
