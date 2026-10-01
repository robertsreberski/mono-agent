import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMonoAgentConfig, type MonoAgentConfig } from "@mono-agent/config";
import { createToolPolicy } from "@mono-agent/agent-harness";
import { parseMcpServers } from "@mono-agent/runtime-adapter";
import { createConfiguredAgentHarness } from "../configured-agent.js";
import { validateMonoAgentFolder } from "../doctor.js";
import { computerUseSection, configuredToolPolicyInput, resolveCuaDriverCommand } from "../computer-use.js";

let dir: string;
let command: string;
let config: MonoAgentConfig;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "computer-use-test-"));
  command = join(dir, "cua-driver");
  await writeFile(command, `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === '--version') console.log('cua-driver 0.31.0');
else if (args === 'doctor --json') console.log(JSON.stringify({ok:true,probes:[]}));
else if (args === 'permissions status --json') console.log(JSON.stringify({accessibility:true,screen_recording:true}));
else process.exit(1);
`);
  await chmod(command, 0o755);
  const jsonPath = join(dir, "config.json");
  await writeFile(jsonPath, JSON.stringify({ runtime: { model: "openai:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { computerUse: { backend: "cua-driver", command } } }));
  config = await loadMonoAgentConfig({ cwd: dir, jsonPath });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const configWithTools = (tools: MonoAgentConfig["tools"]): MonoAgentConfig => ({ ...config, tools });

describe("computer-use MCP integration", () => {
  it("injects a resolved stdio server into the ordinary harness/runtime policy without mode env", () => {
    const warn = vi.fn();
    const policy = createToolPolicy(configuredToolPolicyInput(config, warn));
    expect(warn).not.toHaveBeenCalled();
    expect(parseMcpServers(policy.mcpServers)).toEqual([{ name: "computer-use", transport: "stdio", command, args: ["mcp"] }]);
    expect(policy.mcpServers?.["computer-use"]).toEqual({ command, args: ["mcp"] });
  });
  it("preserves declared servers and rejects a reserved-name collision", async () => {
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { other: { command: "other", args: [] } } }));
    const enabled = configWithTools({ ...config.tools, mcpConfigPath });
    expect(Object.keys(configuredToolPolicyInput(enabled).mcpServers ?? {})).toEqual(["other", "computer-use"]);
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { "computer-use": { command: "other" } } }));
    expect(() => configuredToolPolicyInput(enabled)).toThrow(/name "computer-use" is reserved/u);
    const { computerUse: _computerUse, ...disabledTools } = enabled.tools;
    expect(configuredToolPolicyInput(configWithTools(disabledTools)).mcpServers).toEqual({ "computer-use": { command: "other" } });
  });
  it("does not alter disabled policy and omits a missing driver with one startup warning", () => {
    const { computerUse: _computerUse, ...disabledTools } = config.tools;
    expect(configuredToolPolicyInput(configWithTools(disabledTools))).toEqual({ allowedTools: config.tools.allowedTools, disallowedTools: config.tools.disallowedTools });
    const unavailable = configWithTools({ ...config.tools, computerUse: { backend: "cua-driver", command: join(dir, "missing") } });
    const warn = vi.fn();
    expect(configuredToolPolicyInput(unavailable, warn).mcpServers).toBeUndefined();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("continuing without the computer-use MCP server"));
    configuredToolPolicyInput(unavailable, warn);
    configuredToolPolicyInput(unavailable);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("keeps actual harness construction available and forwards a startup warning", async () => {
    await writeFile(join(dir, "IDENTITY.md"), "A fictional local automation agent.");
    const unavailable = configWithTools({ ...config.tools, computerUse: { backend: "cua-driver", command: join(dir, "missing") } });
    const warn = vi.fn();
    const harness = await createConfiguredAgentHarness({
      config: unavailable, cwd: dir,
      runtime: { async run() { throw new Error("No provider call expected during construction"); } },
      onComputerUseWarning: warn,
    });
    try {
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("executable not found"));
      expect(configuredToolPolicyInput(unavailable).mcpServers).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { await harness.dispose?.(); }
  });
  it("preserves other MCP servers when unavailable and survives a failing warning sink", async () => {
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    const unavailable = configWithTools({ ...config.tools, mcpConfigPath, computerUse: { backend: "cua-driver", command: join(dir, "missing") } });
    expect(configuredToolPolicyInput(unavailable, () => { throw new Error("warning sink failed"); }).mcpServers).toEqual({ other: { command: "other" } });
  });
});

