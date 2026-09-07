import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import type { ProviderAuthStatusSnapshot } from "@mono-agent/agent-contracts";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";
import { createProviderAuthOperator } from "../provider-auth-operator.js";
import { persistPiProviderCredential } from "../provider-setup.js";

const tempDirs: string[] = [];
afterEach(async () => await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }))));

describe("provider auth operator", () => {
  it("replaces an active valid login, rejects its old prompt, and ignores its late events", async () => {
    const observations = createProviderAuthObservationTracker();
    const persisted = vi.spyOn(observations, "credentialPersisted");
    const interactions: Array<{ notify(event: unknown): void }> = [];
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations,
      login: (async (_provider: string, _type: string, interaction: {
        prompt(input: unknown): Promise<string>;
        notify(event: unknown): void;
      }) => {
        interactions.push(interaction);
        return { type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }) };
      }) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });

    const first = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    expect(first).toMatchObject({ state: "awaiting_input", prompt: { type: "secret" } });
    const second = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    expect(second.id).not.toBe(first.id);
    expect(await operator.get(first.id)).toMatchObject({ state: "cancelled" });
    await expect(operator.submit(first.id, { promptId: first.prompt!.id, value: "old" }))
      .rejects.toMatchObject({ status: 409 });

    await vi.waitFor(async () => expect(await operator.get(second.id)).toMatchObject({
      state: "awaiting_input",
      prompt: { type: "secret" },
    }));
    const secondPrompt = (await operator.get(second.id))!.prompt!;

    interactions[0]!.notify({ type: "auth_url", url: "https://stale.example.invalid/callback" });
    expect(await operator.get(second.id)).not.toHaveProperty("authUrl");
    await operator.submit(second.id, { promptId: secondPrompt.id, value: "new" });
    await vi.waitFor(async () => expect((await operator.get(second.id))?.state).toBe("succeeded"));
    expect(persisted).toHaveBeenCalledOnce();
    await operator.stop();
  });

  it("validates replacement requests before disturbing the active session", async () => {
    const status = operatorStatus();
    const statusSnapshot = vi.fn()
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error("fixture status unavailable"))
      .mockResolvedValue(status);
    const configured = config();
    const operator = createProviderAuthOperator({
      config: configured, env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      statusSnapshot,
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string> }) => ({
        type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }),
      })) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });

    const active = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await expect(operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" }))
      .rejects.toThrow("fixture status unavailable");
    await expect(operator.start({ providerId: "unknown", authType: "api_key", strategy: "api_key_prompt" }))
      .rejects.toMatchObject({ code: "provider_auth_invalid_request", status: 400 });
    await expect(operator.start({ providerId: "opencode-go", authType: "oauth", strategy: "paste_back" }))
      .rejects.toMatchObject({ code: "provider_auth_conflict", status: 409 });
    delete (configured.providers as { piAuthPath?: string }).piAuthPath;
    await expect(operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" }))
      .rejects.toMatchObject({ code: "provider_auth_unavailable", status: 503 });
    (configured.providers as { piAuthPath?: string }).piAuthPath = "/tmp/mono-agent-provider-auth-test.json";
    expect(await operator.get(active.id)).toMatchObject({ state: "awaiting_input", prompt: { id: active.prompt!.id } });

    await operator.submit(active.id, { promptId: active.prompt!.id, value: "still-valid" });
    await vi.waitFor(async () => expect((await operator.get(active.id))?.state).toBe("succeeded"));
    await operator.stop();
  });

  it("makes the newest valid concurrent admission win independent of status completion order", async () => {
    const releases: Array<(status: ProviderAuthStatusSnapshot) => void> = [];
    const statusSnapshot = vi.fn(async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => releases.push(resolve)));
    const persist = vi.fn(async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); });
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(), statusSnapshot,
      login: (async () => ({ type: "api_key", key: "fake" })) as never,
      persist: persist as never,
    });

    const older = operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    const olderRejected = expect(older).rejects.toMatchObject({ code: "provider_auth_conflict", status: 409 });
    const newer = operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    expect(releases).toHaveLength(2);
    releases[1]!(operatorStatus());
    const winner = await newer;
    releases[0]!(operatorStatus());
    await olderRejected;
    await vi.waitFor(async () => expect((await operator.get(winner.id))?.state).toBe("succeeded"));
    expect(persist).toHaveBeenCalledOnce();
    await operator.stop();

    const secondReleases: Array<(status: ProviderAuthStatusSnapshot) => void> = [];
    const second = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      statusSnapshot: async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => secondReleases.push(resolve)),
      login: (async () => ({ type: "api_key", key: "fake" })) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });
    const validOlder = second.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    const invalidNewer = second.start({ providerId: "unknown", authType: "api_key", strategy: "api_key_prompt" });
    secondReleases[1]!(operatorStatus());
    await expect(invalidNewer).rejects.toMatchObject({ code: "provider_auth_invalid_request", status: 400 });
    secondReleases[0]!(operatorStatus());
    const surviving = await validOlder;
    await vi.waitFor(async () => expect((await second.get(surviving.id))?.state).toBe("succeeded"));
    await second.stop();
  });

  it("fails a replacement after the two-second safe-drain bound without starting a second writer", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const persist = vi.fn()
        .mockImplementationOnce(async () => await firstPending)
        .mockImplementation(async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); });
      const operator = createProviderAuthOperator({
        config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
        observations: createProviderAuthObservationTracker(), statusSnapshot: async () => operatorStatus(),
        login: (async () => ({ type: "api_key", key: "fake" })) as never,
        persist: persist as never,
      });

      const first = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
      const replacement = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
      expect(await operator.get(first.id)).toMatchObject({ state: "cancelled" });
      expect(replacement.state).toBe("pending");
      expect(persist).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await operator.get(replacement.id)).toMatchObject({
        state: "failed",
        error: {
          code: "replacement_timeout",
          message: "The previous authentication did not stop safely. Retry after it finishes.",
        },
      });
      expect(persist).toHaveBeenCalledOnce();

      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
      const retry = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
      await vi.advanceTimersByTimeAsync(0);
      expect(await operator.get(retry.id)).toMatchObject({ state: "succeeded" });
      expect(persist).toHaveBeenCalledTimes(2);
      await operator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates passive proof when persistence finishes after logical cancellation", async () => {
    const observations = createProviderAuthObservationTracker();
    observations.runStarted("credential-a-run");
    observations.observe({
      runId: "credential-a-run", conversationId: "web:1", status: "succeeded", durationMs: 1,
      eventCount: 0, artifactPaths: [], model: "opencode-go:kimi-k2.6",
    });
    expect(observations.get("opencode-go")).toBeDefined();
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => { finishPersistence = resolve; });
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations,
      statusSnapshot: async () => operatorStatus(),
      persist: (async () => await persistence) as never,
    });

    const session = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await operator.cancel(session.id);
    expect(await operator.get(session.id)).toMatchObject({ state: "cancelled" });
    finishPersistence();
    await operator.stop();
    expect(observations.get("opencode-go")).toBeUndefined();
  });

  it("invalidates passive proof when an installed credential is followed by cleanup failure", async () => {
    const observations = createProviderAuthObservationTracker();
    observations.runStarted("credential-a-run");
    observations.observe({
      runId: "credential-a-run", conversationId: "web:1", status: "succeeded", durationMs: 1,
      eventCount: 0, artifactPaths: [], model: "opencode-go:kimi-k2.6",
    });
    let finishAfterMutation!: () => void;
    const persist = vi.fn(async (input: Parameters<typeof persistPiProviderCredential>[0] & {
      readonly onCredentialStoreMutation?: () => void;
    }) => await new Promise<void>((_resolve, reject) => {
      finishAfterMutation = () => {
        input.onCredentialStoreMutation?.();
        reject(new Error("fixture cleanup failure"));
      };
    }));
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations,
      statusSnapshot: async () => operatorStatus(),
      persist: persist as never,
    });

    const session = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    await operator.cancel(session.id);
    expect(observations.get("opencode-go")).toBeDefined();
    finishAfterMutation();
    await operator.stop();
    expect(observations.get("opencode-go")).toBeUndefined();
  });

  it("stops and fences a login whose status preparation has not settled", async () => {
    let releaseStatus!: (status: ProviderAuthStatusSnapshot) => void;
    const persist = vi.fn();
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      statusSnapshot: async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => { releaseStatus = resolve; }),
      persist: persist as never,
    });
    const pending = operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    const rejected = expect(pending).rejects.toMatchObject({ code: "provider_auth_conflict", status: 409 });

    await operator.stop();
    await rejected;
    releaseStatus(operatorStatus());
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
  });

  it.each(["beforePiAuthPostMutationSync", "beforePiAuthTempCleanup"] as const)(
    "waits for non-cancellable credential %s before adapter stop completes",
    async (hookName) => {
      const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-auth-stop-"));
      tempDirs.push(dir);
      const authPath = join(dir, "auth.json");
      await writeFile(authPath, `${JSON.stringify({ openai: { type: "api_key", key: "sibling" } })}\n`, { mode: 0o600 });
      let enterHook!: () => void;
      const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
      let releaseHook!: () => void;
      const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
      const operator = createProviderAuthOperator({
        config: { ...config(), providers: { piAuthPath: authPath } } as unknown as MonoAgentConfig,
        env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} },
        observations: createProviderAuthObservationTracker(), statusSnapshot: async () => operatorStatus(),
        login: (async () => ({ type: "api_key", key: "fake-replacement" })) as never,
        persist: (async (input: Parameters<typeof persistPiProviderCredential>[0]) => await persistPiProviderCredential({
          ...input,
          [hookName]: async () => {
            enterHook();
            await hookRelease;
          },
        })) as never,
      });

      await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
      await hookEntered;
      let stopped = false;
      const stopping = operator.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      releaseHook();
      await stopping;
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        openai: { type: "api_key", key: "sibling" },
        "opencode-go": { type: "api_key", key: "fake-replacement" },
      });
      expect((await readdir(dir)).filter((name) => name.includes("mono-agent"))).toEqual([]);
    },
  );

  it("excludes login and check preparation in both start orderings", async () => {
    let releaseCheckStatus: ((status: ProviderAuthStatusSnapshot) => void) | undefined;
    const status = operatorStatus();
    const checkFirst = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      statusSnapshot: vi.fn()
        .mockImplementationOnce(async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => {
          releaseCheckStatus = resolve;
        }))
        .mockResolvedValue(status),
      checkExecute: async () => ({ state: "passed", code: "passed", message: "Provider request succeeded." }),
      checkCooldownMs: 0,
      login: (async () => ({ type: "api_key", key: "fake" })) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });
    const preparingCheck = checkFirst.checks!.start({ idempotencyKey: "check-first" });
    await expect(checkFirst.start({
      providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt",
    })).rejects.toMatchObject({
      code: "provider_auth_conflict",
      status: 409,
      message: "Provider live checks are active. Cancel them before authenticating.",
    });
    releaseCheckStatus?.(status);
    await preparingCheck;
    await checkFirst.stop();

    let releaseLoginStatus: ((status: ProviderAuthStatusSnapshot) => void) | undefined;
    const loginFirst = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      statusSnapshot: async () => await new Promise<ProviderAuthStatusSnapshot>((resolve) => {
        releaseLoginStatus = resolve;
      }),
      checkExecute: async () => ({ state: "passed", code: "passed", message: "Provider request succeeded." }),
      checkCooldownMs: 0,
      login: (async () => ({ type: "api_key", key: "fake" })) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });
    const preparingLogin = loginFirst.start({
      providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt",
    });
    await expect(loginFirst.checks!.start({ idempotencyKey: "login-first" }))
      .rejects.toMatchObject({
        code: "provider_auth_conflict",
        status: 409,
        message: "Provider authentication is active. Finish or cancel it before running live checks.",
      });
    releaseLoginStatus?.(status);
    await preparingLogin;
    await loginFirst.stop();
  });

  it("keeps passive status reads side-effect free", async () => {
    const checkExecute = vi.fn();
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      checkExecute,
    });

    await operator.status();
    await operator.status();
    expect(checkExecute).not.toHaveBeenCalled();
    await operator.stop();
  });

  it("runs a provider-owned secret prompt without retaining or returning the submitted value", async () => {
    let committed: unknown;
    const operator = createProviderAuthOperator({
      config: config(), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string> }) => ({
        type: "api_key", key: await interaction.prompt({ type: "secret", message: "OpenCode API key" }),
      })) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { committed = await input.resolveCredential(); }) as never,
    });
    const started = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    expect(started).toMatchObject({ state: "awaiting_input", prompt: { type: "secret" } });
    const secret = "PROVIDER_AUTH_SECRET_SENTINEL";
    await operator.submit(started.id, { promptId: started.prompt!.id, value: secret });
    await vi.waitFor(async () => expect((await operator.get(started.id))?.state).toBe("succeeded"));
    expect(committed).toEqual({ type: "api_key", key: secret });
    expect(JSON.stringify(await operator.get(started.id))).not.toContain(secret);
    await expect(operator.submit(started.id, { promptId: started.prompt!.id, value: secret })).rejects.toMatchObject({ status: 409 });
    await operator.stop();
  });

  it("returns a replaced credential to not-verified until a later model request succeeds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-auth-verification-"));
    tempDirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ "opencode-go": { type: "api_key", key: "old-key" } })}\n`, { mode: 0o600 });
    let now = Date.parse("2026-09-06T12:00:00.000Z");
    const observations = createProviderAuthObservationTracker(() => now);
    observations.runStarted("verified");
    observations.observe({
      runId: "verified", conversationId: "web:1", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "opencode-go:kimi-k2.6",
    });
    now += 1_000;
    observations.runStarted("auth-failed");
    observations.observe({
      runId: "auth-failed", conversationId: "web:1", status: "failed", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "opencode-go:kimi-k2.6", failureKind: "provider_auth",
    });
    const operator = createProviderAuthOperator({
      config: { ...config(), providers: { piAuthPath: authPath } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} }, observations,
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string> }) => ({
        type: "api_key", key: await interaction.prompt({ type: "secret", message: "OpenCode API key" }),
      })) as never,
    });

    expect((await operator.status()).providers[0]).toMatchObject({
      state: "present",
      verification: "not_verified",
      lastFailure: { kind: "provider_auth" },
    });
    expect((await operator.status()).providers[0]).not.toHaveProperty("verifiedAt");
    const started = await operator.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(async () => expect((await operator.get(started.id))?.prompt?.id).toBeDefined());
    await operator.submit(started.id, {
      promptId: (await operator.get(started.id))!.prompt!.id,
      value: "replacement-key",
    });
    await vi.waitFor(async () => expect((await operator.get(started.id))?.state).toBe("succeeded"));
    expect((await operator.status()).providers[0]).toMatchObject({
      state: "present",
      verification: "not_verified",
    });
    expect((await operator.status()).providers[0]).not.toHaveProperty("verifiedAt");
    expect((await operator.status()).providers[0]).not.toHaveProperty("lastFailure");
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      "opencode-go": { type: "api_key", key: "replacement-key" },
    });
    now += 1_000;
    observations.runStarted("replacement-verified");
    observations.observe({
      runId: "replacement-verified", conversationId: "web:1", status: "succeeded", durationMs: 1, eventCount: 0, artifactPaths: [],
      model: "opencode-go:kimi-k2.6",
    });
    expect((await operator.status()).providers[0]).toMatchObject({
      verification: "verified_by_live_request",
      verifiedAt: "2026-09-06T12:00:02.000Z",
    });
    await operator.stop();
  });

  it("selects OpenAI's exact upstream device-code option and surfaces the device event", async () => {
    let selected: string | undefined;
    const operator = createProviderAuthOperator({
      config: { ...config(), runtime: { model: parseMonoRuntimeModelReference("openai-codex:gpt-5.6-terra") } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} }, observations: createProviderAuthObservationTracker(),
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string>; notify(event: unknown): void; signal: AbortSignal }) => {
        selected = await interaction.prompt({ type: "select", message: "Method", options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] });
        interaction.notify({ type: "device_code", verificationUri: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH", expiresInSeconds: 900 });
        await new Promise((_, reject) => interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true }));
      }) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });
    const started = await operator.start({ providerId: "openai-codex", authType: "oauth", strategy: "device_code" });
    await vi.waitFor(async () => expect((await operator.get(started.id))?.deviceCode?.userCode).toBe("ABCD-EFGH"));
    expect(selected).toBe("device_code");
    await operator.cancel(started.id);
    expect((await operator.get(started.id))?.state).toBe("cancelled");
    await operator.stop();
  });

  it("surfaces GitHub's optional domain prompt before its device-code polling state", async () => {
    let finishLogin: ((value: unknown) => void) | undefined;
    const operator = createProviderAuthOperator({
      config: config("github-copilot:gpt-4o"), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string>; notify(event: unknown): void }) => {
        const domain = await interaction.prompt({ type: "text", message: "GitHub Enterprise domain", allowEmpty: true });
        expect(domain).toBe("");
        interaction.notify({ type: "device_code", verificationUri: "https://github.com/login/device", userCode: "GH-1234", expiresInSeconds: 600 });
        return await new Promise((resolve) => { finishLogin = resolve; });
      }) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });
    const started = await operator.start({ providerId: "github-copilot", authType: "oauth", strategy: "device_code" });
    expect(started).toMatchObject({ state: "awaiting_input", prompt: { type: "text" } });
    await operator.submit(started.id, { promptId: started.prompt!.id, value: " " });
    await vi.waitFor(async () => expect(await operator.get(started.id)).toMatchObject({
      state: "awaiting_user",
      deviceCode: { verificationUri: "https://github.com/login/device", userCode: "GH-1234" },
    }));
    finishLogin?.({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 });
    await vi.waitFor(async () => expect((await operator.get(started.id))?.state).toBe("succeeded"));
    await operator.stop();
  });

  it("keeps Anthropic paste-back and generic API-key prompt sequences typed and secret-free", async () => {
    const captured: unknown[] = [];
    const anthropic = createProviderAuthOperator({
      config: config("anthropic:claude-sonnet-4-5"), env: {}, drivers: [], input: { cwd: "/tmp", configPath: "/tmp/config.json", env: {} },
      observations: createProviderAuthObservationTracker(),
      login: (async (_provider: string, type: string, interaction: { prompt(input: unknown): Promise<string>; notify(event: unknown): void }) => {
        if (type === "oauth") {
          interaction.notify({ type: "auth_url", url: "https://console.anthropic.com/oauth/authorize" });
          const code = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
          captured.push(code);
          return { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 };
        }
        const account = await interaction.prompt({ type: "text", message: "Account" });
        const region = await interaction.prompt({ type: "select", message: "Region", options: [
          { id: "eu", label: "Europe" }, { id: "us", label: "United States" },
        ] });
        const secret = await interaction.prompt({ type: "secret", message: "API key" });
        captured.push(account, region, secret);
        return { type: "api_key", env: { ACCOUNT: account, REGION: region, API_KEY: secret } };
      }) as never,
      persist: (async (input: { resolveCredential(): Promise<unknown> }) => { await input.resolveCredential(); }) as never,
    });

    const oauth = await anthropic.start({ providerId: "anthropic", authType: "oauth", strategy: "paste_back" });
    await vi.waitFor(async () => expect(await anthropic.get(oauth.id)).toMatchObject({
      state: "awaiting_input", authUrl: { url: "https://console.anthropic.com/oauth/authorize" }, prompt: { type: "manual_code" },
    }));
    const redirect = "http://localhost:53692/callback?code=one&state=two";
    await anthropic.submit(oauth.id, { promptId: (await anthropic.get(oauth.id))!.prompt!.id, value: redirect });
    await vi.waitFor(async () => expect((await anthropic.get(oauth.id))?.state).toBe("succeeded"));
    expect(JSON.stringify(await anthropic.get(oauth.id))).not.toContain(redirect);

    const apiKey = await anthropic.start({ providerId: "anthropic", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(async () => expect((await anthropic.get(apiKey.id))?.prompt?.type).toBe("text"));
    await anthropic.submit(apiKey.id, { promptId: (await anthropic.get(apiKey.id))!.prompt!.id, value: "owner" });
    await vi.waitFor(async () => expect((await anthropic.get(apiKey.id))?.prompt?.type).toBe("select"));
    await expect(anthropic.submit(apiKey.id, { promptId: (await anthropic.get(apiKey.id))!.prompt!.id, value: "invalid" }))
      .rejects.toMatchObject({ status: 400 });
    await anthropic.submit(apiKey.id, { promptId: (await anthropic.get(apiKey.id))!.prompt!.id, value: "eu" });
    await vi.waitFor(async () => expect((await anthropic.get(apiKey.id))?.prompt?.type).toBe("secret"));
    const secret = "MULTI_PROMPT_SECRET_SENTINEL";
    await anthropic.submit(apiKey.id, { promptId: (await anthropic.get(apiKey.id))!.prompt!.id, value: secret });
    await vi.waitFor(async () => expect((await anthropic.get(apiKey.id))?.state).toBe("succeeded"));
    expect(captured).toContain(secret);
    expect(JSON.stringify(await anthropic.get(apiKey.id))).not.toContain(secret);
    await anthropic.stop();
  });

  it("uses the on-disk lock across service instances and preserves sibling credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mono-agent-provider-auth-lock-"));
    tempDirs.push(dir);
    const authPath = join(dir, "auth.json");
    await writeFile(authPath, `${JSON.stringify({ openai: { type: "api_key", key: "sibling" } })}\n`, { mode: 0o600 });
    const make = () => createProviderAuthOperator({
      config: { ...config(), providers: { piAuthPath: authPath } } as unknown as MonoAgentConfig,
      env: {}, drivers: [], input: { cwd: dir, configPath: join(dir, "config.json"), env: {} },
      observations: createProviderAuthObservationTracker(),
      login: (async (_provider: string, _type: string, interaction: { prompt(input: unknown): Promise<string> }) => ({
        type: "api_key", key: await interaction.prompt({ type: "secret", message: "API key" }),
      })) as never,
    });
    const first = make();
    const firstSession = await first.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(async () => expect((await first.get(firstSession.id))?.state).toBe("awaiting_input"));

    const contender = make();
    const contenderSession = await contender.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(async () => expect(await contender.get(contenderSession.id)).toMatchObject({
      state: "failed", error: { code: "auth_store_busy" },
    }));
    await first.cancel(firstSession.id);

    const third = make();
    const thirdSession = await third.start({ providerId: "opencode-go", authType: "api_key", strategy: "api_key_prompt" });
    await vi.waitFor(async () => expect((await third.get(thirdSession.id))?.prompt?.id).toBeDefined());
    await third.submit(thirdSession.id, { promptId: (await third.get(thirdSession.id))!.prompt!.id, value: "new-key" });
    await vi.waitFor(async () => expect((await third.get(thirdSession.id))?.state).toBe("succeeded"));
    const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
    expect(stored).toEqual({ openai: { type: "api_key", key: "sibling" }, "opencode-go": { type: "api_key", key: "new-key" } });
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dir)).filter((name) => name.includes("mono-agent"))).toEqual([]);
    await Promise.all([first.stop(), contender.stop(), third.stop()]);
  });
});

function config(model = "opencode-go:kimi-k2.6"): MonoAgentConfig {
  return {
    runtime: { model: parseMonoRuntimeModelReference(model) },
    providers: { piAuthPath: "/tmp/mono-agent-provider-auth-test.json" },
  } as unknown as MonoAgentConfig;
}

function operatorStatus(): ProviderAuthStatusSnapshot {
  return {
    schema: "mono-agent.provider-auth.v1",
    generatedAt: "2026-09-06T12:00:00.000Z",
    providers: [{
      providerId: "opencode-go",
      label: "OpenCode Go",
      usages: [{ kind: "primary", model: "opencode-go:kimi-k2.6", label: "Primary model" }],
      state: "present",
      source: "stored",
      verification: "not_verified",
      methods: [{ authType: "api_key", strategy: "api_key_prompt", label: "OpenCode API key", recommended: true }],
    }],
  };
}
