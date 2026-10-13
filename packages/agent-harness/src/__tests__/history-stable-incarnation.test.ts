import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import process from "node:process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof fs>(), readFile: vi.fn() }));
const hostPlatform = process.platform, platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const uuid = "12345678-1234-1234-1234-123456789abc", start = "Mon Jan  5 12:34:56 2026";
type Options = { encoding: "utf8"; env?: NodeJS.ProcessEnv; timeout?: number; killSignal?: NodeJS.Signals };
type Callback = (error: Error | null, stdout: string, stderr: string) => void;
function platform(value: NodeJS.Platform) { Object.defineProperty(process, "platform", { value }); }
function mockExec(action: (file: string, args: readonly string[], options: Options) => string | Promise<string>) {
  vi.mocked(execFile).mockImplementation(((file: string, args: readonly string[], options: Options, callback: Callback) => {
    Promise.resolve().then(() => action(file, args, options)).then((stdout) => callback(null, stdout, ""), (error: Error) => callback(error, "", ""));
    return {} as ChildProcess;
  }) as typeof execFile);
}
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); platform("darwin"); });
afterEach(() => { Object.defineProperty(process, "platform", platformDescriptor); vi.restoreAllMocks(); });

it("a calendar-clock step changes v1 boot evidence but not the same live process's v2 identity", async () => {
  let calendarBoot = 1_700_000_000;
  mockExec((_file, args) => args.includes("kern.boottime") ? `{ sec = ${calendarBoot}, usec = 0 }`
    : args.includes("kern.bootsessionuuid") ? uuid.toUpperCase() : start);
  const before = await import("../process-incarnation.js");
  const oldBefore = await before.readProcessIncarnation(process.pid), stableBefore = await before.readHistoryProcessIncarnation(process.pid);
  calendarBoot += 3_600; vi.resetModules(); // A fresh observer after a clock step, not the first observer's cached v1 boot time.
  const after = await import("../process-incarnation.js");
  const oldAfter = await after.readProcessIncarnation(process.pid), stableAfter = await after.readHistoryProcessIncarnation(process.pid);
  expect(oldBefore!.bootSessionId).not.toBe(oldAfter!.bootSessionId);
  expect(stableAfter).toEqual(stableBefore);
  expect(stableAfter).toEqual({ schema: "mono-agent.process-incarnation.v2", bootSessionId: `darwin-uuid:${uuid}`, processStartId: "posix-utc-lstart:Mon Jan 5 12:34:56 2026" });
  const { historyOwnerLiveness } = await import("../history-process-liveness.js");
  expect(await historyOwnerLiveness()(process.pid, stableBefore)).toBe(true);
  for (const [, args, options] of vi.mocked(execFile).mock.calls) {
    if ((args as string[]).includes("kern.boottime")) expect(options).not.toHaveProperty("timeout"); // v1 remains unchanged.
  }
});

it("v2 Darwin probes are bounded, UTC-pinned, and never request calendar boottime", async () => {
  mockExec((_file, args) => args.includes("kern.bootsessionuuid") ? uuid : start);
  const { readHistoryProcessIncarnation } = await import("../process-incarnation.js");
  expect(await readHistoryProcessIncarnation(process.pid)).toBeDefined();
  expect(execFile).toHaveBeenCalledTimes(2);
  for (const [, args, options] of vi.mocked(execFile).mock.calls) {
    expect(args).not.toContain("kern.boottime");
    expect(options).toMatchObject({ timeout: 5_000, killSignal: "SIGKILL", env: { TZ: "UTC", LANG: "C", LC_ALL: "C" } });
  }
});

