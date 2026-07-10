import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMock = vi.hoisted(() => ({
  selectAnswers: [] as unknown[],
  confirmAnswers: [] as unknown[],
  multiselectAnswers: [] as unknown[],
  textAnswers: [] as unknown[],
  passwordAnswers: [] as unknown[],
  selectCalls: [] as Array<Record<string, unknown>>,
  confirmCalls: [] as Array<Record<string, unknown>>,
  notes: [] as Array<{ message: string; title?: string }>,
  password: vi.fn(),
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
          defaultEffort: "medium" as const,
        },
        {
          value: "pi:ollama:qwen3:8b",
          label: "Ollama qwen3:8b",
          source: "ollama" as const,
          discovered: true,
          defaultEffort: "medium" as const,
        },
        {
          value: "claude:claude-sonnet-4-6",
          label: "Claude Sonnet 4.6",
          source: "claude" as const,
          discovered: true,
          defaultEffort: "medium" as const,
        },
      ],
      statuses: [{ provider: "Codex" as const, status: "detected" as const, detail: "signed in" }],
    };
  }),
}));

function nextAnswer(queue: unknown[], name: string): unknown {
  if (queue.length === 0) {
    throw new Error(`No queued ${name} answer.`);
  }
  return queue.shift();
}

vi.mock("@clack/prompts", () => ({
  isCancel: () => false,
  intro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn((message: string, title?: string) => {
    promptMock.notes.push({ message, ...(title === undefined ? {} : { title }) });
  }),
  select: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.selectCalls.push(options);
    return nextAnswer(promptMock.selectAnswers, "select");
  }),
  confirm: vi.fn(async (options: Record<string, unknown>) => {
    promptMock.confirmCalls.push(options);
    return nextAnswer(promptMock.confirmAnswers, "confirm");
  }),
  multiselect: vi.fn(async () => nextAnswer(promptMock.multiselectAnswers, "multiselect")),
  text: vi.fn(async () => nextAnswer(promptMock.textAnswers, "text")),
  password: promptMock.password,
  log: {
    step: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../wizard/model-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wizard/model-discovery.js")>();
  return { ...actual, discoverWizardModelCandidates: discoveryMock.discover };
});

import { defaultAnswers } from "../wizard/answers.js";
import { runInitWizard, runModelRepairWizard } from "../wizard/run.js";

beforeEach(() => {
  promptMock.selectAnswers.length = 0;
  promptMock.confirmAnswers.length = 0;
  promptMock.multiselectAnswers.length = 0;
  promptMock.textAnswers.length = 0;
  promptMock.passwordAnswers.length = 0;
  promptMock.selectCalls.length = 0;
  promptMock.confirmCalls.length = 0;
  promptMock.notes.length = 0;
  promptMock.password.mockReset();
  promptMock.password.mockImplementation(async () => nextAnswer(promptMock.passwordAnswers, "password"));
  discoveryMock.calls.length = 0;
  discoveryMock.discover.mockClear();
});

