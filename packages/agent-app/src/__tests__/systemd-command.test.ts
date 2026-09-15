import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEMD_BACKGROUND_WORKER_ENV } from "../background-environment.js";
import { decodeBackgroundSnapshot } from "../background-snapshot.js";
import { parseCliArgs } from "../cli-args.js";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(), read: vi.fn(), start: vi.fn(), stop: vi.fn(), traces: vi.fn(), preflight: vi.fn(), health: vi.fn(),
  durable: vi.fn(), snapshot: vi.fn(), target: vi.fn(), lock: vi.fn(),
}));
vi.mock("../systemd.js", () => ({
  SYSTEMD_WEB_IDENTITY: "web", systemdUnitName: (id: string) => `${id}.service`,
  isSystemdUserManagerUnavailable: () => false,
  inspectSystemd: mocks.inspect, readSystemdDefinition: mocks.read, startSystemd: mocks.start,
  stopSystemd: mocks.stop, systemdLogs: vi.fn(async () => 0), withSystemdLock: mocks.lock,
}));
vi.mock("../background.js", () => ({ canonicalBackgroundConfigPath: async (_cwd: string, path: string) => path,
  resolveInstanceTarget: mocks.target }));
vi.mock("../background-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../background-snapshot.js")>();
  return {
    ...actual,
    captureBackgroundSnapshot: mocks.snapshot,
    loadDurableBackgroundEnvironment: mocks.durable,
  };
});
vi.mock("../cli-background-command.js", () => ({ ensureStartable: mocks.preflight }));
vi.mock("../web-command.js", () => ({ webHealthcheck: mocks.health }));
vi.mock("@mono-agent/observability", () => ({ listTraceSources: mocks.traces }));

import { runSystemdAgentCommand, runSystemdWebCommand } from "../systemd-command.js";

const service = { loadState: "loaded", activeState: "active", subState: "running", pid: 42, startedAt: "today", enabled: true };
const args = (action: string) => parseCliArgs([action, "--config", "/agent/config.json"]);
const output = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

/**
 * The exact managed worker invocation `workerArgv` writes: `env -i`, then the
 * selected environment assignments, then node, the `--` separator and the CLI
 * entrypoint, then the command.
 */