it.each(["win32", "freebsd", "openbsd"] as const)("%s history identity is unavailable without spawning a probe", async (name) => {
  platform(name);
  const { readHistoryProcessIncarnation } = await import("../process-incarnation.js");
  expect(await readHistoryProcessIncarnation(process.pid)).toBeUndefined(); expect(execFile).not.toHaveBeenCalled(); expect(fs.readFile).not.toHaveBeenCalled();
});
it("Linux reuses boot UUID and process start ticks under the distinct v2 schema", async () => {
  platform("linux");
  vi.mocked(fs.readFile).mockImplementation((async (path: unknown) => String(path).endsWith("boot_id") ? `${uuid}\n`
    : `${process.pid} (fictional process) ${["S", ...Array(18).fill("0"), "123456"].join(" ")}`) as unknown as typeof fs.readFile);
  const api = await import("../process-incarnation.js");
  const legacy = await api.readProcessIncarnation(process.pid), stable = await api.readHistoryProcessIncarnation(process.pid);
  expect(stable).toEqual({ ...legacy, schema: api.HISTORY_PROCESS_INCARNATION_SCHEMA });
  expect(stable).toMatchObject({ bootSessionId: `linux:${uuid}`, processStartId: "linux-ticks:123456" }); expect(execFile).not.toHaveBeenCalled();
});
it("a failed Linux v2 boot read does not poison the unchanged app v1 boot cache", async () => {
  platform("linux"); let denied = true;
  vi.mocked(fs.readFile).mockImplementation((async (path: unknown) => {
    if (String(path).endsWith("boot_id")) { if (denied) throw new Error("Fictional unavailable boot ID"); return uuid; }
    return `${process.pid} (fictional) ${["S", ...Array(18).fill("0"), "123456"].join(" ")}`;
  }) as unknown as typeof fs.readFile);
  const api = await import("../process-incarnation.js");
  expect(await api.readHistoryProcessIncarnation(process.pid)).toBeUndefined(); denied = false;
  await expect(api.readProcessIncarnation(process.pid)).resolves.toMatchObject({ schema: api.PROCESS_INCARNATION_SCHEMA });
});
it.each(["permission", "malformed UUID", "empty start", "placeholder start"])("unavailable %s evidence is not a v2 identity", async (reason) => {
  mockExec((_file, args) => {
    if (reason === "permission") throw Object.assign(new Error("Fictional denied probe"), { code: "EACCES" });
    return args.includes("kern.bootsessionuuid") ? reason === "malformed UUID" ? "not-a-uuid" : uuid : reason === "placeholder start" ? "-\n" : "";
  });
  const { readHistoryProcessIncarnation } = await import("../process-incarnation.js");
  expect(await readHistoryProcessIncarnation(process.pid)).toBeUndefined();
});
it("history parses only v2; v1 and unknown schemas cannot provide mismatch proof", async () => {
  const api = await import("../process-incarnation.js"), value = { schema: api.HISTORY_PROCESS_INCARNATION_SCHEMA, bootSessionId: uuid, processStartId: start };
  expect(api.historyProcessIncarnationFromJson(value)).toEqual(value);
  for (const invalid of [{ ...value, schema: api.PROCESS_INCARNATION_SCHEMA }, { ...value, schema: "unknown" }, { ...value, processStartId: "" }, null, []]) {
    expect(api.historyProcessIncarnationFromJson(invalid)).toBeUndefined();
  }
});

it.skipIf(hostPlatform !== "darwin")("real Darwin ps changes with TZ, while the v2 reader always sees UTC", async () => {
  const { execFile: realExec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const run = (file: string, args: readonly string[], options: Options) => new Promise<string>((resolve, reject) => realExec(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const args = ["-p", String(process.pid), "-o", "lstart="], env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" };
  expect(await run("/bin/ps", args, { encoding: "utf8", env: { ...env, TZ: "UTC" } }))
    .not.toBe(await run("/bin/ps", args, { encoding: "utf8", env: { ...env, TZ: "Pacific/Honolulu" } }));
  let ambientTZ = "UTC";
  mockExec((file, argv, options) => run(file, argv, { ...options, env: { ...env, TZ: ambientTZ, ...options.env } }));
  const { readHistoryProcessIncarnation } = await import("../process-incarnation.js");
  const first = await readHistoryProcessIncarnation(process.pid); ambientTZ = "Pacific/Honolulu";
  expect(first).toBeDefined(); expect(await readHistoryProcessIncarnation(process.pid)).toEqual(first);
});
it("a real v2 subprocess timeout kills only the probe and keeps the live owner protected", async () => {
  const { execFile: realExec } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  let child: ChildProcess | undefined, timeoutError: unknown;
  vi.mocked(execFile).mockImplementation(((file: string, _args: readonly string[], options: Options, callback: Callback) => {
    if (file !== "/bin/ps") { queueMicrotask(() => callback(null, uuid, "")); return {} as ChildProcess; }
    // Self-exit also bounds the fixture if the production timeout regresses.
    child = realExec(process.execPath, ["-e", "setTimeout(() => process.exit(99), 10_000)"], options, (error, stdout, stderr) => {
      timeoutError = error; callback(error, stdout, stderr);
    });
    return child;
  }) as typeof execFile);
  try {
    const { historyOwnerLiveness } = await import("../history-process-liveness.js");
    const { HISTORY_PROCESS_INCARNATION_SCHEMA } = await import("../process-incarnation.js");
    expect(await historyOwnerLiveness()(process.pid, { schema: HISTORY_PROCESS_INCARNATION_SCHEMA, bootSessionId: uuid, processStartId: start })).toBe(true);
    expect(timeoutError).toMatchObject({ killed: true, signal: "SIGKILL" }); expect(child!.signalCode).toBe("SIGKILL");
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
}, 15_000);
