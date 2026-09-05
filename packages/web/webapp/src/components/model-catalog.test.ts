import { describe, expect, it } from "vitest";
import * as ladder from "../../../src/effort-ladder.js";
import { advertisedEffortLevels, effortLevelsForModel } from "../../../src/effort-ladder.js";
import type { CatalogModel } from "../types";
import { agent } from "../test/fixtures";
import * as catalog from "./model-catalog";
import {
  AUTOMATIC_MODEL_ID,
  buildSelectorModels,
  defaultEffortName,
  effectiveModelForAgent,
  effortLevelsForAgentModel,
  effortName,
  GLOBAL_EFFORT_LEVELS,
  groupSelectorModels,
  providerOfModel,
  selectorProvides,
} from "./model-catalog";

const codex = "pi:openai-codex:gpt-5.5";
const sonnet = "anthropic:claude-sonnet-4.5";
const shortlist: readonly string[] = [codex, sonnet];

/**
 * `/v1/models` emits provider-local ids — `{provider:"anthropic", id:"opus-5"}` —
 * NOT canonical `<provider>:<model>` references. Fixtures must use that shape:
 * feeding an already-canonical id here hides the canonicalization entirely.
 */
const catalogModel = (
  id: string,
  provider: string,
  providerLabel: string,
  overrides: {
    readonly name?: string;
    readonly contextWindow?: number;
    readonly reasoning?: boolean;
    readonly effortLevels?: readonly string[];
    readonly reasoningMode?: string;
  } = {},
): CatalogModel => ({
  id,
  name: overrides.name ?? id,
  provider,
  providerLabel,
  ...(overrides.contextWindow !== undefined
    ? { contextWindow: overrides.contextWindow }
    : {}),
  ...(overrides.reasoning !== undefined
    ? { reasoning: overrides.reasoning }
    : {}),
  ...(overrides.effortLevels !== undefined
    ? { effortLevels: overrides.effortLevels }
    : {}),
  ...(overrides.reasoningMode !== undefined
    ? { reasoningMode: overrides.reasoningMode }
    : {}),
});

const source = agent("agent", {
  models: shortlist,
  defaultModel: sonnet,
  defaultEffort: "high",
  modelOptions: {
    [codex]: { label: "GPT-5.5 Codex", reasoning: true, effortLevels: ["low", "high"] },
    [sonnet]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["medium", "high"] },
  },
});

describe("providerOfModel", () => {
  it("reads the provider from a colon reference", () => {
    expect(providerOfModel("pi:openai-codex:gpt-5.5")).toBe("pi");
    expect(providerOfModel("anthropic:claude-sonnet-4.5")).toBe("anthropic");
  });

  it("reads the provider from a slash reference and leaves bare ids alone", () => {
    expect(providerOfModel("provider/catalog-widened")).toBe("provider");
    expect(providerOfModel("onlycatalog")).toBe("onlycatalog");
  });
});

