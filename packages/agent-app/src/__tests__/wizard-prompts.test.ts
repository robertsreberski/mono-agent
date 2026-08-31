import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// `@clack/core`'s cancel sentinel is a private, unexported symbol, so we stub
// `isCancel` to recognise our own sentinel — enough to exercise both `guard`
// branches deterministically without a TTY. The pure option builders below never
// touch clack, so the mock leaves them untouched.
const { CANCEL } = vi.hoisted(() => ({ CANCEL: Symbol("clack:cancel:test") }));
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();
  return { ...actual, isCancel: (value: unknown): value is symbol => value === CANCEL };
});

import { APP_TOOL_NAMES, BUILTIN_TOOL_NAMES } from "../modules/known-tools.js";
import {
  assertConcreteWizardModelRef,
  channelSelectOptions,
  creationReviewOptions,
  CUSTOM_PI_MODEL_OPTION,
  effortSelectOptions,
  fallbackModelSelectOptions,
  guard,
  memorySelectOptions,
  modelSelectOptions,
  piModelSelectOptions,
  previousWizardStep,
  presetSelectOptions,
  toolMultiselectOptions,
  validateWizardAgentName,
  validateWizardAgentPurpose,
  wizardCancelIntentForKey,
  WizardCancelled,
} from "../wizard/prompts.js";
import {
  defaultEffortForModelRef,
  discoverWizardModelCandidates,
  rankWizardModelCandidates,
  type WizardModelCandidate,
} from "../wizard/model-discovery.js";
import { executeProviderSetupPlan, planProviderSetup, providerSetupActionCommandLine, resolvePiCliPath } from "../provider-setup.js";

function modelCandidate(
  candidate: Pick<WizardModelCandidate, "value" | "label" | "source">
    & Partial<Omit<WizardModelCandidate, "value" | "label" | "source">>,
): WizardModelCandidate {
  return {
    availability: "catalog_available",
    authState: candidate.source === "ollama" || candidate.source === "lmstudio" ? "not_required" : "auth_required",
    supportedEfforts: [],
    ...candidate,
  };
}

