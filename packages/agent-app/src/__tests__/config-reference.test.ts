import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  allConfigReferenceFields,
  buildGeneratedConfigReferenceMarkdown,
  buildMonoAgentConfigSchema,
  findUnknownAppConfigWarnings,
  MONO_AGENT_CONFIG_SCHEMA_URL,
} from "../config-reference.js";

const here = dirname(fileURLToPath(import.meta.url));

interface SchemaNode {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly properties?: Record<string, SchemaNode>;
  readonly items?: SchemaNode;
}

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

describe("config reference", () => {
  it("warns for unknown top-level and nested keys without blocking known sections", () => {
    const warnings = findUnknownAppConfigWarnings({
      $schema: MONO_AGENT_CONFIG_SCHEMA_URL,
      runtime: {
        model: "codex:gpt-5.5",
        session: {
          idleMs: 5_000,
        },
      },
      context: { identityPath: "./IDENTITY.md" },
      traceability: {
        heartBeatMs: 10_000,
        heartbeatMs: 10_000,
      },
      console: { enabled: true, port: 4400 },
      webhook: {
        enabled: true,
        endpoints: [{ name: "ok", path: "/ok", extraPluginOwnedShape: true }],
      },
      channels: {
        plugins: [
          {
            package: "@mono-agent/a2a-adapter",
            config: { provider: { enabled: false, pluginOwned: true } },
          },
        ],
      },
    });

    expect(warnings).toEqual([
      "[WARN] Unknown config key runtime.session.idleMs in mono-agent.config.json - it is ignored.",
      "[WARN] Unknown config key traceability.heartBeatMs in mono-agent.config.json - it is ignored.",
      "[WARN] Unknown config key console in mono-agent.config.json - it is ignored.",
    ]);
  });

  it("keeps the committed schema generated from the current registry", () => {
    const root = repoRoot();
    const schema = readFileSync(join(root, "packages/agent-app/schema/mono-agent.config.schema.json"), "utf8");
    expect(schema).toBe(`${JSON.stringify(buildMonoAgentConfigSchema(), null, 2)}\n`);
  });

  it("models required core keys and important numeric/object shapes in the schema", () => {
    const schema = buildMonoAgentConfigSchema() as SchemaNode;

    expect(schema.required).toEqual(["runtime", "context"]);
    expect(schemaNode(schema, "runtime").required).toEqual(["model"]);
    expect(schemaNode(schema, "context").required).toEqual(["identityPath"]);
    expect(schemaNode(schema, "concurrency", "maxConcurrentRuns").type).toBe("integer");
    expect(schemaNode(schema, "concurrency", "maxPendingRuns").type).toBe("integer");
    expect(schemaNode(schema, "memory", "embeddings", "circuitBreaker", "failureThreshold").type).toBe("integer");
    expect(schemaNode(schema, "cron", "jobs").items?.required).toEqual(["id", "expression", "prompt"]);
    expect(schemaNode(schema, "webhook", "endpoints").items?.required).toEqual(["path"]);
    expect(schemaNode(schema, "agent", "name")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 80,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    });
    expect(schemaNode(schema, "runtime", "fallbacks").items?.required).toEqual(["model"]);
    expect(schemaNode(schema, "runtime", "fallbacks").items?.properties?.effort?.enum)
      .toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(schemaNode(schema, "runtime", "routeSafety").enum).toEqual(["uniform", "per-route-native"]);
    expect(schemaNode(schema, "sandbox", "mode").enum).toEqual(["native", "off"]);
    expect(schemaNode(schema, "sandbox", "network", "mode").enum).toEqual(["none", "localhost", "allowlist"]);
    expect(schemaNode(schema, "sandbox", "fallback").enum).toEqual(["fail-closed", "unsafe-host-process"]);
  });

  it("uses loader-valid examples for generated complex fields", () => {
    const cronJobs = allConfigReferenceFields().find((field) => field.jsonPath === "cron.jobs");
    expect(cronJobs?.example).toEqual([
      { id: "daily", expression: "0 8 * * *", prompt: "Summarize the overnight queue." },
    ]);

    const webhookEndpoints = allConfigReferenceFields().find((field) => field.jsonPath === "webhook.endpoints");
    expect(webhookEndpoints?.example).toEqual([
      { name: "triage", path: "/webhook/triage", prompt: "Triage this payload." },
    ]);
  });

  it("keeps the committed generated config reference in sync", () => {
    const root = repoRoot();
    const reference = readFileSync(join(root, "docs/config/reference.md"), "utf8");
    expect(reference).toBe(buildGeneratedConfigReferenceMarkdown());
  });
});

function schemaNode(schema: SchemaNode, ...path: readonly string[]): SchemaNode {
  let current = schema;
  for (const segment of path) {
    const next = current.properties?.[segment];
    if (next === undefined) {
      throw new Error(`missing schema node ${path.join(".")}`);
    }
    current = next;
  }
  return current;
}
