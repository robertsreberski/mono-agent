import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cronFieldGroup,
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

  it("loads multiple cron jobs from the cron.jobs array in the JSON config file", async () => {
    const path = join(dir, "mono-agent.config.json");
    await writeFile(
      path,
      `${JSON.stringify({
        cron: {
          jobs: [
            { id: "daily", enabled: true, expression: "0 9 * * *", timezone: "UTC", prompt: "Morning summary." },
            { id: "weekly", enabled: false, expression: "0 9 * * 1", prompt: "Weekly recap.", conversationId: "cron-weekly" },
          ],
        },
      })}\n`,
      "utf8",
    );

    const config = await loadCronAdapterConfig({ env: {}, jsonPath: path });

    expect(config.jobs).toEqual([
      { id: "daily", enabled: true, expression: "0 9 * * *", timezone: "UTC", prompt: "Morning summary." },
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

  it("loads multiple cron jobs from JSON env", async () => {
    const config = await loadCronAdapterConfig({
      env: {
        MONO_AGENT_CRON_JOBS_JSON: JSON.stringify([
          { id: "one", enabled: true, expression: "*/5 * * * *", prompt: "one" },
          { id: "two", enabled: false, expression: "0 0 * * *", prompt: "two" },
        ]),
      },
    });

    expect(config.jobs).toEqual([
      { id: "one", enabled: true, expression: "*/5 * * * *", timezone: "UTC", prompt: "one" },
      { id: "two", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "two" },
    ]);
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
        { id: "on", enabled: true, expression: "* * * * *", timezone: "UTC", prompt: "run", conversationId: "c1" },
        { id: "off", enabled: false, expression: "0 0 * * *", timezone: "UTC", prompt: "skip" },
      ],
    });

    expect(jobs).toEqual([
      { id: "on", expression: "* * * * *", timezone: "UTC", prompt: "run", conversationId: "c1" },
    ]);
    expect(jobs.some((job) => job.id === "off")).toBe(false);
  });
});

describe("cronFieldGroup", () => {
  it("declares single-job cron settings for operator surfaces", () => {
    expect(cronFieldGroup.id).toBe("cron");
    expect(cronFieldGroup.fields.find((field) => field.id === "cron.enabled")?.kind).toBe("switch");
    expect(cronFieldGroup.fields.find((field) => field.id === "cron.expression")?.kind).toBe("string");
  });
});
