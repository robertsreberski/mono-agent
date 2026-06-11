import { describe, expect, it } from "vitest";

import { parseCliArgs } from "../cli.js";

describe("parseCliArgs", () => {
  it("parses init with model, fallbacks, and memory", () => {
    expect(
      parseCliArgs([
        "init",
        "--model",
        "claude:claude-sonnet-4-6",
        "--fallback-models",
        "pi:ollama:gemma4:31b, codex:gpt-5.5",
        "--memory",
        "journal",
      ]),
    ).toEqual({
      command: "init",
      model: "claude:claude-sonnet-4-6",
      fallbackModels: ["pi:ollama:gemma4:31b", "codex:gpt-5.5"],
      memory: "journal",
      noConsole: false,
    });
  });

  it("parses start with config, port, and --no-console", () => {
    expect(parseCliArgs(["start", "--config", "agent.json", "--port", "4100", "--no-console"])).toEqual({
      command: "start",
      configPath: "agent.json",
      port: 4100,
      noConsole: true,
    });
  });

  it("defaults to help and rejects unknown commands and flags", () => {
    expect(parseCliArgs([]).command).toBe("help");
    expect(parseCliArgs(["--help"]).command).toBe("help");
    expect(() => parseCliArgs(["serve"])).toThrow(/Unknown command/u);
    expect(() => parseCliArgs(["start", "--what"])).toThrow(/Unknown flag/u);
    expect(() => parseCliArgs(["start", "--port", "no"])).toThrow(/--port/u);
    expect(() => parseCliArgs(["init", "--memory", "vector"])).toThrow(/--memory/u);
  });
});
