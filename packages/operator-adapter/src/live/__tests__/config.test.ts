import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadLiveAdapterConfig, redactLiveAdapterConfig } from "../index.js";
import type { LiveAdapterConfig } from "../index.js";

const SYNTHETIC_API_KEY = "sk-test-secret";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-live-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadLiveAdapterConfig", () => {
  it("defaults to enabled on loopback with an ephemeral port", async () => {
    await expect(loadLiveAdapterConfig({ env: {} })).resolves.toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
    });
  });

  it("loads live settings from JSON and lets env values override every field", async () => {
    const config = await loadLiveAdapterConfig({
      json: {
        live: {
          enabled: false,
          host: "json.example.test",
          port: 4111,
          basePath: "/json/live",
          allowNonLoopback: false,
          apiKey: "json-secret",
        },
      },
      env: {
        MONO_AGENT_LIVE_ENABLED: "true",
        MONO_AGENT_LIVE_HOST: "  env.example.test  ",
        MONO_AGENT_LIVE_PORT: "4222",
        MONO_AGENT_LIVE_BASE_PATH: "/env/live/",
        MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK: "true",
        MONO_AGENT_LIVE_API_KEY: `  ${SYNTHETIC_API_KEY}  `,
      },
    });

    expect(config).toEqual({
      enabled: true,
      host: "env.example.test",
      port: 4222,
      basePath: "/env/live",
      allowNonLoopback: true,
      apiKey: SYNTHETIC_API_KEY,
    });
  });

  it("loads the live section from a JSON file and ignores unknown fields", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        unknownTopLevel: { enabled: true },
        live: {
          enabled: true,
          host: "127.0.0.2",
          port: 4333,
          basePath: "/operator/events/",
          allowNonLoopback: true,
          apiKey: SYNTHETIC_API_KEY,
          unknownFutureField: "ignored",
        },
      })}\n`,
      "utf8",
    );

    await expect(loadLiveAdapterConfig({ env: {}, jsonPath: path })).resolves.toEqual({
      enabled: true,
      host: "127.0.0.2",
      port: 4333,
      basePath: "/operator/events",
      allowNonLoopback: true,
      apiKey: SYNTHETIC_API_KEY,
    });
  });

  it("can be disabled via JSON or env", async () => {
    await expect(loadLiveAdapterConfig({
      env: {},
      json: { live: { enabled: false } },
    })).resolves.toMatchObject({ enabled: false });
    await expect(loadLiveAdapterConfig({
      env: { MONO_AGENT_LIVE_ENABLED: "false" },
    })).resolves.toMatchObject({ enabled: false });
  });

  it("treats a non-object live section and wrong-typed JSON fields as absent", async () => {
    await expect(loadLiveAdapterConfig({
      env: {},
      json: { live: "not-an-object" },
    })).resolves.toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
    });

    await expect(loadLiveAdapterConfig({
      env: {},
      json: {
        live: {
          enabled: "false",
          host: 127,
          port: "4333",
          basePath: ["/not-a-string"],
          allowNonLoopback: 1,
          apiKey: { value: SYNTHETIC_API_KEY },
        },
      },
    })).resolves.toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
    });
  });

  it("propagates malformed JSON file errors", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, "{ not-valid-json\n", "utf8");

    await expect(loadLiveAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_json_source",
      details: { path },
    });
  });

  it.each([
    "no-leading-slash",
    "////",
    "/live//events",
    "/live/:source",
    "/live/*",
    "/live?source=test",
    "/live#events",
    "/live/%2Fevents",
  ])("rejects malformed or non-literal basePath %j", async (basePath) => {
    await expect(loadLiveAdapterConfig({
      env: { MONO_AGENT_LIVE_BASE_PATH: basePath },
    })).rejects.toMatchObject({
      code: "invalid_config",
      message: "MONO_AGENT_LIVE_BASE_PATH must be an absolute literal path made of slash-separated URL path segments.",
    });
  });

  it("accepts root and literal path characters while removing one trailing slash", async () => {
    await expect(loadLiveAdapterConfig({
      env: { MONO_AGENT_LIVE_BASE_PATH: "/" },
    })).resolves.toMatchObject({ basePath: "/" });
    await expect(loadLiveAdapterConfig({
      env: { MONO_AGENT_LIVE_BASE_PATH: "/live/~._-/" },
    })).resolves.toMatchObject({ basePath: "/live/~._-" });
  });

  it.each([
    ["MONO_AGENT_LIVE_ENABLED", "yes"],
    ["MONO_AGENT_LIVE_PORT", "1.5"],
    ["MONO_AGENT_LIVE_PORT", "65536"],
    ["MONO_AGENT_LIVE_ALLOW_NON_LOOPBACK", "yes"],
  ] as const)("rejects malformed %s values", async (name, value) => {
    await expect(loadLiveAdapterConfig({
      env: { [name]: value },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });
});

describe("redactLiveAdapterConfig", () => {
  it("marks a synthetic API key as present without returning its value", () => {
    const config: LiveAdapterConfig = {
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
      apiKey: SYNTHETIC_API_KEY,
    };

    const redacted = redactLiveAdapterConfig(config);

    expect(redacted).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
      apiKey: { present: true, redacted: true },
    });
    expect(JSON.stringify(redacted)).not.toContain(SYNTHETIC_API_KEY);
    expect(config.apiKey).toBe(SYNTHETIC_API_KEY);
  });

  it("keeps the redacted marker when no API key is configured", () => {
    expect(redactLiveAdapterConfig({
      enabled: false,
      host: "127.0.0.1",
      port: 0,
      basePath: "/live",
      allowNonLoopback: false,
    }).apiKey).toEqual({ present: false, redacted: true });
  });
});