describe("wizard prompt builders", () => {
  it("channelSelectOptions lists all six channels, webhook first", () => {
    const options = channelSelectOptions();
    expect(options).toHaveLength(6);
    expect(options[0]?.value).toBe("channel:webhook");
    expect(options.map((option) => option.value)).toEqual([
      "channel:webhook",
      "channel:telegram",
      "channel:slack",
      "channel:openai-api",
      "channel:cron",
      "channel:a2a",
    ]);
    for (const option of options) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("hides optional plugin channels from the live first-run picker", () => {
    expect(channelSelectOptions({ readyOnly: true }).map((option) => option.value)).not.toContain("channel:a2a");
  });

  it("memorySelectOptions leads with an empty-value 'None' option", () => {
    const options = memorySelectOptions();
    expect(options[0]?.value).toBe("");
    expect(options[0]?.label).toContain("None");
    // The rest are real memory module ids.
    for (const option of options.slice(1)) {
      expect(option.value.startsWith("memory:")).toBe(true);
    }
    expect(options.map((option) => option.value)).toEqual([
      "",
      "memory:lite",
      "memory:journal",
      "memory:bujo",
    ]);
  });

  it("offers the Supermemory plugin only when setup confirms it is available", () => {
    expect(memorySelectOptions().map((option) => option.value)).not.toContain("memory:supermemory");
    expect(memorySelectOptions({ includeOptionalPlugins: true }).map((option) => option.value))
      .toContain("memory:supermemory");
  });

  it("modelSelectOptions offers the curated set plus Pi and generic escape hatches", () => {
    const options = modelSelectOptions();
    const values = options.map((option) => option.value);
    expect(values.slice(0, 2)).toEqual([
      "openai-codex:gpt-5.6-terra",
      "openai-codex:gpt-5.6-sol",
    ]);
    expect(values).toContain("__pi_other__");
    expect(values).toContain("__other__");
    expect(values[values.length - 2]).toBe("__pi_other__");
    expect(values[values.length - 1]).toBe("__other__");
    expect(options.find((option) => option.value === "openai-codex:gpt-5.6-terra")?.hint)
      .toBe("OAuth setup available");
    expect(options.find((option) => option.value === "openai-codex:gpt-5.6-sol")?.hint)
      .toBe("OAuth setup available");
  });

  it("modelSelectOptions keeps Terra first and deduplicates discovered Pi copies", () => {
    const ranked = rankWizardModelCandidates([
      { value: "openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", source: "pi" },
      {
        value: "openai-codex:gpt-5.6-terra",
        label: "Pi OpenAI-Codex GPT-5.6 Terra",
        source: "pi",
        discovered: true,
      },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0])));

    const options = modelSelectOptions(ranked);
    const values = options.map((option) => option.value);
    expect(values.slice(0, 4)).toEqual([
      "openai-codex:gpt-5.6-terra",
      "openai-codex:gpt-5.6-sol",
      "__pi_other__",
      "__other__",
    ]);
  });

  it("fallbackModelSelectOptions reuses model labels while excluding the primary and prior fallbacks", () => {
    const candidates: WizardModelCandidate[] = [
      { value: "anthropic:claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "default", source: "pi" },
      { value: "openai-codex:gpt-5.6-terra", label: "Pi Codex GPT-5.6 Terra", source: "pi" },
      { value: "opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "Pi catalog", source: "pi" },
      { value: "ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama" },
      { value: "lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally", source: "lmstudio" },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0]));

    const options = fallbackModelSelectOptions(
      candidates,
      "anthropic:claude-sonnet-4-6",
      ["openai-codex:gpt-5.6-terra", "opencode-go:kimi-k2.6"],
    );

    expect(options).toEqual([
      { value: "ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local" },
      { value: "lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally" },
      { value: "__pi_other__", label: "Other Pi model…", hint: "choose provider and model id" },
      { value: "__other__", label: "Other model ref…", hint: "type a full provider:model reference" },
      { value: "__done__", label: "Done", hint: "finish fallback chain" },
    ]);
  });

  it("piModelSelectOptions offers discovered Pi candidates before the manual escape hatch", () => {
    const candidates: WizardModelCandidate[] = [
      { value: "openai-codex:gpt-5.6-terra", label: "Pi OpenAI-Codex GPT-5.6 Terra", hint: "auth setup available", source: "pi" },
      { value: "openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", hint: "auth setup available", source: "pi" },
      { value: "opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "Pi catalog", source: "pi" },
      { value: "ollama:llama3.1:8b", label: "Ollama llama3.1:8b", hint: "fully local", source: "ollama" },
      { value: "lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally", source: "lmstudio" },
    ].map((candidate) => modelCandidate(candidate as Parameters<typeof modelCandidate>[0]));

    const options = piModelSelectOptions(candidates, ["ollama:llama3.1:8b"]);

    expect(options).toEqual([
      { value: "openai-codex:gpt-5.6-terra", label: "Pi OpenAI-Codex GPT-5.6 Terra", hint: "auth setup available" },
      { value: "openai-codex:gpt-5.6-sol", label: "Pi OpenAI-Codex GPT-5.6 Sol", hint: "auth setup available" },
      { value: "opencode-go:kimi-k2.6", label: "OpenCode kimi-k2.6", hint: "Pi catalog" },
      { value: "lmstudio:qwen/qwen3-8b", label: "LM Studio qwen/qwen3-8b", hint: "discovered locally" },
      {
        value: CUSTOM_PI_MODEL_OPTION,
        label: "Supported Pi provider/model id…",
        hint: "Anthropic, GitHub Copilot, OpenAI Codex, OpenCode-Go, Ollama, or LM Studio",
      },
    ]);
  });

  it("assertConcreteWizardModelRef rejects wizard sentinel values", () => {
    for (const sentinel of ["__pi_other__", "__other__", "__done__", CUSTOM_PI_MODEL_OPTION]) {
      expect(() => assertConcreteWizardModelRef(sentinel)).toThrow("Wizard model sentinel");
    }
    expect(() => assertConcreteWizardModelRef("ollama:llama3.1:8b")).not.toThrow();
  });

  it("preserves an authored unknown model with provider-default effort guidance", () => {
    expect(modelSelectOptions([], "private-provider:future-model")[0]).toEqual({
      value: "private-provider:future-model",
      label: "private-provider:future-model",
      hint: "current authored model; provider-default effort",
    });
  });

  it("effortSelectOptions offers only provider-advertised exact values", () => {
    expect(effortSelectOptions(["minimal", "low", "max", "ultra"], "low").map((option) => option.value))
      .toEqual(["", "minimal", "low", "max", "ultra"]);
  });

  it("represents provider default as an omitted route effort", () => {
    expect(effortSelectOptions(["low", "medium"], "medium")[0]).toEqual({
      value: "",
      label: "Provider default",
      hint: "currently medium; omit effort for this route",
    });
  });

  it("validates names, cancel intent, and back transitions deterministically", () => {
    expect(validateWizardAgentName(" Research Companion ")).toBeUndefined();
    expect(validateWizardAgentName("line one\nline two")).toContain("single-line");
    expect(validateWizardAgentName("x".repeat(81))).toContain("80");
    expect(validateWizardAgentPurpose("Coordinate project research.")).toBeUndefined();
    expect(validateWizardAgentPurpose("line one\nline two")).toContain("one line");
    expect(validateWizardAgentPurpose("x".repeat(241))).toContain("240");
    expect(wizardCancelIntentForKey({ name: "escape" })).toBe("back");
    expect(wizardCancelIntentForKey({ name: "c", ctrl: true })).toBe("exit");
    expect(previousWizardStep(0)).toBeUndefined();
    expect(previousWizardStep(4)).toBe(3);
  });

  it("renders unambiguous creation actions", () => {
    expect(creationReviewOptions({ setupRequired: true }).map((option) => option.label)).toEqual([
      "Run setup and readiness checks, then create agent",
      "Edit choices",
      "Cancel without writing",
    ]);
    expect(creationReviewOptions({ setupRequired: false })[0]?.label)
      .toBe("Run readiness checks, then create agent");
  });

  it("toolMultiselectOptions appends app and channel tools then AskUser after the built-ins", () => {
    const options = toolMultiselectOptions(["channel:telegram"]);
    const values = options.map((option) => option.value);
    expect(values.slice(0, BUILTIN_TOOL_NAMES.length)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(values.slice(BUILTIN_TOOL_NAMES.length)).toEqual([
      "RunHistory",
      "SessionHistory",
      "SetConversationTitle",
      "Remember",
      "TelegramSendMessage",
      "AskUser",
    ]);
    const ask = options.find((option) => option.value === "AskUser");
    expect(ask?.hint).toContain("web, Slack, or Telegram");
    const send = options.find((option) => option.value === "TelegramSendMessage");
    expect(send?.hint).toBe("proactive send (Telegram)");
    expect(options.find((option) => option.value === "RunHistory")?.hint).toContain("prior runs");
    expect(options.find((option) => option.value === "SessionHistory")?.hint).toContain("tool calls");
    expect(options.find((option) => option.value === "SetConversationTitle")?.hint).toContain("web conversations");
    expect(options.find((option) => option.value === "Remember")?.hint).toContain("durably save");
  });

  it("toolMultiselectOptions offers the built-ins plus channel-agnostic AskUser with no channel", () => {
    const options = toolMultiselectOptions([]);
    expect(options.map((option) => option.value)).toEqual([...BUILTIN_TOOL_NAMES, ...APP_TOOL_NAMES, "AskUser"]);
    const ask = options.find((option) => option.value === "AskUser");
    expect(ask?.hint).toContain("web, Slack, or Telegram");
  });

  it("presetSelectOptions ends with the __custom__ escape hatch", () => {
    const options = presetSelectOptions();
    expect(options.length).toBeGreaterThan(1);
    expect(options[options.length - 1]?.value).toBe("__custom__");
  });
});

describe("provider setup planner", () => {
  it("plans auth and preflight for selected primary and fallback providers", () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      piAuthPath: ".pi/auth.json",
      modelRefs: [
        "anthropic:claude-sonnet-4-6",
        "openai-codex:gpt-5.6-terra",
        "openai-codex:gpt-5.6-terra",
        "openai:gpt-5.5",
        "opencode-go:kimi-k2.6",
        "ollama:gemma4:31b",
        "lmstudio:qwen/qwen3-8b",
      ],
    });

    expect(plan.actions.map((action) => action.id)).toEqual([
      "pi-login:anthropic",
      "pi-login:openai-codex",
      "pi-api-key:opencode-go",
      "ollama-list",
      "lmstudio-models",
    ]);
    const piLogin = plan.actions.find((action) => action.id === "pi-login:openai-codex");
    expect(piLogin).toMatchObject({ cwd: "/agent/.pi" });
    expect("command" in piLogin! ? piLogin.command : []).toEqual([
      process.execPath,
      expect.stringMatching(/pi-oauth-login-main\.js$/u),
      "openai-codex",
    ]);
    expect(providerSetupActionCommandLine(piLogin!)).toBe("mono-agent auth login openai-codex --pi-auth-path /agent/.pi/auth.json");
    expect(plan.actions.find((action) => action.id === "ollama-list")).toMatchObject({
      command: ["ollama", "list"],
      cwd: "/agent",
    });
    expect(plan.actions.find((action) => action.id === "lmstudio-models")).toMatchObject({
      url: "http://localhost:1234/v1/models",
      cwd: "/agent",
    });
    expect(plan.actions.find((action) => action.id === "pi-api-key:opencode-go")).toMatchObject({
      provider: "opencode-go",
      envVar: "OPENCODE_API_KEY",
      piAuthPath: "/agent/.pi/auth.json",
    });
  });

  it("stages Pi login, preserves existing providers, and atomically writes a custom auth filename", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authDir = join(tmp, "nested", ".pi");
      const authPath = join(authDir, "credentials.json");
      await mkdir(authDir, { recursive: true });
      await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "existing" } }));
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        modelRefs: ["openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn((_file: string, _args: readonly string[], opts: { cwd?: string }) => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        void (async () => {
          const stagedAuthPath = join(opts.cwd!, "auth.json");
          const auth = JSON.parse(await readFile(stagedAuthPath, "utf8"));
          await writeFile(stagedAuthPath, JSON.stringify({ ...auth, "openai-codex": { type: "oauth", refresh: "new" } }));
          listeners.get("close")?.(0, null);
        })();
        return {
          once: (event: string, listener: (value: unknown, signal?: unknown) => void) => {
            listeners.set(event, listener);
          },
        };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(fakeSpawn).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringMatching(/pi-oauth-login-main\.js$/u), "openai-codex"],
        expect.objectContaining({ cwd: expect.stringMatching(/\.mono-agent-pi-auth-/u) }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        anthropic: { type: "oauth", refresh: "existing" },
        "openai-codex": { type: "oauth", refresh: "new" },
      });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
      expect(await readdir(authDir)).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs the app-owned Pi OAuth wrapper from a packed layout and stages a custom auth path", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const bundledLoginCliPath = join(tmp, "global", "lib", "node_modules", "@mono-agent", "agent-app", "dist", "pi-oauth-login-main.js");
      await mkdir(dirname(bundledLoginCliPath), { recursive: true });
      await writeFile(bundledLoginCliPath, "// app-owned Pi OAuth wrapper fixture\n", "utf8");
      const authPath = join(tmp, "nested", ".pi", "credentials.json");
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        piCliPath: bundledLoginCliPath,
        modelRefs: ["openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn((_file: string, _args: readonly string[], opts: { cwd?: string }) => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        void (async () => {
          await writeFile(join(opts.cwd!, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", refresh: "new" } }));
          listeners.get("close")?.(0, null);
        })();
        return { once: (event: string, listener: (value: unknown, signal?: unknown) => void) => listeners.set(event, listener) };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(fakeSpawn).toHaveBeenCalledWith(
        process.execPath,
        [bundledLoginCliPath, "openai-codex"],
        expect.objectContaining({ cwd: expect.stringMatching(/\.mono-agent-pi-auth-/u) }),
      );
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ "openai-codex": { type: "oauth", refresh: "new" } });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
      expect(resolvePiCliPath()).toMatch(/(?:src|dist)\/pi-oauth-login-main\.js$/u);
      expect(await readdir(dirname(authPath))).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("cleans Pi auth staging after a failed login without touching the configured store", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authDir = join(tmp, "nested", ".pi");
      const authPath = join(authDir, "credentials.json");
      await mkdir(authDir, { recursive: true });
      await writeFile(authPath, JSON.stringify({ anthropic: { type: "oauth", refresh: "existing" } }));
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/credentials.json",
        modelRefs: ["openai-codex:gpt-5.6-terra"],
      });
      const fakeSpawn = vi.fn(() => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        queueMicrotask(() => listeners.get("close")?.(1, null));
        return { once: (event: string, listener: (value: unknown, signal?: unknown) => void) => listeners.set(event, listener) };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect(results[0]?.status).toBe("failed");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({ anthropic: { type: "oauth", refresh: "existing" } });
      expect(await readdir(authDir)).toEqual(["credentials.json"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("stores OpenCode-Go API keys in the Pi auth store", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authPath = join(tmp, "nested", ".pi", "auth.json");
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/auth.json",
        modelRefs: ["opencode-go:kimi-k2.6"],
      });

      const results = await executeProviderSetupPlan(plan, { apiKeys: { "pi-api-key:opencode-go": "sk-opencode" } });

      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("ok");
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        "opencode-go": { type: "api_key", key: "sk-opencode" },
      });
      expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("skips OpenCode-Go API-key setup when no key is provided", async () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      modelRefs: ["opencode-go:kimi-k2.6"],
    });

    const results = await executeProviderSetupPlan(plan, { apiKeys: {} });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("skipped");
    expect(results[0]?.detail).toContain("OPENCODE_API_KEY");
  });


});

