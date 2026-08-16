import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES,
  parseProcessJobProjections,
  type ProcessJobProjection,
} from "@mono-agent/agent-contracts";
import { MonoAgentConfigError } from "@mono-agent/config";
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
      unsafeAllowUnprotectedState: false,
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

  it("keeps ordinary unconfigured startup permissive when no default durable state exists", async () => {
    const input = await fixture({
      providers: { piNative: { piSessionsRoot: ".mono-agent" } },
    });
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({
      configured: false,
      enabled: false,
      stateDir: join(input.cwd, ".mono-agent/process-jobs"),
    });
  });

  it("does not recognize an environment shortcut for the JSON-only unsafe opt-in", async () => {
    const input = await fixture({ processJobs: { enabled: true } });
    await expect(loadProcessJobsSettings({
      ...input,
      env: { MONO_AGENT_PROCESS_JOBS_UNSAFE_ALLOW_UNPROTECTED_STATE: "true" },
    })).resolves.toMatchObject({
      enabled: true,
      unsafeAllowUnprotectedState: false,
    });
  });

  it("accepts every bounded setting and rejects values above compiled caps", async () => {
    const input = await fixture({
      processJobs: {
        enabled: true,
        unsafeAllowUnprotectedState: true,
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
      unsafeAllowUnprotectedState: true,
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

  it("keeps the shared lifecycle and operator parser ceilings aligned with the host", () => {
    const hostRecordCeiling = PROCESS_JOBS_CAPS.retention.maxRecords
      + PROCESS_JOBS_CAPS.maxQueued
      + PROCESS_JOBS_CAPS.maxConcurrent;
    expect(hostRecordCeiling).toBe(MAX_PROCESS_JOB_OUTSTANDING_LIFECYCLES);
    const projection: ProcessJobProjection = {
      schema: "mono-agent.process-job-projection.v1",
      jobId: "pj_capacity_0",
      tool: "Exec",
      state: "queued",
      summary: "exec (values redacted)",
      origin: {
        conversationId: "web:capacity",
        channel: "web",
        runId: "run-capacity",
        historyBoundary: "run-capacity",
        bucket: null,
      },
      timestamps: {
        admittedAt: "2026-08-14T10:00:00.000Z",
        queueDeadlineAt: "2026-08-14T10:05:00.000Z",
        startedAt: null,
        runtimeDeadlineAt: null,
        completedAt: null,
      },
      limits: {
        maxRuntimeMs: PROCESS_JOBS_CAPS.maxRuntimeMs,
        maxOutputBytes: PROCESS_JOBS_CAPS.maxOutputBytes,
        previewChars: PROCESS_JOBS_CAPS.previewChars,
        chainDepth: 0,
      },
      output: {
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        preview: "",
        stdoutRef: null,
        stderrRef: null,
      },
      wake: {
        state: "pending",
        attempts: 0,
        deliveryKey: "process-job:pj_capacity_0",
        lastAttemptAt: null,
      },
      exitCode: null,
      signal: null,
      durationMs: null,
      cancelRequested: false,
      lastError: null,
    };
    const atHostCeiling = Array.from({ length: hostRecordCeiling }, (_, index) => ({
      ...projection,
      jobId: `pj_capacity_${String(index)}`,
      wake: { ...projection.wake, deliveryKey: `process-job:pj_capacity_${String(index)}` },
    }));

    expect(parseProcessJobProjections(atHostCeiling)).toHaveLength(hostRecordCeiling);
  });

  it("rejects unknown keys and state paths outside the agent root", async () => {
    const input = await fixture({ processJobs: { retry: true } });
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/unknown key/u);

    await writeFile(input.configPath, JSON.stringify({ processJobs: { retention: { bytes: 1 } } }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/unknown key/u);

    await writeFile(input.configPath, JSON.stringify({ processJobs: { unsafeAllowUnprotectedState: "yes" } }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/processJobs\.unsafeAllowUnprotectedState must be a boolean/u);

    await writeFile(input.configPath, JSON.stringify({ processJobs: { stateDir: "../elsewhere" } }));
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/inside the agent root/u);

    await mkdir(join(input.cwd, "nested"));
    await writeFile(input.configPath, JSON.stringify({ processJobs: { stateDir: "nested/jobs" } }));
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({ stateDir: join(input.cwd, "nested/jobs") });
  });

  it.each([
    {
      name: "equal to durable history",
      value: {
        artifacts: { dir: ".state/artifacts" },
        processJobs: { stateDir: ".state/history" },
      },
      kind: "durable session/tool history",
    },
    {
      name: "inside durable history",
      value: {
        artifacts: { dir: ".state/artifacts" },
        processJobs: { stateDir: ".state/history/jobs" },
      },
      kind: "durable session/tool history",
    },
    {
      name: "containing durable history",
      value: {
        artifacts: { dir: ".state/artifacts" },
        processJobs: { stateDir: ".state" },
      },
      kind: "durable session/tool history",
    },
    {
      name: "inside ACP sessions",
      value: {
        artifacts: { dir: ".state/artifacts" },
        processJobs: { stateDir: ".state/acp-sessions/jobs" },
      },
      kind: "ACP sessions",
    },
    {
      name: "inside Pi provider sessions",
      value: {
        artifacts: { dir: ".other/artifacts" },
        providers: { piNative: { piSessionsRoot: ".state/sessions" } },
        processJobs: { stateDir: ".state/sessions/jobs" },
      },
      kind: "Pi provider sessions",
    },
    {
      name: "containing Pi provider sessions",
      value: {
        artifacts: { dir: ".other/artifacts" },
        providers: { piNative: { piSessionsRoot: ".state/sessions" } },
        processJobs: { stateDir: ".state" },
      },
      kind: "Pi provider sessions",
    },
  ])("rejects a process-job state directory $name the clear-sessions root", async ({ value, kind }) => {
    const input = await fixture(value);
    let failure: unknown;
    try {
      await loadProcessJobsSettings(input);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(MonoAgentConfigError);
    expect(failure).toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir", purgeRootKind: kind },
    });
    expect((failure as Error).message).toMatch(/restart --clear-sessions/u);
  });

  it("accepts custom state and reset roots that are safe siblings", async () => {
    const input = await fixture({
      artifacts: { dir: ".state/artifacts" },
      providers: { piNative: { piSessionsRoot: ".state/sessions" } },
      processJobs: { enabled: true, stateDir: ".state/jobs" },
    });
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({
      enabled: true,
      stateDir: join(input.cwd, ".state/jobs"),
    });
  });

  it("accepts the normal default state directory beside the default purge roots", async () => {
    const input = await fixture({ processJobs: { enabled: true } });
    await expect(loadProcessJobsSettings(input)).resolves.toMatchObject({
      enabled: true,
      stateDir: join(input.cwd, ".mono-agent/process-jobs"),
    });
  });

  it.skipIf(process.platform === "win32")("rejects a canonical symlink alias of a reset root", async () => {
    const input = await fixture({
      artifacts: { dir: ".other/artifacts" },
      providers: { piNative: { piSessionsRoot: ".reset/sessions" } },
      processJobs: { stateDir: ".state/jobs" },
    });
    await mkdir(join(input.cwd, ".reset/sessions"), { recursive: true });
    await mkdir(join(input.cwd, ".state"), { recursive: true });
    await symlink(join(input.cwd, ".reset/sessions"), join(input.cwd, ".state/jobs"), "dir");

    await expect(loadProcessJobsSettings(input)).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir", purgeRootKind: "Pi provider sessions" },
    });
  });

  it("fails closed with a typed config error when state cannot be canonicalized", async () => {
    const input = await fixture({ processJobs: { stateDir: "blocked/jobs" } });
    await writeFile(join(input.cwd, "blocked"), "not a directory");
    await expect(loadProcessJobsSettings(input)).rejects.toMatchObject({
      code: "invalid_json",
      details: { path: "processJobs.stateDir" },
    });
    await expect(loadProcessJobsSettings(input)).rejects.toThrow(/could not be canonicalized/u);
  });
});