describe("cua-driver executable resolution", () => {
  it("resolves PATH first, then minimal-PATH Unix and macOS installations", () => {
    const executable = (path: string) => ["/bin/cua-driver", "/home/morgan/.local/bin/cua-driver", "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"].includes(path);
    expect(resolveCuaDriverCommand(undefined, { platform: "linux", env: { PATH: "/bin" }, home: "/home/morgan", executable })).toBe("/bin/cua-driver");
    expect(resolveCuaDriverCommand(undefined, { platform: "linux", env: {}, home: "/home/morgan", executable })).toBe("/home/morgan/.local/bin/cua-driver");
    expect(resolveCuaDriverCommand(undefined, { platform: "darwin", env: {}, home: "/other", executable })).toBe("/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
  });
  it("resolves Windows installer and PATH locations", () => {
    const installed = "C:\\Users\\Morgan\\AppData\\Local\\Programs\\Cua\\cua-driver\\bin\\cua-driver.exe";
    expect(resolveCuaDriverCommand(undefined, { platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\Morgan\\AppData\\Local" }, home: "C:\\Users\\Morgan", executable: (path) => path === installed })).toBe(installed);
    expect(resolveCuaDriverCommand("custom", { platform: "win32", env: { Path: "C:\\Tools" }, executable: (path) => path === "C:\\Tools\\custom.exe" })).toBe("C:\\Tools\\custom.exe");
  });
  it("honors explicit overrides without falling back and checks executable files", async () => {
    expect(resolveCuaDriverCommand(command)).toBe(command);
    expect(resolveCuaDriverCommand("./cua-driver", { cwd: dir })).toBe(command);
    expect(resolveCuaDriverCommand("missing-driver", { env: {}, home: dir })).toBeUndefined();
    expect(resolveCuaDriverCommand(dir)).toBeUndefined();
    await chmod(command, 0o644);
    if (process.platform !== "win32") expect(resolveCuaDriverCommand(command)).toBeUndefined();
  });
});

describe("computer-use doctor", () => {
  it("reports disabled, missing and ready using a real fake executable", async () => {
    expect((await computerUseSection(undefined)).status).toBe("disabled");
    expect((await computerUseSection({ backend: "cua-driver", command: join(dir, "missing") })).status).toBe("waiting");
    const ready = await computerUseSection(config.tools.computerUse, { platform: "darwin" });
    expect(ready.status).toBe("ok");
    expect(ready.details.join(" ")).toContain(command);
    expect(ready.details.join(" ")).toContain("0.31.0");
  });
  it.each([{ status: "unknown", daemon_running: true }, { status: "pending" }, { accessibility: false, screen_recording: true }, { accessibility: true, screen_recording: false }, { accessibility: true, screen_recording: true, daemon_running: false }, { accessibility: true, screen_recording: true, screen_recording_capturable: false }])("waits for unconfirmed macOS permissions %j", async (permissions) => {
    const section = await computerUseSection(config.tools.computerUse, { platform: "darwin", probe: async (_command, args) => args[0] === "--version" ? "cua-driver 0.31.0" : JSON.stringify(args[0] === "doctor" ? { ok: true } : permissions) });
    expect(section.status).toBe("waiting");
    expect(section.details.join(" ")).toContain("interactive session");
  });
  it.each(["not-json", JSON.stringify({ ok: false }), JSON.stringify([])])("handles malformed/not-ready doctor output %s", async (report) => {
    expect((await computerUseSection(config.tools.computerUse, { probe: async (_command, args) => args[0] === "--version" ? "cua-driver 0.31.0" : report })).status).toBe("waiting");
  });
  it("handles timeout/failed execution without leaking subprocess output", async () => {
    const section = await computerUseSection(config.tools.computerUse, { probe: async () => { throw new Error("private subprocess output"); } });
    expect(section.status).toBe("waiting");
    expect(section.details.join(" ")).not.toContain("private subprocess output");
  });
});

describe("computer-use doctor wiring", () => {
  it("reports enabled and disabled integration and rejects colliding configuration", async () => {
    const mcpConfigPath = join(dir, "mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { "computer-use": { command: "other" } } }));
    const jsonPath = join(dir, "doctor-config.json");
    await writeFile(join(dir, "IDENTITY.md"), "A fictional local automation agent.");
    await writeFile(jsonPath, JSON.stringify({ runtime: { model: "openai:gpt-5.5" }, context: { identityPath: "IDENTITY.md" }, tools: { computerUse: { backend: "cua-driver", command }, mcpConfigPath } }));
    const report = await validateMonoAgentFolder({ cwd: dir, configPath: jsonPath, env: {} });
    expect(report.sections.find((section) => section.id === "computer-use")).toBeDefined();
    expect(report.sections.find((section) => section.id === "tools")?.status).toBe("error");
    expect(report.sections.find((section) => section.id === "tools")?.details.join(" ")).toContain('name "computer-use" is reserved');
    await writeFile(jsonPath, JSON.stringify({ runtime: { model: "openai:gpt-5.5" }, context: { identityPath: "IDENTITY.md" } }));
    expect((await validateMonoAgentFolder({ cwd: dir, configPath: jsonPath, env: {} })).sections.find((section) => section.id === "computer-use")?.status).toBe("disabled");
  });
});
