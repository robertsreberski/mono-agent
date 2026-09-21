import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MonoAgentConfigError } from "../index.js";
import { readMonoAgentConfigJson, writeMonoAgentConfigJson } from "../json-source.js";
import type { MonoAgentConfigJson } from "../json-source.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readMonoAgentConfigJson", () => {
  it("returns an empty config when the file is missing", async () => {
    const result = await readMonoAgentConfigJson(join(dir, "absent.json"));
    expect(result.missing).toBe(true);
    expect(result.json).toEqual({});
    expect(result.version).toBe("");
  });

  it("parses an existing file and reports a stable version hash", async () => {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ runtime: { maxTurns: 12 } }), "utf8");
    const first = await readMonoAgentConfigJson(path);
    const second = await readMonoAgentConfigJson(path);
    expect(first.json.runtime?.maxTurns).toBe(12);
    expect(first.version).toBe(second.version);
    expect(first.missing).toBe(false);
  });

  it("rejects files that don't contain a JSON object", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "[1,2,3]", "utf8");
    await expect(readMonoAgentConfigJson(path)).rejects.toBeInstanceOf(MonoAgentConfigError);
  });

  it("rejects malformed JSON", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json", "utf8");
    await expect(readMonoAgentConfigJson(path)).rejects.toBeInstanceOf(MonoAgentConfigError);
  });

  it("treats an empty file as an empty config", async () => {
    const path = join(dir, "empty.json");
    await writeFile(path, "", "utf8");
    const result = await readMonoAgentConfigJson(path);
    expect(result.json).toEqual({});
    expect(result.missing).toBe(false);
  });

  it.each([
    [
      "runtime.permissionMode",
      { runtime: { permissionMode: "bypassPermissions" } },
      "`runtime.permissionMode` was removed because the Pi runtime never enforced it. Delete the key; configure `sandbox` for enforced tool isolation.",
    ],
    [
      "runtime.executionMode",
      { runtime: { executionMode: "sdk" } },
      "`runtime.executionMode` was removed; mono-agent runs only the Pi runtime (SDK). Delete the key.",
    ],
    [
      "runtime.routeSafety",
      { runtime: { routeSafety: "per-route-native" } },
      "`runtime.routeSafety` was removed; every route is Pi-native, so `per-route-native` has no meaning. Delete the key.",
    ],
    [
      "runtime.fallbackModels",
      { runtime: { fallbackModels: ["openai-codex:gpt-5.6-sol"] } },
      "`runtime.fallbackModels` was replaced by `runtime.fallbacks: [{ \"model\": \"...\" }]`. Replace the key with that shape.",
    ],
    [
      "memory.llm.executionMode",
      { memory: { llm: { executionMode: "sdk" } } },
      "`memory.llm.executionMode` was removed for the same reason as `runtime.executionMode`: mono-agent runs only the Pi runtime (SDK). Delete the key.",
    ],
  ] as const)("rejects retired JSON key %s with migration guidance", async (retiredPath, json, message) => {
    const path = join(dir, "retired.json");
    await writeFile(path, JSON.stringify(json), "utf8");

    await expect(readMonoAgentConfigJson(path)).rejects.toMatchObject({
      name: "MonoAgentConfigError",
      code: "invalid_json",
      message,
      details: { path: retiredPath, code: "invalid_json" },
    });
  });

  /**
   * `mono-agent migrate-config` was removed on the argument that one load names
   * everything left to fix. A `.find` reported one retired key per run, so a config with
   * four of them took four edit/re-run cycles to discover them all.
   */
  it("accepts only the narrow inert observability compatibility shapes", async () => {
    for (const observability of [{}, { exporters: [] }]) {
      const path = join(dir, `inert-${JSON.stringify(observability).length}.json`);
      await writeFile(path, JSON.stringify({ observability }), "utf8");
      await expect(readMonoAgentConfigJson(path)).resolves.toMatchObject({ json: { observability } });
    }
  });

  it.each([
    null,
    [],
    "removed",
    { exporters: null },
    { exporters: {} },
    { exporters: [{ type: "phoenix", headers: { authorization: "Bearer secret-token" } }] },
    { unknown: "secret-token" },
  ])("rejects active or malformed removed observability JSON secret-safely (%j)", async (observability) => {
    const path = join(dir, "retired-observability.json");
    await writeFile(path, JSON.stringify({ observability }), "utf8");
    let rejection: unknown;
    try {
      await readMonoAgentConfigJson(path);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: "invalid_json", details: { path: "observability" } });
    expect(String(rejection)).toContain("observability.exporters");
    expect(String(rejection)).not.toContain("secret-token");
  });

  it("accepts only an exact empty Supermemory block as inert JSON compatibility", async () => {
    const path = join(dir, "inert-supermemory.json");
    const json = { memory: { supermemory: {} } };
    await writeFile(path, JSON.stringify(json), "utf8");

    await expect(readMonoAgentConfigJson(path)).resolves.toMatchObject({ json });
  });

  it.each(["supermemory", "  supermemory  "])(
    "rejects the retired JSON backend selector before projection (%j)",
    async (backend) => {
      const path = join(dir, "retired-supermemory-selector.json");
      await writeFile(path, JSON.stringify({ memory: { backend, supermemory: {} } }), "utf8");

      await expect(readMonoAgentConfigJson(path)).rejects.toMatchObject({
        code: "invalid_json",
        details: { path: "memory.backend", paths: ["memory.backend"] },
      });
    },
  );

  it("reports the retired selector and active block once each without echoing values", async () => {
    const path = join(dir, "retired-supermemory-combined.json");
    await writeFile(path, JSON.stringify({
      memory: { backend: "supermemory", supermemory: { apiKey: "secret-api-key" } },
    }), "utf8");
    let rejection: unknown;
    try {
      await readMonoAgentConfigJson(path);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: {
        path: "memory.backend",
        paths: ["memory.backend", "memory.supermemory"],
      },
    });
    expect(String(rejection)).not.toContain("secret-api-key");
  });

  it.each([
    null,
    [],
    "removed",
    42,
    { baseUrl: "" },
    { apiKey: "secret-api-key" },
    { exposeMcpServer: false },
    { unknown: "secret-unknown-value" },
  ])("rejects nonempty or malformed Supermemory JSON secret-safely (%j)", async (supermemory) => {
    const path = join(dir, "retired-supermemory-block.json");
    const original = JSON.stringify({ memory: { supermemory } });
    await writeFile(path, original, "utf8");
    let rejection: unknown;
    try {
      await readMonoAgentConfigJson(path);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      code: "invalid_json",
      details: { path: "memory.supermemory", paths: ["memory.supermemory"] },
    });
    expect(String(rejection)).toContain("first-party Supermemory support");
    expect(String(rejection)).not.toContain("secret-api-key");
    expect(String(rejection)).not.toContain("secret-unknown-value");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("reports every retired JSON key in one read, not just the first", async () => {
    const path = join(dir, "retired-many.json");
    await writeFile(
      path,
      JSON.stringify({
        runtime: {
          executionMode: "sdk",
          routeSafety: "per-route-native",
          fallbackModels: ["openai-codex:gpt-5.6-sol"],
        },
        memory: { llm: { executionMode: "sdk" } },
      }),
      "utf8",
    );

    await expect(readMonoAgentConfigJson(path)).rejects.toMatchObject({
      code: "invalid_json",
      details: {
        path: "runtime.executionMode",
        paths: [
          "runtime.executionMode",
          "runtime.routeSafety",
          "runtime.fallbackModels",
          "memory.llm.executionMode",
        ],
      },
    });
    await expect(readMonoAgentConfigJson(path)).rejects.toThrow(/runtime\.routeSafety/u);
    await expect(readMonoAgentConfigJson(path)).rejects.toThrow(/memory\.llm\.executionMode/u);
  });
});

