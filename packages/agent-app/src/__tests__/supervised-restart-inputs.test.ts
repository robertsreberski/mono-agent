import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { ensureStartable, verifySupervisedRestartInputs } from "../cli-background-command.js";
import { captureBackgroundSnapshot, encodeBackgroundSnapshot } from "../background-snapshot.js";
import { createSupervisedRestartAuthority } from "../supervised-restart-authority.js";
import { createSupervisedRestartLatch } from "../supervised-restart-latch.js";
import { systemdUnitName } from "../systemd.js";
import type { ParsedCliArgs } from "../cli-args.js";

let dir: string;
let configPath: string;
const config = () => JSON.stringify({
  runtime: { model: "openai-codex:gpt-5.5", workspace: "." },
  context: { identityPath: "IDENTITY.md", soulPath: "SOUL.md", selectedSkills: [] },
  tools: { allowedTools: [], disallowedTools: [], mcpConfigPath: ".mcp.json" },
});
const env = { PATH: "/usr/bin:/bin", MODEL_API_KEY: "fictional-key" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "restart-inputs-"));
  configPath = join(dir, "mono-agent.config.json");
  await writeFile(configPath, config());
  await writeFile(join(dir, ".env"), "MODEL_API_KEY=fictional-key\n");
  await writeFile(join(dir, "IDENTITY.md"), "# Identity\n\n## Role\n\nBe helpful.\n");
  await writeFile(join(dir, "SOUL.md"), "# Soul\n\nBe kind.\n");
  await writeFile(join(dir, ".mcp.json"), "{\"mcpServers\":{}}\n");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function approved() {
  const snapshot = await captureBackgroundSnapshot({ cwd: dir, configPath, env });
  return { expectedBackgroundSnapshot: encodeBackgroundSnapshot(snapshot) } as ParsedCliArgs;
}
function launchctlPrint(pid: number, identity: string): string {
  const argumentsList = ["/usr/bin/env", "-i", "MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin", "/node", "/cli.js", "start",
    "--foreground", "--config", identity, "--expected-background-snapshot", "proof", "--expected-managed-runtime-launch", "proof"];
  return `gui/501/com.mono-agent.demo = {\n\tpath = /tmp/demo.plist\n\tprogram = /usr/bin/env\n\targuments = {\n${argumentsList.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n\tlast exit code = (never exited)\n\n\tsemaphores = {\n\t\tsuccessful exit => 0\n\t}\n\tworking directory = ${dir}\n\tstdout path = /tmp/out.log\n\tstderr path = /tmp/err.log\n\tpid = ${pid}\n}\n`;
}

for (const file of ["mono-agent.config.json", ".env", "IDENTITY.md", "SOUL.md", ".mcp.json"]) {
  it(`keeps launchd worker serving when ${file} changes before POST`, async () => {
    const args = await approved();
    await writeFile(join(dir, file), `${await readFile(join(dir, file), "utf8")}\n`);
    const stop = vi.fn();
    const latch = createSupervisedRestartLatch(); latch.onStop(stop);
    const authority = createSupervisedRestartAuthority({ configPath, startedAt: "boot-1", platform: "darwin", pid: 4321,
      getuid: () => 501, launchdRunner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath), stderr: "" }),
      verifyStartupInputs: () => verifySupervisedRestartInputs({ args, cwd: dir, configPath, env, platform: "darwin" }),
    }, latch);
    const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    try {
      const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("mono-agent restart") } });
      expect(latch.exitCode).toBe(0);
      expect(stop).not.toHaveBeenCalled();
    } finally { await adapter.stop(); }
  });
}

it("accepts unchanged launchd inputs and commits a supervised restart", async () => {
  const args = await approved();
  const stop = vi.fn(); const latch = createSupervisedRestartLatch(); latch.onStop(stop);
  const authority = createSupervisedRestartAuthority({ configPath, startedAt: "boot-1", platform: "darwin", pid: 4321,
    getuid: () => 501, launchdRunner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath), stderr: "" }),
    verifyStartupInputs: () => verifySupervisedRestartInputs({ args, cwd: dir, configPath, env, platform: "darwin" }),
  }, latch);
  const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
  try {
    const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(202);
    expect(latch.exitCode).toBe(42);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally { await adapter.stop(); }
});

describe("systemd structural startup rule", () => {
  async function requestAfterEdit(edit: () => Promise<void>) {
    const args = await approved();
    await edit();
    const stop = vi.fn(); const latch = createSupervisedRestartLatch(); latch.onStop(stop);
    const authority = createSupervisedRestartAuthority({ configPath, startedAt: "boot-1", platform: "linux", pid: 777,
      systemdRun: async () => ({ code: 0, stderr: "", stdout: ["LoadState=loaded", "ActiveState=active", "MainPID=777",
        `FragmentPath=/tmp/${systemdUnitName(configPath)}`,
        `ExecStart=argv[]=/node /cli start --foreground --config ${configPath} --expected-background-snapshot proof`,
        "Restart=on-failure"].join("\n") }),
      verifyStartupInputs: () => verifySupervisedRestartInputs({ args, cwd: dir, configPath, env, platform: "linux" }),
    }, latch);
    const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    try {
      const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
      return { status: response.status, exitCode: latch.exitCode, stop, body: await response.json() };
    } finally { await adapter.stop(); }
  }
  it("accepts valid edited config and commits a supervised relaunch", async () => {
    const result = await requestAfterEdit(async () => { await writeFile(configPath, `${config()}\n`); });
    const pre = await ensureStartable({ configPath }, { ...env }, { cwd: dir, configPath });
    expect(pre).toMatchObject({ ok: true });
    expect(result).toMatchObject({ status: 202 });
    expect(result.exitCode).toBe(42);
    expect(result.stop).toHaveBeenCalledTimes(1);
  });
  it("refuses invalid edited config before stop", async () => {
    const result = await requestAfterEdit(async () => { await writeFile(configPath, "{invalid-json"); });
    expect(result.status).toBe(409);
    expect(result.exitCode).toBe(0);
    expect(result.stop).not.toHaveBeenCalled();
  });
});
