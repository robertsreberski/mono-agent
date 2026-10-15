import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// App-owner identity (#1264): Darwin writes stable v2, every other platform keeps v1 bytes.
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>(), readFile: vi.fn() }));
const hostPlatform = process.platform, platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const uuid = "12345678-1234-1234-1234-123456789abc", start = "Mon Jan  5 12:34:56 2026";
const V1 = "mono-agent.process-incarnation.v1", V2 = "mono-agent.process-incarnation.v2";
type Options = { encoding: "utf8"; env?: NodeJS.ProcessEnv; timeout?: number; killSignal?: NodeJS.Signals };
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
function platform(value: NodeJS.Platform) { Object.defineProperty(process, "platform", { value }); }
function mockExec(action: (file: string, args: readonly string[], options: Options) => string | Promise<string>) {
  vi.mocked(execFile).mockImplementation(((file: string, args: readonly string[], options: Options, callback: Callback) => {
    Promise.resolve().then(() => action(file, args, options)).then((stdout) => callback(null, stdout, ""), (error: Error) => callback(error, "", ""));
    return {} as ChildProcess;
  }) as typeof execFile);
}
/** Darwin probes: v2 boot-session UUID, v1 calendar boot time, and `ps lstart`. */
function darwinProbes(state: { calendarBoot?: number; start?: string } = {}) {
  mockExec((_file, args) => args.includes("kern.boottime") ? `{ sec = ${state.calendarBoot ?? 1_700_000_000}, usec = 0 }`
    : args.includes("kern.bootsessionuuid") ? uuid : state.start ?? start);
}
function linuxProcfs() {
  vi.mocked(fs.readFile).mockImplementation((async (path: unknown) => String(path).endsWith("boot_id") ? `${uuid}\n`
    : `${process.pid} (fictional process) ${["S", ...Array(18).fill("0"), "123456"].join(" ")}`) as unknown as typeof fs.readFile);
}
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); platform("darwin"); });
afterEach(() => { Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks(); });

