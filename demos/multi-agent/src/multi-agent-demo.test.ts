import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sendA2AMessage } from "@worklab-ai/a2a-adapter";
import type { RuntimeRunOptions, RuntimeResult } from "@worklab-ai/runtime-adapter";

import { writeMultiAgentDeploymentFiles } from "./deployment.js";
import { startMultiAgentDemo } from "./multi-agent-demo.js";
import type { MultiAgentRole } from "./orchestrator-responder.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-multi-demo-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("multi-agent demo", () => {
  it("routes an orchestrator A2A request through researcher and worker and records distinct traces", async () => {
    const dir = await tempDir();
    const files = await writeMultiAgentDeploymentFiles({ cwd: process.cwd(), configDir: dir });
    const fakeRuntime = createFakeRuntime();
    const demo = await startMultiAgentDemo({
      cwd: process.cwd(),
      configDir: files.configDir,
      env: {},
      startTelegram: false,
      runtimeFactory: (role) => fakeRuntime.runtimeFor(role),
    });

    try {
      expect(demo.telegramStatus).toMatchObject({ kind: "disabled" });
      expect(demo.orchestratorStatus.kind).toBe("running");
      expect(demo.researcherStatus.kind).toBe("running");
      expect(demo.workerStatus.kind).toBe("running");
      if (demo.orchestratorStatus.kind !== "running") {
        throw new Error("orchestrator not running");
      }

      const response = await sendA2AMessage({
        agentUrl: demo.orchestratorStatus.agentCardUrl,
        text: "Research current context and inspect the workspace.",
      });
      expect(response.text).toBe("Final synthesis used collaborator reports.");
      expect(fakeRuntime.calls.map((call) => call.role)).toEqual(["researcher", "worker", "orchestrator"]);
      expect(String(fakeRuntime.calls[2]?.options.messages[0]?.content)).toContain("Research report with source https://example.com.");
      expect(String(fakeRuntime.calls[2]?.options.messages[0]?.content)).toContain("Worker read the dedicated workspace.");
      expect(fakeRuntime.calls.find((call) => call.role === "researcher")?.options.allowedTools).toEqual(["WebSearch", "WebFetch"]);
      expect(fakeRuntime.calls.find((call) => call.role === "worker")?.options.allowedTools).toEqual(["Read", "Grep", "Bash"]);

      const traceability = await getTraceabilityRuns(demo.operatorConsole.url, demo.operatorConsole.token);
      expect(traceability.sources.map((source) => source.sourceId).sort()).toEqual([
        "multi-agent-orchestrator",
        "multi-agent-researcher",
        "multi-agent-worker",
      ]);
      expect(traceability.runs.map((run) => run.source.sourceId).sort()).toEqual([
        "multi-agent-orchestrator",
        "multi-agent-researcher",
        "multi-agent-worker",
      ]);

      for (const role of ["orchestrator", "researcher", "worker"] as const) {
        const artifactFiles = await readdir(files.roles[role].artifactDir);
        expect(artifactFiles.some((file) => file.endsWith(".summary.json"))).toBe(true);
        const summaryFile = artifactFiles.find((file) => file.endsWith(".summary.json"));
        expect(await readFile(join(files.roles[role].artifactDir, summaryFile as string), "utf8")).toContain(role);
      }
    } finally {
      await demo.stop();
    }
  });
});

function createFakeRuntime(): {
  readonly calls: Array<{ role: MultiAgentRole; prompt: string; options: RuntimeRunOptions }>;
  runtimeFor(role: MultiAgentRole): { run(prompt: string, options: RuntimeRunOptions): Promise<RuntimeResult> };
} {
  const calls: Array<{ role: MultiAgentRole; prompt: string; options: RuntimeRunOptions }> = [];
  return {
    calls,
    runtimeFor(role) {
      return {
        async run(prompt, options) {
          calls.push({ role, prompt, options });
          options.onEvent?.({ type: "fake-event", role });
          return {
            text: textForRole(role),
            model: options.model.model,
            sdk: options.model.sdk,
            capabilitiesUsed: [role],
            cost: { totalUsd: 0 },
          };
        },
      };
    },
  };
}

function textForRole(role: MultiAgentRole): string {
  if (role === "researcher") {
    return "Research report with source https://example.com.";
  }
  if (role === "worker") {
    return "Worker read the dedicated workspace.";
  }
  return "Final synthesis used collaborator reports.";
}

async function getTraceabilityRuns(
  url: string,
  token: string,
): Promise<{
  sources: Array<{ sourceId: string; label: string; health: string }>;
  runs: Array<{ runId: string; source: { sourceId: string } }>;
}> {
  const response = await fetch(`${url}/api/traceability/runs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    sources: Array<{ sourceId: string; label: string; health: string }>;
    runs: Array<{ runId: string; source: { sourceId: string } }>;
  };
}
