import { describe, expect, it, vi } from "vitest";

import {
  listPiBuiltinModels,
  listPiBuiltinProviders,
} from "@mono-agent/agent-runtime";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import { buildProviderModelCatalog } from "../provider-model-catalog.js";
import { resolveAdvertisedModelEffortForBuiltin } from "../model-effort-capabilities.js";

describe("provider-model-catalog", () => {
  it("advertises nothing when the agent declared no providers and has no routes", () => {
    // `providers` is a support gate. An agent that declared nothing and routes
    // nowhere advertises nothing, rather than every Pi built-in it holds no
    // credential for.
    expect(buildProviderModelCatalog().listProviders()).toEqual([]);
  });

  it("declaring every built-in never throws and stays within the ≤45 advertised bound", () => {
    const builtins = listPiBuiltinProviders();
    const catalog = buildProviderModelCatalog({
      providers: builtins.map((builtin) => ({ id: builtin.id })),
    });
    const providers = catalog.listProviders();

    expect(providers.length).toBeLessThanOrEqual(45);
    for (const builtin of builtins) {
      expect(providers.some((provider) => provider.id === builtin.id)).toBe(true);
    }
  });

  it("caps openrouter at 100 and reports totalModelCount when not narrowed", () => {
    const catalog = buildProviderModelCatalog({ providers: [{ id: "openrouter" }] });
    const openrouter = catalog.listProviders().find((provider) => provider.id === "openrouter");
    const full = listPiBuiltinModels("openrouter").length;

    // Pi's generated provider catalog changes independently of mono-agent. The
    // contract here is that an oversized upstream catalog is reported exactly
    // while only the first 100 models are advertised, not its release-specific
    // total.
    expect(full).toBeGreaterThan(100);
    expect(openrouter?.modelCount).toBe(100);
    expect(openrouter?.totalModelCount).toBe(full);

    // listModels never serves past the advertised cap, even with a large limit.
    const page = catalog.listModels("openrouter", { limit: 200 });
    expect(page.models.length).toBe(100);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });

  it("narrows a built-in with an allowlist without inventing or flattening models", () => {
    const real = listPiBuiltinModels("anthropic")[0]!;
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "anthropic",
        models: [{ name: real.id }, { name: "not-a-real-model" }],
      }],
    });
    const models = catalog.listModels("anthropic").models;

    // A name the provider does not have is dropped, not advertised as
    // selectable and then failed at turn time with `pi model not found`.
    expect(models.map((model) => model.id)).toEqual([real.id]);
    // An allowlist NARROWS the real catalog, so the surviving row keeps the
    // reasoning/effort metadata the picker needs.
    const resolved = resolveAdvertisedModelEffortForBuiltin(real);
    expect(models[0]?.reasoning).toBe(resolved.reasoning);
    expect(models[0]?.effortLevels).toEqual(resolved.effortLevels);
  });

  it("uses the configured display name in catalog pages and shortlist descriptions", () => {
    const real = listPiBuiltinModels("anthropic")[0]!;
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "anthropic",
        models: [{
          name: real.id,
          alias: "preferred-claude",
          displayName: "Robert's preferred Claude",
        }],
      }],
    });
    const ref = parseMonoRuntimeModelReference(`anthropic:${real.id}`);
    const aliasRef = parseMonoRuntimeModelReference("anthropic:preferred-claude");

    expect(catalog.listModels("anthropic").models[0]).toMatchObject({
      id: real.id,
      name: "Robert's preferred Claude",
    });
    expect(catalog.describe([ref])[ref.reference]?.label)
      .toBe("Robert's preferred Claude");
    expect(catalog.describe([aliasRef])[aliasRef.reference]?.label)
      .toBe("Robert's preferred Claude");
  });

  it("an explicit models allowlist bypasses the cap and preserves order", () => {
    const catalog = buildProviderModelCatalog({
      providers: [
        {
          id: "anthropic",
          models: [{ name: "claude-opus-4-7" }, { name: "claude-sonnet-4-6" }],
        },
      ],
    });

    const anthropic = catalog.listProviders().find((provider) => provider.id === "anthropic");
    expect(anthropic?.modelCount).toBe(2);
    expect(anthropic?.totalModelCount).toBeUndefined();
    expect(anthropic?.source).toBe("builtin");
    expect(catalog.listModels("anthropic").models.map((model) => model.id))
      .toEqual(["claude-opus-4-7", "claude-sonnet-4-6"]);
  });

  it("advances the cursor even when an allowlist declares the same name twice", () => {
    const real = listPiBuiltinModels("anthropic").slice(0, 2).map((model) => model.id);
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "anthropic",
        models: [{ name: real[0]! }, { name: real[0]! }, { name: real[1]! }],
      }],
    });

    // The cursor is the last row's id and resolves with findIndex, so a
    // duplicate id would resolve to the first occurrence and serve the same
    // page forever.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = catalog.listModels("anthropic", { ...(cursor === undefined ? {} : { cursor }), limit: 1 });
      seen.push(...result.models.map((model) => model.id));
      if (result.nextCursor === undefined) break;
      expect(result.nextCursor).not.toBe(cursor);
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(real);
  });

  it("terminates pagination with strictly increasing cursors and no duplicate models", () => {
    const catalog = buildProviderModelCatalog({ providers: [{ id: "anthropic" }] });
    const total = listPiBuiltinModels("anthropic").length;
    const seen: string[] = [];
    let cursor: string | undefined;
    let previousCursor: string | undefined;
    let pages = 0;

    for (;;) {
      const page = catalog.listModels("anthropic", {
        ...(cursor === undefined ? {} : { cursor }),
        limit: 5,
      });
      for (const model of page.models) {
        seen.push(model.id);
      }
      if (page.nextCursor === undefined) break;
      if (previousCursor !== undefined) {
        expect(page.nextCursor.localeCompare(previousCursor)).toBeGreaterThan(0);
      }
      previousCursor = page.nextCursor;
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(1_000);
    }

    expect(seen.length).toBe(total);
    expect(new Set(seen).size).toBe(total);
  });

  it("resolve() reads memory only and never re-reads the builtin catalog", () => {
    const listBuiltinModels = vi.fn(listPiBuiltinModels);
    const catalog = buildProviderModelCatalog({
      providers: [{ id: "anthropic" }],
      listBuiltinModels,
    });
    const readsAfterBuild = listBuiltinModels.mock.calls.length;
    expect(readsAfterBuild).toBeGreaterThan(0);

    const anthropicFirst = catalog.listModels("anthropic").models[0];
    expect(anthropicFirst).toBeDefined();

    // Reads after build never re-enter the provider catalog: the pages are
    // precomputed, so the counting spy sees no new calls however many times
    // they are served.
    catalog.listModels("anthropic");
    catalog.searchModels("claude");
    catalog.listProviders();
    expect(listBuiltinModels.mock.calls.length).toBe(readsAfterBuild);
  });

  it("searchModels bounds to MAX_SEARCH_RESULTS and matches across providers", () => {
    const catalog = buildProviderModelCatalog({
      providers: [{ id: "anthropic" }, { id: "openrouter" }, { id: "github-copilot" }],
    });
    const results = catalog.searchModels("claude", 1_000);
    expect(results.length).toBeLessThanOrEqual(100);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((model) => (
      model.id.toLowerCase().includes("claude") || model.name.toLowerCase().includes("claude")
    ))).toBe(true);
  });

  it("marks a provider configured when `providers` lists it, with no route using it", () => {
    const catalog = buildProviderModelCatalog({
      providers: [{ id: "anthropic" }],
      configuredRoutes: [parseMonoRuntimeModelReference("openai-codex:gpt-5.6-sol")],
    });

    const byId = new Map(catalog.listProviders().map((provider) => [provider.id, provider]));
    // Listed in `providers` purely to widen selection — no route touches it.
    expect(byId.get("anthropic")?.configured).toBe(true);
    expect(byId.get("anthropic")?.modelCount).toBeGreaterThan(0);
    // Supported by construction: you cannot route through an unsupported provider.
    expect(byId.get("openai-codex")?.configured).toBe(true);
    // An undeclared, unrouted built-in is not advertised at all — the gate, not
    // merely an unset flag. Selecting one was how an operator could reach a
    // provider the agent holds no credential for.
    expect(byId.has("google")).toBe(false);
    expect(catalog.listModels("google").models).toEqual([]);
  });

  it("does not advertise a provider disabled with `enabled: false`", () => {
    const catalog = buildProviderModelCatalog({
      providers: [{ id: "anthropic", enabled: false }, { id: "openai" }],
    });
    const ids = catalog.listProviders().map((provider) => provider.id);
    expect(ids).toContain("openai");
    expect(ids).not.toContain("anthropic");
    expect(catalog.listModels("anthropic").models).toEqual([]);
  });

  it("lets a typed local provider own a Pi built-in id instead of advertising Pi's catalog", () => {
    // `runtimeOptionsForLocalProvider` routes on provider id alone, so every
    // selection under this id executes against the local endpoint. Advertising
    // Pi's built-in `openai` models here made every advertised row unselectable
    // in practice.
    const catalog = buildProviderModelCatalog({
      providers: [{ id: "openai", type: "openai_compat", baseUrl: "http://localhost:9000" }],
      discoveredModels: [
        { ref: "openai:local-b", label: "Local B", providerId: "openai" },
        { ref: "openai:local-a", label: "Local A", providerId: "openai" },
      ],
    });

    const openai = catalog.listProviders().find((provider) => provider.id === "openai");
    expect(openai?.source).toBe("custom");
    expect(catalog.listModels("openai").models.map((model) => model.id))
      .toEqual(["local-a", "local-b"]);
  });

  it("never advertises a model whose reference a turn could not route to", () => {
    // Byte bounds are a paging concern and say nothing about content. A local
    // endpoint reporting an id with a control character cleared the length
    // filter, reached `/v1/models`, and was admitted by the console — the
    // operator only found out at turn time, when the parser refused the
    // reference. `/v1/info` already parsed each discovered ref; the paged
    // catalog did not.
    const unroutable = `llama3.1${String.fromCharCode(7)}turbo`;
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        enabled: true,
        models: [{ name: unroutable, enabled: true }, { name: "gemma4:31b", enabled: true }],
      }],
    });

    const ids = catalog.listModels("ollama").models.map((model) => model.id);
    expect(ids).toEqual(["gemma4:31b"]);
    expect(catalog.listProviders().find((provider) => provider.id === "ollama")?.modelCount).toBe(1);
  });

  it("keeps a typed local provider's allowlist off Pi's built-in catalog", () => {
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "openai",
        type: "openai_compat",
        baseUrl: "http://localhost:9000",
        models: [{ name: "local-only" }],
      }],
    });

    // The name is not in Pi's `openai` catalog, but the local endpoint owns the
    // id, so it must not be validated against — or dropped by — Pi's snapshot.
    expect(catalog.listModels("openai").models.map((model) => model.id)).toEqual(["local-only"]);
  });

  it("does not advertise an allowlist model withdrawn with `enabled: false`", () => {
    const real = listPiBuiltinModels("anthropic").slice(0, 2).map((model) => model.id);
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "anthropic",
        models: [{ name: real[0]! }, { name: real[1]!, enabled: false }],
      }],
    });

    expect(catalog.listModels("anthropic").models.map((model) => model.id)).toEqual([real[0]]);
    expect(catalog.listProviders().find((provider) => provider.id === "anthropic")?.modelCount)
      .toBe(1);
  });

  it("does not fall back to the full built-in catalog when every allowlist entry is disabled", () => {
    // Branching on the FILTERED list would make "narrowed to two, both
    // withdrawn" advertise all 13 Pi anthropic models instead of none.
    const real = listPiBuiltinModels("anthropic").slice(0, 2).map((model) => model.id);
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "anthropic",
        models: real.map((name) => ({ name, enabled: false })),
      }],
    });

    expect(catalog.listModels("anthropic").models).toEqual([]);
    expect(catalog.listProviders().find((provider) => provider.id === "anthropic")?.modelCount)
      .toBe(0);
  });

  it("drops authored allowlist names when the built-in snapshot is unavailable", () => {
    // Fail CLOSED on the snapshot itself, not on its size: an empty/throwing
    // listing left every authored name unverified and advertised it anyway.
    for (const listBuiltinModels of [
      () => { throw new Error("catalog unavailable"); },
      () => [],
    ] as const) {
      const catalog = buildProviderModelCatalog({
        providers: [{ id: "anthropic", models: [{ name: "claude-opus-4-7" }] }],
        listBuiltinModels,
      });
      expect(catalog.listModels("anthropic").models).toEqual([]);
      const anthropic = catalog.listProviders().find((provider) => provider.id === "anthropic");
      expect(anthropic?.modelCount).toBe(0);
      // The provider stays in the picker rather than disappearing entirely.
      expect(anthropic?.source).toBe("builtin");
    }
  });

  it("applies the provider's maxAdvertisedModels to live-discovered models", () => {
    const catalog = buildProviderModelCatalog({
      providers: [{
        id: "ollama",
        type: "ollama",
        baseUrl: "http://localhost:11434",
        maxAdvertisedModels: 2,
      }],
      discoveredModels: Array.from({ length: 5 }, (_unused, index) => ({
        ref: `ollama:m${index}`,
        label: `M${index}`,
        providerId: "ollama",
      })),
    });

    expect(catalog.listModels("ollama").models.map((model) => model.id)).toEqual(["m0", "m1"]);
    const ollama = catalog.listProviders().find((provider) => provider.id === "ollama");
    expect(ollama?.modelCount).toBe(2);
    expect(ollama?.totalModelCount).toBe(5);
  });

  it("skips oversized provider and model identifiers instead of emitting them", () => {
    // Config validation does not length-bound these. `/v1/info` shares one
    // 1 MiB body cap with every other field, so an oversized entry takes the
    // agent OFFLINE rather than degrading it.
    const huge = "x".repeat(600_000);
    const catalog = buildProviderModelCatalog({
      providers: [
        { id: huge, type: "openai_compat", baseUrl: "http://localhost:9000" },
        { id: "anthropic", models: [{ name: "y".repeat(400), displayName: "ok" }] },
      ],
    });

    expect(catalog.listProviders().map((provider) => provider.id)).not.toContain(huge);
    expect(catalog.listModels("anthropic").models).toEqual([]);
    expect(JSON.stringify(catalog.listProviders()).length).toBeLessThan(8_192);
  });

  it("degrades an unknown provider to an empty page and never throws", () => {
    const catalog = buildProviderModelCatalog();
    expect(catalog.listModels("does-not-exist")).toEqual({ models: [], truncated: false });
    expect(catalog.listModels("does-not-exist", { cursor: "x", limit: 200 }))
      .toEqual({ models: [], truncated: false });
  });
});
