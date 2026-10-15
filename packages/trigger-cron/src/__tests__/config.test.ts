import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CRON_CONFIG_FIELDS,
  MAX_CRON_JOBS,
  loadCronAdapterConfig,
  redactCronAdapterConfig,
  toCronJobs,
} from "../index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mono-agent-cron-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadCronAdapterConfig", () => {
  it("loads a single cron job from JSON and env overrides", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          enabled: true,
          expression: "0 * * * *",
          timezone: "Europe/Amsterdam",
          prompt: "json prompt",
          conversationId: "json-conversation",
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_PROMPT: "env prompt",
        MONO_AGENT_CRON_TIMEZONE: "Asia/Tokyo",
      },
      jsonPath: path,
    });

    expect(config).toEqual({
      operatorActionsEnabled: false,
      jobs: [{
        id: "default",
        enabled: true,
        expression: "0 * * * *",
        timezone: "Asia/Tokyo",
        prompt: "env prompt",
        conversationId: "json-conversation",
      }],
    });
  });

  it("keeps operator actions off by default and lets env override JSON", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(path, `${JSON.stringify({
      cron: {
        operatorActions: { enabled: false },
        jobs: [{ id: "daily", expression: "0 9 * * *", prompt: "brief" }],
      },
    })}\n`, "utf8");

    const config = await loadCronAdapterConfig({
      env: { MONO_AGENT_CRON_OPERATOR_ACTIONS_ENABLED: "true" },
      jsonPath: path,
    });
    expect(config.operatorActionsEnabled).toBe(true);
  });

  it("loads multiple cron jobs from the cron.jobs array in the JSON config file", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [
            {
              id: "daily",
              enabled: true,
              expression: "0 9 * * *",
              timezone: "UTC",
              prompt: "Morning summary.",
              maxRunMs: 2_700_000,
              notify: true,
              notifyConversationId: "telegram:42",
              notifyFailureCooldownHours: 2,
            },
            { id: "weekly", enabled: false, expression: "0 9 * * 1", prompt: "Weekly recap.", conversationId: "cron-weekly" },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });

    expect(config.jobs).toEqual([
      {
        id: "daily",
        enabled: true,
        expression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Morning summary.",
        maxRunMs: 2_700_000,
        notify: true,
        notifyConversationId: "telegram:42",
        notifyFailureCooldownHours: 2,
      },
      { id: "weekly", enabled: false, expression: "0 9 * * 1", timezone: "UTC", prompt: "Weekly recap.", conversationId: "cron-weekly" },
    ]);
  });

  it("lets the MONO_AGENT_CRON_JOBS_JSON env beat the cron.jobs JSON section", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "from-json", expression: "0 9 * * *", prompt: "json" }] } })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([
          { id: "from-env", expression: "*/5 * * * *", prompt: "env" },
        ]),
      },
      jsonPath: path,
    });

    expect(config.jobs.map((job) => job.id)).toEqual(["from-env"]);
  });

  it("rejects a cron.jobs section that is not an array of valid jobs", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken" }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects a cron.jobs maxRunMs that is not a positive integer", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken", expression: "0 9 * * *", prompt: "run", maxRunMs: -1 }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("rejects a cron.jobs notifyFailureCooldownHours that is not a positive integer", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { jobs: [{ id: "broken", expression: "0 9 * * *", prompt: "run", notifyFailureCooldownHours: 0 }] } })}\n`,
      "utf8",
    );

    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path })).rejects.toMatchObject({
      code: "invalid_config",
    });
  });

  it("loads multiple cron jobs from JSON env", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([
          { id: "one", enabled: true, expression: "*/5 * * * *", prompt: "one", notify: true, notifyConversationId: "slack:C1" },
          { id: "two", enabled: false, expression: "0 0 * * *", prompt: "two" },
        ]),
      },
    });

    expect(config.jobs).toEqual([
      { id: "one", enabled: true, expression: "*/5 * * * *", timezone: "UTC", prompt: "one", notify: true, notifyConversationId: "slack:C1" },
      { id: "two", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "two" },
    ]);
  });

  it("loads native notify settings from single-job env fields", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_NOTIFY: "true",
        MONO_AGENT_CRON_NOTIFY_CONVERSATION_ID: "telegram:42",
        MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS: "3",
      },
    });

    expect(config.jobs).toEqual([
      {
        id: "default",
        enabled: true,
        expression: "0 8 * * *",
        timezone: "UTC",
        prompt: "brief",
        notify: true,
        notifyConversationId: "telegram:42",
        notifyFailureCooldownHours: 3,
      },
    ]);
  });

  it("rejects an invalid notify failure cooldown from single-job env fields", async () => {
    await expect(loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_NOTIFY_FAILURE_COOLDOWN_HOURS: "0",
      },
    })).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("loads per-job model and effort overrides from the cron.jobs JSON array", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [
            {
              id: "research",
              enabled: true,
              expression: "0 9 * * *",
              prompt: "Deep research.",
              model: "claude:claude-opus-4-8",
              effort: "high",
            },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });

    expect(config.jobs).toEqual([
      {
        id: "research",
        enabled: true,
        expression: "0 9 * * *",
        timezone: "UTC",
        prompt: "Deep research.",
        model: "claude:claude-opus-4-8",
        effort: "high",
      },
    ]);
  });

  it("loads model and effort from single-job env fields", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_ENABLED: "true",
        MONO_AGENT_CRON_EXPRESSION: "0 8 * * *",
        MONO_AGENT_CRON_PROMPT: "brief",
        MONO_AGENT_CRON_MODEL: "claude:claude-opus-4-8",
        MONO_AGENT_CRON_EFFORT: "max",
      },
    });

    expect(config.jobs).toEqual([
      {
        id: "default",
        enabled: true,
        expression: "0 8 * * *",
        timezone: "UTC",
        prompt: "brief",
        model: "claude:claude-opus-4-8",
        effort: "max",
      },
    ]);
  });

  it("rejects cron identities that cannot fit the bounded operator overview contract", async () => {
    const jobs = Array.from({ length: MAX_CRON_JOBS + 1 }, (_, index) => ({
      id: `job-${String(index)}`,
      expression: "* * * * *",
      prompt: "run",
    }));
    await expect(loadCronAdapterConfig({ env: {}, json: { cron: { jobs } } }))
      .rejects.toThrow(`at most ${String(MAX_CRON_JOBS)} configured jobs`);
    await expect(loadCronAdapterConfig({
      env: {},
      json: { cron: { jobs: [{ id: "x".repeat(257), expression: "* * * * *", prompt: "run" }] } },
    })).rejects.toThrow("cron.jobs[].id must be at most 256 UTF-8 bytes");
    await expect(loadCronAdapterConfig({
      env: {},
      json: { cron: { jobs: [{ id: "bounded", expression: "* * * * *", prompt: "run", conversationId: "é".repeat(257) }] } },
    })).rejects.toThrow("cron.jobs[].conversationId must be at most 512 UTF-8 bytes");
  });
});

