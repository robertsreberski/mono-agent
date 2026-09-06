import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "../cli-args.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(), read: vi.fn(), start: vi.fn(), stop: vi.fn(), traces: vi.fn(), preflight: vi.fn(), health: vi.fn(),
  durable: vi.fn(), target: vi.fn(), lock: vi.fn(),
}));
vi.mock("../systemd.js", () => ({
  SYSTEMD_WEB_IDENTITY: "web", systemdUnitName: (id: string) => `${id}.service`,
  isSystemdUserManagerUnavailable: () => false,
  inspectSystemd: mocks.inspect, readSystemdDefinition: mocks.read, startSystemd: mocks.start,
  stopSystemd: mocks.stop, systemdLogs: vi.fn(async () => 0), withSystemdLock: mocks.lock,
}));
vi.mock("../background.js", () => ({ canonicalBackgroundConfigPath: async (_cwd: string, path: string) => path,
  resolveInstanceTarget: mocks.target }));
vi.mock("../background-snapshot.js", () => ({ loadDurableBackgroundEnvironment: mocks.durable }));
vi.mock("../cli-background-command.js", () => ({ ensureStartable: mocks.preflight }));
vi.mock("../web-command.js", () => ({ webHealthcheck: mocks.health }));
vi.mock("@mono-agent/observability", () => ({ listTraceSources: mocks.traces }));

import { runSystemdAgentCommand, runSystemdWebCommand } from "../systemd-command.js";

const service = { loadState: "loaded", activeState: "active", subState: "running", pid: 42, startedAt: "today", enabled: true };
const args = (action: string) => parseCliArgs([action, "--config", "/agent/config.json"]);
const output = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(service);
  mocks.read.mockResolvedValue(undefined);
  mocks.preflight.mockResolvedValue({ ok: true });
  mocks.target.mockResolvedValue({ registryDir: "/traces", staleAfterMs: 60_000 });
  mocks.durable.mockResolvedValue({});
  mocks.traces.mockResolvedValue({ sources: [] });
  mocks.lock.mockImplementation(async (_id, _deps, callback) => await callback());
  mocks.start.mockImplementation(async (_definition, _restart, ready) => {
    if (!await ready(service)) throw new Error("not ready");
  });
});

describe("Linux agent command composition", () => {
  it("requires matching PID/config startup proof and never persists exported secrets", async () => {
    mocks.traces.mockResolvedValue({ sources: [{ configPath: "/agent/config.json", pid: 42, health: "running", metadata: { lifecycle: { startupCompleted: true } } }] });
    const deps = output();
    expect(await runSystemdAgentCommand(args("start"), "start", { PATH: "/bin", PROVIDER_API_KEY: "not-for-the-unit" }, deps)).toBe(0);
    const definition = mocks.start.mock.calls[0]![0];
    expect(definition.argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    expect(JSON.stringify(definition)).not.toContain("not-for-the-unit");
    expect(definition.argv).toContain("--foreground");
    expect(definition.argv[definition.argv.indexOf(process.execPath) + 1]).toBe("--");
    expect(definition.argv).toContain("--env-file");
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining("dev (unmanaged)"));
  });

  it("refuses an existing worker owned by another supervisor", async () => {
    mocks.traces.mockResolvedValue({ sources: [{ configPath: "/agent/config.json", pid: 99, health: "running" }] });
    expect(await runSystemdAgentCommand(args("start"), "start", {}, { ...output(), isAlive: () => true })).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it("ignores a stale running trace after its recorded process exits", async () => {
    mocks.traces
      .mockResolvedValueOnce({ sources: [{ configPath: "/agent/config.json", pid: 99, health: "running" }] })
      .mockResolvedValue({ sources: [{ configPath: "/agent/config.json", pid: 42, health: "running", metadata: { lifecycle: { startupCompleted: true } } }] });
    expect(await runSystemdAgentCommand(args("start"), "start", {}, { ...output(), isAlive: () => false })).toBe(0);
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("does not accept trace liveness without completed startup", async () => {
    mocks.traces.mockResolvedValue({ sources: [{ configPath: "/agent/config.json", pid: 42, health: "running" }] });
    expect(await runSystemdAgentCommand(args("start"), "start", {}, output())).toBe(1);
  });

  it("reports supervisor status even when installed config is broken", async () => {
    mocks.read.mockResolvedValue({ cwd: "/agent", argv: [] });
    mocks.durable.mockRejectedValue(new Error("broken dotenv"));
    const deps = output();
    expect(await runSystemdAgentCommand({ ...args("status"), json: true }, "status", {}, deps)).toBe(1);
    const status = JSON.parse(deps.stdout.write.mock.calls[0]![0] as string);
    expect(status).toMatchObject({
      ok: false,
      instance: { pid: 42, health: "stopped", configPath: "/agent/config.json" },
      others: [],
      backend: "systemd-user",
      pid: 42,
      activeState: "active",
      ready: false,
    });
  });

  it("allows stop without parsing a broken config or dotenv", async () => {
    mocks.durable.mockRejectedValue(new Error("broken dotenv"));
    expect(await runSystemdAgentCommand(args("stop"), "stop", {}, output())).toBe(0);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.durable).not.toHaveBeenCalled();
  });
});

describe("Linux web command composition", () => {
  it("keeps bare status read-only", async () => {
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: [], env: {} }, output())).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });

  it("preserves installed endpoint, theme, and allowed hosts on restart", async () => {
    mocks.read.mockResolvedValue({ argv: ["MONO_AGENT_WEB_ALLOWED_HOSTS=example.ts.net", "web", "run", "--host", "127.0.0.1", "--port", "6060", "--theme", "plum"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining([
      "MONO_AGENT_WEB_ALLOWED_HOSTS=example.ts.net", "127.0.0.1", "6060", "plum",
    ]));
    expect(mocks.health).toHaveBeenCalledWith("http://127.0.0.1:6060/healthz");
  });

  it("persists an operator-chosen console name into the unit argv", async () => {
    mocks.read.mockResolvedValue({ argv: ["web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand(
      { positionals: ["restart"], env: {}, name: "Flockbox" },
      output(),
    )).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--name", "Flockbox"]));
  });

  it("preserves the installed console name when restart does not override it", async () => {
    mocks.read.mockResolvedValue({ argv: ["web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum", "--name", "Flockbox"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--name", "Flockbox"]));
  });

  it("leaves the console name out of the unit argv when none was chosen", async () => {
    mocks.read.mockResolvedValue({ argv: ["web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).not.toContain("--name");
  });

  it("probes the IPv6 loopback address for a bracketed wildcard listener", async () => {
    mocks.read.mockResolvedValue({ argv: ["web", "run", "--host", "[::]", "--port", "5050", "--theme", "plum"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.health).toHaveBeenCalledWith("http://[::1]:5050/healthz");
  });

  it("refuses a new address that already serves another console", async () => {
    mocks.inspect.mockResolvedValue({ ...service, pid: 0 });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["start"], env: {}, loopback: true }, output())).toBe(1);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("allows an owned active console to restart on a new host at the same port", async () => {
    mocks.read.mockResolvedValue({ argv: ["web", "run", "--host", "0.0.0.0", "--port", "5050", "--theme", "plum"] });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {}, loopback: true }, output())).toBe(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "5050"]));
  });
});
