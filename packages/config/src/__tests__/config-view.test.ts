import { describe, expect, it } from "vitest";

import { loadMonoAgentConfig, redactMonoAgentConfig } from "../config.js";
import { buildMonoAgentConfigView, findJsonSecretConfigWarnings, findRemovedConfigWarnings } from "../config-view.js";
import type { ConfigViewSection } from "../config-view.js";
import type { MonoAgentConfigJson } from "../json-source.js";
import { layerJsonOntoEnv } from "../layered-loader.js";

const baseEnv: Record<string, string | undefined> = {
  MONO_AGENT_MODEL: "pi:ollama:qwen3:8b",
  MONO_AGENT_IDENTITY_PATH: "/repo/IDENTITY.md",
};

function buildView(
  env: Record<string, string | undefined>,
  json: MonoAgentConfigJson = {},
): readonly ConfigViewSection[] {
  const config = loadMonoAgentConfig({ cwd: "/repo", env: layerJsonOntoEnv(json, env) });
  const redacted = redactMonoAgentConfig(config);
  return buildMonoAgentConfigView({ redacted, json, env });
}

function field(sections: readonly ConfigViewSection[], id: string) {
  for (const section of sections) {
    const found = section.fields.find((entry) => entry.id === id);
    if (found !== undefined) {
      return found;
    }
  }
  throw new Error(`field ${id} not found in view`);
}

function section(sections: readonly ConfigViewSection[], id: string): ConfigViewSection {
  const found = sections.find((entry) => entry.id === id);
  if (found === undefined) {
    throw new Error(`section ${id} not found in view`);
  }
  return found;
}

describe("buildMonoAgentConfigView", () => {
  it("covers every core section exactly once", () => {
    const sections = buildView(baseEnv);
    expect(sections.map((entry) => entry.id)).toEqual([
      "runtime",
      "concurrency",
      "context",
      "memory",
      "tools",
      "sandbox",
      "artifacts",
      "traceability",
      "observability",
      "providers",
    ]);
  });

  it("marks an env-sourced field as env", () => {
    const sections = buildView({ ...baseEnv, MONO_AGENT_MAX_TURNS: "5" });
    expect(field(sections, "runtime.maxTurns")).toMatchObject({ value: "5", source: "env" });
  });

  it("marks a json-sourced field as json", () => {
    const sections = buildView(baseEnv, { runtime: { maxTurns: 7 } });
    // The loader resolved from baseEnv (no env max turns), so json presence wins over default.
    expect(field(sections, "runtime.maxTurns").source).toBe("json");
  });

  it("marks an unset field as default", () => {
    const sections = buildView(baseEnv);
    expect(field(sections, "runtime.effort").source).toBe("default");
    expect(field(sections, "runtime.effort").value).toBe("—");
  });

  it("lets a real env var win over a json-present value", () => {
    const sections = buildView(
      { ...baseEnv, MONO_AGENT_MAX_TURNS: "9" },
      { runtime: { maxTurns: 7 } },
    );
    expect(field(sections, "runtime.maxTurns")).toMatchObject({ value: "9", source: "env" });
  });

  it("reports the memory section as disabled when memory is unconfigured", () => {
    const memory = section(buildView(baseEnv), "memory");
    expect(memory.status).toBe("disabled");
    expect(memory.fields[0]).toMatchObject({ value: "not configured", source: "default" });
  });

  it("surfaces the observability and local-provider sections the old registry omitted", () => {
    const sections = buildView(baseEnv);
    expect(section(sections, "observability").status).toBe("disabled");
    expect(field(sections, "providers.local")).toBeDefined();
    expect(field(sections, "observability.exporters")).toBeDefined();
  });

  it("redacts the embeddings api key and never leaks the value", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "journal",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
      MONO_AGENT_MEMORY_EMBEDDINGS_PROVIDER: "openai",
      MONO_AGENT_MEMORY_EMBEDDINGS_MODEL: "text-embedding-3-small",
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-super-secret",
    });
    const apiKey = field(sections, "memory.embeddings.apiKey");
    expect(apiKey.redacted).toBe(true);
    expect(apiKey.value).toBe("set");
    expect(JSON.stringify(sections)).not.toContain("sk-super-secret");
  });

  it("activates the memory section and shows the resolved mode", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "lite",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
    });
    const memory = section(sections, "memory");
    expect(memory.status).toBe("active");
    expect(field(sections, "memory.mode")).toMatchObject({ value: "lite", source: "env" });
  });

  it("surfaces consolidation fields for bujo memory and does not expose removed ritual fields", () => {
    const sections = buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_MODE: "bujo",
      MONO_AGENT_MEMORY_PATH: "/repo/memory",
      MONO_AGENT_MEMORY_CONSOLIDATION_CRON: "0 */4 * * *",
    });

    expect(field(sections, "memory.consolidation.enabled")).toMatchObject({ value: "on", source: "default" });
    expect(field(sections, "memory.consolidation.cron")).toMatchObject({ value: "0 */4 * * *", source: "env" });
    expect(sections.flatMap((entry) => entry.fields).map((entry) => entry.id)).not.toEqual(
      expect.arrayContaining([
        "memory.reflection.enabled",
        "memory.reflection.cron",
        "memory.migration.enabled",
        "memory.migration.cron",
      ]),
    );
  });

  it("shows artifact retention with default, json, and env sources", () => {
    const defaultSections = buildView(baseEnv);
    expect(field(defaultSections, "artifacts.retention.maxAgeDays")).toMatchObject({ value: "365 day(s)", source: "default" });
    expect(field(defaultSections, "artifacts.retention.maxCount")).toMatchObject({ value: "50000", source: "default" });
    expect(field(defaultSections, "artifacts.retention.dryRun")).toMatchObject({ value: "no", source: "default" });

    const jsonSections = buildView(baseEnv, {
      artifacts: {
        retention: { maxAgeDays: 10, maxCount: 200, dryRun: true },
      },
    });
    expect(field(jsonSections, "artifacts.retention.maxAgeDays")).toMatchObject({ value: "10 day(s)", source: "json" });
    expect(field(jsonSections, "artifacts.retention.maxCount")).toMatchObject({ value: "200", source: "json" });
    expect(field(jsonSections, "artifacts.retention.dryRun")).toMatchObject({ value: "yes", source: "json" });

    const envSections = buildView(
      {
        ...baseEnv,
        MONO_AGENT_ARTIFACT_RETENTION_MAX_COUNT: "50",
      },
      {
        artifacts: {
          retention: { maxCount: 200 },
        },
      },
    );
    expect(field(envSections, "artifacts.retention.maxCount")).toMatchObject({ value: "50", source: "env" });
  });
});

