import type { MonoAgentConfig } from "@mono-agent/config";
import type { ProviderAuthStatusSnapshot } from "@mono-agent/agent-contracts";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { describe, expect, it, vi } from "vitest";

import { createProviderAuthCheckManager, type ProviderAuthCheckExecution } from "../provider-auth-checks.js";
import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";

describe("provider auth checks", () => {
  it("reserves preparation synchronously, replays the same key, and rejects a different key", async () => {
    let releaseStatus: ((status: ProviderAuthStatusSnapshot) => void) | undefined;
    const statusSnapshot = vi.fn(async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => {
      releaseStatus = resolve;
    }));
    const execute = vi.fn(async () => passed());
    const manager = createProviderAuthCheckManager({
      ...options(["fixture-a"], createProviderAuthObservationTracker()),
      isLoginActive: () => false,
      statusSnapshot,
      execute,
      cooldownMs: 0,
    });

    const first = manager.start({ idempotencyKey: "same-click" });
    expect(manager.isActive()).toBe(true);
    const replay = manager.start({ idempotencyKey: "same-click" });
    await expect(manager.start({ idempotencyKey: "different-click" })).rejects.toMatchObject({
      code: "provider_auth_conflict",
      status: 409,
    });
    expect(statusSnapshot).toHaveBeenCalledOnce();

    releaseStatus?.(fixtureStatus(["fixture-a"]));
    const [firstSnapshot, replaySnapshot] = await Promise.all([first, replay]);
    expect(replaySnapshot.id).toBe(firstSnapshot.id);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await manager.stop();
  });

  it("releases failed preparation and fences preparation during stop", async () => {
    const execute = vi.fn(async () => passed());
    const failed = createProviderAuthCheckManager({
      ...options(["fixture-a"], createProviderAuthObservationTracker()),
      isLoginActive: () => false,
      statusSnapshot: vi.fn()
        .mockRejectedValueOnce(new Error("fixture snapshot failure"))
        .mockResolvedValue(fixtureStatus(["fixture-a"])),
      execute,
      cooldownMs: 0,
    });
    await expect(failed.start({ idempotencyKey: "failed" })).rejects.toThrow("fixture snapshot failure");
    expect(failed.isActive()).toBe(false);
    await failed.start({ idempotencyKey: "after-failure" });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await failed.stop();

    let releaseStatus: ((status: ProviderAuthStatusSnapshot) => void) | undefined;
    const stoppedExecute = vi.fn(async () => passed());
    const stopped = createProviderAuthCheckManager({
      ...options(["fixture-a"], createProviderAuthObservationTracker()),
      isLoginActive: () => false,
      statusSnapshot: async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => {
        releaseStatus = resolve;
      }),
      execute: stoppedExecute,
      cooldownMs: 0,
    });
    const preparing = stopped.start({ idempotencyKey: "stopped" });
    const rejected = expect(preparing).rejects.toMatchObject({ code: "provider_auth_conflict", status: 409 });
    expect(stopped.isActive()).toBe(true);
    await stopped.stop();
    await rejected;
    expect(stopped.isActive()).toBe(false);
    releaseStatus?.(fixtureStatus(["fixture-a"]));
    await Promise.resolve();
    expect(stoppedExecute).not.toHaveBeenCalled();
  });

  it("checks only displayed providers, caps concurrency, replays clicks, and records fixed outcomes", async () => {
    const observations = createProviderAuthObservationTracker();
    const releases: Array<(outcome: ProviderAuthCheckExecution) => void> = [];
    let active = 0;
    let maximum = 0;
    const execute = vi.fn(async () => await new Promise<ProviderAuthCheckExecution>((resolve) => {
      active += 1;
      maximum = Math.max(maximum, active);
      releases.push((outcome) => {
        active -= 1;
        resolve(outcome);
      });
    }));
    const manager = createProviderAuthCheckManager({
      ...options(["fixture-a", "fixture-b", "fixture-c"], observations),
      isLoginActive: () => false,
      execute,
      cooldownMs: 60_000,
    });

    const started = await manager.start({ idempotencyKey: "click-one" });
    expect(started.results.map((result) => result.providerId)).toEqual(["fixture-a", "fixture-b", "fixture-c"]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(maximum).toBe(2);
    expect((await manager.start({ idempotencyKey: "click-one" })).id).toBe(started.id);
    releases.shift()!(passed());
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    releases.shift()!({ state: "auth_failed", code: "credential_rejected", message: "Provider rejected the configured credential." });
    releases.shift()!({ state: "quota_limited", code: "quota_limited", message: "Provider quota or rate limit prevented the check." });
    await vi.waitFor(async () => expect((await manager.get(started.id))?.state).toBe("completed"));

    const finished = await manager.get(started.id);
    expect(finished?.results.map((result) => result.state)).toEqual(["passed", "auth_failed", "quota_limited"]);
    expect(observations.get("fixture-a")?.verifiedAt).toBeDefined();
    expect(observations.get("fixture-b")?.failure?.kind).toBe("provider_auth");
    expect(observations.get("fixture-c")).toBeUndefined();
    await expect(manager.start({ idempotencyKey: "click-two" })).rejects.toMatchObject({
      code: "provider_auth_rate_limited",
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(JSON.stringify(finished)).not.toContain("RAW_PROVIDER_SECRET_SENTINEL");
    await manager.stop();
  });

  it("times out abort-ignoring execution and makes credential replacement stale", async () => {
    const observations = createProviderAuthObservationTracker();
    const timeoutManager = createProviderAuthCheckManager({
      ...options(["fixture-a"], observations),
      isLoginActive: () => false,
      execute: async () => await new Promise<ProviderAuthCheckExecution>(() => undefined),
      providerTimeoutMs: 5,
      batchTimeoutMs: 50,
      cooldownMs: 0,
    });
    const timed = await timeoutManager.start({ idempotencyKey: "timeout" });
    await vi.waitFor(async () => expect((await timeoutManager.get(timed.id))?.state).toBe("completed"));
    expect((await timeoutManager.get(timed.id))?.results[0]).toMatchObject({ state: "timeout", code: "timeout" });
    expect(observations.get("fixture-a")?.failure?.kind).toBe("provider_unavailable");
    await timeoutManager.stop();

    const staleObservations = createProviderAuthObservationTracker();
    const staleManager = createProviderAuthCheckManager({
      ...options(["fixture-a"], staleObservations),
      isLoginActive: () => false,
      execute: async () => await new Promise<ProviderAuthCheckExecution>(() => undefined),
      providerTimeoutMs: 1_000,
      batchTimeoutMs: 2_000,
      cooldownMs: 0,
    });
    const stale = await staleManager.start({ idempotencyKey: "stale" });
    await vi.waitFor(async () => expect((await staleManager.get(stale.id))?.results[0]?.state).toBe("running"));
    staleManager.credentialPersisted("fixture-a");
    await vi.waitFor(async () => expect((await staleManager.get(stale.id))?.state).toBe("completed"));
    expect((await staleManager.get(stale.id))?.results[0]?.state).toBe("stale");
    expect(staleObservations.get("fixture-a")).toBeUndefined();
    await staleManager.stop();
  });

  it("cancels active and pending work and rejects overlapping login/check starts", async () => {
    const observations = createProviderAuthObservationTracker();
    let loginActive = false;
    const manager = createProviderAuthCheckManager({
      ...options(["fixture-a", "fixture-b", "fixture-c"], observations),
      isLoginActive: () => loginActive,
      execute: async () => await new Promise<ProviderAuthCheckExecution>(() => undefined),
      providerTimeoutMs: 1_000,
      batchTimeoutMs: 2_000,
      cooldownMs: 0,
    });
    loginActive = true;
    await expect(manager.start({ idempotencyKey: "login-active" })).rejects.toMatchObject({
      status: 409,
      message: "Provider authentication is active. Finish or cancel it before running live checks.",
    });
    loginActive = false;

    const started = await manager.start({ idempotencyKey: "cancel" });
    await vi.waitFor(async () => expect(
      (await manager.get(started.id))?.results.filter((result) => result.state === "running"),
    ).toHaveLength(2));
    await expect(manager.start({ idempotencyKey: "overlap" })).rejects.toMatchObject({ status: 409 });
    await manager.cancel(started.id);
    expect((await manager.get(started.id))?.state).toBe("cancelled");
    expect((await manager.get(started.id))?.results.map((result) => result.state))
      .toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(observations.get("fixture-a")).toBeUndefined();
    await manager.stop();
  });

  it("marks active requests timed out and undispatched requests not run at the batch deadline", async () => {
    const manager = createProviderAuthCheckManager({
      ...options(["fixture-a", "fixture-b", "fixture-c"], createProviderAuthObservationTracker()),
      isLoginActive: () => false,
      execute: async () => await new Promise<ProviderAuthCheckExecution>(() => undefined),
      providerTimeoutMs: 1_000,
      batchTimeoutMs: 5,
      cooldownMs: 0,
    });
    const started = await manager.start({ idempotencyKey: "batch-timeout" });
    await vi.waitFor(async () => expect((await manager.get(started.id))?.state).toBe("completed"));
    expect((await manager.get(started.id))?.results.map((result) => result.state))
      .toEqual(["timeout", "timeout", "not_run"]);
    await manager.stop();
  });

  it("reports incomparable prices without making a request", async () => {
    const observations = createProviderAuthObservationTracker();
    const base = fixtureConfig(["fixture-a"]);
    const config = {
      ...base,
      providers: {
        ...base.providers,
        local: [{
          ...base.providers!.local![0]!,
          models: [
            { name: "known", pricing: { input_per_million: 1, output_per_million: 1 } },
            { name: "unknown" },
          ],
        }],
      },
    } as MonoAgentConfig;
    const execute = vi.fn();
    const manager = createProviderAuthCheckManager({
      config,
      env: {},
      drivers: [],
      input: { cwd: "/fixture", configPath: "/fixture/config.json", env: {} },
      observations,
      isLoginActive: () => false,
      execute,
      cooldownMs: 0,
    });
    const started = await manager.start({ idempotencyKey: "unsupported" });
    await vi.waitFor(async () => expect((await manager.get(started.id))?.state).toBe("completed"));
    expect((await manager.get(started.id))?.results[0]).toMatchObject({
      state: "unsupported",
      code: "pricing_unavailable",
    });
    expect(execute).not.toHaveBeenCalled();
    await manager.stop();
  });
});

function options(
  ids: readonly string[],
  observations: ReturnType<typeof createProviderAuthObservationTracker>,
) {
  return {
    config: fixtureConfig(ids),
    env: {},
    drivers: [],
    input: { cwd: "/fixture", configPath: "/fixture/config.json", env: {} },
    observations,
  } as const;
}

function fixtureConfig(ids: readonly string[]): MonoAgentConfig {
  return {
    runtime: {
      model: parseMonoRuntimeModelReference(`${ids[0]}:cheap`),
      fallbacks: ids.slice(1).map((id) => ({ model: parseMonoRuntimeModelReference(`${id}:cheap`) })),
    },
    providers: {
      piAuthPath: "/fixture/auth.json",
      local: ids.map((id) => ({
        id,
        type: "openai_compat",
        baseUrl: "http://127.0.0.1:9999",
        enabled: true,
        models: [{ name: "cheap", pricing: { input_per_million: 1, output_per_million: 1 } }],
      })),
    },
  } as unknown as MonoAgentConfig;
}

function fixtureStatus(ids: readonly string[]): ProviderAuthStatusSnapshot {
  return {
    schema: "mono-agent.provider-auth.v1",
    generatedAt: "2026-09-06T12:00:00.000Z",
    providers: ids.map((providerId, index) => ({
      providerId,
      label: providerId,
      usages: [{
        kind: index === 0 ? "primary" : "fallback",
        model: `${providerId}:cheap`,
        label: index === 0 ? "Primary model" : `Fallback ${index}`,
      }],
      state: "present",
      source: "config",
      verification: "not_verified",
      methods: [],
    })),
  };
}

function passed(): ProviderAuthCheckExecution {
  return { state: "passed", code: "passed", message: "Provider request succeeded." };
}
