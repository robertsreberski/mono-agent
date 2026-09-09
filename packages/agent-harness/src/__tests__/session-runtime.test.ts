import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionRuntimeResolver, uniqueSessionHandles } from "../session-runtime.js";
import { createRuntimeSessionStore } from "../sessions.js";
import { retireRunResultSession } from "../harness/session-retirement.js";

const model = { provider: "faux", model: "base", reference: "faux:base" };
const runtime = () => ({ run: vi.fn(), disposeSession: vi.fn(async () => true),
  invalidateSession: vi.fn(async () => true), retireDurableSession: vi.fn(async () => undefined) });
afterEach(() => vi.useRealTimers());

describe("session runtime ownership", () => {
  it("caches owners, accepts default input aliases and retries failed construction without a default fallback", () => {
    const base = runtime();
    const alternate = runtime();
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error("construction failed"); }).mockReturnValue(alternate);
    const resolve = createSessionRuntimeResolver({ model: { ...model, reference: "pi:faux:base" }, runtime: base, runtimeForModel: factory });
    expect(resolve()).toBe(base);
    expect(resolve("faux:base")).toBe(base);
    expect(() => resolve("faux:override")).toThrow("construction failed");
    expect(resolve("faux:override")).toBe(alternate);
    expect(resolve("faux:override")).toBe(alternate);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(() => resolve("pi:faux:override")).toThrow();
    expect(createSessionRuntimeResolver({ model, runtime: base })("faux:override")).toBe(base);
  });

  it("rejects contradictory ownership before any retirement and deduplicates legacy handles", async () => {
    const base = runtime();
    const resolve = createSessionRuntimeResolver({ model, runtime: base });
    expect(uniqueSessionHandles([{ providerSessionId: "id" }, { providerSessionId: "id", modelKey: "faux:base" }]))
      .toEqual([{ providerSessionId: "id", modelKey: "faux:base" }]);
    await expect(retireRunResultSession({ model, runtime: base, identityPath: "/unused" }, resolve, undefined, true, "c", undefined,
      { providerSessionId: "id", modelKey: "faux:base" }, { providerSessionId: "id", modelKey: "faux:override" })).rejects.toThrow("conflicting");
    expect(base.invalidateSession).not.toHaveBeenCalled();
  });

  it.each(["timer", "lazy", "replaced", "disposed"])("routes %s eviction to the stored model owner", async (reason) => {
    vi.useFakeTimers();
    let now = 0;
    const base = runtime();
    const alternate = runtime();
    const resolve = createSessionRuntimeResolver({ model, runtime: base, runtimeForModel: () => alternate });
    const store = createRuntimeSessionStore({ idleTimeoutMs: 100, now: () => now,
      onEvict: async (record) => { await resolve(record.modelKey).disposeSession?.(record.providerSessionId); } });
    store.save("c", "override-id", undefined, undefined, undefined, "faux:override");
    if (reason === "timer") { now = 1001; await vi.advanceTimersByTimeAsync(1001); }
    if (reason === "lazy") { now = 1001; store.acquire("c"); }
    if (reason === "replaced") store.save("c", "next-id", undefined, undefined, undefined, "faux:base");
    if (reason === "disposed") await store.disposeAll();
    expect(alternate.disposeSession).toHaveBeenCalledWith("override-id");
    expect(base.disposeSession).not.toHaveBeenCalled();
    await store.disposeAll();
  });

  it("retires acquired and late-result handles on distinct owners", async () => {
    const base = runtime();
    const alternate = runtime();
    const resolve = createSessionRuntimeResolver({ model, runtime: base, runtimeForModel: () => alternate });
    await retireRunResultSession({ model, runtime: base, identityPath: "/unused", piSessionsRoot: "/sessions" },
      resolve, undefined, true, "c", undefined,
      { providerSessionId: "base-id", modelKey: "faux:base" },
      { providerSessionId: "late-id", modelKey: "faux:override" });
    expect(base.invalidateSession.mock.calls).toEqual([["base-id"]]);
    expect(alternate.invalidateSession.mock.calls).toEqual([["late-id"]]);
    expect(base.retireDurableSession).toHaveBeenCalledWith("base-id", "/sessions");
    expect(alternate.retireDurableSession).toHaveBeenCalledWith("late-id", "/sessions");
  });
});
