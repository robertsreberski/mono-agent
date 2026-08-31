import { describe, expect, it } from "vitest";

import {
  getPiBuiltinModel,
  reasoningLevelsForPiModel,
} from "@mono-agent/agent-runtime";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import type { LocalProviderDefinition } from "@mono-agent/runtime-adapter";

import { resolveAdvertisedModelEffort } from "../model-effort-capabilities.js";

const LOCAL_OLLAMA: readonly LocalProviderDefinition[] = [
  { id: "ollama", type: "ollama", baseUrl: "http://localhost:11434", enabled: true },
];

const LOCAL_LMSTUDIO: readonly LocalProviderDefinition[] = [
  {
    id: "lmstudio",
    type: "lmstudio",
    baseUrl: "http://localhost:1234",
    enabled: true,
    models: [
      {
        name: "qwen/qwen3-8b",
        capabilities: {
          reasoning: true,
          reasoning_mode: "effort",
          reasoning_levels: ["low", "medium", "high"],
        },
      },
    ],
  },
];

describe("resolveAdvertisedModelEffort", () => {
  it("uses Pi builtin thinking levels for cloud Pi routes", () => {
    const ref = parseMonoRuntimeModelReference("anthropic:claude-sonnet-4-6");
    const builtin = getPiBuiltinModel("anthropic", "claude-sonnet-4-6");
    expect(builtin).toBeDefined();
    expect(resolveAdvertisedModelEffort(ref)).toEqual({
      reasoning: true,
      reasoningMode: "effort",
      effortLevels: reasoningLevelsForPiModel(builtin!),
    });
  });

  it("keeps configured local Pi toggle, graded, and non-reasoning metadata", () => {
    expect(resolveAdvertisedModelEffort(parseMonoRuntimeModelReference("lmstudio:qwen/qwen3-8b"), {
      localProviders: LOCAL_LMSTUDIO,
    })).toEqual({
      reasoning: true,
      reasoningMode: "effort",
      effortLevels: ["low", "medium", "high"],
    });
    expect(resolveAdvertisedModelEffort(parseMonoRuntimeModelReference("ollama:qwen3.6:latest"), {
      localProviders: LOCAL_OLLAMA,
    })).toMatchObject({ reasoning: true, reasoningMode: "toggle" });
    expect(resolveAdvertisedModelEffort(parseMonoRuntimeModelReference("ollama:llama3.1:latest"), {
      localProviders: LOCAL_OLLAMA,
    })).toMatchObject({ reasoning: false, reasoningMode: "none" });
  });

  it("exposes no explicit effort choices for unknown provider metadata", () => {
    expect(resolveAdvertisedModelEffort(parseMonoRuntimeModelReference("unknown-provider:unknown-model")))
      .toEqual({ reasoning: true });
  });
});
