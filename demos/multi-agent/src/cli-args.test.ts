import { describe, expect, it } from "vitest";

import {
  parseMultiAgentCliArgs,
  parseMultiAgentDeployCliArgs,
} from "./cli-args.js";

describe("multi-agent CLI args", () => {
  it("accepts pnpm separators and runtime ports", () => {
    expect(parseMultiAgentDeployCliArgs([
      "--",
      "--config-dir",
      "local-state",
      "--model",
      "gemma4:31b",
      "--researcher-model",
      "qwen3:8b",
      "--port",
      "5417",
      "--orchestrator-a2a-port",
      "5418",
      "--researcher-a2a-port",
      "5419",
      "--worker-a2a-port",
      "5420",
      "--no-telegram",
    ], {}, "/repo")).toMatchObject({
      configDir: "/repo/local-state",
      model: "gemma4:31b",
      researcherModel: "qwen3:8b",
      port: 5417,
      orchestratorA2APort: 5418,
      researcherA2APort: 5419,
      workerA2APort: 5420,
      noTelegram: true,
    });
  });

  it("uses deploy model defaults from multi-agent env", () => {
    expect(parseMultiAgentDeployCliArgs([], {
      MONO_AGENT_MULTI_AGENT_MODEL: "qwen3:8b",
      MONO_AGENT_MULTI_AGENT_WORKER_MODEL: "gemma4:31b",
      MONO_AGENT_MULTI_AGENT_OLLAMA_URL: "http://127.0.0.1:11434",
    })).toMatchObject({
      model: "qwen3:8b",
      workerModel: "gemma4:31b",
      ollamaBaseUrl: "http://127.0.0.1:11434",
    });
  });

  it("parses demo start flags", () => {
    expect(parseMultiAgentCliArgs(["--", "--config-dir", "state", "--port", "5517", "--no-a2a"], "/repo")).toEqual({
      configDir: "/repo/state",
      port: 5517,
      noTelegram: false,
      noA2A: true,
      help: false,
    });
  });

  it("rejects unknown args and invalid ports", () => {
    expect(() => parseMultiAgentCliArgs(["--wat"])).toThrow(/Unknown argument/u);
    expect(() => parseMultiAgentDeployCliArgs(["--worker-a2a-port", "abc"])).toThrow(/numeric port/u);
  });
});
