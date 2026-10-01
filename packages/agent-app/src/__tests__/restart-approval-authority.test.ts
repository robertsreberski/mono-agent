import { afterEach, expect, it, vi } from "vitest";
import { startTuiAdapter } from "@mono-agent/operator-adapter";
import { createSupervisedRestartAuthority } from "../supervised-restart-authority.js";
import { createSupervisedRestartLatch } from "../supervised-restart-latch.js";
import { systemdUnitName } from "../systemd.js";
import type { PreparedSupervisedRestartInputs } from "../supervised-restart.js";

const configPath = "/work/example/mono-agent.config.json";
function fixture(prepareStartupInputs: (signal: AbortSignal) => Promise<PreparedSupervisedRestartInputs>) {
  const latch = createSupervisedRestartLatch();
  const stop = vi.fn(); latch.onStop(stop);
  const authority = createSupervisedRestartAuthority({ configPath, startedAt: "fixture-boot", platform: "linux", pid: 777,
    systemdRun: async () => ({ code: 0, stderr: "", stdout: ["LoadState=loaded", "ActiveState=active", "MainPID=777",
      `FragmentPath=/tmp/${systemdUnitName(configPath)}`,
      `ExecStart=argv[]=/node /cli start --foreground --config ${configPath} --expected-background-snapshot proof`, "Restart=on-failure"].join("\n") }),
    prepareStartupInputs,
  }, latch);
  return { authority, latch, stop };
}
afterEach(() => vi.useRealTimers());

it("publishes synchronously before exit disposition; concurrent tokens cause one stop", async () => {
  const dispose = vi.fn(async () => undefined);
  let latchRef: ReturnType<typeof createSupervisedRestartLatch>;
  const publish = vi.fn(() => { expect(latchRef.exitCode).toBe(0); });
  const prepare = vi.fn(async () => ({ supported: true, publish, dispose }));
  const { authority, latch, stop } = fixture(prepare); latchRef = latch;
  const [first, second] = await Promise.all([authority.verifyFresh!(), authority.verifyFresh!()]);
  expect(prepare).toHaveBeenCalledTimes(1);
  const accepted = authority.accept(first);
  expect(accepted.kind).toBe("accepted");
  expect(publish).toHaveBeenCalledTimes(1);
  expect(latch.exitCode).toBe(42);
  expect(authority.accept(second)).toMatchObject({ kind: "conflict" });
  if (accepted.kind === "accepted") { authority.beginStop(accepted.operationId); authority.beginStop(accepted.operationId); }
  expect(stop).toHaveBeenCalledTimes(1);
});

it.each(["Startup approval publication failed.", "Startup approval publication and restoration failed; validated approval may be active."])("refuses %s with no committed latch", async (reason) => {
  const publish = vi.fn(() => { throw new Error(reason); });
  const { authority, latch, stop } = fixture(async () => ({ supported: true, publish, dispose: async () => undefined }));
  const result = authority.accept(await authority.verifyFresh!());
  expect(result).toEqual({ kind: "refused", reason });
  expect(latch.exitCode).toBe(0); expect(stop).not.toHaveBeenCalled();
});

it("never prepares or publishes on cached capability reads, or accepts cached copies", async () => {
  const publish = vi.fn(); const prepare = vi.fn(async () => ({ supported: true, publish, dispose: async () => undefined }));
  const { authority } = fixture(prepare);
  await authority.verify(); await authority.verify();
  expect(prepare).not.toHaveBeenCalled();
  await authority.verifyFresh!();
  expect(authority.accept(await authority.verify()).kind).toBe("refused");
  expect(publish).not.toHaveBeenCalled();
});

it("expires abandoned/dead-client preparation without publication", async () => {
  vi.useFakeTimers();
  const publish = vi.fn(); const dispose = vi.fn(async () => undefined);
  const { authority, latch } = fixture(async () => ({ supported: true, publish, dispose }));
  const token = await authority.verifyFresh!();
  await vi.advanceTimersByTimeAsync(1_001);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(authority.accept(token).kind).toBe("refused");
  expect(publish).not.toHaveBeenCalled(); expect(latch.exitCode).toBe(0);
});

