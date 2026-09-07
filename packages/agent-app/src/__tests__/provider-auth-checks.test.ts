import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { describe, expect, it, vi } from "vitest";

import { createProviderAuthCheckManager, type ProviderAuthCheckExecution } from "../provider-auth-checks.js";
import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";

describe("provider auth checks", () => {
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
    releases.shift()!({ state: "passed", code: "passed", message: "Provider request succeeded." });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    releases.shift()!({ state: "auth_failed", code: "credential_rejected", message: "Provider rejected the configured credential." });
    releases.shift()!({ state: "quota_limited", code: "quota_limited", message: "Provider quota prevented the check." });
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
    await expect(manager.start({ idempotencyKey: "login-active" })).rejects.toMatchObject({ status: 409 });
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
