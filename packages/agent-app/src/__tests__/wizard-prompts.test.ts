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
  discoverWizardModelCandidates,
  rankWizardModelCandidates,
  type WizardModelCandidate,
} from "../wizard/model-discovery.js";

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

  it("modelSelectOptions offers the curated set plus an __other__ escape hatch", () => {
    const options = modelSelectOptions();
    const values = options.map((option) => option.value);
    expect(values).toContain("claude:claude-sonnet-4-6");
    expect(values).toContain("__other__");
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

  it("effortSelectOptions offers default plus the runtime effort enum", () => {
    expect(effortSelectOptions().map((option) => option.value)).toEqual(["", "none", "low", "medium", "high", "xhigh", "max"]);
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

describe("wizard model discovery", () => {
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
      readFile: async () => JSON.stringify({ providers: { "openai-codex": {} } }),
    });

    const values = result.candidates.map((candidate) => candidate.value);
    expect(values).toContain("claude:claude-sonnet-4-6");
    expect(values).toContain("pi:openai-codex:gpt-5.5");
    expect(values).toContain("codex:gpt-5.5");
    expect(values.indexOf("pi:openai-codex:gpt-5.5")).toBeLessThan(values.indexOf("codex:gpt-5.5"));
    expect(values).toContain("pi:opencode-go:kimi-k2.6");
    expect(values).toContain("pi:ollama:llama3.1:8b");
    expect(values).toContain("pi:lmstudio:qwen/qwen3-8b");
    expect(result.statuses.every((status) => status.status === "detected")).toBe(true);
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
        throw new Error("missing");
      },
    });

    expect(result.candidates.map((candidate: WizardModelCandidate) => candidate.value)).toContain("codex:gpt-5.5");
    expect(result.statuses.map((status) => status.status)).toEqual(["unavailable", "unavailable", "unavailable", "unavailable"]);
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
