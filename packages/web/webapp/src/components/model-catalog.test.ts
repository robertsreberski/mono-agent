import { describe, expect, it } from "vitest";
import type { CatalogModel } from "../types";
import { agent } from "../test/fixtures";
import {
  AUTOMATIC_MODEL_ID,
  buildSelectorModels,
  defaultEffortName,
  effortLevelsForAgentModel,
  effortName,
  groupSelectorModels,
  providerOfModel,
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
    readonly contextWindow?: number;
    readonly reasoning?: boolean;
    readonly effortLevels?: readonly string[];
    readonly reasoningMode?: string;
  } = {},
): CatalogModel => ({
  id,
  name: id,
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
});