describe("redactCronAdapterConfig", () => {
  it("returns cron jobs without changing prompts", () => {
    expect(redactCronAdapterConfig({
      jobs: [{ id: "default", enabled: true, expression: "* * * * *", timezone: "UTC", prompt: "run" }],
    })).toEqual({
      jobs: [{ id: "default", enabled: true, expression: "* * * * *", timezone: "UTC", prompt: "run" }],
    });
  });
});

describe("toCronJobs", () => {
  it("drops disabled jobs and maps to the runtime CronJob shape", () => {
    const jobs = toCronJobs({
      jobs: [
        {
          id: "on",
          enabled: true,
          expression: "* * * * *",
          timezone: "UTC",
          prompt: "run",
          conversationId: "c1",
          maxRunMs: 45_000,
          notify: true,
          notifyConversationId: "telegram:42",
          model: "claude:claude-opus-4-8",
          effort: "high",
        },
        { id: "off", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "skip" },
      ],
    });

    expect(jobs).toEqual([
      {
        id: "on",
        expression: "* * * * *",
        timezone: "UTC",
        prompt: "run",
        conversationId: "c1",
        maxRunMs: 45_000,
        notify: true,
        notifyConversationId: "telegram:42",
        model: "claude:claude-opus-4-8",
        effort: "high",
      },
    ]);
    expect(jobs.some((job) => job.id === "off")).toBe(false);
  });
});