describe("Darwin owners", () => {
  it("write stable v2 and stay held across a simulated calendar-clock step", async () => {
    const state = { calendarBoot: 1_700_000_000 };
    darwinProbes(state);
    const before = await import("../process-incarnation.js");
    const owner = await before.currentProcessIncarnation();
    const legacyBefore = await before.currentProcessIncarnation(before.PROCESS_INCARNATION_SCHEMA);
    expect(owner).toEqual({ schema: V2, bootSessionId: `darwin-uuid:${uuid}`, processStartId: "posix-utc-lstart:Mon Jan 5 12:34:56 2026" });
    state.calendarBoot += 3_600; vi.resetModules(); // `kern.boottime` moves; a fresh observer sees the step.
    const after = await import("../process-incarnation.js");
    expect((await after.readProcessIncarnation(process.pid, after.PROCESS_INCARNATION_SCHEMA))!.bootSessionId).not.toBe(legacyBefore.bootSessionId);
    await expect(after.isProcessIncarnationLive(process.pid, owner)).resolves.toBe(true);
    await expect(after.isSameProcessIncarnation(process.pid, owner)).resolves.toBe(true);
  });

  it("detect a reused PID through a different v2 start", async () => {
    const state = { start };
    darwinProbes(state);
    const api = await import("../process-incarnation.js");
    const owner = await api.currentProcessIncarnation();
    state.start = "Tue Jan  6 08:00:00 2026";
    await expect(api.isProcessIncarnationLive(process.pid, owner)).resolves.toBe(false);
    await expect(api.isSameProcessIncarnation(process.pid, owner)).resolves.toBe(false);
  });

  it("hold a live legacy v1 owner by PID alone, but never authorize it", async () => {
    darwinProbes();
    const api = await import("../process-incarnation.js");
    const legacy = { schema: V1, bootSessionId: "darwin:1600000000:0", processStartId: "posix-lstart:Fictional local start" } as const;
    await expect(api.isProcessIncarnationLive(process.pid, legacy)).resolves.toBe(true);
    await expect(api.isSameProcessIncarnation(process.pid, legacy)).resolves.toBe(false);
    expect(execFile).toHaveBeenCalledTimes(2); // only the strict read probed; liveness of v1 needs no probe
  });

  it("treat only ESRCH as absence", async () => {
    darwinProbes();
    const api = await import("../process-incarnation.js");
    const owner = await api.currentProcessIncarnation();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("Fictional ESRCH"), { code: "ESRCH" }); });
    await expect(api.readProcessIncarnation(4242)).resolves.toBeUndefined();
    await expect(api.isProcessIncarnationLive(4242, owner)).resolves.toBe(false);
    kill.mockImplementation(() => { throw Object.assign(new Error("Fictional EPERM"), { code: "EPERM" }); });
    mockExec(() => { throw Object.assign(new Error("Fictional ps failure"), { code: 1 }); });
    await expect(api.readProcessIncarnation(4242)).rejects.toThrow("Fictional ps failure");
    await expect(api.isProcessIncarnationLive(4242, owner)).resolves.toBe(true);
    await expect(api.isSameProcessIncarnation(4242, owner)).rejects.toThrow();
  });

  it.each(["empty", "placeholder", "malformed UUID"])("throw on %s probe output for a live PID, never report absence", async (reason) => {
    mockExec((_file, args) => args.includes("kern.bootsessionuuid") ? reason === "malformed UUID" ? "not-a-uuid" : uuid
      : reason === "empty" ? "" : reason === "placeholder" ? "-\n" : start);
    const api = await import("../process-incarnation.js");
    await expect(api.readProcessIncarnation(process.pid)).rejects.toThrow();
    await expect(api.isProcessIncarnationLive(process.pid, { schema: V2, bootSessionId: `darwin-uuid:${uuid}`, processStartId: "posix-utc-lstart:x" })).resolves.toBe(true);
  });

  it("bound every Darwin probe, pin v2 to UTC and leave v1 values local", async () => {
    darwinProbes();
    const api = await import("../process-incarnation.js");
    await api.currentProcessIncarnation(); await api.currentProcessIncarnation(api.PROCESS_INCARNATION_SCHEMA);
    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(4); // v2: bootsessionuuid + ps; v1: kern.boottime + ps
    calls.forEach(([, , options], index) => {
      expect(options).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL" });
      if (index < 2) expect((options as Options).env).toMatchObject({ TZ: "UTC" });
      else expect((options as Options).env).not.toHaveProperty("TZ");
    });
  });

  it("a real probe timeout leaves the owner live and the strict check unavailable", async () => {
    const { execFile: realExec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let child: ChildProcess | undefined;
    vi.mocked(execFile).mockImplementation(((file: string, _args: readonly string[], options: Options, callback: Callback) => {
      if (file !== "/bin/ps") { queueMicrotask(() => callback(null, uuid, "")); return {} as ChildProcess; }
      child = realExec(process.execPath, ["-e", "setTimeout(() => process.exit(99), 10_000)"], options, callback);
      return child;
    }) as typeof execFile);
    try {
      const api = await import("../process-incarnation.js");
      const owner = { schema: V2, bootSessionId: `darwin-uuid:${uuid}`, processStartId: "posix-utc-lstart:Mon Jan 5 12:34:56 2026" } as const;
      await expect(api.isProcessIncarnationLive(process.pid, owner)).resolves.toBe(true);
      expect(child!.signalCode).toBe("SIGKILL");
      await expect(api.readProcessIncarnation(process.pid)).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
    } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 20_000);

  it.skipIf(hostPlatform !== "darwin")("real ps: a TZ change does not alter the v2 start id", async () => {
    const { execFile: realExec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
    let ambientTZ = "UTC";
    mockExec((file, argv, options) => new Promise<string>((resolve, reject) => realExec(file, argv,
      { ...options, env: { ...env, TZ: ambientTZ, ...options.env } }, (error, stdout) => error ? reject(error) : resolve(stdout))));
    const api = await import("../process-incarnation.js");
    const first = await api.currentProcessIncarnation(); ambientTZ = "Pacific/Honolulu";
    expect(first.schema).toBe(V2);
    await expect(api.readProcessIncarnation(process.pid)).resolves.toEqual(first);
    await expect(api.isProcessIncarnationLive(process.pid, first)).resolves.toBe(true);
  });
});

describe("other platforms keep v1", () => {
  it("Linux writes byte-identical v1 evidence and still detects reuse", async () => {
    platform("linux"); linuxProcfs();
    const api = await import("../process-incarnation.js");
    const owner = await api.currentProcessIncarnation();
    expect(JSON.stringify(owner)).toBe(`{"schema":"${V1}","bootSessionId":"linux:${uuid}","processStartId":"linux-ticks:123456"}`);
    await expect(api.isProcessIncarnationLive(process.pid, owner)).resolves.toBe(true);
    await expect(api.isSameProcessIncarnation(process.pid, owner)).resolves.toBe(true);
    const reused = { ...owner, processStartId: "linux-ticks:999" };
    await expect(api.isProcessIncarnationLive(process.pid, reused)).resolves.toBe(false);
    await expect(api.isSameProcessIncarnation(process.pid, reused)).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("win32 writes byte-identical v1 evidence through unbounded PowerShell probes", async () => {
    platform("win32");
    mockExec((_file, args) => String(args.at(-1)).includes("LastBootUpTime") ? "638000000000000000\r\n" : "638100000000000000\r\n");
    const api = await import("../process-incarnation.js");
    const owner = await api.currentProcessIncarnation();
    expect(JSON.stringify(owner)).toBe(`{"schema":"${V1}","bootSessionId":"win32:638000000000000000","processStartId":"win32-ticks:638100000000000000"}`);
    await expect(api.isSameProcessIncarnation(process.pid, { ...owner, processStartId: "win32-ticks:1" })).resolves.toBe(false);
    await expect(api.isProcessIncarnationLive(process.pid, { ...owner, processStartId: "win32-ticks:1" })).resolves.toBe(false);
    for (const [, , options] of vi.mocked(execFile).mock.calls) expect(options).not.toHaveProperty("timeout");
    await expect(api.readProcessIncarnation(process.pid, api.HISTORY_PROCESS_INCARNATION_SCHEMA)).rejects.toThrow(/unsupported/u);
  });

  it("other POSIX platforms write byte-identical v1 evidence from PID 1's birth", async () => {
    platform("freebsd");
    mockExec(() => `${start}\n`);
    const api = await import("../process-incarnation.js");
    expect(JSON.stringify(await api.currentProcessIncarnation()))
      .toBe(`{"schema":"${V1}","bootSessionId":"freebsd:pid1:posix-lstart:Mon Jan 5 12:34:56 2026","processStartId":"posix-lstart:Mon Jan 5 12:34:56 2026"}`);
    for (const [, , options] of vi.mocked(execFile).mock.calls) expect(options).not.toHaveProperty("timeout");
  });
});

describe("review regressions", () => {
  it("Linux procfs ENOENT while kill(0) still succeeds keeps the owner live", async () => {
    platform("linux"); linuxProcfs();
    const api = await import("../process-incarnation.js");
    const owner = await api.currentProcessIncarnation();
    vi.mocked(fs.readFile).mockImplementation((async (path: unknown) => {
      if (String(path).endsWith("boot_id")) return `${uuid}\n`;
      throw Object.assign(new Error("Fictional procfs race"), { code: "ENOENT" });
    }) as unknown as typeof fs.readFile);
    await expect(api.readProcessIncarnation(process.pid)).resolves.toBeUndefined(); // raw v1 reader unchanged
    await expect(api.isSameProcessIncarnation(process.pid, owner)).resolves.toBe(false); // strict unchanged
    await expect(api.isProcessIncarnationLive(process.pid, owner)).resolves.toBe(true);
    const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => true).mockImplementation(() => {
      throw Object.assign(new Error("Fictional ESRCH"), { code: "ESRCH" });
    });
    await expect(api.isProcessIncarnationLive(4242, owner)).resolves.toBe(false); // ESRCH on the re-check
    expect(kill).toHaveBeenCalled();
  });

  it("a rejected Darwin boot-session UUID capture is retried, not cached", async () => {
    let fail = true;
    mockExec((_file, args) => {
      if (args.includes("kern.bootsessionuuid")) { if (fail) { fail = false; throw new Error("Fictional sysctl failure"); } return uuid; }
      return start;
    });
    const api = await import("../process-incarnation.js");
    await expect(api.readProcessIncarnation(process.pid)).rejects.toThrow("Fictional sysctl failure");
    await expect(api.readProcessIncarnation(process.pid)).resolves.toMatchObject({ bootSessionId: `darwin-uuid:${uuid}` });
  });

  it("a rejected current-process v2 capture is retried, then cached", async () => {
    let failures = 1;
    mockExec((_file, args) => {
      if (args.includes("kern.bootsessionuuid")) return uuid;
      if (failures > 0) { failures -= 1; throw new Error("Fictional ps timeout"); }
      return start;
    });
    const api = await import("../process-incarnation.js");
    await expect(api.currentProcessIncarnation()).rejects.toThrow("Fictional ps timeout");
    const owner = await api.currentProcessIncarnation();
    expect(owner.schema).toBe(V2);
    const calls = vi.mocked(execFile).mock.calls.length;
    await expect(api.currentProcessIncarnation()).resolves.toBe(owner);
    expect(vi.mocked(execFile).mock.calls.length).toBe(calls);
  });

  it("a rejected v1 calendar boot capture is retried, not cached", async () => {
    let fail = true;
    mockExec((_file, args) => {
      if (args.includes("kern.boottime")) { if (fail) { fail = false; throw new Error("Fictional boottime failure"); } return "{ sec = 1700000000, usec = 0 }"; }
      return start;
    });
    const api = await import("../process-incarnation.js");
    await expect(api.currentProcessIncarnation(api.PROCESS_INCARNATION_SCHEMA)).rejects.toThrow("Fictional boottime failure");
    await expect(api.currentProcessIncarnation(api.PROCESS_INCARNATION_SCHEMA)).resolves.toMatchObject({ schema: V1, bootSessionId: "darwin:1700000000:0" });
  });
});

it("the persisted parser accepts v1 and v2 and rejects everything else", async () => {
  const api = await import("../process-incarnation.js");
  for (const schema of [V1, V2]) expect(api.processIncarnationFromJson({ schema, bootSessionId: "b", processStartId: "s" })).toBeDefined();
  for (const invalid of [{ schema: "mono-agent.process-incarnation.v3", bootSessionId: "b", processStartId: "s" }, { schema: V2, bootSessionId: "", processStartId: "s" }, null, []]) {
    expect(api.processIncarnationFromJson(invalid)).toBeUndefined();
  }
});
