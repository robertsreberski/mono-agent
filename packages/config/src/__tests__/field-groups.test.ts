import { describe, expect, it } from "vitest";

import { CORE_AGENT_FIELD_GROUPS, runtimeFieldGroup } from "../field-groups.js";

describe("CORE_AGENT_FIELD_GROUPS", () => {
  it("contains only adapter-neutral core agent settings sections", () => {
    expect(CORE_AGENT_FIELD_GROUPS.map((group) => group.id)).toEqual([
      "identity",
      "runtime",
      "concurrency",
      "memory",
      "tools",
      "sandbox",
      "providers",
      "artifacts",
      "traceability",
    ]);
    expect(CORE_AGENT_FIELD_GROUPS.some((group) => group.id === "telegram")).toBe(false);
  });

  it("exposes sandbox policy fields", () => {
    const sandbox = CORE_AGENT_FIELD_GROUPS.find((group) => group.id === "sandbox");
    expect(sandbox?.fields.map((field) => field.id)).toEqual([
      "sandbox.mode",
      "sandbox.network.mode",
      "sandbox.network.allowlist",
      "sandbox.readableRoots",
      "sandbox.writableRoots",
      "sandbox.denyWrite",
      "sandbox.fallback",
      "sandbox.unsafeAllowHostProcess",
    ]);
  });

  it("exposes memory embeddings fields but not retired scope/graphPath/tools fields", () => {
    const memory = CORE_AGENT_FIELD_GROUPS.find((group) => group.id === "memory");
    const ids = memory?.fields.map((field) => field.id) ?? [];
    expect(ids).not.toContain("memory.scope");
    expect(ids).not.toContain("memory.graphPath");
    expect(ids).not.toContain("memory.tools.enabled");
    expect(ids).not.toContain("memory.tools.allowJournalAppend");
    expect(ids).toContain("memory.embeddings.provider");
    expect(ids).toContain("memory.embeddings.model");
    expect(ids).toContain("memory.embeddings.endpoint");
    expect(ids).toContain("memory.embeddings.apiKey");
    expect(ids).toContain("memory.llm.executionMode");
    const apiKey = memory?.fields.find((field) => field.id === "memory.embeddings.apiKey");
    expect(apiKey?.kind).toBe("secret");
    const llmExecutionMode = memory?.fields.find((field) => field.id === "memory.llm.executionMode");
    expect(llmExecutionMode).toMatchObject({
      kind: "select",
      path: ["memory", "llm", "executionMode"],
    });
  });

  it("exposes concurrency.maxConcurrentRuns on the concurrency group", () => {
    const concurrency = CORE_AGENT_FIELD_GROUPS.find((group) => group.id === "concurrency");
    expect(concurrency?.fields.find((field) => field.id === "concurrency.maxConcurrentRuns")).toMatchObject({
      kind: "integer",
      path: ["concurrency", "maxConcurrentRuns"],
    });
  });

  it("exposes embeddings timeoutMs and circuit breaker fields on the memory group", () => {
    const memory = CORE_AGENT_FIELD_GROUPS.find((group) => group.id === "memory");
    const ids = memory?.fields.map((field) => field.id) ?? [];
    expect(ids).toContain("memory.embeddings.timeoutMs");
    expect(ids).toContain("memory.embeddings.circuitBreaker.failureThreshold");
    expect(ids).toContain("memory.embeddings.circuitBreaker.cooldownMs");
    const timeout = memory?.fields.find((field) => field.id === "memory.embeddings.timeoutMs");
    expect(timeout).toMatchObject({
      kind: "integer",
      path: ["memory", "embeddings", "timeoutMs"],
    });
    const threshold = memory?.fields.find((field) => field.id === "memory.embeddings.circuitBreaker.failureThreshold");
    expect(threshold).toMatchObject({
      kind: "integer",
      path: ["memory", "embeddings", "circuitBreaker", "failureThreshold"],
    });
  });

  it("exposes the skill byte cap on the identity group", () => {
    const identity = CORE_AGENT_FIELD_GROUPS.find((group) => group.id === "identity");
    expect(identity?.fields.find((field) => field.id === "context.skillMaxBytes")).toMatchObject({
      kind: "integer",
      path: ["context", "skillMaxBytes"],
    });
  });

  it("exposes runtime session fields with nested paths", () => {
    const mode = runtimeFieldGroup.fields.find((field) => field.id === "runtime.session.mode");
    const idleTimeout = runtimeFieldGroup.fields.find((field) => field.id === "runtime.session.idleTimeoutMs");

    expect(mode).toMatchObject({
      kind: "select",
      options: [
        { value: "continuous", label: "continuous" },
        { value: "per-message", label: "per-message" },
      ],
      path: ["runtime", "session", "mode"],
    });
    expect(idleTimeout).toMatchObject({
      kind: "integer",
      placeholder: "1800000",
      path: ["runtime", "session", "idleTimeoutMs"],
    });
  });

  it("documents runtime maxTurns as optional with zero meaning unlimited", () => {
    const maxTurns = runtimeFieldGroup.fields.find((field) => field.id === "runtime.maxTurns");

    expect(maxTurns).toMatchObject({
      kind: "integer",
      min: 0,
      max: 100,
      placeholder: "0",
      path: ["runtime", "maxTurns"],
    });
  });
});
