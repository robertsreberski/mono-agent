import { describe, expect, it } from "vitest";

import {
  ALLOW_ALL_TOOLS,
  baseConfig,
  BUILTIN_TOOL_NAMES,
  type CapabilityModule,
  DEFAULT_MODEL,
  isAllowAllTools,
  isKnownToolName,
  isMcpToolName,
  resolveModuleInputs,
  suggestToolName,
} from "../modules/index.js";

/** A minimal module fixture used only to exercise resolveModuleInputs. */
const fixtureModule: CapabilityModule = {
  id: "channel:telegram",
  kind: "channel",
  title: "Telegram",
  summary: "Chat with the agent over Telegram.",
  riskLevel: "low",
  inputs: [
    { id: "model", label: "Model", description: "Primary model.", default: DEFAULT_MODEL },
    { id: "botToken", label: "Bot token", description: "Telegram bot token.", secret: true, envVar: "MONO_AGENT_TELEGRAM_BOT_TOKEN" },
  ],
  configFragment: () => ({}),
  validateExpectations: [],
};

describe("resolveModuleInputs", () => {
  it("applies declared defaults when no override is supplied", () => {
    const values = resolveModuleInputs(fixtureModule);
    expect(values.model).toBe(DEFAULT_MODEL);
    // A secret input with no default resolves to undefined.
    expect(values.botToken).toBeUndefined();
  });

  it("lets overrides win over defaults", () => {
    const values = resolveModuleInputs(fixtureModule, { model: "codex:gpt-5.5" });
    expect(values.model).toBe("codex:gpt-5.5");
  });

  it("preserves overrides that do not correspond to a declared input", () => {
    const values = resolveModuleInputs(fixtureModule, { extra: "kept" });
    expect(values.extra).toBe("kept");
    expect(values.model).toBe(DEFAULT_MODEL);
  });
});

describe("baseConfig", () => {
  it("sets runtime.model and workspace '.'", () => {
    const config = baseConfig({ dirBasename: "my-agent", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(config.runtime?.model).toBe(DEFAULT_MODEL);
    expect(config.runtime?.workspace).toBe(".");
  });

  it("includes context.skillsRoot only when skillsRootExists", () => {
    const withSkills = baseConfig({ dirBasename: "a", skillsRootExists: true }, DEFAULT_MODEL, []);
    expect(withSkills.context?.skillsRoot).toBe("./skills");

    const withoutSkills = baseConfig({ dirBasename: "a", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(withoutSkills.context).not.toHaveProperty("skillsRoot");
    expect(withoutSkills.context?.selectedSkills).toEqual([]);
  });

  it("sets traceability.sourceLabel from the directory basename", () => {
    const config = baseConfig({ dirBasename: "orchestrator", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(config.traceability?.sourceLabel).toBe("Mono Agent (orchestrator)");
    expect(config.traceability?.registryDir).toBe("./.mono-agent/trace-sources");
  });

  it("includes fallbackModels only when non-empty", () => {
    const none = baseConfig({ dirBasename: "a", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(none.runtime).not.toHaveProperty("fallbackModels");

    const some = baseConfig({ dirBasename: "a", skillsRootExists: false }, DEFAULT_MODEL, ["codex:gpt-5.5"]);
    expect(some.runtime?.fallbackModels).toEqual(["codex:gpt-5.5"]);
  });

  it("starts with an empty allowedTools policy", () => {
    const config = baseConfig({ dirBasename: "a", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(config.tools?.allowedTools).toEqual([]);
    expect(config.tools?.disallowedTools).toEqual([]);
  });

  it("omits $schema and any module-owned blocks (memory/sandbox/webhook)", () => {
    const config = baseConfig({ dirBasename: "a", skillsRootExists: false }, DEFAULT_MODEL, []);
    expect(config).not.toHaveProperty("$schema");
    expect(config).not.toHaveProperty("memory");
    expect(config).not.toHaveProperty("sandbox");
    expect(config).not.toHaveProperty("webhook");
  });
});

describe("known-tools", () => {
  it("lists all eight built-in tools", () => {
    expect(BUILTIN_TOOL_NAMES).toHaveLength(8);
    for (const name of ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch"]) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
    }
  });

  it("recognizes exact built-in and adapter-send tool names, case-sensitively", () => {
    expect(isKnownToolName("Read")).toBe(true);
    expect(isKnownToolName("read")).toBe(false);
    expect(isKnownToolName("telegram_ask")).toBe(true);
    expect(isKnownToolName("nope")).toBe(false);
  });

  it("treats the allow-all sentinel ('*') as a known tool name", () => {
    expect(ALLOW_ALL_TOOLS).toBe("*");
    expect(isKnownToolName(ALLOW_ALL_TOOLS)).toBe(true);
  });

  it("detects the allow-all sentinel in a tool list", () => {
    expect(isAllowAllTools([ALLOW_ALL_TOOLS])).toBe(true);
    expect(isAllowAllTools(["Read", "*"])).toBe(true);
    expect(isAllowAllTools(["Read"])).toBe(false);
    expect(isAllowAllTools([])).toBe(false);
  });

  it("detects MCP server tool names by prefix", () => {
    expect(isMcpToolName("mcp__x__y")).toBe(true);
    expect(isMcpToolName("Read")).toBe(false);
  });

  it("suggests the closest known tool name for a case-only typo", () => {
    expect(suggestToolName("read")).toBe("Read");
    expect(suggestToolName("BASH")).toBe("Bash");
    expect(suggestToolName("zzz")).toBeUndefined();
  });
});