describe("cron preflight config", () => {
  it("accepts a preflight argv and timeout in cron.jobs[] and projects them", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [{
            id: "gated",
            expression: "0 9 * * *",
            prompt: "run",
            preflight: ["node", "gate.mjs", "--strict"],
            preflightTimeoutMs: 12_000,
          }],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });
    expect(config.jobs[0]).toMatchObject({
      preflight: ["node", "gate.mjs", "--strict"],
      preflightTimeoutMs: 12_000,
    });
    expect(toCronJobs(config)[0]).toMatchObject({
      preflight: ["node", "gate.mjs", "--strict"],
      preflightTimeoutMs: 12_000,
    });
  });

  it("reads the single-job JSON array and env overrides, with env winning", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          enabled: true,
          expression: "0 * * * *",
          prompt: "json prompt",
          preflight: ["json-gate"],
          preflightTimeoutMs: 1_000,
        },
      })}\n`,
      "utf8",
    );

    const fromJson = await loadCronAdapterConfig({ env: {}, jsonPath: path });
    expect(fromJson.jobs[0]).toMatchObject({ preflight: ["json-gate"], preflightTimeoutMs: 1_000 });

    const fromEnv = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_PREFLIGHT_JSON: '["env-gate","--flag"]',
        MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS: "60000",
      },
      jsonPath: path,
    });
    expect(fromEnv.jobs[0]).toMatchObject({
      preflight: ["env-gate", "--flag"],
      preflightTimeoutMs: 60_000,
    });
  });

  it("reads preflight from MONO_AGENT_CRON_JOBS_JSON", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([{
          id: "jobs-json",
          expression: "* * * * *",
          prompt: "run",
          preflight: ["./gate"],
        }]),
      },
    });
    expect(config.jobs[0]).toMatchObject({ preflight: ["./gate"] });
  });

  it("rejects malformed or unbounded preflight declarations as config errors", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({ cron: { enabled: true, expression: "0 * * * *", prompt: "p" } })}\n`,
      "utf8",
    );

    const cases: ReadonlyArray<{ readonly env: Record<string, string>; readonly reason: RegExp }> = [
      { env: { MONO_AGENT_CRON_PREFLIGHT_JSON: "node gate.mjs" }, reason: /single-line JSON array/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_JSON: "[]" }, reason: /non-empty array/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_JSON: '["ok",""]' }, reason: /non-empty argument strings/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_JSON: '["ok\\u0000bad"]' }, reason: /without NUL/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_JSON: '{"command":"node"}' }, reason: /non-empty array/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS: "0" }, reason: /positive integer/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS: "60001" }, reason: /no greater than 60000/u },
      { env: { MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS: "5s" }, reason: /positive integer/u },
    ];
    for (const { env, reason } of cases) {
      await expect(loadCronAdapterConfig({ env, jsonPath: path })).rejects.toThrowError(reason);
    }
  });

  it("rejects a malformed single-job JSON preflight instead of ignoring the gate", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: { enabled: true, expression: "0 * * * *", prompt: "p", preflight: "node gate.mjs" },
      })}\n`,
      "utf8",
    );
    await expect(loadCronAdapterConfig({ env: {}, jsonPath: path }))
      .rejects.toThrowError(/non-empty array of argument strings/u);
  });

  it("exposes the single-job preflight fields through the config field registry", () => {
    const preflight = CRON_CONFIG_FIELDS.find((field) => field.id === "cron.preflight");
    const timeout = CRON_CONFIG_FIELDS.find((field) => field.id === "cron.preflightTimeoutMs");
    expect(preflight?.env).toBe("MONO_AGENT_CRON_PREFLIGHT_JSON");
    expect(timeout).toMatchObject({ env: "MONO_AGENT_CRON_PREFLIGHT_TIMEOUT_MS", kind: "integer" });
    expect(preflight?.fromJson({ preflight: ["a", "b"] })).toBe('["a","b"]');
    expect(preflight?.fromJson({})).toBeUndefined();
    expect(timeout?.fromJson({ preflightTimeoutMs: 2_500 })).toBe(2_500);
  });
});
