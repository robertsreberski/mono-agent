import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessJobProcessHandle, ProcessJobStartRequest } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

// Package-private integration seam: this verifies the exact Pi runner used by
// Exec/Bash without making that runner a new public @mono-agent export.
// @ts-expect-error The JavaScript runtime source intentionally has no public package subpath.
import { startPreparedProcess } from "../../../agent-runtime/src/agent/tools/shared/process-runner.js";
import { PROCESS_JOBS_DEFAULTS, type ProcessJobsSettings } from "../process-jobs-config.js";
import { openProcessJobsService, type ProcessJobsServiceHandle } from "../process-jobs-service.js";
import type { ProcessJobOriginRecord } from "../process-jobs-store.js";
import type { ProcessIncarnation } from "../process-incarnation.js";

const INCARNATION: ProcessIncarnation = {
  schema: "mono-agent.process-incarnation.v1",
  bootSessionId: "live-test-boot",
  processStartId: "live-test-process",
};
const ORIGIN: ProcessJobOriginRecord = {
  conversationId: "web:live-tail-thread",
  baseConversationId: "web:live-tail-thread",
  bucket: null,
  replyToConversationId: "web:live-tail-thread",
  normalizedReplyTarget: "web:live-tail-thread",
  runId: "live-tail-run",
  historyBoundary: "live-tail-run",
  channel: "web",
};

const services: ProcessJobsServiceHandle[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(async (service) => await service.stop()));
  await Promise.allSettled(directories.splice(0).map(async (directory) => await rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe.skipIf(process.platform === "win32")("process job live output with the Pi runner", () => {
  it("exposes changing redacted running projections and preserves the final tail", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mono-process-job-live-tail-"));
    directories.push(cwd);
    const settings: ProcessJobsSettings = {
      configured: true,
      ...PROCESS_JOBS_DEFAULTS,
      enabled: true,
      stateDir: join(cwd, ".mono-agent", "process-jobs"),
      maxRuntimeMs: 10_000,
      previewChars: 2_000,
      retention: { ...PROCESS_JOBS_DEFAULTS.retention },
    };
    const service = await openProcessJobsService({
      cwd,
      workspace: cwd,
      settings,
      registration: {} as never,
      attestRegistration: async () => ({} as never),
      wake: async () => ({ delivered: true as const }),
      currentIncarnation: async () => INCARNATION,
      readIncarnation: async () => INCARNATION,
      acquireLock: async () => ({
        path: join(settings.stateDir, ".lock"),
        ownerPid: process.pid,
        release: async () => undefined,
      }),
    });
    services.push(service);

    const secret = "live-tail-secret-value";
    const script = [
      "process.stdout.write('phase-one\\n')",
      "setTimeout(() => process.stderr.write(`token=${process.env.LIVE_TAIL_SECRET}\\n`), 450)",
      "setTimeout(() => process.stdout.write('phase-three\\n'), 900)",
      "setTimeout(() => {}, 1_300)",
    ].join(";");
    const request: ProcessJobStartRequest = {
      tool: "Exec",
      summary: "node command (content redacted)",
      prepared: {
        command: process.execPath,
        args: ["--eval", script],
        cwd,
        env: { LIVE_TAIL_SECRET: secret },
        sandboxed: true,
        cleanup: async () => undefined,
      },
      launch(options) {
        return startPreparedProcess({
          command: process.execPath,
          args: ["--eval", script],
          cwd,
          env: { LIVE_TAIL_SECRET: secret },
        }, {
          ...options,
          waitForProcessGroup: true,
        }) as ProcessJobProcessHandle;
      },
    };

    const started = await service.controller(ORIGIN, 0).start(request);
    const first = await waitForProjection(service, started.jobId, (job) =>
      job.state === "running" && job.output.preview.includes("phase-one"));
    expect(first.output.preview).not.toContain(secret);

    const second = await waitForProjection(service, started.jobId, (job) =>
      job.state === "running" && job.output.preview.includes("[REDACTED]"));
    expect(second.output.preview).toContain("STDOUT:\nphase-one\nSTDERR:\ntoken=[REDACTED]");
    expect(second.output.preview).not.toContain(secret);
    expect(second.output.stderrBytes).toBeGreaterThan(0);

    const terminal = await waitForProjection(service, started.jobId, (job) => job.state === "succeeded");
    expect(terminal.output.preview).toContain("phase-one");
    expect(terminal.output.preview).toContain("phase-three");
    expect(terminal.output.preview).toContain("[REDACTED]");
    expect(terminal.output.preview).not.toContain(secret);
  }, 15_000);
});

async function waitForProjection(
  service: ProcessJobsServiceHandle,
  jobId: string,
  predicate: (job: NonNullable<Awaited<ReturnType<ProcessJobsServiceHandle["get"]>>>) => boolean,
): Promise<NonNullable<Awaited<ReturnType<ProcessJobsServiceHandle["get"]>>>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await service.get(jobId);
    if (job !== undefined && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process job ${jobId} did not reach the expected projection.`);
}
