import { describe, expect, it } from "vitest";
import { agent } from "../test/fixtures";
import type { AgentSummary } from "../types";
import {
  effortFullName,
  effortToken,
  flattenCatalogModels,
  resolveSubagentRoute,
  resolveThreadRoute,
  shortModelName,
} from "./route-label";

const SONNET = "anthropic:claude-sonnet-4.5";
const CODEX_SOL = "openai-codex:gpt-5.6-sol";

const richAgent = (): AgentSummary => agent("alpha", {
  label: "Alpha",
  models: [SONNET, CODEX_SOL],
  defaultModel: SONNET,
  defaultEffort: "high",
  modelOptions: {
    [SONNET]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["medium", "high"] },
    [CODEX_SOL]: { label: "GPT-5.6 Sol", reasoning: true, effortLevels: ["low", "high"] },
  },
});

describe("effortToken", () => {
  it("uses L/M/H/XH/Max plus explicit off/minimal values", () => {
    expect(effortToken("low")).toBe("L");
    expect(effortToken("medium")).toBe("M");
    expect(effortToken("high")).toBe("H");
    expect(effortToken("xhigh")).toBe("XH");
    expect(effortToken("max")).toBe("Max");
    expect(effortToken("none")).toBe("Off");
    expect(effortToken("minimal")).toBe("Min");
    expect(effortToken("ultra")).toBe("Ultra");
  });

  it("keeps unknown efforts readable instead of blanking them", () => {
    expect(effortToken("turbo")).toBe("turbo");
    expect(effortToken("super-turbo-plus")).toBe("super-t…");
    expect(effortFullName("turbo")).toBe("turbo");
  });
});

describe("shortModelName", () => {
  it("names the known families in one word", () => {
    expect(shortModelName(CODEX_SOL, "GPT-5.6 Sol")).toBe("Sol");
    expect(shortModelName("openai-codex:gpt-6-astra", "GPT-6 Astra")).toBe("Astra");
    expect(shortModelName(SONNET, "Claude Sonnet 4.5")).toBe("Sonnet");
    expect(shortModelName("anthropic:claude-fable-5", "Claude Fable 5")).toBe("Fable");
  });

  it("keeps materially distinct Muse versions apart in the short word", () => {
    expect(shortModelName("pi:muse-spark-1.3", "Muse Spark 1.3")).toBe("Muse 1.3");
    expect(shortModelName("pi:muse-spark-2.0", "Muse Spark 2.0")).toBe("Muse 2.0");
  });

  it("reads the id leaf when no display name is known", () => {
    expect(shortModelName("anthropic:claude-opus-4.1")).toBe("Opus");
    expect(shortModelName("some-provider:my-custom-model-7")).toBe("my-custom-mod…");
  });

  it("ellipsizes long unknown ids while the badge name keeps the whole of them", () => {
    const long = "provider:a-very-long-custom-model-name-with-version-9";
    const route = resolveThreadRoute(
      { runModel: long, runEffort: "high", sourceId: "alpha" },
      richAgent(),
    );
    expect(route.modelShort.endsWith("…")).toBe(true);
    expect(route.label).toContain(long);
    expect(route.title).toContain(long);
  });
});

