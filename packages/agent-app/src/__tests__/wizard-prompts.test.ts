import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

import { BUILTIN_TOOL_NAMES } from "../modules/known-tools.js";
import {
  channelSelectOptions,
  effortSelectOptions,
  guard,
  memorySelectOptions,
  modelSelectOptions,
  presetSelectOptions,
  toolMultiselectOptions,
  WizardCancelled,
} from "../wizard/prompts.js";
import {
  defaultEffortForModelRef,
  discoverWizardModelCandidates,
  rankWizardModelCandidates,
  type WizardModelCandidate,
} from "../wizard/model-discovery.js";
import { executeProviderSetupPlan, planProviderSetup } from "../provider-setup.js";

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

  it("memorySelectOptions leads with an empty-value 'None' option", () => {
    const options = memorySelectOptions();
    expect(options[0]?.value).toBe("");
    expect(options[0]?.label).toContain("None");
    // The rest are real memory module ids.
    for (const option of options.slice(1)) {
      expect(option.value.startsWith("memory:")).toBe(true);
    }
  });

  it("modelSelectOptions offers the curated set plus Pi and generic escape hatches", () => {
    const options = modelSelectOptions();
    const values = options.map((option) => option.value);
    expect(values).toContain("claude:claude-sonnet-4-6");
    expect(values).toContain("__pi_other__");
    expect(values).toContain("__other__");
    expect(values[values.length - 2]).toBe("__pi_other__");
    expect(values[values.length - 1]).toBe("__other__");
  });

  it("modelSelectOptions ranks discovered Pi OpenAI-Codex above direct Codex while keeping direct selectable", () => {
    const ranked = rankWizardModelCandidates([
      { value: "codex:gpt-5.5", label: "Codex GPT-5.5", source: "codex" },
      {
        value: "pi:openai-codex:gpt-5.5",
        label: "Pi OpenAI-Codex GPT-5.5",
        source: "pi",
        discovered: true,
      },
    ]);

    const options = modelSelectOptions(ranked);
    const values = options.map((option) => option.value);
    expect(values.indexOf("pi:openai-codex:gpt-5.5")).toBeLessThan(values.indexOf("codex:gpt-5.5"));
    expect(values).toContain("codex:gpt-5.5");
  });

  it("modelSelectOptions ranks setup-required Pi OpenAI-Codex below direct Codex while keeping it selectable", () => {
    const ranked = rankWizardModelCandidates([
      { value: "codex:gpt-5.5", label: "Codex GPT-5.5", source: "codex" },
      {
        value: "pi:openai-codex:gpt-5.5",
        label: "Pi OpenAI-Codex GPT-5.5",
        source: "pi",
        setupRequired: true,
        defaultEffort: "medium",
      },
    ]);

    const values = modelSelectOptions(ranked).map((option) => option.value);
    expect(values.indexOf("codex:gpt-5.5")).toBeLessThan(values.indexOf("pi:openai-codex:gpt-5.5"));
    expect(values).toContain("pi:openai-codex:gpt-5.5");
  });

  it("effortSelectOptions offers default plus the runtime effort enum", () => {
    expect(effortSelectOptions().map((option) => option.value)).toEqual(["", "none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("effortSelectOptions marks the model-derived effort", () => {
    const medium = effortSelectOptions("medium").find((option) => option.value === "medium");
    expect(medium).toMatchObject({ label: "medium (derived)", hint: "derived from selected model" });
  });

  it("toolMultiselectOptions appends a channel's send tools then AskUser after the built-ins", () => {
    const options = toolMultiselectOptions(["channel:telegram"]);
    const values = options.map((option) => option.value);
    expect(values.slice(0, BUILTIN_TOOL_NAMES.length)).toEqual([...BUILTIN_TOOL_NAMES]);
    expect(values.slice(BUILTIN_TOOL_NAMES.length)).toEqual([
      "TelegramSendMessage",
      "TelegramAskButtons",
      "AskUser",
    ]);
    // Channel send-tool hints name the action and the channel.
    const ask = options.find((option) => option.value === "TelegramAskButtons");
    expect(ask?.hint).toContain("Telegram");
    expect(ask?.hint).toContain("tappable buttons");
    const send = options.find((option) => option.value === "TelegramSendMessage");
    expect(send?.hint).toBe("proactive send (Telegram)");
  });

  it("toolMultiselectOptions offers the built-ins plus channel-agnostic AskUser with no channel", () => {
    const options = toolMultiselectOptions([]);
    expect(options.map((option) => option.value)).toEqual([...BUILTIN_TOOL_NAMES, "AskUser"]);
    const ask = options.find((option) => option.value === "AskUser");
    expect(ask?.hint).toContain("any channel");
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
        "claude:claude-sonnet-4-6",
        "codex:gpt-5.5",
        "pi:openai-codex:gpt-5.5",
        "pi:openai:gpt-5.5",
        "pi:opencode-go:kimi-k2.6",
        "pi:ollama:gemma4:31b",
        "pi:lmstudio:qwen/qwen3-8b",
      ],
    });

    expect(plan.actions.map((action) => action.id)).toEqual([
      "claude-login",
      "codex-login",
      "pi-login:openai-codex",
      "opencode-models",
      "ollama-list",
      "lmstudio-models",
    ]);
    expect(plan.actions.find((action) => action.id === "pi-login:openai-codex")).toMatchObject({
      command: ["npx", "@earendil-works/pi-ai", "login", "openai-codex"],
      cwd: "/agent/.pi",
    });
    expect(plan.actions.find((action) => action.id === "ollama-list")).toMatchObject({
      command: ["ollama", "list"],
      cwd: "/agent",
    });
    expect(plan.actions.find((action) => action.id === "lmstudio-models")).toMatchObject({
      url: "http://localhost:1234/v1/models",
      cwd: "/agent",
    });
  });

  it("creates the Pi auth working directory before running pi login", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "mono-agent-provider-setup-"));
    try {
      const authDir = join(tmp, "nested", ".pi");
      const plan = planProviderSetup({
        cwd: tmp,
        piAuthPath: "nested/.pi/auth.json",
        modelRefs: ["pi:openai-codex:gpt-5.5"],
      });
      const fakeSpawn = vi.fn((_file: string, _args: readonly string[], _opts: { cwd?: string }) => {
        const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
        queueMicrotask(() => listeners.get("close")?.(0, null));
        return {
          once: (event: string, listener: (value: unknown, signal?: unknown) => void) => {
            listeners.set(event, listener);
          },
        };
      });

      const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

      expect((await stat(authDir)).isDirectory()).toBe(true);
      expect(fakeSpawn).toHaveBeenCalledWith("npx", ["@earendil-works/pi-ai", "login", "openai-codex"], expect.objectContaining({ cwd: authDir }));
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("ok");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("stops execution on the first failed provider setup action", async () => {
    const plan = planProviderSetup({
      cwd: "/agent",
      modelRefs: ["codex:gpt-5.5", "claude:claude-sonnet-4-6"],
    });
    const spawnCalls: string[] = [];
    const fakeSpawn = vi.fn((file: string, args: readonly string[]) => {
      spawnCalls.push([file, ...args].join(" "));
      const listeners = new Map<string, (value: unknown, signal?: unknown) => void>();
      queueMicrotask(() => listeners.get("close")?.(1, null));
      return {
        once: (event: string, listener: (value: unknown, signal?: unknown) => void) => {
          listeners.set(event, listener);
        },
      };
    });

    const results = await executeProviderSetupPlan(plan, { spawn: fakeSpawn as never });

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("failed");
    expect(spawnCalls).toEqual(["codex login"]);
  });
});

