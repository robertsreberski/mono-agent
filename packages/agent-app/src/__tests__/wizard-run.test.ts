import { beforeEach, describe, expect, it, vi } from "vitest";

const { CANCEL, ESCAPE, promptMock } = vi.hoisted(() => ({
  CANCEL: Symbol("clack:cancel:test"),
  ESCAPE: Symbol("clack:escape:test"),
  promptMock: {
    selectAnswers: [] as unknown[],
    autocompleteAnswers: [] as unknown[],
    confirmAnswers: [] as unknown[],
    multiselectAnswers: [] as unknown[],
    textAnswers: [] as unknown[],
    passwordAnswers: [] as unknown[],
    selectCalls: [] as Array<Record<string, unknown>>,
    autocompleteCalls: [] as Array<Record<string, unknown>>,
    confirmCalls: [] as Array<Record<string, unknown>>,
    textCalls: [] as Array<Record<string, unknown>>,
    passwordCalls: [] as Array<Record<string, unknown>>,
    notes: [] as Array<{ message: string; title?: string }>,
  },
}));

const discoveryMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  discover: vi.fn(async (opts: Record<string, unknown> = {}) => {
    discoveryMock.calls.push(opts);
    return {
      candidates: [
        {
          value: "codex:gpt-5.6-terra",
          label: "Codex GPT-5.6 Terra",
          source: "codex" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "credential_detected" as const,
          supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"] as const,
          defaultEffort: "low" as const,
        },
        {
          value: "codex:gpt-5.6-sol",
          label: "Codex GPT-5.6 Sol",
          source: "codex" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "credential_detected" as const,
          supportedEfforts: ["minimal", "low", "medium", "high", "xhigh"] as const,
          defaultEffort: "low" as const,
          providerDefault: true,
        },
        {
          value: "pi:ollama:qwen3:8b",
          label: "Ollama qwen3:8b",
          source: "ollama" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "not_required" as const,
          supportedEfforts: ["none", "low", "medium", "high"] as const,
          defaultEffort: "medium" as const,
        },
        {
          value: "pi:opencode-go:kimi-k2.6",
          label: "OpenCode Go Kimi K2.6",
          source: "pi" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "auth_required" as const,
          supportedEfforts: ["low", "medium", "high"] as const,
          defaultEffort: "medium" as const,
        },
        {
          value: "claude:claude-sonnet-5",
          label: "Claude Sonnet 5",
          source: "claude" as const,
          discovered: true,
          availability: "catalog_available" as const,
          authState: "auth_required" as const,
          supportedEfforts: ["low", "medium", "high", "max"] as const,
          defaultEffort: "high" as const,
        },
      ],
      statuses: [
        { provider: "Codex" as const, status: "detected" as const, detail: "sign-in detected; readiness not yet verified" },
      ],
    };
  }),
}));

function nextAnswer(queue: unknown[], name: string): unknown {
  if (queue.length === 0) throw new Error(`No queued ${name} answer.`);
  return queue.shift();
}

function nextPromptAnswer(queue: unknown[], name: string): unknown {
  const answer = nextAnswer(queue, name);
  if (answer === ESCAPE) {
    process.stdin.emit("keypress", "", { name: "escape" });
    return CANCEL;
  }
  return answer;
}

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown): value is symbol => value === CANCEL,
  intro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn((message: string, title?: string) => {
    promptMock.notes.push({ message, ...(title === undefined ? {} : { title }) });
  }),
  select: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.selectCalls.push(options);
    return nextPromptAnswer(promptMock.selectAnswers, "select");
  }),
  autocomplete: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.autocompleteCalls.push(options);
    return nextPromptAnswer(promptMock.autocompleteAnswers, "autocomplete");
  }),
  confirm: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.confirmCalls.push(options);
    return nextPromptAnswer(promptMock.confirmAnswers, "confirm");
  }),
  multiselect: vi.fn(async () => nextPromptAnswer(promptMock.multiselectAnswers, "multiselect")),
  text: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.textCalls.push(options);
    return nextPromptAnswer(promptMock.textAnswers, "text");
  }),
  password: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.passwordCalls.push(options);
    return nextPromptAnswer(promptMock.passwordAnswers, "password");
  }),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../wizard/model-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/model-discovery.js")>();
  return { ...actual, discoverWizardModelCandidates: discoveryMock.discover };
});

