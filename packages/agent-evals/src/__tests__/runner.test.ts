import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentResponder } from "@mono-agent/agent-contracts";
import type { RuntimeEventLike } from "@mono-agent/observability";
import { afterEach, describe, expect, it } from "vitest";

import {
  defineAgentEvalScenario,
  runAgentEvalScenario,
  runAgentEvalSuite,
} from "../index.js";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-evals-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runAgentEvalScenario", () => {
  it("passes deterministic responder scenarios and writes eval artifacts", async () => {
    const artifactRoot = await tempDir();
    const scenario = defineAgentEvalScenario({
      id: "collaborator-routing",
      name: "Collaborator routing",
      input: "Plan the launch.",
      target: {
        responder: responderWith({
          text: "Use the researcher report in the final launch plan.",
          metadata: {
            runtime: {
              cost: { totalUsd: 0.02 },
              numTurns: 2,
            },
          },
        }),
      },
      events: [
        toolUse("tool-1", "ask_collaborator", { id: "researcher", message: "Find context." }),
        toolResult("tool-1", "Context found."),
      ],
      assertions: {
        finalText: {
          includes: ["researcher report"],
          matches: [/launch plan/u],
        },
        trajectory: {
          expectedToolCalls: [
            { name: "ask_collaborator", arguments: { id: "researcher", message: "Find context." } },
          ],
          mode: "superset",
        },
        requiredTools: ["ask_collaborator"],
        forbiddenTools: ["Write"],
        maxCostUsd: 0.05,
        maxTurns: 3,
      },
    });

    const result = await runAgentEvalScenario(scenario, {
      artifactRoot,
      suiteId: "demo",
      createRunId: () => "run-1",
      clock: monotonicClock(0),
    });

    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => [check.name, check.passed])).toEqual([
      ["agent status", true],
      ["final text includes", true],
      ["final text matches", true],
      ["required tools", true],
      ["forbidden tools", true],
      ["max cost", true],
      ["max turns", true],
      ["trajectory match", true],
    ]);
    expect(result.finalText).toBe("Use the researcher report in the final launch plan.");
    expect(result.toolCalls.map((call) => call.name)).toEqual(["ask_collaborator"]);
    expect(result.artifacts.resultPath).toBe(join(artifactRoot, "demo", "collaborator-routing", "eval-result.json"));
    expect(result.artifacts.reportPath).toBe(join(artifactRoot, "demo", "collaborator-routing", "report.md"));
    const resultPath = result.artifacts.resultPath;
    const reportPath = result.artifacts.reportPath;
    if (resultPath === undefined || reportPath === undefined) {
      throw new Error("Expected eval artifact paths.");
    }
    await expect(readFile(resultPath, "utf8")).resolves.toContain("\"status\": \"passed\"");
    await expect(readFile(reportPath, "utf8")).resolves.toContain("# Collaborator routing");
  });

  it("fails scenarios when deterministic checks do not pass", async () => {
    const artifactRoot = await tempDir();
    const result = await runAgentEvalScenario(defineAgentEvalScenario({
      id: "bad-output",
      input: "Inspect files.",
      target: {
        responder: responderWith({ text: "I changed the files." }),
      },
      events: [
        toolUse("tool-1", "Write", { file_path: "README.md" }),
      ],
      assertions: {
        finalText: {
          includes: ["read-only"],
        },
        requiredTools: ["Read"],
        forbiddenTools: ["Write"],
      },
    }), {
      artifactRoot,
      suiteId: "demo",
      createRunId: () => "run-2",
      clock: monotonicClock(100),
    });

    expect(result.status).toBe("failed");
    expect(result.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual([
      "final text includes",
      "required tools",
      "forbidden tools",
    ]);
    expect(result.checks.find((check) => check.name === "forbidden tools")?.message).toContain("Write");
  });

  it("captures harness runtime events through request onEvent", async () => {
    const artifactRoot = await tempDir();
    const result = await runAgentEvalScenario(defineAgentEvalScenario({
      id: "harness-events",
      input: "Use a tool.",
      target: {
        harness: {
          async run(request) {
            request.onEvent?.(toolUse("tool-1", "Read", { file_path: "README.md" }));
            return {
              text: "Read the file.",
              metadata: {
                runId: "harness-run",
                conversationId: request.conversationId,
                contextSources: [],
                contextSectionIds: [],
                runtime: { numTurns: 1 },
              },
            };
          },
        },
      },
      assertions: {
        requiredTools: ["Read"],
      },
    }), {
      artifactRoot,
      suiteId: "demo",
      createRunId: () => "run-3",
      clock: monotonicClock(200),
    });

    expect(result.status).toBe("passed");
    expect(result.events).toHaveLength(1);
    expect(result.toolCalls.map((call) => call.name)).toEqual(["Read"]);
  });

  it("skips live-only scenarios unless live execution is enabled", async () => {
    const result = await runAgentEvalScenario(defineAgentEvalScenario({
      id: "live-only",
      input: "Use a real model.",
      requiresLive: true,
      target: {
        responder: responderWith({ text: "should not run" }),
      },
    }), {
      artifactRoot: await tempDir(),
      suiteId: "demo",
      live: false,
    });

    expect(result.status).toBe("skipped");
    expect(result.finalText).toBeUndefined();
  });
});

describe("runAgentEvalSuite", () => {
  it("aggregates scenario results", async () => {
    const artifactRoot = await tempDir();
    const result = await runAgentEvalSuite({
      id: "suite",
      scenarios: [
        defineAgentEvalScenario({
          id: "one",
          input: "Hello.",
          target: { responder: responderWith({ text: "hello" }) },
        }),
        defineAgentEvalScenario({
          id: "two",
          input: "Hello.",
          target: { responder: responderWith({ text: "bad" }) },
          assertions: { finalText: { includes: ["missing"] } },
        }),
      ],
    }, {
      artifactRoot,
      createRunId: (() => {
        let next = 0;
        return () => `run-${next += 1}`;
      })(),
      clock: monotonicClock(300),
    });

    expect(result.status).toBe("failed");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
  });
});

function responderWith(response: { readonly text?: string; readonly metadata?: Record<string, unknown> }): AgentResponder {
  return {
    async respond(_request, stream) {
      if (response.text !== undefined) {
        await stream.append(response.text);
      }
      return response;
    },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>): RuntimeEventLike {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name, input },
      ],
    },
  };
}

function toolResult(id: string, content: string): RuntimeEventLike {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content },
      ],
    },
  };
}

function monotonicClock(start: number): () => number {
  let value = start;
  return () => {
    value += 1;
    return value;
  };
}
