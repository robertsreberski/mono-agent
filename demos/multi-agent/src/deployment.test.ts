import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildMultiAgentDeploymentConfigs,
  writeMultiAgentDeploymentFiles,
} from "./deployment.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-agent-multi-deploy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("multi-agent deployment files", () => {
  it("generates three role configs under ignored local state with explicit tool policies", async () => {
    const dir = await tempDir();
    const files = await writeMultiAgentDeploymentFiles({
      cwd: dir,
      researcherA2APort: 5119,
      workerA2APort: 5120,
    });

    expect(files.configDir).toBe(resolve(dir, ".mono-agent", "multi-agent"));
    expect(files.traceRegistryDir).toBe(resolve(dir, ".mono-agent", "multi-agent", "trace-sources"));
    expect(files.roles.orchestrator.configPath).toContain(".mono-agent/multi-agent/config/orchestrator.config.json");
    expect(files.roles.researcher.configPath).toContain(".mono-agent/multi-agent/config/researcher.config.json");
    expect(files.roles.worker.configPath).toContain(".mono-agent/multi-agent/config/worker.config.json");

    for (const role of ["orchestrator", "researcher", "worker"] as const) {
      await expect(stat(files.roles[role].workspaceDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(stat(files.roles[role].artifactDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });
      await expect(stat(files.roles[role].memoryPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    }

    const researcher = JSON.parse(await readFile(files.roles.researcher.configPath, "utf8")) as {
      tools: { allowedTools: string[]; disallowedTools: string[] };
      a2a: { provider: { port: number } };
      telegram?: unknown;
    };
    const worker = JSON.parse(await readFile(files.roles.worker.configPath, "utf8")) as {
      tools: { allowedTools: string[]; disallowedTools: string[] };
      a2a: { provider: { port: number } };
      telegram?: unknown;
    };
    const orchestratorRaw = await readFile(files.roles.orchestrator.configPath, "utf8");

    expect(researcher.tools.allowedTools).toEqual(["WebSearch", "WebFetch"]);
    expect(researcher.tools.disallowedTools).toContain("Bash");
    expect(researcher.a2a.provider.port).toBe(5119);
    expect(worker.tools.allowedTools).toEqual(["Read", "Grep", "Bash"]);
    expect(worker.tools.disallowedTools).toEqual(["Write", "Edit"]);
    expect(worker.a2a.provider.port).toBe(5120);
    expect(researcher.telegram).toBeUndefined();
    expect(worker.telegram).toBeUndefined();
    expect(orchestratorRaw).not.toContain("botToken");
    expect(orchestratorRaw).not.toContain("secret");
  });

  it("builds role-specific model overrides", () => {
    const configs = buildMultiAgentDeploymentConfigs({
      cwd: "/repo",
      model: "gemma4:31b",
      researcherModel: "qwen3:8b",
      workerModel: "llama3.2:latest",
    });

    expect(configs.orchestrator.runtime?.model).toBe("pi:ollama:gemma4:31b");
    expect(configs.researcher.runtime?.model).toBe("pi:ollama:qwen3:8b");
    expect(configs.worker.runtime?.model).toBe("pi:ollama:llama3.2:latest");
  });
});
