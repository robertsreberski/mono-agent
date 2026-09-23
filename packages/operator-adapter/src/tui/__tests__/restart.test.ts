import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTuiAdapter, type TuiAdapterStartResult, type TuiRestartSupport } from "../index.js";
import { scheduleRestartStop } from "../restart-response.js";

let running: TuiAdapterStartResult | undefined;
afterEach(async () => { vi.useRealTimers(); await running?.stop(); running = undefined; });

function fixture(key = "owner") {
  let operationId: string | undefined;
  let support: TuiRestartSupport = { supported: true };
  const stop = vi.fn();
  const verify = vi.fn(async () => support);
  const authority = {
    verify,
    accept: vi.fn((verified: TuiRestartSupport) => {
      if (operationId !== undefined) return { kind: "conflict" as const, operationId };
      if (!verified.supported) return { kind: "refused" as const, reason: verified.reason ?? "unsupported" };
      operationId = "op-1";
      return { kind: "accepted" as const, operationId };
    }),
    processIdentity: () => ({ pid: 17, startedAt: "boot-1" }),
    beginStop: stop,
  };
  const request = (signal?: AbortSignal) => fetch(`${running!.baseUrl}/v1/restart`, {
    method: "POST", ...(signal === undefined ? {} : { signal }), headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}",
  });
  return { authority, stop, verify, request, setSupport(value: TuiRestartSupport) { support = value; } };
}

describe("operator restart", () => {
  it("advertises explicit unsupported status and forbids keyless or unauthenticated POST", async () => {
    const f = fixture();
    running = await startTuiAdapter({ responder: { respond: async () => ({ text: "unused" }) }, restart: f.authority });
    expect(((await (await fetch(running.infoUrl)).json()) as { capabilities: { restart: unknown } }).capabilities.restart).toEqual({ supported: false, reason: "Agent restart requires a configured operator API key." });
    expect((await f.request()).status).toBe(403);
    expect(f.authority.accept).not.toHaveBeenCalled();
    await running.stop();
    running = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: f.authority });
    expect(((await (await fetch(running.infoUrl, { headers: { authorization: "Bearer owner" } })).json()) as { capabilities: { restart: unknown } }).capabilities.restart).toEqual({ supported: true });
    expect((await fetch(`${running.baseUrl}/v1/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${running.baseUrl}/v1/restart`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: '{"extra":true}' })).status).toBe(400);
  });

  it("a policy change after advertisement refuses the POST and later acceptance conflicts with the original id", async () => {
    const f = fixture();
    running = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: f.authority });
    expect(((await (await fetch(running.infoUrl, { headers: { authorization: "Bearer owner" } })).json()) as { capabilities: { restart: unknown } }).capabilities.restart).toEqual({ supported: true });
    f.setSupport({ supported: false, reason: "Restart=no" });
    const refused = await f.request();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "restart_unsupported", message: "Restart=no" } });
    expect(f.stop).not.toHaveBeenCalled();
    f.setSupport({ supported: true });
    const accepted = await f.request();
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ operation: { id: "op-1" }, process: { pid: 17, startedAt: "boot-1" } });
    const second = await f.request();
    expect(second.status).toBe(409);
    expect(((await second.json()) as { operation: unknown }).operation).toEqual({ id: "op-1" });
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("invokes a receiver-dependent host method with its original receiver", async () => {
    class Host {
      readonly marker = "host-marker";
      async verify() { expect(this.marker).toBe("host-marker"); return { supported: true }; }
      accept() { expect(this.marker).toBe("host-marker"); return { kind: "accepted" as const, operationId: "bound-op" }; }
      processIdentity() { expect(this.marker).toBe("host-marker"); return { pid: 17, startedAt: "boot-1" }; }
      beginStop() { expect(this.marker).toBe("host-marker"); }
    }
    running = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: new Host() });
    const response = await fetch(`${running.baseUrl}/v1/restart`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(202);
  });

  it("keeps /v1/info live and refuses POST when injected supervisor inspection never settles", async () => {
    const f = fixture();
    f.verify.mockImplementation(() => new Promise(() => undefined));
    const authority = { ...f.authority, verifyFresh: () => new Promise<never>(() => undefined) };
    running = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: authority });
    const started = Date.now();
    const info = await fetch(running.infoUrl, { headers: { authorization: "Bearer owner" } });
    expect(info.status).toBe(200);
    expect((await info.json() as { capabilities: { restart: unknown } }).capabilities.restart)
      .toEqual({ supported: false, reason: "Supervisor verification timed out." });
    expect(Date.now() - started).toBeLessThan(1_000);
    const refused = await f.request();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { message: "Supervisor verification timed out." } });
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("dead A during verification cannot wedge live B or mint a false 202", async () => {
    const f = fixture();
    let resolveA!: (support: TuiRestartSupport) => void;
    f.verify.mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }));
    running = await startTuiAdapter({ apiKey: "owner", responder: { respond: async () => ({ text: "unused" }) }, restart: f.authority });
    const dead = new AbortController();
    const first = f.request(dead.signal);
    await vi.waitFor(() => expect(f.verify).toHaveBeenCalledTimes(1));
    dead.abort();
    await expect(first).rejects.toThrow();
    const second = await f.request();
    expect(second.status).toBe(202);
    resolveA({ supported: true });
    await Promise.resolve();
    await Promise.resolve(); // flush dead A's verification/response continuation
    expect(((await second.json()) as { operation: unknown }).operation).toEqual({ id: "op-1" });
    expect(f.authority.accept).toHaveBeenCalledTimes(1);
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("finishing, disconnecting and a never-finished response trigger only one stop using fake clocks", () => {
    vi.useFakeTimers();
    const finish = new EventEmitter();
    const stop = vi.fn();
    scheduleRestartStop(finish as never, stop);
    finish.emit("close");
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(stop).toHaveBeenCalledTimes(1);
    finish.emit("finish");
    expect(stop).toHaveBeenCalledTimes(1);
    const fast = new EventEmitter();
    scheduleRestartStop(fast as never, stop);
    fast.emit("finish");
    vi.advanceTimersByTime(1000);
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
