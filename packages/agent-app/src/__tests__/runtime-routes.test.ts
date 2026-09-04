import { describe, expect, it } from "vitest";

import {
  configuredRuntimeFallbackModels,
  configuredRuntimeModels,
  hasConfiguredRuntimeFallbacks,
  runtimeUsesFallbackRouter,
} from "../runtime-routes.js";
import { runtimeRouteSupportsMcpApps } from "../app-controller-utils.js";

const primary = {
  provider: "openai-codex",
  model: "gpt-5.6-terra",
  reference: "openai-codex:gpt-5.6-terra",
};
const local = { provider: "ollama", model: "qwen3", reference: "ollama:qwen3" };
const fallback = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  reference: "anthropic:claude-sonnet-5",
};

describe("configured runtime routes", () => {
  it("uses structured fallbacks and keeps their effort out of model-only consumers", () => {
    const runtime = {
      model: primary,
      fallbacks: [{ model: fallback, effort: "high" as const }],
    };
    expect(configuredRuntimeFallbackModels(runtime)).toEqual([fallback]);
    expect(configuredRuntimeModels(runtime)).toEqual([primary, fallback]);
    expect(hasConfiguredRuntimeFallbacks(runtime)).toBe(true);
  });

  it("returns an empty fallback list when no structured routes are configured", () => {
    expect(configuredRuntimeFallbackModels({})).toEqual([]);
    expect(configuredRuntimeFallbackModels({ fallbacks: [] })).toEqual([]);
    expect(hasConfiguredRuntimeFallbacks({ fallbacks: [] })).toBe(false);
  });

  it("advertises MCP Apps for every provider route", () => {
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: local, fallbacks: [] },
    } as never)).toBe(true);
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: local, fallbacks: [{ model: primary }] },
    } as never)).toBe(true);
  });
});

describe("runtimeUsesFallbackRouter", () => {
  const base = { model: { provider: "ollama", model: "m", reference: "ollama:m" } };

  it("is true when backups are configured", () => {
    expect(runtimeUsesFallbackRouter({
      ...base,
      fallbacks: [{ model: fallback }],
    })).toBe(true);
  });

  it("is true for a retry-only chain with no backups", () => {
    // Regression guard: same-model retries build a single-entry chain, so the
    // router is active and freezes the model. Keying per-trigger overrides off
    // configured backups alone ran them on the chain primary instead.
    expect(runtimeUsesFallbackRouter({
      ...base,
      retry: { primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 },
    })).toBe(true);
  });

  it("is false only when nothing routes", () => {
    expect(runtimeUsesFallbackRouter({
      ...base,
      retry: { primaryAttempts: 1, backoffMs: 1_000, maxBackoffMs: 15_000 },
    })).toBe(false);
    expect(runtimeUsesFallbackRouter({ ...base, fallbacks: [] })).toBe(false);
  });
});