const managedWebArgv = (...args: readonly string[]): string[] =>
  ["/usr/bin/env", "-i", "PATH=/usr/bin", "/usr/bin/node", "--", "/managed/dist/cli.js", ...args];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue(service);
  mocks.read.mockResolvedValue(undefined);
  mocks.preflight.mockResolvedValue({ ok: true });
  mocks.target.mockResolvedValue({ registryDir: "/traces", staleAfterMs: 60_000 });
  mocks.durable.mockResolvedValue({});
  mocks.snapshot.mockImplementation(async (input: { readonly cwd: string; readonly configPath: string; readonly envFile?: string }) => ({
    schema: "mono-agent.background-snapshot.v1",
    configPath: resolve(input.cwd, input.configPath),
    configFingerprint: "config-fingerprint",
    dotenvPath: resolve(input.cwd, input.envFile ?? ".env"),
    dotenvFingerprint: "dotenv-fingerprint",
    identityPath: resolve(input.cwd, "IDENTITY.md"),
    identityFingerprint: "identity-fingerprint",
    operationalEnvironmentFingerprint: "environment-fingerprint",
  }));
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
    const linuxEnvironment = {
      PATH: "/bin",
      XDG_CONFIG_HOME: "/home/user/.config",
      XDG_DATA_HOME: "/home/user/.local/share",
      XDG_CACHE_HOME: "/home/user/.cache",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      PROVIDER_API_KEY: "not-for-the-unit",
    };
    expect(await runSystemdAgentCommand(args("start"), "start", linuxEnvironment, deps)).toBe(0);
    const definition = mocks.start.mock.calls[0]![0];
    expect(definition.argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    expect(JSON.stringify(definition)).not.toContain("not-for-the-unit");
    expect(definition.argv).toContain("--foreground");
    expect(definition.argv[definition.argv.indexOf(process.execPath) + 1]).toBe("--");
    expect(definition.argv).toContain("--env-file");
    expect(definition.argv).toContain(`${SYSTEMD_BACKGROUND_WORKER_ENV}=1`);
    const encoded = definition.argv[definition.argv.indexOf("--expected-background-snapshot") + 1];
    expect(decodeBackgroundSnapshot(encoded)).toMatchObject({
      configPath: "/agent/config.json",
      dotenvPath: resolve(process.cwd(), ".env"),
    });
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      configPath: "/agent/config.json",
      envFile: resolve(process.cwd(), ".env"),
      env: expect.objectContaining({
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      }),
      operationalEnvironmentPolicy: "systemd",
    }));
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining("dev (unmanaged)"));
  });

  it("pins a custom env file into the systemd snapshot transport", async () => {
    mocks.traces.mockResolvedValue({ sources: [{ configPath: "/agent/config.json", pid: 42, health: "running", metadata: { lifecycle: { startupCompleted: true } } }] });
    const customEnv = "/agent/production.env";
    const customArgs = parseCliArgs(["start", "--config", "/agent/config.json", "--env-file", customEnv]);

    expect(await runSystemdAgentCommand(customArgs, "start", { PATH: "/bin" }, output())).toBe(0);

    const definition = mocks.start.mock.calls[0]![0];
    const encoded = definition.argv[definition.argv.indexOf("--expected-background-snapshot") + 1];
    expect(decodeBackgroundSnapshot(encoded)).toMatchObject({
      configPath: "/agent/config.json",
      dotenvPath: customEnv,
    });
    expect(definition.argv).toEqual(expect.arrayContaining(["--env-file", customEnv]));
    expect(mocks.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      configPath: "/agent/config.json",
      envFile: customEnv,
    }));
  });

  it("does not install a unit when the selected dotenv snapshot cannot be captured", async () => {
    mocks.snapshot.mockRejectedValue(new Error("exported value disagrees"));
    const deps = output();

    expect(await runSystemdAgentCommand(args("start"), "start", {}, deps)).toBe(1);

    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringMatching(
      /Linux lifecycle: Cannot capture the selected dotenv snapshot:.*Unset conflicting exported values.*no unit changes were made/u,
    ));
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
    const deps = output();
    expect(await runSystemdWebCommand({ positionals: [], env: {} }, deps)).toBe(0);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(deps.stdout.write).toHaveBeenCalledWith(expect.stringContaining("Name: — (machine hostname)"));
  });

  it("preserves installed endpoint, theme, and allowed hosts on restart", async () => {
    mocks.read.mockResolvedValue({
      argv: [
        "/usr/bin/env", "-i", "PATH=/usr/bin", "MONO_AGENT_WEB_ALLOWED_HOSTS=example.ts.net",
        "/usr/bin/node", "--", "/managed/dist/cli.js",
        "web", "run", "--host", "127.0.0.1", "--port", "6060", "--theme", "plum",
      ],
    });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining([
      "MONO_AGENT_WEB_ALLOWED_HOSTS=example.ts.net", "127.0.0.1", "6060", "plum",
    ]));
    expect(mocks.health).toHaveBeenCalledWith("http://127.0.0.1:6060/healthz");
  });

  it("persists an operator-chosen console name into the unit argv", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand(
      { positionals: ["restart"], env: {}, name: "Flockbox" },
      output(),
    )).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--name", "Flockbox"]));
  });

  it("preserves the installed console name when restart does not override it", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum", "--name", "Flockbox") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--name", "Flockbox"]));
  });

  it("clears the installed console name when restart receives the reset sentinel", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum", "--name", "Flockbox") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand(
      { positionals: ["restart"], env: {}, name: "-" },
      output(),
    )).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).not.toContain("--name");
  });

  it("leaves the console name out of the unit argv when none was chosen", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "127.0.0.1", "--port", "5050", "--theme", "plum") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).not.toContain("--name");
  });

  it("probes the IPv6 loopback address for a bracketed wildcard listener", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "[::]", "--port", "5050", "--theme", "plum") });
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
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "5050", "--theme", "plum") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {}, loopback: true }, output())).toBe(0);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "5050"]));
  });

  it("binds loopback on a fresh install with no installed unit", async () => {
    mocks.inspect.mockResolvedValue({ ...service, activeState: "inactive", pid: 0 });
    // Nothing answers before the install; the service is healthy once started.
    mocks.health.mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["start"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--host", "127.0.0.1", "--port", "5050"]));
  });

  it("keeps the historical wide bind of an installed unit that never recorded --host", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--port", "5050", "--theme", "plum") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--port", "5050"]));
  });

  it("preserves an installed unit's explicit host", async () => {
    mocks.read.mockResolvedValue({ argv: managedWebArgv("web", "run", "--host", "10.0.0.5", "--port", "6060", "--theme", "plum") });
    mocks.health.mockResolvedValue(true);
    expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, output())).toBe(0);
    expect(mocks.start.mock.calls[0]![0].argv).toEqual(expect.arrayContaining(["--host", "10.0.0.5", "--port", "6060"]));
  });

  it("refuses a malformed installed unit before any mutation", async () => {
    const cases: ReadonlyArray<readonly string[]> = [
      managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "not-a-number", "--theme", "plum"),
      managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "5050", "--port", "5051", "--theme", "plum"),
      managedWebArgv("web", "run", "--host", "0.0.0.0", "--theme", "plum"),
      ["/bin/echo", "--host", "0.0.0.0", "--port", "5050", "--theme", "plum"],
    ];
    for (const argv of cases) {
      mocks.read.mockResolvedValue({ argv });
      mocks.health.mockResolvedValue(true);
      const deps = output();
      expect(await runSystemdWebCommand({ positionals: ["restart"], env: {} }, deps)).toBe(1);
      expect(deps.stderr.write).toHaveBeenCalledWith(expect.stringContaining("not a recognized managed web invocation"));
      expect(mocks.start).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
    }
  });

  it("keeps a malformed installed unit unknown in status without probing it", async () => {
    mocks.read.mockResolvedValue({
      argv: managedWebArgv("web", "run", "--host", "0.0.0.0", "--port", "not-a-number", "--theme", "plum"),
    });
    const deps = output();
    expect(await runSystemdWebCommand({ positionals: ["status"], json: true, env: {} }, deps)).toBe(1);
    const status = JSON.parse(deps.stdout.write.mock.calls[0]![0] as string) as {
      ok: boolean;
      listener: { host: null; port: null; url: null; source: string };
      definitionError: string | null;
    };
    expect(status.ok).toBe(false);
    expect(status.listener).toMatchObject({ host: null, port: null, url: null, source: "unknown" });
    expect(status.definitionError).toContain("not a recognized managed web definition");
    expect(mocks.health).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("reports listener and externally managed HTTPS routes in JSON status", async () => {
    mocks.health.mockResolvedValue(true);
    const deps = output();
    expect(await runSystemdWebCommand({ positionals: ["status"], json: true, env: {} }, deps)).toBe(0);
    const status = JSON.parse(deps.stdout.write.mock.calls[0]![0] as string) as {
      ok: boolean;
      listener: { host: string; port: number; url: string };
      ownedTailscaleRoute: { state: string };
      note: string;
    };
    expect(status.ok).toBe(true);
    expect(status.listener).toMatchObject({ host: "127.0.0.1", port: 5050, url: "http://127.0.0.1:5050/" });
    expect(status.ownedTailscaleRoute.state).toBe("not-managed");
    expect(status.note).toContain("not inspected");
    expect(deps.stdout.write).toHaveBeenCalledOnce();
  });
});
