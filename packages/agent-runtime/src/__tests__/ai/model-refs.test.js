import { describe, expect, it } from "vitest";

import { listPiBuiltinModels, listPiBuiltinProviders } from "../../ai/pi-interop.js";
import { MAX_MODEL_REFERENCE_BYTES, parseRuntimeModelReference } from "../../ai/runtime/model-refs.js";

const utf8 = (value) => new TextEncoder().encode(value).length;

/** The longest reference in Pi's built-in catalog: 77 bytes across all 1312 entries. */
const LONGEST_BUILTIN = "cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct";

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
  [
    LONGEST_BUILTIN,
    {
      provider: "cloudflare-ai-gateway",
      model: "workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct",
      reference: LONGEST_BUILTIN,
    },
  ],
  [
    "lmstudio:text-embedding-nomic-embed-text-v1.5@q4_k_m",
    {
      provider: "lmstudio",
      model: "text-embedding-nomic-embed-text-v1.5@q4_k_m",
      reference: "lmstudio:text-embedding-nomic-embed-text-v1.5@q4_k_m",
    },
  ],
  [
    "ollama:hf.co/bartowski/Qwen_Qwen3-235B-A22B-Instruct-2507-GGUF:Q4_K_M",
    {
      provider: "ollama",
      model: "hf.co/bartowski/Qwen_Qwen3-235B-A22B-Instruct-2507-GGUF:Q4_K_M",
      reference: "ollama:hf.co/bartowski/Qwen_Qwen3-235B-A22B-Instruct-2507-GGUF:Q4_K_M",
    },
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

/**
 * A reference this function returns is quoted verbatim, without re-validation, by roughly six
 * renderers -- `doctor`, `validate`, the TUI, the web console, the daemon log, launchd's
 * captured stdout. Bounding any one of them leaves the composed line unbounded through the
 * others, so what an accepted reference may contain is settled here instead.
 */
describe("parseRuntimeModelReference bounds what it accepts", () => {
  it.each([
    ["newline", "openai:foo\nbar"],
    ["carriage return", "openai:foo\rbar"],
    ["tab", "openai:foo\tbar"],
    ["NUL", "openai:foo\u0000bar"],
    ["escape", "openai:foo\u001B[31mbar"],
    ["line separator", "openai:foo\u2028bar"],
    ["paragraph separator", "openai:foo\u2029bar"],
    ["right-to-left override", "openai:foo\u202Ebar"],
    ["zero-width space", "openai:foo\u200Bbar"],
  ])("rejects a model id carrying a %s", (_label, authored) => {
    expect(() => parseRuntimeModelReference(authored)).toThrow(
      "model reference must not contain control or formatting characters",
    );
  });

  it("rejects a model id longer than any real model id", () => {
    expect(() => parseRuntimeModelReference(`openai:${"a".repeat(400)}`)).toThrow(
      `model reference must be at most ${MAX_MODEL_REFERENCE_BYTES} bytes; got 407`,
    );
  });

  it("bounds the provider half too, not only the model half", () => {
    // `PROVIDER_ID_RE` constrains a provider id's alphabet but not its length, so a reference
    // can be pathological on either side of the colon.
    expect(() => parseRuntimeModelReference(`${"a".repeat(400)}:gpt-4`)).toThrow(
      `model reference must be at most ${MAX_MODEL_REFERENCE_BYTES} bytes; got 406`,
    );
  });

  it("accepts a reference exactly at the ceiling and rejects the next byte", () => {
    const atCeiling = `openai:${"a".repeat(MAX_MODEL_REFERENCE_BYTES - "openai:".length)}`;
    expect(utf8(atCeiling)).toBe(MAX_MODEL_REFERENCE_BYTES);
    expect(parseRuntimeModelReference(atCeiling).reference).toBe(atCeiling);
    expect(() => parseRuntimeModelReference(`${atCeiling}a`)).toThrow(
      `must be at most ${MAX_MODEL_REFERENCE_BYTES} bytes; got ${MAX_MODEL_REFERENCE_BYTES + 1}`,
    );
  });

  it("counts UTF-8 bytes, not characters, so a multibyte id cannot slip past the ceiling", () => {
    const wide = `openai:${"\u{1F9E0}".repeat(23)}`;
    expect(wide.length).toBeLessThan(MAX_MODEL_REFERENCE_BYTES);
    expect(utf8(wide)).toBe(99);
    expect(() => parseRuntimeModelReference(wide)).toThrow("must be at most 96 bytes; got 99");
    expect(() => parseRuntimeModelReference(`openai:${"\u{1F9E0}".repeat(22)}`)).not.toThrow();
  });

  it("applies the ceiling to the canonical form, so the legacy pi: wrapper is not charged for", () => {
    const canonical = `openai:${"a".repeat(MAX_MODEL_REFERENCE_BYTES - "openai:".length)}`;
    expect(utf8(`pi:${canonical}`)).toBeGreaterThan(MAX_MODEL_REFERENCE_BYTES);
    expect(parseRuntimeModelReference(`pi:${canonical}`).reference).toBe(canonical);
  });

  it.each([
    ["codex:gpt\nbar", "use openai-codex:gpt\nbar"],
    [`codex:${"a".repeat(400)}`, `use openai-codex:${"a".repeat(400)}`],
    ["vercel:anthropic:claude\u2028opus", "use anthropic:claude\u2028opus directly"],
  ])("still names the replacement for a retired backend carrying a bad value: %j", (authored, repair) => {
    // Order is load-bearing: the shape check runs AFTER the retired-backend check so an
    // operator gets the concrete repair rather than a generic complaint. That message is
    // operator-supplied text too, and is bounded where it is rendered, by runtime-adapter's
    // `sanitizeModelReferenceText` -- not by re-checking the shape first here.
    expect(() => parseRuntimeModelReference(authored)).toThrow(repair);
  });

  it("keeps the ceiling an identifier bound rather than a licence for a payload", () => {
    // The failure mode this pins is not a typo, it is a temptation: the next value that gets
    // refused can always be admitted by raising the number, and the rule quietly stops meaning
    // anything. So both directions are asserted against the catalog measurement, not against
    // the constant itself -- above every real id by a margin that covers local providers
    // publishing their own ids, and still short enough to quote on one operator line.
    const longestBuiltin = utf8(LONGEST_BUILTIN);
    expect(longestBuiltin).toBe(77);
    expect(MAX_MODEL_REFERENCE_BYTES).toBeGreaterThan(longestBuiltin);
    expect(MAX_MODEL_REFERENCE_BYTES - longestBuiltin).toBeGreaterThanOrEqual(16);
    expect(MAX_MODEL_REFERENCE_BYTES).toBeLessThanOrEqual(2 * longestBuiltin);
  });

  it("accepts every reference in Pi's built-in catalog", () => {
    const references = listPiBuiltinProviders()
      .map((provider) => (typeof provider === "string" ? provider : provider.id))
      .flatMap((id) => listPiBuiltinModels(id).map((model) => `${id}:${model.id}`));
    expect(references.length).toBeGreaterThan(1000);
    const refused = references.filter((reference) => {
      try {
        parseRuntimeModelReference(reference);
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toEqual([]);
    const longest = references.reduce((a, b) => (utf8(b) > utf8(a) ? b : a));
    expect(utf8(longest)).toBe(77);
    expect(utf8(longest)).toBeLessThan(MAX_MODEL_REFERENCE_BYTES);
  });
});