describe("findJsonSecretConfigWarnings", () => {
  it("warns for a JSON-sourced embeddings api key and names its env var", () => {
    const warnings = findJsonSecretConfigWarnings(buildView(baseEnv, {
      memory: {
        mode: "journal",
        path: "./memory",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
          apiKey: "sk-json-secret",
        },
      },
    }));

    expect(warnings).toEqual([
      "[WARN] memory.embeddings.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY).",
    ]);
  });

  it("does not warn when the embeddings api key is env-sourced", () => {
    const warnings = findJsonSecretConfigWarnings(buildView({
      ...baseEnv,
      MONO_AGENT_MEMORY_EMBEDDINGS_API_KEY: "sk-env-secret",
    }, {
      memory: {
        mode: "journal",
        path: "./memory",
        embeddings: {
          provider: "openai",
          model: "text-embedding-3-small",
        },
      },
    }));

    expect(warnings).toEqual([]);
  });

  it("warns for a JSON-sourced Supermemory api key and names its env var", () => {
    const warnings = findJsonSecretConfigWarnings(buildView(baseEnv, {
      memory: {
        backend: "supermemory",
        supermemory: {
          baseUrl: "http://127.0.0.1:6767",
          apiKey: "sm-json-secret",
        },
      },
    }));

    expect(warnings).toEqual([
      "[WARN] memory.supermemory.apiKey is a secret read from mono-agent.config.json — move it to .env (MONO_AGENT_MEMORY_SUPERMEMORY_API_KEY).",
    ]);
  });
});

describe("findRemovedConfigWarnings", () => {
  it("warns for removed JSON memory keys without printing values", () => {
    const warnings = findRemovedConfigWarnings({
      json: {
        memory: {
          reflection: { enabled: true, cron: "secret-ish-cron" },
          migration: { enabled: false },
        },
      },
      env: {},
    });

    expect(warnings).toEqual([
      "[WARN] memory.reflection is removed and ignored; use memory.consolidation instead.",
      "[WARN] memory.migration is removed and ignored; use memory.consolidation instead.",
    ]);
    expect(warnings.join("\n")).not.toContain("secret-ish-cron");
  });

  it("warns for removed env memory keys without printing values", () => {
    const warnings = findRemovedConfigWarnings({
      json: {},
      env: {
        MONO_AGENT_MEMORY_REFLECTION_ENABLED: "true",
        MONO_AGENT_MEMORY_MIGRATION_CRON: "secret-ish-cron",
      },
    });

    expect(warnings).toEqual([
      "[WARN] MONO_AGENT_MEMORY_REFLECTION_ENABLED is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
      "[WARN] MONO_AGENT_MEMORY_MIGRATION_CRON is removed and ignored; use MONO_AGENT_MEMORY_CONSOLIDATION_ENABLED or MONO_AGENT_MEMORY_CONSOLIDATION_CRON instead.",
    ]);
    expect(warnings.join("\n")).not.toContain("secret-ish-cron");
  });
});
