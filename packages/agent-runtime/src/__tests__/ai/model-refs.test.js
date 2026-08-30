import { describe, expect, it } from "vitest";

import { parseRuntimeModelReference } from "../../ai/runtime/model-refs.js";

const accepted = [
  ["anthropic:claude-opus-5", { provider: "anthropic", model: "claude-opus-5", reference: "anthropic:claude-opus-5" }],
  ["openai:gpt-5.5", { provider: "openai", model: "gpt-5.5", reference: "openai:gpt-5.5" }],
  ["opencode:claude-opus-5", { provider: "opencode", model: "claude-opus-5", reference: "opencode:claude-opus-5" }],
  ["ollama:llama3.1:8b", { provider: "ollama", model: "llama3.1:8b", reference: "ollama:llama3.1:8b" }],
  [
    "openrouter:meta-llama/llama-3.1-70b",
    {
      provider: "openrouter",
      model: "meta-llama/llama-3.1-70b",
      reference: "openrouter:meta-llama/llama-3.1-70b",
    },
  ],
  [
    "pi:openai-codex:gpt-5.6-sol",
    { provider: "openai-codex", model: "gpt-5.6-sol", reference: "openai-codex:gpt-5.6-sol" },
  ],
];

const rejected = [
  ["pi:foo", "pi:<provider>:<model>"],
  ["opencode:github-copilot:gpt-4.1", "github-copilot:gpt-4.1"],
  ["codex:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
  ["claude:claude-opus-5", "anthropic:claude-opus-5"],
  ["claude-code:claude-opus-5", "anthropic:claude-opus-5"],
  ["codex-cli:gpt-5.6-sol", "openai-codex:gpt-5.6-sol"],
  ["acp:worklab", "mono-agent bridge acp"],
  ["vercel:anthropic:claude-opus-5", "anthropic:claude-opus-5"],
];

describe("parseRuntimeModelReference", () => {
  it.each(accepted)("accepts and canonicalizes %s", (authored, expected) => {
    expect(parseRuntimeModelReference(authored)).toEqual(expected);
  });

  it.each(rejected)("rejects %s with its replacement", (authored, replacement) => {
    expect(() => parseRuntimeModelReference(authored)).toThrow(replacement);
  });

  it.each(["haiku", "sonnet", "opus"])("rejects the %s tier alias as a model id", (alias) => {
    expect(() => parseRuntimeModelReference(`anthropic:${alias}`)).toThrow("exact model id");
  });

  it.each(accepted)("is idempotent after parsing %s", (authored) => {
    const canonical = parseRuntimeModelReference(authored).reference;
    expect(parseRuntimeModelReference(canonical).reference).toBe(canonical);
  });
});
