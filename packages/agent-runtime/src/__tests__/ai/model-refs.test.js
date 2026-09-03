import { describe, expect, it } from "vitest";

import { listPiBuiltinModels, listPiBuiltinProviders } from "../../ai/pi-interop.js";
import { MAX_MODEL_REFERENCE_BYTES, parseRuntimeModelReference } from "../../ai/runtime/model-refs.js";

const utf8 = (value) => new TextEncoder().encode(value).length;

/** The longest reference in Pi's built-in catalog: 77 bytes across all 1312 entries. */
const LONGEST_BUILTIN = "cloudflare-ai-gateway:workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct";

/**
 * A real, current Hugging Face GGUF repo documented for `ollama run`, at 100 bytes.
 *
 * This is the counterexample that retired the previous rule ("a reference is accepted exactly
 * when every operator surface can quote it whole", which made the parse ceiling and the
 * diagnostic echo budget one 96-byte constant). It is not a synthetic edge: `hf.co/<org>/<repo>`
 * repo names run to Hugging Face's own 96-character cap, and what a model may legitimately be
 * called is decided by providers, not by our print width.
 */
const HF_GGUF_100_BYTE_REFERENCE =
  "ollama:hf.co/mradermacher/Qwen3.5-27B-HERETIC-Polaris-Advanced-Thinking-Alpha-uncensored-GGUF:Q4_K_M";

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
  [
    HF_GGUF_100_BYTE_REFERENCE,
    {
      provider: "ollama",
      model: HF_GGUF_100_BYTE_REFERENCE.slice("ollama:".length),
      reference: HF_GGUF_100_BYTE_REFERENCE,
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
 * A reference this function returns is quoted, without re-validation, by roughly six renderers
 * -- `doctor`, `validate`, the TUI, the web console, the daemon log, launchd's captured stdout
 * -- and reaches cache keys and wire payloads besides. What an accepted reference may CONTAIN
 * is therefore settled here: bounding any one renderer would leave the composed line unbounded
 * through the others, and a control character cannot be made safe after the fact.
 *
 * How LONG one may be is a different question with a different answer, and conflating them is
 * the mistake these cases now guard against. A renderer too narrow for a legitimate reference
 * truncates it; the ceiling here exists to keep an identifier from becoming a payload, and is
 * derived from what model ids actually are rather than from any renderer's width.
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
    // Derived from the constant, so the unit stays pinned wherever the ceiling sits: `wide` is
    // the first 4-byte-per-character id past it. Its UTF-16 length is barely half its byte
    // length, which is exactly what a ceiling counted in code units would wave through.
    const perCharacter = 4;
    const modelBudget = MAX_MODEL_REFERENCE_BYTES - "openai:".length;
    const overflowing = Math.floor(modelBudget / perCharacter) + 1;
    const wide = `openai:${"\u{1F9E0}".repeat(overflowing)}`;
    expect(wide.length).toBeLessThan(MAX_MODEL_REFERENCE_BYTES);
    expect(utf8(wide)).toBeGreaterThan(MAX_MODEL_REFERENCE_BYTES);
    expect(() => parseRuntimeModelReference(wide)).toThrow(
      `must be at most ${MAX_MODEL_REFERENCE_BYTES} bytes; got ${utf8(wide)}`,
    );
    expect(() => parseRuntimeModelReference(`openai:${"\u{1F9E0}".repeat(overflowing - 1)}`)).not.toThrow();
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
    // The failure mode this pins is not a typo, it is a temptation in both directions. Too low
    // and a working model is refused -- which is what happened when the ceiling was collapsed
    // into the 96-byte diagnostic echo budget and a real 100-byte Hugging Face GGUF reference
    // stopped parsing. Too high, or nudged up once per complaint, and the bound quietly stops
    // meaning anything. So the constant is asserted against a DERIVATION rather than against
    // itself: the longest reference the upstream naming systems can structurally produce.
    const structuralWorstCase =
      "ollama:hf.co/".length   // the fixed Ollama prefix for a Hugging Face pull
      + 32                     // HF namespace; longest of 3395 sampled is 30
      + "/".length
      + 96                     // HF's own documented repo-name cap; 11325 ids sampled, max 96
      + ":".length
      + 16;                    // GGUF quant tag; longest of 53 real tags is 10 (UD-Q4_K_XL)
    expect(structuralWorstCase).toBe(159);
    expect(MAX_MODEL_REFERENCE_BYTES).toBeGreaterThanOrEqual(structuralWorstCase);
    // Rounded to the worst case, not padded past it: the ceiling has to be re-derived to move,
    // not merely raised until the latest complaint fits.
    expect(MAX_MODEL_REFERENCE_BYTES - structuralWorstCase).toBeLessThan(16);
    // A reference of exactly that shape really does parse, so the derivation is not arithmetic
    // about a form the grammar would have rejected anyway.
    const worstCaseReference =
      `ollama:hf.co/${"n".repeat(32)}/${"r".repeat(96)}:${"Q".repeat(16)}`;
    expect(utf8(worstCaseReference)).toBe(structuralWorstCase);
    expect(parseRuntimeModelReference(worstCaseReference).reference).toBe(worstCaseReference);
    // And it still clears Pi's whole built-in catalog with room to spare, which is the other
    // population it has to cover.
    const longestBuiltin = utf8(LONGEST_BUILTIN);
    expect(longestBuiltin).toBe(77);
    expect(MAX_MODEL_REFERENCE_BYTES - longestBuiltin).toBeGreaterThanOrEqual(64);
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