describe("wizard model discovery", () => {
  it("derives only local/reasoning defaults and never fabricates cloud effort metadata", () => {
    expect(defaultEffortForModelRef("anthropic:claude-sonnet-5")).toBeUndefined();
    expect(defaultEffortForModelRef("openai-codex:gpt-5.6-terra")).toBeUndefined();
    expect(defaultEffortForModelRef("openai-codex:gpt-5.6-sol")).toBeUndefined();
    expect(defaultEffortForModelRef("openai-codex:gpt-5.6-terra")).toBeUndefined();
    expect(defaultEffortForModelRef("openai-codex:gpt-5.6-sol")).toBeUndefined();
    expect(defaultEffortForModelRef("ollama:llama3.1:8b")).toBe("none");
    expect(defaultEffortForModelRef("lmstudio:qwen/qwen3-8b")).toBe("medium");
    expect(defaultEffortForModelRef("opencode-go:some-model", true)).toBe("medium");
    expect(defaultEffortForModelRef("opencode-go:some-model", false)).toBe("none");
    expect(defaultEffortForModelRef("openai:gpt-5.5")).toBeUndefined();
  });

  it("discovers Pi, Ollama, and LM Studio candidates without dropping static Pi options", async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === "ollama") {
        return { stdout: "NAME ID SIZE MODIFIED\nllama3.1:8b abc 4GB today\n" };
      }
      throw new Error(file);
    });
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }] }), { status: 200 }));

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: fetchImpl,
      inspectPiAuthStore: async () => ({
        status: "ok",
        auth: { "openai-codex": { type: "oauth", access: "fixture-access" } },
      }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("openai-codex:gpt-5.6-terra");
    expect(values).toContain("openai-codex:gpt-5.6-sol");
    expect(values).toContain("opencode-go:kimi-k2.6");
    expect(values).toContain("ollama:llama3.1:8b");
    expect(values).toContain("lmstudio:qwen/qwen3-8b");
    expect(result.statuses).toMatchObject([
      { provider: "Pi", status: "detected" },
      { provider: "Ollama", status: "detected" },
      { provider: "LM Studio", status: "detected" },
    ]);
  });

  it("reads Pi auth providers from the top-level auth store shape", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: async () => ({
        status: "ok",
        auth: { "openai-codex": { type: "oauth", access: "fixture-access" } },
      }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("openai-codex:gpt-5.6-terra");
    expect(values).toContain("openai-codex:gpt-5.6-sol");
    expect(values.indexOf("openai-codex:gpt-5.6-terra"))
      .toBeLessThan(values.indexOf("openai-codex:gpt-5.3-codex-spark"));
    expect(result.statuses[0]).toMatchObject({ provider: "Pi", status: "detected" });
  });

  it("uses the supplied Pi auth path and treats malformed stores as unavailable", async () => {
    const inspect = vi.fn(async () => ({ status: "unsafe" as const, reason: "malformed-json" as const }));
    const result = await discoverWizardModelCandidates({
      piAuthPath: "/agent/custom/pi-auth.json",
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      inspectPiAuthStore: inspect,
    });

    expect(inspect).toHaveBeenCalledWith("/agent/custom/pi-auth.json");
    expect(result.statuses[0]).toMatchObject({ provider: "Pi", status: "unavailable" });
  });

  it("treats absent provider tools and servers as unavailable status, not thrown errors", async () => {
    const exec = vi.fn(async () => {
      throw new Error("missing");
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: fetchImpl,
      inspectPiAuthStore: async () => ({ status: "missing" }),
    });

    const pi = result.candidates.find((candidate: WizardModelCandidate) => candidate.value === "openai-codex:gpt-5.6-terra");
    const piSol = result.candidates.find((candidate: WizardModelCandidate) => candidate.value === "openai-codex:gpt-5.6-sol");
    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("openai-codex:gpt-5.6-terra");
    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("openai-codex:gpt-5.6-sol");
    expect(pi).toMatchObject({ setupRequired: true });
    expect(pi?.defaultEffort).toBeUndefined();
    expect(piSol).toMatchObject({ setupRequired: true });
    expect(piSol?.defaultEffort).toBeUndefined();
    expect(piSol?.hint).toBe("OAuth setup available");
    expect(result.statuses.map((status) => status.status)).toEqual([
      "setup_available",
      "unavailable",
      "unavailable",
    ]);
  });
});

describe("guard", () => {
  it("returns the value for a non-cancel result", () => {
    expect(guard("anthropic:claude-sonnet-4-6")).toBe("anthropic:claude-sonnet-4-6");
    expect(guard(["Read", "Glob", "Grep"])).toEqual(["Read", "Glob", "Grep"]);
    expect(guard(true)).toBe(true);
    expect(guard([])).toEqual([]);
  });

  it("throws WizardCancelled for the clack cancel symbol", () => {
    expect(() => guard(CANCEL)).toThrow(WizardCancelled);
  });
});
