import { describe, expect, it } from "vitest";

import {
  configuredRuntimeFallbackModels,
  configuredRuntimeModels,
  runtimeUsesFallbackRouter,
  hasConfiguredRuntimeFallbacks,
} from "../runtime-routes.js";
import { historyToolRouteSupport } from "../app-controller-utils.js";
import { runtimeRouteSupportsMcpApps } from "../app-controller-utils.js";

const primary = { sdk: "codex", model: "gpt-5.6-terra", reference: "codex:gpt-5.6-terra" };
const legacy = { sdk: "pi", provider: "ollama", model: "qwen3", reference: "pi:ollama:qwen3" };
const canonical = { sdk: "claude", model: "claude-sonnet-5", reference: "claude:claude-sonnet-5" };

describe("configured runtime routes", () => {
  it("preserves RunHistory but suppresses SessionHistory on a direct ACP route", () => {
    const config = {
      runtime: {
        model: { sdk: "acp", provider: "personal-agent", model: "personal-agent", reference: "acp:personal-agent" },
      },
    } as never;
    expect(historyToolRouteSupport(config)).toEqual({
      runHistory: true,
      sessionHistory: false,
    });
  });

  it("uses structured fallbacks when present and keeps their effort out of model-only consumers", () => {
    const runtime = {
      model: primary,
      fallbackModels: [legacy],
      fallbacks: [{ model: canonical, effort: "high" as const }],
    };
    expect(configuredRuntimeFallbackModels(runtime)).toEqual([canonical]);
    expect(configuredRuntimeModels(runtime)).toEqual([primary, canonical]);
    expect(hasConfiguredRuntimeFallbacks(runtime)).toBe(true);
  });

  it("preserves legacy configs when the structured list is absent or empty", () => {
    expect(configuredRuntimeFallbackModels({ fallbackModels: [legacy] })).toEqual([legacy]);
    expect(configuredRuntimeFallbackModels({ fallbackModels: [legacy], fallbacks: [] })).toEqual([legacy]);
    expect(hasConfiguredRuntimeFallbacks({ fallbackModels: [], fallbacks: [] })).toBe(false);
  });

  it("advertises MCP Apps only when every possible runtime route supports them", () => {
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: legacy, fallbackModels: [], fallbacks: [] },
    } as never)).toBe(true);
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: legacy, fallbackModels: [], fallbacks: [{ model: { ...legacy, model: "backup" } }] },
    } as never)).toBe(true);
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: legacy, fallbackModels: [], fallbacks: [{ model: primary }] },
    } as never)).toBe(false);
    expect(runtimeRouteSupportsMcpApps({
      runtime: { model: primary, fallbackModels: [legacy], fallbacks: [] },
    } as never)).toBe(false);
  });

describe("runtimeUsesFallbackRouter", () => {
  const base = { model: { sdk: "pi", model: "m", reference: "pi:m" } };

  it("is true when backups are configured", () => {
    expect(runtimeUsesFallbackRouter({
      ...base,
      fallbacks: [{ model: { sdk: "claude", model: "c", reference: "claude:c" } }],
    } as never)).toBe(true);
  });

  it("is true for a retry-only chain with no backups", () => {
    // Regression guard: same-model retries build a single-entry chain, so the
    // router is active and freezes the model. Keying per-trigger overrides off
    // configured backups alone ran them on the chain primary instead.
    expect(runtimeUsesFallbackRouter({
      ...base,
      retry: { primaryAttempts: 2, backoffMs: 1_000, maxBackoffMs: 15_000 },
    } as never)).toBe(true);
  });

  it("is false only when nothing routes", () => {
    expect(runtimeUsesFallbackRouter({
      ...base,
      retry: { primaryAttempts: 1, backoffMs: 1_000, maxBackoffMs: 15_000 },
    } as never)).toBe(false);
    expect(runtimeUsesFallbackRouter(base as never)).toBe(false);
  });
});
});
