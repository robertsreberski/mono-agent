import { describe, expect, it } from "vitest";

import { redactMonoAgentConfig, resolveJsonMonoAgentConfig } from "../config.js";
import {
  buildMonoAgentConfigView,
  findJsonSecretConfigWarnings,
  findRemovedConfigWarnings,
  sameJsonValue,
} from "../config-view.js";
import type { ConfigViewSection } from "../config-view.js";
import type { MonoAgentConfigJson } from "../json-source.js";

function buildView(json: MonoAgentConfigJson): readonly ConfigViewSection[] {
  const complete: MonoAgentConfigJson = {
    ...json,
    runtime: { model: "pi:ollama:qwen3:8b", ...json.runtime },
    context: { identityPath: "/repo/IDENTITY.md", ...json.context },
  };
  const config = resolveJsonMonoAgentConfig({ cwd: "/repo", json: complete });
  return buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(config), json: complete });
}

function field(sections: readonly ConfigViewSection[], id: string) {
  const found = sections.flatMap((section) => section.fields).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`field ${id} not found`);
  return found;
}

describe("buildMonoAgentConfigView", () => {
  it("emits every core section", () => {
    expect(buildView({}).map((section) => section.id)).toEqual([
      "agent", "runtime", "concurrency", "context", "memory", "tools",
      "sandbox", "artifacts", "traceability", "providers",
    ]);
  });

  it("reports only JSON and default provenance for core fields", () => {
    const sections = buildView({ runtime: { maxTurns: 7 } });
    expect(field(sections, "runtime.maxTurns")).toMatchObject({ value: "7", source: "json" });
    expect(field(sections, "runtime.effort")).toMatchObject({ source: "default" });
    expect(new Set(sections.flatMap((section) => section.fields).map((entry) => entry.source)))
      .toEqual(new Set(["json", "default"]));
  });

  it("marks JSON values that restate a default", () => {
    expect(field(buildView({ traceability: { heartbeatMs: 10_000 } }), "traceability.heartbeatMs"))
      .toMatchObject({ source: "json", restatesDefault: true });
  });

  it("shows an explicitly selected classifier model without inventing an unset default", () => {
    const memory = { mode: "bujo" as const, path: "/repo/memory", writeMode: "capture" as const,
      embeddings: { provider: "ollama" as const, model: "nomic-embed-text" },
      llm: { provider: "agent-host" as const, model: "openai-codex:gpt-5.5" } };
    expect(buildView({ memory }).flatMap((section) => section.fields).some((entry) => entry.id === "memory.capture.reconcileModel"))
      .toBe(false);
    expect(field(buildView({ memory: { ...memory, capture: { cron: false } } }),
      "memory.capture.cron")).toMatchObject({ value: "false", source: "json" });
    expect(field(buildView({ memory: { ...memory, capture: { reconcileModel: "openai-codex:gpt-5.6-terra" } } }),
      "memory.capture.reconcileModel")).toMatchObject({ value: "openai-codex:gpt-5.6-terra", source: "json" });
  });

  it("flags an inline core secret with a usable apiKeyEnv reference", () => {
    const sections = buildView({
      memory: {
        mode: "journal",
        path: "/repo/memory",
        embeddings: { provider: "openai", model: "text-embedding-3-small", apiKey: "secret" },
      },
    });
    expect(findJsonSecretConfigWarnings(sections)).toEqual([
      "[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — put it in an environment variable of your choice and set memory.embeddings.apiKeyEnv in JSON to that variable's name.",
    ]);
    expect(field(sections, "memory.embeddings.apiKey")).toMatchObject({ value: "set", redacted: true });
  });

  it("keeps removed JSON warnings but silently ignores stale env names", () => {
    expect(findRemovedConfigWarnings({
      json: { memory: { reflection: { enabled: true } } },
    })).toEqual(["[WARN] memory.reflection is removed and ignored; use memory.consolidation instead."]);
  });
});

describe("sameJsonValue", () => {
  it("compares objects structurally while preserving array order", () => {
    expect(sameJsonValue({ a: 1, b: { c: true } }, { b: { c: true }, a: 1 })).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
  });
});
