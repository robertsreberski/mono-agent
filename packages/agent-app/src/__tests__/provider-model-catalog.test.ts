import { describe, expect, it, vi } from "vitest";

import {
  listPiBuiltinModels,
  listPiBuiltinProviders,
} from "@mono-agent/agent-runtime";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";

import { buildProviderModelCatalog } from "../provider-model-catalog.js";

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

    expect(full).toBe(351);
    expect(openrouter?.modelCount).toBe(100);
    expect(openrouter?.totalModelCount).toBe(full);

    // listModels never serves past the advertised cap, even with a large limit.
    const page = catalog.listModels("openrouter", { limit: 200 });
    expect(page.models.length).toBe(100);
    expect(page.truncated).toBe(false);
    expect(page.nextCursor).toBeUndefined();
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
    expect(catalog.resolve(`anthropic:${anthropicFirst!.id}`)).toEqual(anthropicFirst);
    expect(catalog.resolve("anthropic:does-not-exist")).toBeUndefined();
    expect(catalog.resolve("unknown:model")).toBeUndefined();

    // resolve never triggers a re-read of the provider catalog (the page cache
    // stays precomputed), so the counting spy sees no new calls.
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

  it("degrades an unknown provider to an empty page and never throws", () => {
    const catalog = buildProviderModelCatalog();
    expect(catalog.listModels("does-not-exist")).toEqual({ models: [], truncated: false });
    expect(catalog.listModels("does-not-exist", { cursor: "x", limit: 200 }))
      .toEqual({ models: [], truncated: false });
  });
});
