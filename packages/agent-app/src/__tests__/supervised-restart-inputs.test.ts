import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTuiAdapter } from "@mono-agent/operator-adapter";

import { ensureStartable, prepareSupervisedRestartInputs, verifySupervisedRestartInputs } from "../cli-background-command.js";
import { captureBackgroundSnapshot, encodeBackgroundSnapshot } from "../background-snapshot.js";
import { createSupervisedRestartAuthority } from "../supervised-restart-authority.js";
import { createSupervisedRestartLatch } from "../supervised-restart-latch.js";
import { systemdUnitName } from "../systemd.js";
import { resolveApprovedBackgroundSnapshot } from "../approved-background-snapshot.js";
import { acquireFilesystemLifecycleLock } from "../launchd-lifecycle-lock.js";
import { launchdPathsFor, deriveLaunchdLabel } from "../launchd.js";
import { workerApprovalBinding } from "../cli-background-command.js";
import { materializeBackgroundRuntimeInputs } from "../background-snapshot.js";
import type { ParsedCliArgs } from "../cli-args.js";

const state = vi.hoisted(() => ({ home: "", root: "", packages: "none" }));
vi.mock("../account-home.js", () => ({ accountHomeDirectory: () => state.home }));
vi.mock("../background-runtime.js", async (original) => ({ ...await original<typeof import("../background-runtime.js")>(),
  verifyManagedRuntimeLaunch: async () => ({ installRoot: state.root, provenanceDetail: "fixture runtime", packageVersion: "0.25.1", cliSha256: "fixture" }),
}));
vi.mock("../managed-runtime-packages.js", () => ({ resolveConfiguredManagedRuntimePackages: async () => {
  if (state.packages === "missing") throw new Error("fixture package unavailable");
  if (state.packages === "outside") return [{ packageName: "@example/channel", packageSource: "/outside/package" }];
  if (state.packages === "available") return [{ packageName: "@example/channel", packageSource: `${state.root}/node_modules/@example/channel` }];
  return [];
} }));
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
  state.home = dir; state.root = join(dir, "runtime"); state.packages = "none";
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
  return { expectedBackgroundSnapshot: encodeBackgroundSnapshot(snapshot), expectedManagedRuntimeLaunch: "runtime-proof" } as ParsedCliArgs;
}
function launchctlPrint(pid: number, identity: string, args?: ParsedCliArgs): string {
  const argumentsList = ["/usr/bin/env", "-i", "MONO_AGENT_MANAGED_WORKER=1", "PATH=/usr/bin:/bin", "/node", "/cli.js", "start",
    "--foreground", "--config", identity, "--expected-background-snapshot", args?.expectedBackgroundSnapshot ?? "proof", "--expected-managed-runtime-launch", args?.expectedManagedRuntimeLaunch ?? "proof"];
  return `gui/501/com.mono-agent.demo = {\n\tpath = /tmp/demo.plist\n\tprogram = /usr/bin/env\n\targuments = {\n${argumentsList.map((arg) => `\t\t${arg}`).join("\n")}\n\t}\n\tlast exit code = (never exited)\n\n\tsemaphores = {\n\t\tsuccessful exit => 0\n\t}\n\tworking directory = ${dir}\n\tstdout path = /tmp/out.log\n\tstderr path = /tmp/err.log\n\tpid = ${pid}\n}\n`;
}

for (const file of ["mono-agent.config.json", ".env", "IDENTITY.md", "SOUL.md", ".mcp.json"]) {
  it(`approves valid ${file} edits and relaunches with unchanged cached argv`, async () => {
    const args = await approved();
    await writeFile(join(dir, file), `${await readFile(join(dir, file), "utf8")}\n`);
    let releaseLock: (() => Promise<void>) | undefined;
    const stop = vi.fn();
    const latch = createSupervisedRestartLatch(); latch.onStop(stop);
    const authority = createSupervisedRestartAuthority({ configPath, startedAt: "boot-1", platform: "darwin", pid: 4321,
      getuid: () => 501, launchdRunner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }),
      prepareStartupInputs: (signal) => prepareSupervisedRestartInputs({ args, cwd: dir, configPath, env, signal,
        runtime: { installRoot: state.root, provenanceDetail: "fixture", packageVersion: "0.25.1", cliSha256: "fixture" },
        runner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }),
        pid: 4321, uid: 501, retainLifecycle: (release) => { releaseLock = release; },
      }),
    }, latch);
    const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    try {
      const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(202);
      expect(latch.exitCode).toBe(42);
      expect(stop).toHaveBeenCalledTimes(1);
      const effective = resolveApprovedBackgroundSnapshot(workerApprovalBinding({ args, configPath }));
      expect(encodeBackgroundSnapshot(effective)).not.toBe(args.expectedBackgroundSnapshot);
      const replacement = await materializeBackgroundRuntimeInputs({ snapshot: effective, cwd: dir, env });
      await replacement.dispose();
    } finally { await adapter.stop(); await releaseLock?.(); }
  });
}