it("timed-out late completion can only dispose, never publish", async () => {
  vi.useFakeTimers();
  let finish: ((value: PreparedSupervisedRestartInputs) => void) | undefined;
  let signal: AbortSignal | undefined;
  const publish = vi.fn(); const dispose = vi.fn(async () => undefined);
  const { authority, latch } = fixture((received) => {
    signal = received;
    return new Promise((resolve) => { finish = resolve; });
  });
  const pending = authority.verifyFresh!();
  await vi.advanceTimersByTimeAsync(5_000);
  const token = await pending;
  expect(token.reason).toContain("timed out"); expect(signal?.aborted).toBe(true);
  finish!({ supported: true, publish, dispose });
  await vi.advanceTimersByTimeAsync(0);
  expect(dispose).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
  expect(authority.accept(token).kind).toBe("refused"); expect(latch.exitCode).toBe(0);
});

it("stopping disposition prevents publication", async () => {
  const publish = vi.fn(); const { authority, latch } = fixture(async () => ({ supported: true, publish, dispose: async () => undefined }));
  const token = await authority.verifyFresh!(); latch.signal();
  expect(authority.accept(token).kind).toBe("refused"); expect(publish).not.toHaveBeenCalled(); expect(latch.exitCode).toBe(0);
});

it.each([undefined, "wrong"])("rejects a keyless or wrong-key POST before preparation", async (bearer) => {
  const prepare = vi.fn(async () => ({ supported: true, publish: vi.fn(), dispose: async () => undefined }));
  const { authority } = fixture(prepare);
  const adapter = await startTuiAdapter({ ...(bearer === undefined ? {} : { apiKey: "fictional-owner" }),
    responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
  try {
    const response = await fetch(`${adapter.baseUrl}/v1/restart`, { method: "POST", headers: {
      "content-type": "application/json", ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    }, body: "{}" });
    expect(response.status).toBe(bearer === undefined ? 403 : 401);
    expect(prepare).not.toHaveBeenCalled();
  } finally { await adapter.stop(); }
});

it("cannot share a late prepared verdict through dedupe into a later POST's fresh deadline", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  let finish: ((value: PreparedSupervisedRestartInputs) => void) | undefined;
  const publish = vi.fn(); const dispose = vi.fn(async () => undefined);
  const prepare = vi.fn(() => new Promise<PreparedSupervisedRestartInputs>((resolve) => { finish = resolve; }));
  const { authority, latch, stop } = fixture(prepare);
  const firstPost = authority.verifyFresh!();
  await vi.advanceTimersByTimeAsync(0);
  // Model an overdue adapter/worker while timer callbacks are delayed. A later
  // POST shares the same promise, not a new origin deadline.
  vi.setSystemTime(started + 6_501);
  const laterPost = authority.verifyFresh!();
  finish!({ supported: true, publish, dispose });
  const [first, later] = await Promise.all([firstPost, laterPost]);
  expect(prepare).toHaveBeenCalledTimes(1); expect(later).toBe(first);
  expect(later.supported).toBe(false); expect(later.reason).toContain("timed out");
  expect(authority.accept(later).kind).toBe("refused");
  expect(dispose).toHaveBeenCalledTimes(1); expect(publish).not.toHaveBeenCalled();
  expect(latch.exitCode).toBe(0); expect(stop).not.toHaveBeenCalled();
});

it("expires a completed preparation at its input origin deadline even before the token TTL", async () => {
  vi.useFakeTimers();
  const started = Date.now(); const publish = vi.fn();
  let finish: ((value: PreparedSupervisedRestartInputs) => void) | undefined;
  const { authority, latch } = fixture(() => new Promise((resolve) => { finish = resolve; }));
  const pending = authority.verifyFresh!(); await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(started + 4_900);
  finish!({ supported: true, publish, dispose: async () => undefined });
  const token = await pending; expect(token.supported).toBe(true);
  vi.setSystemTime(started + 5_001);
  expect(authority.accept(token).kind).toBe("refused");
  expect(publish).not.toHaveBeenCalled(); expect(latch.exitCode).toBe(0);
});