describe("resolveThreadRoute", () => {
  it("resolves null overrides to the agent's config defaults", () => {
    const route = resolveThreadRoute(
      { runModel: null, runEffort: null, sourceId: "alpha" },
      richAgent(),
    );
    expect(route.model).toBe(SONNET);
    expect(route.effort).toBe("high");
    expect(route.modelShort).toBe("Sonnet");
    expect(route.effortShort).toBe("H");
    expect(route.modelProvenance).toBe("inherited");
    expect(route.effortProvenance).toBe("inherited");
    expect(route.label).toContain("Claude Sonnet 4.5 (anthropic:claude-sonnet-4.5)");
    expect(route.label).toContain("High");
    expect(route.label).toContain("inherited agent defaults");
  });

  it("ignores web-new-thread draft defaults: null inherits config, not runSettings.effective", () => {
    const drafty = agent("alpha", {
      models: [SONNET],
      defaultModel: SONNET,
      defaultEffort: "high",
      modelOptions: {
        [SONNET]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["medium", "high"] },
      },
      // What a fresh composer draft would offer; an existing conversation with
      // no overrides must not follow it.
      runSettings: {
        config: { model: SONNET, effort: "high" },
        override: null,
        effective: { model: CODEX_SOL, modelSource: "config", effort: "low", effortSource: "config" },
      },
    });
    const route = resolveThreadRoute(
      { runModel: null, runEffort: null, sourceId: "alpha" },
      drafty,
    );
    expect(route.model).toBe(SONNET);
    expect(route.effort).toBe("high");
  });

  it("applies per-field overrides independently", () => {
    const agentSummary = richAgent();
    const modelOnly = resolveThreadRoute(
      { runModel: CODEX_SOL, runEffort: null, sourceId: "alpha" },
      agentSummary,
    );
    // The effort is inherited FOR the override model, not the old default's.
    expect(modelOnly.model).toBe(CODEX_SOL);
    expect(modelOnly.modelProvenance).toBe("override");
    expect(modelOnly.effort).toBe("high");
    expect(modelOnly.effortProvenance).toBe("inherited");
    expect(modelOnly.label).toContain("conversation override");

    const effortOnly = resolveThreadRoute(
      { runModel: null, runEffort: "medium", sourceId: "alpha" },
      agentSummary,
    );
    expect(effortOnly.model).toBe(SONNET);
    expect(effortOnly.modelProvenance).toBe("inherited");
    expect(effortOnly.effort).toBe("medium");
    expect(effortOnly.effortProvenance).toBe("override");
  });

  it("uses each thread's own agent, never a fleet-wide selected one", () => {
    const beta = agent("beta", {
      label: "Beta",
      models: ["beta:model-one"],
      defaultModel: "beta:model-one",
      defaultEffort: "low",
    });
    const route = resolveThreadRoute(
      { runModel: null, runEffort: null, sourceId: "beta" },
      beta,
    );
    expect(route.model).toBe("beta:model-one");
    expect(route.effort).toBe("low");
  });

  it("admits an unknown effort honestly instead of inventing one", () => {
    // The shared rule keeps the primary's effort unconditionally, so the
    // no-grade path needs a non-primary route: an override to a model whose
    // advertisement takes no grade inherits no effort.
    const noGrades = agent("alpha", {
      models: [SONNET, "local:plain"],
      defaultModel: SONNET,
      defaultEffort: "high",
      modelOptions: {
        [SONNET]: { label: "Claude Sonnet 4.5", reasoning: true, effortLevels: ["medium", "high"] },
        "local:plain": { reasoning: false },
      },
    });
    const route = resolveThreadRoute(
      { runModel: "local:plain", runEffort: null, sourceId: "alpha" },
      noGrades,
    );
    expect(route.model).toBe("local:plain");
    expect(route.effort).toBe("");
    expect(route.effortShort).toBe("—");
    expect(route.label).toContain("effort not reported");
  });

  it("says the agent is unavailable rather than dropping the override", () => {
    const route = resolveThreadRoute(
      { runModel: CODEX_SOL, runEffort: "high", sourceId: "gone" },
      null,
    );
    expect(route.model).toBe(CODEX_SOL);
    expect(route.effort).toBe("high");
    expect(route.agentMissing).toBe(true);
    expect(route.label).toContain("agent unavailable");
  });

  it("reports nothing made up when there is no agent and no override", () => {
    const route = resolveThreadRoute(
      { runModel: null, runEffort: null, sourceId: "gone" },
      null,
    );
    expect(route.model).toBe("");
    expect(route.effort).toBe("");
    expect(route.modelShort).toBe("—");
    expect(route.effortShort).toBe("—");
    expect(route.label).toContain("no route reported");
  });

  it("reads display names and effort admission from the loaded catalog", () => {
    const bare = agent("alpha", {
      models: [SONNET],
      defaultModel: SONNET,
      defaultEffort: "high",
    });
    const catalogModels = {
      anthropic: [{
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "anthropic",
        providerLabel: "Anthropic",
        reasoning: true as const,
        effortLevels: ["low", "high"] as const,
      }],
    };
    const route = resolveThreadRoute(
      { runModel: "anthropic:claude-fable-5", runEffort: null, sourceId: "alpha" },
      bare,
      catalogModels,
    );
    expect(route.modelShort).toBe("Fable");
    expect(route.effort).toBe("high");
    expect(route.label).toContain("Claude Fable 5 (anthropic:claude-fable-5)");
  });
});

describe("flattenCatalogModels", () => {
  it("projects provider states to what the effort helpers read", () => {
    expect(flattenCatalogModels(undefined)).toBeUndefined();
    expect(flattenCatalogModels({ anthropic: { models: [] } }))
      .toEqual({ anthropic: [] });
  });
});

describe("resolveSubagentRoute", () => {
  const completed = (attribution: Parameters<typeof resolveSubagentRoute>[0]) =>
    resolveSubagentRoute(attribution, "complete");

  it("prefers executed, then attempted, then requested", () => {
    expect(completed({
      requested: { model: "primary", effort: "low" },
      attempted: { model: "middle", effort: "medium" },
      executed: { model: CODEX_SOL, effort: "high" },
      disposition: "requested",
      transitions: [],
      retries: [],
    })).toMatchObject({ kind: "executed", modelShort: "Sol", effortShort: "H" });

    expect(completed({
      requested: { model: "primary", effort: "low" },
      attempted: { model: SONNET, effort: "medium" },
      disposition: "requested",
      transitions: [],
      retries: [],
    })).toMatchObject({ kind: "attempted", modelShort: "Sonnet", effortShort: "M" });

    const requestedOnly = completed({
      requested: { model: SONNET, effort: "medium" },
      disposition: "requested",
      transitions: [],
      retries: [],
    });
    expect(requestedOnly).toMatchObject({ kind: "requested", modelShort: "Sonnet" });
    expect(requestedOnly?.isRequestedOnly).toBe(true);
    expect(requestedOnly?.label).toContain("requested, not a confirmed run");
  });

  it("shows the effective effort while keeping the requested one in the detail", () => {
    const route = completed({
      requested: { model: "primary", effort: "high" },
      executed: { model: "fallback", effort: "xhigh", effectiveEffort: "max" },
      disposition: "fallback",
      transitions: [{ from: "primary", to: "fallback", reason: "overloaded" }],
      retries: [],
    });
    expect(route).toMatchObject({ kind: "executed", effortShort: "Max", isFallback: true });
    expect(route?.label).toContain("Fallback");
    expect(route?.label).toContain("requested High");
    expect(route?.label).toContain("effective Max");
  });

  it("names running work as running, never as already ran", () => {
    const route = resolveSubagentRoute({
      requested: { model: SONNET, effort: "high" },
      disposition: "requested",
      transitions: [],
      retries: [],
    }, "running");
    expect(route?.label).toContain("Running with");
  });

  it("renders no badge for attribution-free records", () => {
    expect(completed(undefined)).toBeUndefined();
  });

  it("stays honest when the runtime reported almost nothing", () => {
    const route = completed({
      requested: {},
      disposition: "unknown",
      transitions: [],
      retries: [],
    });
    expect(route).toMatchObject({ kind: "none", modelShort: "—", effortShort: "—" });
  });
});