it("accepts unchanged launchd inputs and commits a supervised restart", async () => {
  const args = await approved();
  let releaseLock: (() => Promise<void>) | undefined;
  const stop = vi.fn(); const latch = createSupervisedRestartLatch(); latch.onStop(stop);
  const authority = createSupervisedRestartAuthority({ configPath, startedAt: "boot-1", platform: "darwin", pid: 4321,
    getuid: () => 501, launchdRunner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }),
    prepareStartupInputs: (signal) => prepareSupervisedRestartInputs({ args, cwd: dir, configPath, env, signal,
      runtime: { installRoot: state.root, provenanceDetail: "fixture", packageVersion: "0.25.1", cliSha256: "fixture" },
      runner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }),
      pid: 4321, uid: 501, retainLifecycle: (release) => { releaseLock = release; },
    }),
  }, latch);
  const adapter = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
  try {
    const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(202);
    expect(latch.exitCode).toBe(42);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally { await adapter.stop(); await releaseLock?.(); }
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

async function preparedRequest(edit: () => Promise<void>, afterPrepare?: () => Promise<void>) {
  const args = await approved();
  await edit();
  let cleanup: Promise<void> | undefined;
  let releaseLock: (() => Promise<void>) | undefined;
  const stop = vi.fn(); const latch = createSupervisedRestartLatch(); latch.onStop(stop);
  const authority = createSupervisedRestartAuthority({ configPath, startedAt: "fixture-boot", platform: "darwin", pid: 4321,
    getuid: () => 501, launchdRunner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }),
    prepareStartupInputs: async (signal) => {
      const prepared = await prepareSupervisedRestartInputs({ args, cwd: dir, configPath, env, signal,
      runtime: { installRoot: state.root, provenanceDetail: "fixture", packageVersion: "0.25.1", cliSha256: "fixture" },
      runner: async () => ({ code: 0, stdout: launchctlPrint(4321, configPath, args), stderr: "" }), pid: 4321, uid: 501,
      retainLifecycle: (release) => { releaseLock = release; },
      });
      if (prepared.supported) await afterPrepare?.();
      return { ...prepared, dispose: () => cleanup ??= prepared.dispose() };
    },
  }, latch);
  const adapter = await startTuiAdapter({ apiKey: "fictional-owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
  try {
    const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer fictional-owner" }, body: "{}" });
    const body = await response.json() as { error: { message: string } };
    const snapshot = resolveApprovedBackgroundSnapshot(workerApprovalBinding({ args, configPath }));
    return { status: response.status, body, stop, exitCode: latch.exitCode, snapshot, original: args.expectedBackgroundSnapshot };
  } finally { await adapter.stop(); await cleanup; await releaseLock?.(); }
}

it.each([
  ["config", async () => writeFile(configPath, "{malformed")],
  [".env", async () => { await rm(join(dir, ".env")); await symlink(configPath, join(dir, ".env")); }],
  ["IDENTITY", async () => rm(join(dir, "IDENTITY.md"))],
  ["SOUL", async () => rm(join(dir, "SOUL.md"))],
  ["MCP", async () => writeFile(join(dir, ".mcp.json"), "{malformed")],
] as const)("refuses invalid %s with its cause and no approval or stop", async (cause, edit) => {
  const result = await preparedRequest(edit);
  expect(result.status).toBe(409); expect(result.exitCode).toBe(0); expect(result.stop).not.toHaveBeenCalled();
  expect(result.body.error.message).toMatch(new RegExp(cause, "i"));
  expect(encodeBackgroundSnapshot(result.snapshot)).toBe(result.original);
});

it.each(["missing", "outside"])("refuses %s config-selected package in the fixed runtime closure", async (packages) => {
  const result = await preparedRequest(async () => { state.packages = packages; await writeFile(configPath, `${config()}\n`); });
  expect(result.status).toBe(409); expect(result.body.error.message).toContain("pinned runtime");
  expect(result.body.error.message).toContain("terminal"); expect(result.exitCode).toBe(0); expect(result.stop).not.toHaveBeenCalled();
  expect(encodeBackgroundSnapshot(result.snapshot)).toBe(result.original);
});

it("accepts a config-selected package already available in the verified closure", async () => {
  const result = await preparedRequest(async () => { state.packages = "available"; await writeFile(configPath, `${config()}\n`); });
  expect(result.status).toBe(202); expect(result.exitCode).toBe(42); expect(result.stop).toHaveBeenCalledTimes(1);
});

it("reconstructs changed and deleted dotenv values instead of approving stale worker env", async () => {
  const result = await preparedRequest(async () => { await writeFile(join(dir, ".env"), "NEW_VALUE=fictional-new-value\n"); });
  expect(result.status).toBe(202);
  const replacement = await materializeBackgroundRuntimeInputs({ snapshot: result.snapshot, cwd: dir, env: { PATH: env.PATH, NEW_VALUE: "fictional-new-value" } });
  try { expect(replacement.environment.MODEL_API_KEY).toBeUndefined(); expect(replacement.environment.NEW_VALUE).toBe("fictional-new-value"); }
  finally { await replacement.dispose(); }
});

it("refuses lifecycle contention without publication", async () => {
  let unlock: (() => Promise<void>) | undefined;
  const result = await preparedRequest(async () => {
    const label = deriveLaunchdLabel(configPath);
    unlock = await acquireFilesystemLifecycleLock({ label, paths: launchdPathsFor(label) });
  });
  try {
    expect(result.status).toBe(409); expect(result.body.error.message).toContain("lifecycle command");
    expect(result.exitCode).toBe(0); expect(result.stop).not.toHaveBeenCalled();
    expect(encodeBackgroundSnapshot(result.snapshot)).toBe(result.original);
  } finally { await unlock?.(); }
});

it.each(["mono-agent.config.json", ".env", "IDENTITY.md", "SOUL.md", ".mcp.json"])("refuses %s edited after final preparation and before synchronous acceptance", async (file) => {
  const result = await preparedRequest(async () => undefined, async () => {
    await writeFile(join(dir, file), `${await readFile(join(dir, file), "utf8")}\n`);
  });
  expect(result.status).toBe(409);
  expect(result.body.error.message).toContain("inputs changed while preparing the restart");
  expect(result.exitCode).toBe(0); expect(result.stop).not.toHaveBeenCalled();
  expect(encodeBackgroundSnapshot(result.snapshot)).toBe(result.original);
});