describe("writeMonoAgentConfigJson", () => {
  it("creates the file with mode 0o600 and pretty-printed content", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: { runtime: { maxTurns: 12 }, futureAdapter: { enabled: true } },
    });
    const text = await readFile(path, "utf8");
    expect(text).toContain("\"maxTurns\": 12");
    expect(text.endsWith("\n")).toBe(true);
    const stats = await stat(path);
    // mask off file-type bits and check the permission bits.
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("merges a sparse patch into an existing file (deep-merge per section)", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        runtime: { maxTurns: 8, model: "pi:openai-codex:gpt-5.5" },
        tools: { allowedTools: ["Read"] },
      },
    });
    await writeMonoAgentConfigJson({
      path,
      patch: { runtime: { maxTurns: 16 } },
    });
    const { json } = await readMonoAgentConfigJson(path);
    expect(json.runtime?.maxTurns).toBe(16);
    expect(json.runtime?.model).toBe("pi:openai-codex:gpt-5.5");
    expect(json.tools?.allowedTools).toEqual(["Read"]);
  });

  it("preserves and merges unknown object sections for adapter-owned settings", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        runtime: { maxTurns: 8 },
        telegram: { botToken: "abc", allowedChatIds: ["111"] },
      },
    });
    await writeMonoAgentConfigJson({
      path,
      patch: { telegram: { allowedChatIds: ["222"] } },
    });
    const { json } = await readMonoAgentConfigJson(path);
    expect(json.telegram).toEqual({ botToken: "abc", allowedChatIds: ["222"] });
  });

  it("round-trips LM Studio embeddings including an optional credential reference", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({
      path,
      patch: {
        memory: {
          mode: "journal",
          path: ".mono-agent/memory",
          embeddings: {
            provider: "lmstudio",
            model: "embed-model",
            endpoint: "http://localhost:1234",
            apiKeyEnv: "LM_STUDIO_API_KEY",
            dim: 768,
          },
        },
      },
    });

    const { json } = await readMonoAgentConfigJson(path);
    expect(json.memory?.embeddings).toEqual({
      provider: "lmstudio",
      model: "embed-model",
      endpoint: "http://localhost:1234",
      apiKeyEnv: "LM_STUDIO_API_KEY",
      dim: 768,
    });
  });

  it("preserves generic writer semantics while load rejects and an empty replacement repairs legacy exporters", async () => {
    const path = join(dir, "config.json");
    const activeLegacy = {
      observability: {
        exporters: [{ type: "phoenix", headers: { authorization: "Bearer secret-token" } }],
      },
    } as unknown as MonoAgentConfigJson;

    await expect(writeMonoAgentConfigJson({ path, patch: activeLegacy })).resolves.toHaveProperty("version");
    let rejection: unknown;
    try {
      await readMonoAgentConfigJson(path);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: "invalid_json", details: { path: "observability" } });
    expect(String(rejection)).not.toContain("secret-token");

    await writeMonoAgentConfigJson({ path, patch: { observability: { exporters: [] } } });
    await expect(readMonoAgentConfigJson(path)).resolves.toMatchObject({
      json: { observability: { exporters: [] } },
    });
  });

  it("preserves generic writes while reads reject active Supermemory and accept an explicit empty repair", async () => {
    const path = join(dir, "config.json");
    const activeLegacy = {
      memory: { supermemory: { apiKey: "secret-api-key" } },
    } as unknown as MonoAgentConfigJson;

    await expect(writeMonoAgentConfigJson({ path, patch: activeLegacy })).resolves.toHaveProperty("version");
    let rejection: unknown;
    try {
      await readMonoAgentConfigJson(path);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toMatchObject({ code: "invalid_json", details: { path: "memory.supermemory" } });
    expect(String(rejection)).not.toContain("secret-api-key");

    // Repair is an explicit replacement, not an automatic loader mutation or a
    // special case in the generic deep-merge writer.
    await writeFile(path, `${JSON.stringify({ memory: { supermemory: {} } }, null, 2)}\n`, "utf8");
    await expect(readMonoAgentConfigJson(path)).resolves.toMatchObject({
      json: { memory: { supermemory: {} } },
    });
  });

  it("does not leave a .tmp file behind on success", async () => {
    const path = join(dir, "config.json");
    await writeMonoAgentConfigJson({ path, patch: { runtime: { maxTurns: 4 } } });
    const tmpStat = await stat(`${path}.tmp`).catch(() => null);
    expect(tmpStat).toBeNull();
  });

  it("creates parent directories when needed", async () => {
    const path = join(dir, "nested", "deeper", "config.json");
    await writeMonoAgentConfigJson({ path, patch: { runtime: { maxTurns: 4 } } });
    const stats = await stat(path);
    expect(stats.isFile()).toBe(true);
  });
});
