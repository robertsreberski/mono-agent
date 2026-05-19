import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cronFieldGroup,
  loadCronAdapterConfig,
  redactCronAdapterConfig,
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

describe("cronFieldGroup", () => {
  it("declares single-job cron settings for operator surfaces", () => {
    expect(cronFieldGroup.id).toBe("cron");
    expect(cronFieldGroup.fields.find((field) => field.id === "cron.enabled")?.kind).toBe("switch");
    expect(cronFieldGroup.fields.find((field) => field.id === "cron.expression")?.kind).toBe("string");
  });
});
