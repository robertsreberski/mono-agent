import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROCESS_JOBS_CAPS,
  PROCESS_JOBS_DEFAULTS,
  loadProcessJobsSettings,
} from "../process-jobs-config.js";

describe("loadProcessJobsSettings", () => {
  async function fixture(value: unknown): Promise<{ cwd: string; configPath: string }> {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "mono-process-jobs-config-")));
    const configPath = join(cwd, "mono-agent.config.json");
    await writeFile(configPath, `${JSON.stringify(value)}\n`);
    return { cwd, configPath };
  }

  it("is dormant by default with the reviewed compiled defaults", async () => {
    const input = await fixture({});
    expect(PROCESS_JOBS_DEFAULTS).toEqual({
      enabled: false,
      stateDir: ".mono-agent/process-jobs",
      maxConcurrent: 4,
      maxActivePerConversation: 2,
      maxQueued: 8,
      maxRuntimeMs: 1_800_000,
      maxQueueAgeMs: 300_000,
      maxOutputBytes: 1_048_576,
      previewChars: 2_000,
      maxChainDepth: 4,
      retention: { maxRecords: 1_000, maxAgeMs: 604_800_000, artifactMaxBytes: 268_435_456 },
    });
    expect(PROCESS_JOBS_CAPS).toEqual({
      maxConcurrent: 32,
      maxActivePerConversation: 8,
      maxQueued: 64,
      maxRuntimeMs: 86_400_000,
      maxQueueAgeMs: 3_600_000,
      maxOutputBytes: 8_388_608,
      previewChars: 8_000,
      maxChainDepth: 8,
      retention: { maxRecords: 10_000, maxAgeMs: 2_592_000_000, artifactMaxBytes: 1_073_741_824 },
    });
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({
      configured: false,
      ...PROCESS_JOBS_DEFAULTS,
      stateDir: join(input.cwd, ".mono-agent/process-jobs"),
    });
  });

  it("accepts every bounded setting and rejects values above compiled caps", async () => {
    const input = await fixture({
      processJobs: {
        enabled: true,
        stateDir: ".state/jobs",
        maxConcurrent: 9,
        maxActivePerConversation: 3,
        maxQueued: 17,
        maxRuntimeMs: 90_000,
        maxQueueAgeMs: 30_000,
        maxOutputBytes: 99_999,
        previewChars: 777,
        maxChainDepth: 5,
        retention: { maxRecords: 222, maxAgeMs: 333_000, artifactMaxBytes: 444_000 },
      },
    });
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({
      configured: true,
      enabled: true,
      stateDir: join(input.cwd, ".state/jobs"),
      maxConcurrent: 9,
      maxActivePerConversation: 3,
      maxQueued: 17,
      maxRuntimeMs: 90_000,
      maxQueueAgeMs: 30_000,
      maxOutputBytes: 99_999,
      previewChars: 777,
      maxChainDepth: 5,
      retention: { maxRecords: 222, maxAgeMs: 333_000, artifactMaxBytes: 444_000 },
    });

    await writeFile(input.configPath, JSON.stringify({
      processJobs: { maxConcurrent: PROCESS_JOBS_CAPS.maxConcurrent + 1 },
    }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/cannot exceed 32/u);
  });

  it("rejects unknown keys and state paths outside the agent root", async () => {
    const input = await fixture({ processJobs: { retry: true } });
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/unknown key/u);

    await writeFile(input.configPath, JSON.stringify({ processJobs: { retention: { bytes: 1 } } }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/unknown key/u);

    await writeFile(input.configPath, JSON.stringify({ processJobs: { stateDir: "../elsewhere" } }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/inside the agent root/u);

    await mkdir(join(input.cwd, "nested"));
    await writeFile(input.configPath, JSON.stringify({ processJobs: { stateDir: "nested/jobs" } }));
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({ stateDir: join(input.cwd, "nested/jobs") });
  });
});
