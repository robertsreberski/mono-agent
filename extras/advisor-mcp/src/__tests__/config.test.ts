import { describe, expect, it } from "vitest";

import {
  ADVISOR_CONFIG_FIELDS,
  ADVISOR_MAX_REQUEST_BYTES,
  DEFAULT_ADVISOR_ALLOWED_HOSTS,
  loadAdvisorConfig,
  redactAdvisorConfig,
} from "../config.js";
import { AdvisorError } from "../errors.js";

describe("advisor config", () => {
  it("loads the complete disabled loopback defaults", async () => {
    await expect(loadAdvisorConfig({ env: {}, json: {} })).resolves.toEqual({
      enabled: false,
      host: "127.0.0.1",
      port: 4312,
      path: "/mcp",
      allowNonLoopback: false,
      requireBearer: false,
      allowedHosts: [...DEFAULT_ADVISOR_ALLOWED_HOSTS],
      allowedOrigins: [],
      maxRequestBytes: ADVISOR_MAX_REQUEST_BYTES,
      maxPatchChars: 400_000,
      maxVerificationChars: 120_000,
      maxIntentChars: 4_000,
      maxOutputChars: 64_000,
      maxResponseBytes: 524_288,
      maxRunMs: 900_000,
      maxConcurrentReviews: 2,
      maxSessions: 64,
      sessionTtlMs: 21_600_000,
      namespace: "default",
    });
  });

  it("layers environment values over the top-level advisor JSON section", async () => {
    const config = await loadAdvisorConfig({
      json: {
        advisor: {
          enabled: true,
          port: 1111,
          path: "/json",
          maxRunMs: 0,
          namespace: "json-space",
          operatorPrompt: "JSON prompt",
        },
      },
      env: {
        MONO_AGENT_ADVISOR_PORT: "0",
        MONO_AGENT_ADVISOR_PATH: "/env",
        MONO_AGENT_ADVISOR_NAMESPACE: "env-space",
        MONO_AGENT_ADVISOR_MODEL: "anthropic:claude-opus-test",
        MONO_AGENT_ADVISOR_EFFORT: "high",
      },
    });

    expect(config).toMatchObject({
      enabled: true,
      port: 0,
      path: "/env",
      maxRunMs: 0,
      namespace: "env-space",
      operatorPrompt: "JSON prompt",
    });
  });

  it.each(["mcp", "/mcp?x=1", "/mcp#fragment", "/mcp\u0000"])(
    "rejects unsafe endpoint path %j",
    async (path) => {
      await expect(loadAdvisorConfig({
        env: { MONO_AGENT_ADVISOR_PATH: path },
        json: {},
      })).rejects.toMatchObject({ code: "invalid_config" });
    },
  );

  it("enforces the exact request and run bounds", async () => {
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_MAX_REQUEST_BYTES: String(ADVISOR_MAX_REQUEST_BYTES + 1) },
      json: {},
    })).rejects.toThrow(`must be between 1024 and ${ADVISOR_MAX_REQUEST_BYTES}`);
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_MAX_RUN_MS: "86400001" },
      json: {},
    })).rejects.toThrow("must be between 0 and 86400000");
  });

  it("fails closed for every incomplete non-loopback configuration", async () => {
    const base = {
      MONO_AGENT_ADVISOR_ENABLED: "true",
      MONO_AGENT_ADVISOR_HOST: "0.0.0.0",
      MONO_AGENT_ADVISOR_MODEL: "anthropic:claude-opus-test",
      MONO_AGENT_ADVISOR_EFFORT: "xhigh",
    };
    await expect(loadAdvisorConfig({ env: base, json: {} })).rejects.toMatchObject({
      code: "unsafe_host",
    });
    await expect(loadAdvisorConfig({
      env: { ...base, MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK: "true" },
      json: {},
    })).rejects.toMatchObject({ code: "missing_required_config" });
    await expect(loadAdvisorConfig({
      env: {
        ...base,
        MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK: "true",
        MONO_AGENT_ADVISOR_BEARER_TOKEN: "secret",
      },
      json: {},
    })).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("accepts an opted-in, bearer-protected non-loopback bind with explicit hosts", async () => {
    await expect(loadAdvisorConfig({
      env: {
        MONO_AGENT_ADVISOR_ENABLED: "true",
        MONO_AGENT_ADVISOR_HOST: "0.0.0.0",
        MONO_AGENT_ADVISOR_ALLOW_NON_LOOPBACK: "true",
        MONO_AGENT_ADVISOR_BEARER_TOKEN: "secret",
        MONO_AGENT_ADVISOR_ALLOWED_HOSTS: "advisor.example.test",
        MONO_AGENT_ADVISOR_MODEL: "anthropic:claude-opus-test",
        MONO_AGENT_ADVISOR_EFFORT: "xhigh",
      },
      json: {},
    })).resolves.toMatchObject({
      host: "0.0.0.0",
      allowNonLoopback: true,
      bearerToken: "secret",
      allowedHosts: ["advisor.example.test"],
    });
  });

  it("adds a configured loopback literal to the default Host allowlist", async () => {
    const config = await loadAdvisorConfig({
      env: {
        MONO_AGENT_ADVISOR_ENABLED: "true",
        MONO_AGENT_ADVISOR_HOST: "127.0.0.2",
        MONO_AGENT_ADVISOR_MODEL: "pi:openai-codex:gpt-5.6-sol",
        MONO_AGENT_ADVISOR_EFFORT: "max",
      },
      json: {},
    });
    expect(config.allowedHosts).toContain("127.0.0.2");
  });

  it("requires a bearer token when loopback auth is requested", async () => {
    await expect(loadAdvisorConfig({
      env: {
        MONO_AGENT_ADVISOR_ENABLED: "true",
        MONO_AGENT_ADVISOR_REQUIRE_BEARER: "true",
        MONO_AGENT_ADVISOR_MODEL: "anthropic:claude-opus-test",
        MONO_AGENT_ADVISOR_EFFORT: "high",
      },
      json: {},
    })).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("redacts the bearer token without retaining its value", async () => {
    const config = await loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_BEARER_TOKEN: "do-not-print" },
      json: {},
    });
    const redacted = redactAdvisorConfig(config);
    expect(redacted.bearerToken).toEqual({ present: true, redacted: true });
    expect(JSON.stringify(redacted)).not.toContain("do-not-print");
  });

  it("exports one field spec for every public advisor config field", () => {
    expect(ADVISOR_CONFIG_FIELDS.map((field) => field.id)).toEqual([
      "advisor.enabled",
      "advisor.host",
      "advisor.port",
      "advisor.path",
      "advisor.allowNonLoopback",
      "advisor.requireBearer",
      "advisor.bearerToken",
      "advisor.allowedHosts",
      "advisor.allowedOrigins",
      "advisor.model",
      "advisor.effort",
      "advisor.maxRequestBytes",
      "advisor.maxPatchChars",
      "advisor.maxVerificationChars",
      "advisor.maxIntentChars",
      "advisor.maxOutputChars",
      "advisor.maxResponseBytes",
      "advisor.maxRunMs",
      "advisor.maxConcurrentReviews",
      "advisor.maxSessions",
      "advisor.sessionTtlMs",
      "advisor.namespace",
      "advisor.operatorPrompt",
    ]);
  });

  it("uses the package's typed config error", async () => {
    await expect(loadAdvisorConfig({
      env: {},
      json: { advisor: { enabled: "yes" } },
    })).rejects.toBeInstanceOf(AdvisorError);
  });

  it("requires an explicit model and effort whenever the endpoint is enabled", async () => {
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_ENABLED: "true" },
      json: {},
    })).rejects.toMatchObject({ code: "missing_required_config" });
    await expect(loadAdvisorConfig({
      env: {
        MONO_AGENT_ADVISOR_ENABLED: "true",
        MONO_AGENT_ADVISOR_MODEL: "anthropic:claude-opus-test",
      },
      json: {},
    })).rejects.toMatchObject({ code: "missing_required_config" });
  });

  it("rejects unknown config keys and unbounded arrays", async () => {
    await expect(loadAdvisorConfig({
      env: {},
      json: { advisor: { typo: true } },
    })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_ALLOWED_HOSTS: Array.from({ length: 65 }, (_, index) => `h${index}`).join(",") },
      json: {},
    })).rejects.toThrow("at most 64 entries");
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_ALLOWED_HOSTS: "advisor.example.test:443" },
      json: {},
    })).rejects.toMatchObject({ code: "invalid_config" });
    await expect(loadAdvisorConfig({
      env: { MONO_AGENT_ADVISOR_NAMESPACE: "ﷺ".repeat(128) },
      json: {},
    })).rejects.toMatchObject({ code: "invalid_config" });
  });
});
