import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MonoAgentConfig } from "@mono-agent/config";
import { parseMonoRuntimeModelReference } from "@mono-agent/runtime-adapter";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderAuthObservationTracker } from "../provider-auth-observations.js";
import { createProviderAuthOperator } from "../provider-auth-operator.js";

const tempDirs: string[] = [];
afterEach(async () => await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }))));

describe("provider auth operator", () => {
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