describe("wizard model discovery", () => {
  it("derives default effort from cloud, Pi OpenAI-Codex, local reasoning, and unknown manual refs", () => {
    expect(defaultEffortForModelRef("claude:claude-sonnet-4-6")).toBe("medium");
    expect(defaultEffortForModelRef("codex:gpt-5.5")).toBe("medium");
    expect(defaultEffortForModelRef("pi:openai-codex:gpt-5.5")).toBe("medium");
    expect(defaultEffortForModelRef("pi:ollama:llama3.1:8b")).toBe("none");
    expect(defaultEffortForModelRef("pi:lmstudio:qwen/qwen3-8b")).toBe("medium");
    expect(defaultEffortForModelRef("pi:opencode-go:some-model", true)).toBe("medium");
    expect(defaultEffortForModelRef("pi:opencode-go:some-model", false)).toBe("none");
    expect(defaultEffortForModelRef("pi:openai:gpt-5.5")).toBeUndefined();
  });

  it("discovers Pi, OpenCode, Ollama, and LM Studio candidates without dropping static options", async () => {
    const exec = vi.fn(async (file: string) => {
      if (file === "opencode") {
        return { stdout: JSON.stringify({ models: [{ id: "kimi-k2.6" }] }) };
      }
      if (file === "ollama") {
        return { stdout: "NAME ID SIZE MODIFIED\nllama3.1:8b abc 4GB today\n" };
      }
      throw new Error(file);
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen/qwen3-8b" }] }), { status: 200 }));

    const result = await discoverWizardModelCandidates({
      execFile: exec,
      fetch: fetchImpl,
      readFile: async () => JSON.stringify({ "openai-codex": { type: "oauth" } }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("claude:claude-sonnet-4-6");
    expect(values).toContain("pi:openai-codex:gpt-5.5");
    expect(values).toContain("codex:gpt-5.5");
    expect(values.indexOf("pi:openai-codex:gpt-5.5")).toBeLessThan(values.indexOf("codex:gpt-5.5"));
    expect(values).toContain("pi:opencode-go:kimi-k2.6");
    expect(values).toContain("pi:ollama:llama3.1:8b");
    expect(values).toContain("pi:lmstudio:qwen/qwen3-8b");
    expect(result.candidates.find((candidate) => candidate.value === "pi:openai-codex:gpt-5.5")?.defaultEffort).toBe("medium");
    expect(result.candidates.find((candidate) => candidate.value === "pi:ollama:llama3.1:8b")?.defaultEffort).toBe("none");
    expect(result.candidates.find((candidate) => candidate.value === "pi:lmstudio:qwen/qwen3-8b")?.defaultEffort).toBe("medium");
    expect(result.statuses.every((status) => status.status === "detected")).toBe(true);
  });

  it("reads Pi auth providers from the top-level auth store shape", async () => {
    const result = await discoverWizardModelCandidates({
      execFile: async () => {
        throw new Error("missing");
      },
      fetch: async () => {
        throw new Error("down");
      },
      readFile: async () => JSON.stringify({ "openai-codex": { type: "oauth" } }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("pi:openai-codex:gpt-5.5");
    expect(values.indexOf("pi:openai-codex:gpt-5.5")).toBeLessThan(values.indexOf("codex:gpt-5.5"));
    expect(result.statuses[0]).toMatchObject({ provider: "Pi", status: "detected" });
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
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });

    const pi = result.candidates.find((candidate: WizardModelCandidate) => candidate.value === "pi:openai-codex:gpt-5.5");
    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("codex:gpt-5.5");
    expect(pi).toMatchObject({ setupRequired: true, defaultEffort: "medium" });
    expect(result.candidates.map((candidate) => candidate.value).indexOf("codex:gpt-5.5"))
      .toBeLessThan(result.candidates.map((candidate) => candidate.value).indexOf("pi:openai-codex:gpt-5.5"));
    expect(result.statuses.map((status) => status.status)).toEqual(["setup_available", "unavailable", "unavailable", "unavailable"]);
  });
});

describe("guard", () => {
  it("returns the value for a non-cancel result", () => {
    expect(guard("claude:claude-sonnet-4-6")).toBe("claude:claude-sonnet-4-6");
    expect(guard(["Read", "Glob", "Grep"])).toEqual(["Read", "Glob", "Grep"]);
    expect(guard(true)).toBe(true);
    expect(guard([])).toEqual([]);
  });

  it("throws WizardCancelled for the clack cancel symbol", () => {
    expect(() => guard(CANCEL)).toThrow(WizardCancelled);
  });
});