describe("wizard run state", () => {
  it("re-confirms tool and sandbox safety when repair changes direct Codex to Pi", async () => {
    const current = defaultAnswers({
      model: "codex:gpt-5.6-terra",
      fallbackModels: ["codex:gpt-5.5"],
      effort: "high",
      channels: ["channel:telegram", "channel:cron"],
      memory: "memory:bujo",
      sandbox: true,
      observability: true,
      allowedTools: ["Read", "TelegramSendMessage"],
      moduleInputs: {
        "channel:telegram": { allowedChatIds: "123" },
        "channel:cron": { cronExpression: "30 7 * * 1-5" },
      },
    });
    promptMock.selectAnswers.push("pi:ollama:qwen3:8b", "medium");
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all after family change
      true, // native sandbox
      false, // no provider setup
      true, // use model configuration
    );

    const result = await runModelRepairWizard({
      cwd: "/agent",
      answers: current,
      piAuthPath: "/agent/custom/pi-auth.json",
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toEqual({
      ...current,
      model: "pi:ollama:qwen3:8b",
      fallbackModels: [],
      effort: "medium",
      allowedTools: ["*"],
    });
    expect(discoveryMock.calls).toEqual([{ piAuthPath: "/agent/custom/pi-auth.json" }]);
    expect(promptMock.password).not.toHaveBeenCalled();
    expect(promptMock.notes.find((note) => note.title === "Models and services to verify")?.message)
      .toContain("pi:ollama:nomic-embed-text");
  });

  it("reconciles Pi safety choices when repair changes to direct Codex", async () => {
    const current = defaultAnswers({
      model: "pi:ollama:qwen3:8b",
      channels: ["channel:webhook"],
      sandbox: true,
      allowedTools: ["Read", "Glob", "Grep"],
    });
    promptMock.selectAnswers.push("codex:gpt-5.6-terra", "medium");
    promptMock.confirmAnswers.push(
      false, // no fallback
      false, // no provider setup
      true, // use model configuration
    );

    const result = await runModelRepairWizard({ cwd: "/agent", answers: current });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      model: "codex:gpt-5.6-terra",
      fallbackModels: [],
      effort: "medium",
      sandbox: false,
      allowedTools: ["*"],
    });
  });

  it("requires a default-false high-risk confirmation and enables sandbox when it is declined", async () => {
    promptMock.selectAnswers.push("__custom__", "pi:ollama:qwen3:8b", "medium", "");
    promptMock.multiselectAnswers.push(["channel:telegram"]);
    promptMock.textAnswers.push("");
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all
      false, // decline sandbox
      false, // decline high-risk unsandboxed access
      false, // no Phoenix
      false, // no provider setup
      true, // write
    );
    promptMock.passwordAnswers.push("typed-bot-token");
    const previousShellToken = process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
    process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN = "shell-only-token";
    try {
      const result = await runInitWizard({ cwd: "/agent", persistedEnv: {} });

      expect(result.status).toBe("answers");
      if (result.status !== "answers") return;
      expect(result.answers.sandbox).toBe(true);
      expect(result.moduleSecrets).toEqual({ MONO_AGENT_TELEGRAM_BOT_TOKEN: "typed-bot-token" });
    } finally {
      if (previousShellToken === undefined) {
        delete process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN;
      } else {
        process.env.MONO_AGENT_TELEGRAM_BOT_TOKEN = previousShellToken;
      }
    }

    const highRisk = promptMock.confirmCalls.find((call) => String(call.message).includes("high-risk unsandboxed"));
    expect(highRisk).toMatchObject({ initialValue: false });
    const tools = promptMock.notes.find((note) => note.title === "Tools")?.message ?? "";
    expect(tools).toContain("run shell commands");
    expect(tools).toContain("read/change files");
    expect(tools).toContain("access the web");
    expect(tools).toContain("send through enabled channels");

    const review = promptMock.notes.find((note) => note.title === "Review")?.message ?? "";
    expect(review).toContain(".env.example (placeholders only)");
    expect(review).toContain("Secret files: .env (merge values), .gitignore (ensure /.env is ignored)");
    expect(review).toContain("MONO_AGENT_TELEGRAM_BOT_TOKEN (values hidden)");
    expect(review).not.toContain("→ .env.example");
  });

  it("keeps unsandboxed allow-all only after explicit high-risk acceptance", async () => {
    promptMock.selectAnswers.push("__custom__", "pi:ollama:qwen3:8b", "medium", "");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(false, true, false, true, false, false, true);

    const result = await runInitWizard({ cwd: "/agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.sandbox).toBe(false);
  });

  it("keeps guided Claude allow-all unsandboxed only after explicit high-risk acceptance", async () => {
    promptMock.selectAnswers.push("__custom__", "claude:claude-sonnet-4-6", "medium", "");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // allow all
      true, // accept high-risk unsandboxed Claude
      false, // no Phoenix
      false, // no provider setup
      true, // write
    );

    const result = await runInitWizard({ cwd: "/agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      model: "claude:claude-sonnet-4-6",
      sandbox: false,
      allowedTools: ["*"],
    });
    expect(promptMock.confirmCalls.some((call) => String(call.message).includes("native srt"))).toBe(false);
    const highRisk = promptMock.confirmCalls.find((call) => String(call.message).includes("high-risk unsandboxed"));
    expect(highRisk).toMatchObject({ initialValue: false });
    const review = promptMock.notes.find((note) => note.title === "Review")?.message ?? "";
    expect(review).toContain("Safety:       no configured sandbox");
  });

  it("reconciles a sandboxed Pi model repair to unsandboxed Claude", async () => {
    const current = defaultAnswers({
      model: "pi:ollama:qwen3:8b",
      channels: ["channel:webhook"],
      sandbox: true,
      allowedTools: ["*"],
    });
    promptMock.selectAnswers.push("claude:claude-sonnet-4-6", "medium");
    promptMock.confirmAnswers.push(
      false, // no fallback
      true, // accept high-risk unsandboxed Claude
      false, // no provider setup
      true, // use model configuration
    );

    const result = await runModelRepairWizard({ cwd: "/agent", answers: current });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers).toMatchObject({
      model: "claude:claude-sonnet-4-6",
      sandbox: false,
      allowedTools: ["*"],
    });
  });

  it("rejects a guided direct OpenCode model with actionable config-only guidance", async () => {
    promptMock.selectAnswers.push("__custom__", "__other__", "medium", "");
    promptMock.textAnswers.push("opencode:github-copilot:gpt-5.1");

    await expect(runInitWizard({ cwd: "/agent" })).rejects.toThrow(
      /Choose pi:opencode-go:<model>.*--model opencode:<provider>:<model>.*runtime\.permissionMode/u,
    );
    expect(promptMock.confirmCalls).toEqual([]);
  });

  it("rejects direct OpenCode entered as a guided fallback", async () => {
    promptMock.selectAnswers.push("__custom__", "pi:ollama:qwen3:8b", "__other__");
    promptMock.confirmAnswers.push(true); // add fallback
    promptMock.textAnswers.push("opencode:github-copilot:gpt-5.1");

    await expect(runInitWizard({ cwd: "/agent" })).rejects.toThrow(
      /Direct opencode:\* is an advanced config-only backend/u,
    );
  });

  it("rejects model repair to direct OpenCode before changing prior Pi safety choices", async () => {
    const current = defaultAnswers({
      model: "pi:ollama:qwen3:8b",
      channels: ["channel:webhook"],
      sandbox: true,
      allowedTools: ["Read", "Glob", "Grep"],
    });
    promptMock.selectAnswers.push("__other__", "medium");
    promptMock.textAnswers.push("opencode:github-copilot:gpt-5.1");

    await expect(runModelRepairWizard({ cwd: "/agent", answers: current })).rejects.toThrow(
      /Direct opencode:\* is an advanced config-only backend/u,
    );
    expect(promptMock.confirmCalls).toEqual([]);
  });

  it("skips a required secret only when a non-empty persisted .env value is supplied", async () => {
    promptMock.selectAnswers.push("__custom__", "codex:gpt-5.6-terra", "medium", "");
    promptMock.multiselectAnswers.push(["channel:telegram"]);
    promptMock.textAnswers.push("");
    promptMock.confirmAnswers.push(false, false, false, true);

    const result = await runInitWizard({
      cwd: "/agent",
      piAuthPath: "/agent/custom/pi-auth.json",
      persistedEnv: { MONO_AGENT_TELEGRAM_BOT_TOKEN: "persisted-token" },
    });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.moduleSecrets).toEqual({});
    expect(promptMock.password).not.toHaveBeenCalled();
    expect(discoveryMock.calls).toEqual([{ piAuthPath: "/agent/custom/pi-auth.json" }]);
  });

  it("uses the truthful unattended Codex-native safety posture without srt or tool-policy prompts", async () => {
    promptMock.selectAnswers.push("__custom__", "codex:gpt-5.6-terra", "medium", "");
    promptMock.multiselectAnswers.push(["channel:webhook"]);
    promptMock.confirmAnswers.push(
      false, // no fallback
      false, // no Phoenix
      false, // no provider setup
      true, // write
    );

    const result = await runInitWizard({ cwd: "/agent" });

    expect(result.status).toBe("answers");
    if (result.status !== "answers") return;
    expect(result.answers.sandbox).toBe(false);
    expect(result.answers.allowedTools).toEqual(["*"]);
    expect(promptMock.confirmCalls.some((call) => String(call.message).includes("Allow all tools"))).toBe(false);
    expect(promptMock.confirmCalls.some((call) => String(call.message).includes("native srt"))).toBe(false);
    expect(promptMock.confirmCalls.some((call) => String(call.message).includes("high-risk unsandboxed"))).toBe(false);
    const review = promptMock.notes.find((note) => note.title === "Review")?.message ?? "";
    expect(review).toContain("Codex-native workspace-write sandbox, network disabled");
  });
});