/**
 * The same table `packages/web/src/__tests__/effort-ladder.test.ts` pins on the
 * server. The webapp is its own pnpm workspace, so the table itself cannot be
 * imported across the boundary -- but the rule can be, and is. Each end asserts
 * its own public helper against `effort-ladder.ts`, so re-deriving the rule on
 * either end turns that end red. That is the drift this pair exists to catch:
 * the server fell through to the global ladder on silence while this helper
 * returned nothing, so the picker hid grades `startTurn` was accepting.
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

describe("the shared effort rule, as this end applies it", () => {
  it.each(EFFORT_RULE_CASES)("resolves $name from a shortlist entry", ({ advertisement, ladder }) => {
    const configured = agent("agent", {
      models: ["route"],
      defaultModel: "route",
      modelOptions: { route: advertisement },
    });
    expect(effortLevelsForAgentModel(configured, "route")).toEqual(ladder);
    expect(effortLevelsForAgentModel(configured, "route"))
      .toEqual(effortLevelsForModel(configured, "route", undefined));
  });

  it.each(EFFORT_RULE_CASES)("resolves $name from a catalog row", ({ advertisement, ladder }) => {
    const row = catalogModel("row", "localx", "Local X", advertisement);
    expect(effortLevelsForAgentModel(source, "localx:row", row)).toEqual(ladder);
    expect(effortLevelsForAgentModel(source, "localx:row", row))
      .toEqual(effortLevelsForModel(source, "localx:row", advertisedEffortLevels(row)));
  });

  it("offers the same permissive floor the server validates against", () => {
    // A modern agent (it has `modelOptions`) says nothing about a model reached
    // only through the catalog. Returning [] here hid every grade while
    // `WebService.startTurn` accepted them: the picker cleared a selection the
    // server would have run.
    expect(effortLevelsForAgentModel(source, "localx:reasoner")).toEqual([...GLOBAL_EFFORT_LEVELS]);
    expect(effortLevelsForAgentModel(source, "localx:reasoner", catalogModel("reasoner", "localx", "Local X")))
      .toEqual([...GLOBAL_EFFORT_LEVELS]);
  });
});

describe("effort helpers", () => {
  it("names grades and toggles with the provider default", () => {
    expect(effortName("xhigh")).toBe("Extra high");
    expect(defaultEffortName("high", false)).toBe("High");
    expect(defaultEffortName("none", true)).toBe("Off");
    expect(defaultEffortName(undefined, false)).toBe("Provider");
  });

  it("uses a catalog model's grades for rows the agent shortlist does not name", () => {
    expect(effortLevelsForAgentModel(source, "anthropic:opus-5", catalogModel(
      "opus-5",
      "anthropic",
      "Anthropic",
      { reasoning: true, effortLevels: ["low", "max"] },
    ))).toEqual(["low", "max"]);
    expect(effortLevelsForAgentModel(source, "anthropic:opus-5", catalogModel(
      "opus-5",
      "anthropic",
      "Anthropic",
      { reasoningMode: "toggle" },
    ))).toEqual(["high", "none"]);
  });

  it("ranks a catalog row's own metadata above the legacy global ladder", () => {
    // An agent without `modelOptions` describes ONE ladder for everything, so
    // catalog rows used to inherit it: a non-reasoning model rendered Thinking
    // controls and grades its page never advertised were selectable.
    const legacy = agent("legacy", {
      models: ["legacy/model"],
      efforts: [...GLOBAL_EFFORT_LEVELS],
    });
    expect(effortLevelsForAgentModel(legacy, "anthropic:opus-5", catalogModel(
      "opus-5",
      "anthropic",
      "Anthropic",
      { reasoning: true, effortLevels: ["low", "max"] },
    ))).toEqual(["low", "max"]);
    expect(effortLevelsForAgentModel(legacy, "anthropic:instant", catalogModel(
      "instant",
      "anthropic",
      "Anthropic",
      { reasoning: false },
    ))).toEqual([]);
    // Silence is not a claim that the model has no grades; the legacy ladder
    // still applies, or the row loses effort control it actually supports.
    expect(effortLevelsForAgentModel(legacy, "anthropic:quiet", catalogModel(
      "quiet",
      "anthropic",
      "Anthropic",
    ))).toEqual([...GLOBAL_EFFORT_LEVELS]);
  });
});

describe("buildSelectorModels", () => {
  it("keeps the automatic row first, shortlist order, then catalog-only rows", () => {
    const catalogByProvider = {
      anthropic: [
        catalogModel("claude-sonnet-4.5", "anthropic", "Anthropic"),
        catalogModel("opus-5", "anthropic", "Anthropic"),
      ],
    };
    const rows = buildSelectorModels({ agent: source, modelOptions: shortlist, defaultEffort: "high", catalogByProvider });

    expect(rows.map((row) => row.id)).toEqual([
      AUTOMATIC_MODEL_ID,
      codex,
      sonnet,
      "anthropic:opus-5",
    ]);
    // The shortlist row for a catalog-widened route picks up provider metadata.
    expect(rows[2]).toMatchObject({
      id: sonnet,
      provider: "anthropic",
      providerLabel: "Anthropic",
    });
    // Catalog-only rows carry their provider and don't duplicate shortlist ids.
    // The row id is the canonical reference built from the wire's bare `id`,
    // because that is what the thread override and turn API are validated against.
    expect(rows[3]).toMatchObject({
      id: "anthropic:opus-5",
      provider: "anthropic",
      providerLabel: "Anthropic",
    });
    expect(rows.map((row) => row.id).every((id) => id === AUTOMATIC_MODEL_ID || id.includes(":")))
      .toBe(true);
    expect(rows.filter((row) => row.id === sonnet)).toHaveLength(1);
  });

  it("falls back to the reference prefix for providers the catalog has not widened", () => {
    const rows = buildSelectorModels({ agent: source, modelOptions: shortlist, defaultEffort: "high" });
    expect(rows[1]).toMatchObject({ id: codex, provider: "pi", providerLabel: "pi" });
  });

  it("names the automatic row after the agent default and its effort choices", () => {
    const rows = buildSelectorModels({ agent: source, modelOptions: shortlist, defaultEffort: "high" });
    expect(rows[0]).toMatchObject({ id: AUTOMATIC_MODEL_ID, name: "Default · Claude Sonnet 4.5" });
    expect(rows[0].efforts.map((option) => option.id)).toEqual(["", "medium", "high"]);
  });

  it("uses catalog names when shortlist metadata has no label", () => {
    const unlabeled = agent("agent", {
      models: shortlist,
      defaultModel: sonnet,
      modelOptions: {
        [codex]: { reasoning: true, effortLevels: ["low", "high"] },
        [sonnet]: { reasoning: true, effortLevels: ["medium", "high"] },
      },
    });
    const rows = buildSelectorModels({
      agent: unlabeled,
      modelOptions: shortlist,
      defaultEffort: "high",
      catalogByProvider: {
        anthropic: [catalogModel("claude-sonnet-4.5", "anthropic", "Anthropic", {
          name: "Claude Sonnet, configured",
        })],
      },
    });

    expect(rows[0]?.name).toBe("Default · Claude Sonnet, configured");
    expect(rows.find((row) => row.id === sonnet)?.name)
      .toBe("Claude Sonnet, configured");
  });

  it("keeps /v1/info labels ahead of catalog fallback names", () => {
    const rows = buildSelectorModels({
      agent: source,
      modelOptions: shortlist,
      defaultEffort: "high",
      catalogByProvider: {
        anthropic: [catalogModel("claude-sonnet-4.5", "anthropic", "Anthropic", {
          name: "Catalog fallback only",
        })],
      },
    });

    expect(rows[0]?.name).toBe("Default · Claude Sonnet 4.5");
    expect(rows.find((row) => row.id === sonnet)?.name).toBe("Claude Sonnet 4.5");
  });

  it("offers each catalog row only the grades its own page advertised", () => {
    const rows = buildSelectorModels({
      agent: source,
      modelOptions: shortlist,
      defaultEffort: "high",
      catalogByProvider: {
        anthropic: [
          catalogModel("opus-5", "anthropic", "Anthropic", {
            reasoning: true,
            effortLevels: ["low", "max"],
          }),
          catalogModel("instant", "anthropic", "Anthropic", { reasoning: false }),
        ],
      },
    });

    expect(rows.find((row) => row.id === "anthropic:opus-5")?.efforts.map((option) => option.id))
      .toEqual(["", "low", "max"]);
    // A non-reasoning row must not render Thinking controls at all: the effort
    // it offered was discarded by the store and rejected by the agent.
    expect(rows.find((row) => row.id === "anthropic:instant")?.efforts).toEqual([]);
  });

  it("returns an empty list when no agent is selected", () => {
    expect(buildSelectorModels({ agent: null, modelOptions: [], defaultEffort: "" })).toEqual([]);
  });
});

describe("groupSelectorModels", () => {
  it("buckets rows by provider in first-seen order and leaves the automatic row outside groups", () => {
    const rows = buildSelectorModels({
      agent: source,
      modelOptions: shortlist,
      defaultEffort: "high",
      catalogByProvider: {
        anthropic: [catalogModel("claude-sonnet-4.5", "anthropic", "Anthropic")],
      },
    });
    const groups = groupSelectorModels(rows);
    expect(groups.map((group) => group.provider)).toEqual(["pi", "anthropic"]);
    expect(groups[0]?.label).toBe("pi");
    expect(groups[1]?.label).toBe("Anthropic");
    expect(groups[1]?.models.map((model) => model.id)).toEqual([sonnet]);
  });

  it("keeps first-seen provider order while preferring advertised labels", () => {
    const groups = [
      { provider: "codex", label: "codex", models: [] },
      { provider: "anthropic", label: "anthropic", models: [] },
    ];

    expect(selectorProvides(groups, [
      { id: "anthropic", label: "Anthropic" },
      { id: "codex", label: "OpenAI Codex" },
      { id: "ollama", label: "Ollama" },
    ])).toEqual([
      { provider: "codex", label: "OpenAI Codex" },
      { provider: "anthropic", label: "Anthropic" },
      { provider: "ollama", label: "Ollama" },
    ]);
  });
});
describe("the shared effort module", () => {
  it("is the SAME module both ends run, not an equal copy of it", () => {
    // The value-level table below this pins that the browser AGREES with
    // `packages/web/src/effort-ladder.ts`. It cannot tell agreement from
    // duplication: replacing the import in `model-catalog.ts` with a local copy
    // that returns identical values passed all 28 of these tests, and a copy is
    // exactly how the two ends drifted the first time. Identity is the part
    // that cannot be satisfied by re-deriving the rule.
    expect(catalog.effortLevelsForModel).toBe(ladder.effortLevelsForModel);
    expect(catalog.advertisedEffortLevels).toBe(ladder.advertisedEffortLevels);
    expect(catalog.effectiveModelForAgent).toBe(ladder.effectiveModelForAgent);
    expect(catalog.GLOBAL_EFFORT_LEVELS).toBe(ladder.GLOBAL_EFFORT_LEVELS);
  });

  it("resolves a blank selection to the route the server will run", () => {
    // A payload that advertises a shortlist but no default: the picker used to
    // fall back to `models[0]` while the server stopped at `defaultModel` and
    // judged against the global ladder, so the two disagreed about every turn
    // that carried no explicit model.
    const modelOptions = {
      "local:ungraded": { reasoning: false },
      "local:graded": { reasoning: true, effortLevels: ["low"] },
    };
    // Built without `agent()` on purpose: the fixture always supplies a
    // default, and a payload with none is the whole case.
    const { defaultModel: _omitted, ...noDefault } = agent("agent", {
      models: ["local:ungraded", "local:graded"],
      modelOptions,
    });
    expect(effectiveModelForAgent(noDefault, "")).toBe("local:ungraded");
    expect(effortLevelsForAgentModel(noDefault, effectiveModelForAgent(noDefault, "") ?? ""))
      .toEqual([]);

    const withDefault = agent("agent", {
      models: ["local:ungraded", "local:graded"],
      defaultModel: "local:graded",
      modelOptions,
    });
    expect(effectiveModelForAgent(withDefault, "")).toBe("local:graded");
    expect(effectiveModelForAgent(withDefault, "local:ungraded")).toBe("local:ungraded");
    expect(effectiveModelForAgent({}, "")).toBeUndefined();
  });
});