import { defaultAnswers } from "../wizard/answers.js";
import { guidedModelRefProblem, runInitWizard, runModelRepairWizard } from "../wizard/run.js";

beforeEach(() => {
  for (const queue of [
    promptMock.selectAnswers,
    promptMock.autocompleteAnswers,
    promptMock.confirmAnswers,
    promptMock.multiselectAnswers,
    promptMock.textAnswers,
    promptMock.passwordAnswers,
    promptMock.selectCalls,
    promptMock.autocompleteCalls,
    promptMock.confirmCalls,
    promptMock.textCalls,
    promptMock.passwordCalls,
    promptMock.notes,
  ]) queue.length = 0;
  discoveryMock.calls.length = 0;
  discoveryMock.discover.mockClear();
});

async function withTtyStdin<T>(run: () => Promise<T>): Promise<T> {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const rawBefore = (process.stdin as NodeJS.ReadStream).isRaw;
  const keypressListenersBefore = process.stdin.rawListeners("keypress");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    const result = await run();
    expect(process.stdin.rawListeners("keypress")).toEqual(keypressListenersBefore);
    expect((process.stdin as NodeJS.ReadStream).isRaw).toBe(rawBefore);
    return result;
  } finally {
    if (ttyDescriptor === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
  }
}

describe("wizard production flow", () => {
  it("accepts only canonical guided model families and rejects direct OpenCode", () => {
    expect(guidedModelRefProblem("codex:gpt-5.6-sol")).toBeUndefined();
    expect(guidedModelRefProblem("claude:claude-sonnet-5")).toBeUndefined();
    expect(guidedModelRefProblem("pi:ollama:qwen3:8b")).toBeUndefined();
    expect(guidedModelRefProblem("opencode:github-copilot:gpt-5.1")).toMatch(/scaffold\/config-only/u);
    expect(guidedModelRefProblem("foo:bar")).toBeDefined();
    expect(guidedModelRefProblem("claude:")).toBeDefined();
    expect(guidedModelRefProblem("pi:ollama:")).toBeDefined();
  });

  it("uses searchable model pickers, per-route efforts, mixed safety, and a clear creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__", // preset
      "minimal", // primary effort
      "high", // fallback effort
      "", // memory
      "per-route-native", // route safety
      "create", // final action
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "claude:claude-sonnet-5",
      "__done__",
    );
    promptMock.textAnswers.push("Research Companion");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallbacks
      true, // allow all
      true, // accept the one per-route matrix
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/research-companion" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      name: "Research Companion",
      model: "codex:gpt-5.6-terra",
      effort: "minimal",
      fallbacks: [{ model: "claude:claude-sonnet-5", effort: "high" }],
      routeSafety: "per-route-native",
    });
    expect(result.runProviderSetup).toBe(true);
    expect(result.credentialStates).toEqual({
      codex: "credential_detected",
      claude: "auth_required",
    });
    expect(promptMock.autocompleteCalls).toHaveLength(3);
    for (const call of promptMock.autocompleteCalls) {
      expect(call).toMatchObject({ maxItems: 10 });
      expect(call.placeholder).toContain("search");
    }
    expect(promptMock.autocompleteCalls[0]?.initialValue).toBe("codex:gpt-5.6-sol");
    const matrix = promptMock.notes.find((note) => note.title === "Per-route safety contract")?.message ?? "";
    expect(matrix).toContain("Codex-native sandbox + exact allow-all");
    expect(matrix).toContain("Claude: provider-native sandbox");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("Agent:        Research Companion");
    expect(review).toContain("minimal");
    expect(review).toContain("high");
    expect(review).toContain("2 real model call(s)");
    expect(review).toContain("mono-agent.config.json");
    expect(review).toContain("credential/sign-in detected; skip initial auth");
    const finalCall = promptMock.selectCalls.find((call) => String(call.message).startsWith("Create "));
    expect(finalCall?.message).toBe("Create “Research Companion”?");
    expect((finalCall?.options as Array<{ label: string }>).map((option) => option.label)).toEqual([
      "Run setup and readiness checks, then create agent",
      "Edit choices",
      "Cancel without writing",
    ]);
  });

  it("resolves a uniform managed-SRT mismatch before provider setup can begin", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // primary provider-default effort
      "low", // fallback effort
      "", // memory
      "uniform", // requested chain contract
      "disable-managed-srt", // resolve the invalid mixed contract
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "pi:ollama:qwen3:8b",
      "codex:gpt-5.6-terra",
      "__done__",
    );
    promptMock.textAnswers.push("Mixed Safety Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallback
      true, // allow all tools
      true, // initially request managed SRT
      true, // explicitly accept high-risk unsandboxed access
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/mixed-safety-agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      routeSafety: "uniform",
      sandbox: false,
    });
    const safetyNote = promptMock.notes.find((note) => note.title === "Safety choice required")?.message ?? "";
    expect(safetyNote).toContain("cannot promise one uniform managed-SRT contract");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).not.toContain("Managed SRT: install");
    const resolutionIndex = promptMock.selectCalls.findIndex((call) =>
      call.message === "How should this mixed chain resolve the managed-SRT mismatch?"
    );
    const creationIndex = promptMock.selectCalls.findIndex((call) =>
      String(call.message).startsWith("Create ")
    );
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    expect(creationIndex).toBeGreaterThan(resolutionIndex);
  });

  it("shows only advertised efforts and never offers none for Claude", async () => {
    promptMock.selectAnswers.push("__custom__", "max", "", "create");
    promptMock.autocompleteAnswers.push("claude:claude-sonnet-5");
    promptMock.textAnswers.push("Claude Helper");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all
      true, // high-risk provider-native
      false, // Phoenix
    );

    const result = await runInitWizard({ cwd: "/tmp/claude-helper" });

    expect(result.status).toBe("answers");
    const effortCall = promptMock.selectCalls.find((call) => String(call.message).includes("Reasoning effort"));
    expect((effortCall?.options as Array<{ value: string }>).map((option) => option.value))
      .toEqual(["", "low", "medium", "high", "max"]);
    expect((effortCall?.options as Array<{ value: string }>).map((option) => option.value)).not.toContain("none");
  });

  it("uses the humanized folder name as the early name default", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Research Companion");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await runInitWizard({ cwd: "/tmp/research-companion" });

    expect(result.status).toBe("answers");
    expect(promptMock.textCalls[0]).toMatchObject({
      message: "What should this agent be called?",
      initialValue: "Research Companion",
    });
  });

  it("keeps a custom agent name visible when Escape returns from model selection", async () => {
    promptMock.selectAnswers.push("__custom__", "high", "", "create");
    promptMock.autocompleteAnswers.push(ESCAPE, "codex:gpt-5.6-sol");
    promptMock.textAnswers.push("Polished Production Agent", "Polished Production Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/research-companion" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.name).toBe("Polished Production Agent");
    const nameCalls = promptMock.textCalls.filter((call) => call.message === "What should this agent be called?");
    expect(nameCalls).toHaveLength(2);
    expect(nameCalls[1]).toMatchObject({ initialValue: "Polished Production Agent" });
  });

  it("lets Escape interrupt model discovery and return to the prior wizard step", async () => {
    discoveryMock.discover.mockImplementationOnce(async (options: Record<string, unknown> = {}) => {
      discoveryMock.calls.push(options);
      const signal = options.abortSignal as AbortSignal;
      queueMicrotask(() => process.stdin.emit("keypress", "", { name: "escape" }));
      await new Promise<void>((resolveAbort) => signal.addEventListener("abort", () => resolveAbort(), { once: true }));
      return { candidates: [], statuses: [] };
    });
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Discovery Agent", "Discovery Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/discovery-agent" }));

    expect(result.status).toBe("answers");
    expect(discoveryMock.calls).toHaveLength(2);
    expect((discoveryMock.calls[0]?.abortSignal as AbortSignal).aborted).toBe(true);
    const nameCalls = promptMock.textCalls.filter((call) => call.message === "What should this agent be called?");
    expect(nameCalls).toHaveLength(2);
  });

  it("does not review or collect an optional-only channel secret that will not be written", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Loopback API");
    promptMock.multiselectAnswers.push(["channel:openai-api"]);
    promptMock.confirmAnswers.push(false, false);

    const result = await runInitWizard({ cwd: "/tmp/loopback-api" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.moduleSecrets).toEqual({});
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain(".env.example (placeholders only)");
    expect(review).toContain("Secret persistence: none");
    expect(review).not.toContain("MONO_AGENT_OPENAI_API_KEY ->");
    expect(review).not.toContain(".env (owner-only secret merge)");
    expect(review).not.toContain(".gitignore (ensure /.env is ignored)");
  });

  it("treats a non-empty destination OPENCODE_API_KEY as durable credential detection", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Durable OpenCode Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-opencode-agent",
      persistedEnv: { OPENCODE_API_KEY: "durable-agent-key" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ "pi:opencode-go": "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    expect(result.providerSetupSecrets).toEqual({});
    expect(result.providerEnvironmentSecrets).toEqual({});
    expect(result.piApiKeyPersistenceByProvider).toEqual({});
    expect(promptMock.selectCalls.some((call) => String(call.message).includes("store OPENCODE_API_KEY?")))
      .toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("pi:opencode-go:kimi-k2.6: credential/sign-in detected");
    expect(review).not.toContain("durable-agent-key");
  });

  it("treats a destination Claude credential as detected without exposing it in review", async () => {
    promptMock.selectAnswers.push("__custom__", "high", "", "create");
    promptMock.autocompleteAnswers.push("claude:claude-sonnet-5");
    promptMock.textAnswers.push("Durable Claude Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // accept provider-native high-risk access
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-claude-agent",
      persistedEnv: { ANTHROPIC_AUTH_TOKEN: "durable-claude-token" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ claude: "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("claude:claude-sonnet-5: credential/sign-in detected");
    expect(review).not.toContain("durable-claude-token");
  });

  it("treats a destination OPENAI_API_KEY as a direct Codex credential", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "create");
    promptMock.autocompleteAnswers.push("__other__");
    promptMock.textAnswers.push("Durable Codex Agent", "codex:gpt-private");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      false, // Phoenix
    );

    const result = await runInitWizard({
      cwd: "/tmp/durable-codex-agent",
      persistedEnv: { OPENAI_API_KEY: "durable-openai-key" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ codex: "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("codex:gpt-private: credential/sign-in detected");
    expect(review).not.toContain("durable-openai-key");
    const createCall = promptMock.selectCalls.find((call) => String(call.message).startsWith("Create "));
    expect((createCall?.options as Array<{ label: string }>)[0]?.label)
      .toBe("Run readiness checks, then create agent");
  });

  it("reviews an environment-selected Pi key as an owner-only .env write before creation", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // no memory
      "environment", // Pi API-key persistence
      "create",
    );
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Environment Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );
    promptMock.passwordAnswers.push("review-secret-value");

    const previousAmbient = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "shell-only-key";
    try {
      const result = await runInitWizard({ cwd: "/tmp/environment-agent", persistedEnv: {} });

      expect(result.status).toBe("answers");
      if (result.status !== "answers") return;
      expect(result.credentialStates).toEqual({ "pi:opencode-go": "auth_required" });
      expect(result.providerEnvironmentSecrets).toEqual({ OPENCODE_API_KEY: "review-secret-value" });
      expect(result.providerSetupSecrets).toEqual({});
      expect(result.piApiKeyPersistenceByProvider).toEqual({ "opencode-go": "environment" });
      const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
      expect(review).toContain("OPENCODE_API_KEY -> owner-only .env merge");
      expect(review).toContain("(environment): read OPENCODE_API_KEY");
      expect(review).not.toContain("(secure store): read OPENCODE_API_KEY");
      expect(review).toContain("May create or update: .env (owner-only secret merge), .gitignore");
      const createsLine = review.split("\n").find((line) => line.startsWith("Creates if missing")) ?? "";
      expect(createsLine).not.toContain(".env (owner-only secret merge)");
      expect(createsLine).not.toContain(".gitignore");
      expect(review).toContain("do not write Pi auth.json");
      expect(review).not.toContain("review-secret-value");
      expect(review).not.toContain("shell-only-key");
    } finally {
      if (previousAmbient === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = previousAmbient;
    }
  });

  it("reviews a secure-store Pi key as auth.json-only before creation", async () => {
    promptMock.selectAnswers.push("__custom__", "", "", "secure-store", "create");
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Secure Store Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, true, true, false);
    promptMock.passwordAnswers.push("auth-store-secret-value");

    const result = await runInitWizard({ cwd: "/tmp/secure-store-agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.providerEnvironmentSecrets).toEqual({});
    expect(result.providerSetupSecrets).toHaveProperty("pi-api-key:opencode-go", "auth-store-secret-value");
    const review = promptMock.notes.find((note) => note.title === "Creation review")?.message ?? "";
    expect(review).toContain("(secure store): save credential");
    expect(review).toContain("save credential to owner-only");
    expect(review).toContain("Pi auth.json");
    expect(review).toContain("not copied to .env");
    expect(review).not.toContain(".env (owner-only secret merge)");
    expect(review).not.toContain("auth-store-secret-value");
  });

  it("uses an actual Escape keypress at primary effort to return to the model picker", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      ESCAPE, // first primary effort prompt
      "high", // replacement primary effort
      "", // memory
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-sol",
    );
    promptMock.textAnswers.push("Effort Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks after replacing the primary model
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/effort-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      name: "Effort Back Agent",
      model: "codex:gpt-5.6-sol",
      effort: "high",
      fallbacks: [],
    });
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => String(call.message).startsWith("Reasoning effort for ")))
      .toHaveLength(2);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses actual Escape keypresses to retry fallback effort and remove the latest fallback", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "minimal", // primary effort
      ESCAPE, // first Claude fallback effort
      "high", // retried Claude fallback effort
      "xhigh", // replacement Codex fallback effort
      "", // memory
      "create",
    );
    promptMock.autocompleteAnswers.push(
      "codex:gpt-5.6-terra",
      "claude:claude-sonnet-5",
      "claude:claude-sonnet-5", // effort Escape reopens fallback model #1
      ESCAPE, // fallback model #2 removes the latest fallback
      "codex:gpt-5.6-sol",
      "__done__",
    );
    promptMock.textAnswers.push("Fallback Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      true, // add fallbacks
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/fallback-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      model: "codex:gpt-5.6-terra",
      effort: "minimal",
      fallbacks: [{ model: "codex:gpt-5.6-sol", effort: "xhigh" }],
    });
    expect(promptMock.selectCalls.filter((call) => call.message === "Reasoning effort for claude:claude-sonnet-5"))
      .toHaveLength(2);
    expect(promptMock.autocompleteCalls
      .filter((call) => String(call.message).startsWith("Fallback model #"))
      .map((call) => call.message))
      .toEqual([
        "Fallback model #1",
        "Fallback model #1",
        "Fallback model #2",
        "Fallback model #1",
        "Fallback model #2",
      ]);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses an actual Escape keypress in the edit submenu to return directly to creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // memory
      "edit",
      ESCAPE, // edit submenu
      "create",
    );
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-terra");
    promptMock.textAnswers.push("Review Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks
      false, // Phoenix
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/review-back-agent" }));

    expect(result.status).toBe("answers");
    expect(promptMock.notes.filter((note) => note.title === "Creation review")).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => call.message === "What would you like to edit?"))
      .toHaveLength(1);
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(1);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("uses an actual Escape keypress in a provider secret prompt to return to creation review", async () => {
    promptMock.selectAnswers.push(
      "__custom__",
      "", // provider-default effort
      "", // memory
      "environment", // first review's Pi key destination
      "create",
      "environment", // repeated review's Pi key destination
      "create",
    );
    promptMock.autocompleteAnswers.push("pi:opencode-go:kimi-k2.6");
    promptMock.textAnswers.push("Secret Back Agent");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallbacks
      true, // allow all tools
      true, // managed SRT
      false, // Phoenix
    );
    promptMock.passwordAnswers.push(
      ESCAPE,
      "replacement-secret",
    );

    const result = await withTtyStdin(() => runInitWizard({ cwd: "/tmp/secret-back-agent" }));

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.providerEnvironmentSecrets).toEqual({ OPENCODE_API_KEY: "replacement-secret" });
    expect(promptMock.notes.filter((note) => note.title === "Creation review")).toHaveLength(2);
    expect(promptMock.passwordCalls).toHaveLength(2);
    expect(promptMock.selectCalls.filter((call) => String(call.message).includes("store OPENCODE_API_KEY?")))
      .toHaveLength(2);
    expect(promptMock.textCalls.filter((call) => call.message === "What should this agent be called?")).toHaveLength(1);
    expect(promptMock.autocompleteCalls.filter((call) => call.message === "Which model?")).toHaveLength(1);
    expect(promptMock.confirmCalls.some((call) => call.message === "Exit setup?")).toBe(false);
  });

  it("exits cleanly when setup is cancelled again during the default-No exit confirmation", async () => {
    promptMock.selectAnswers.push(CANCEL);
    promptMock.confirmAnswers.push(CANCEL);

    await expect(runInitWizard({ cwd: "/tmp/agent" })).resolves.toEqual({ status: "cancelled" });
  });

  it("repairs only model settings and preserves unrelated answers", async () => {
    const current = defaultAnswers({
      name: "Operations Partner",
      model: "codex:gpt-5.6-terra",
      channels: ["channel:telegram", "channel:cron"],
      memory: "memory:bujo",
      observability: true,
      moduleInputs: { "channel:cron": { cronExpression: "30 7 * * 1-5" } },
    });
    promptMock.autocompleteAnswers.push("codex:gpt-5.6-sol");
    promptMock.selectAnswers.push("", "create");
    promptMock.confirmAnswers.push(
      false, // no fallback
      false, // do not run provider setup in repair
      true, // use repaired configuration
    );

    const result = await runModelRepairWizard({ cwd: "/tmp/agent", answers: current });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.name).toBe("Operations Partner");
    expect(result.answers.model).toBe("codex:gpt-5.6-sol");
    expect(result.answers.channels).toEqual(current.channels);
    expect(result.answers.memory).toBe(current.memory);
    expect(result.answers.moduleInputs).toEqual(current.moduleInputs);
  });

  it("preserves durable provider credential detection during model repair", async () => {
    const current = defaultAnswers({ model: "claude:claude-sonnet-5", effort: "high" });
    promptMock.autocompleteAnswers.push("claude:claude-sonnet-5");
    promptMock.selectAnswers.push("high");
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // use repaired configuration
    );

    const result = await runModelRepairWizard({
      cwd: "/tmp/agent",
      answers: current,
      persistedEnv: { CLAUDE_CODE_OAUTH_TOKEN: "durable-repair-token" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.credentialStates).toEqual({ claude: "credential_detected" });
    expect(result.runProviderSetup).toBe(false);
    expect(promptMock.notes.some((note) => note.message.includes("durable-repair-token"))).toBe(false);
  });

  it("repairs a pre-existing uniform managed-SRT mixed chain even when its families stay unchanged", async () => {
    const current = defaultAnswers({
      model: "pi:ollama:qwen3:8b",
      fallbacks: [{ model: "codex:gpt-5.6-terra", effort: "low" }],
      routeSafety: "uniform",
      sandbox: true,
      allowedTools: ["*"],
    });
    promptMock.autocompleteAnswers.push(
      "pi:ollama:qwen3:8b",
      "codex:gpt-5.6-terra",
      "__done__",
    );
    promptMock.selectAnswers.push(
      "", // primary provider-default effort
      "low", // fallback effort
      "uniform",
      "disable-managed-srt",
    );
    promptMock.confirmAnswers.push(
      true, // keep a fallback
      true, // keep allow-all tools while re-confirming safety
      true, // managed SRT before mismatch resolution
      true, // explicit high-risk unsandboxed acceptance
      false, // skip provider setup
      true, // use repaired configuration
    );

    const result = await runModelRepairWizard({ cwd: "/tmp/agent", answers: current });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({ routeSafety: "uniform", sandbox: false });
    expect(promptMock.notes.some((note) => note.title === "Safety choice required")).toBe(true);
  });

  it("treats Escape in model repair as Back without opening exit confirmation", async () => {
    promptMock.autocompleteAnswers.push(ESCAPE);
    await withTtyStdin(async () => {
      await expect(runModelRepairWizard({
        cwd: "/tmp/agent",
        answers: defaultAnswers({ model: "codex:gpt-5.6-terra" }),
      })).resolves.toEqual({ status: "cancelled" });
      expect(promptMock.confirmCalls).toEqual([]);
    });
  });
});
