import { describe, expect, it } from "vitest";

import {
  getPiBuiltinModel,
  listPiBuiltinModels,
  listPiBuiltinProviders,
  reasoningLevelsForPiModel,
} from "../../ai/pi-interop.js";
import { parseRuntimeModelReference } from "../../ai/runtime/model-refs.js";

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

/**
 * A canonical `ollama:<model>:<tag>` reference at 168 bytes.
 *
 * Ollama validates the model half and the tag half INDEPENDENTLY, 80 bytes each (v0.33.2,
 * `server/modelpath.go`), so a reference an operator can `ollama pull` today reaches
 * 7 + 80 + 1 + 80 = 168 bytes. This is the counterexample that retired the parser's byte
 * ceiling: 96 refused a real Hugging Face GGUF repo, 160 was derived from a sampled
 * distribution and refused this, and no maximum is published in common across Ollama,
 * LM Studio, OpenRouter and custom `openai_compat` endpoints for a third guess to be any
 * better. A grammar layer does not get to decide what a provider may call a model.
 */
const OLLAMA_168_BYTE_REFERENCE =
  "ollama:hf.co/unsloth/Qwen3.5-Coder-480B-A35B-Instruct-Thinking-2512-Turbo-Preview2-GGUF"
  + ":UD-Q4_K_XL-imatrix-calibration-v3-longcontext-262144-rope-scaled-linear-tuned-v2";

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
  [
    OLLAMA_168_BYTE_REFERENCE,
    {
      provider: "ollama",
      model: OLLAMA_168_BYTE_REFERENCE.slice("ollama:".length),
      reference: OLLAMA_168_BYTE_REFERENCE,
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
 * What an accepted reference may CONTAIN is settled here and nowhere else.
 *
 * A reference this function returns is quoted, without re-validation, by roughly six renderers
 * -- `doctor`, `validate`, the TUI, the web console, the daemon log, launchd's captured stdout
 * -- and reaches cache keys and wire payloads besides. Bounding any one of them would leave the
 * composed line unbounded through the others, and a control character cannot be made safe after
 * the fact, so the content rule is absolute and lives at the source.
 *
 * How LONG a reference may be is a different question, and this layer no longer answers it (see
 * `requireQuotableReference`). The two properties the retired ceiling was carrying are asserted
 * where they are actually enforced, not here:
 *  - an oversized id cannot reach a diagnostic unclamped --
 *    `packages/runtime-adapter/src/__tests__/runtime-adapter.test.ts`, "an accepted reference is
 *    bounded where it is RENDERED, at any length";
 *  - an oversized id cannot break the `/v1/info` budget --
 *    `packages/agent-app/src/__tests__/tui-channel.test.ts` and `tui-info-wire.test.ts`.
 * A ceiling asserted here would have been a fourth guess at a number no provider publishes;
 * those two are the guarantees anybody actually wanted from it.
 */
describe("parseRuntimeModelReference bounds what it accepts", () => {
  /** Every code point `UNQUOTABLE_REFERENCE_CHARACTERS` covers, one representative per class. */
  const UNQUOTABLE = [
    ["newline", "\n"],
    ["carriage return", "\r"],
    ["tab", "\t"],
    ["NUL", "\u0000"],
    ["escape", "\u001B"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["right-to-left override", "\u202E"],
    ["zero-width space", "\u200B"],
  ];

  it.each(UNQUOTABLE)("rejects a model id carrying a %s", (_label, character) => {
    expect(() => parseRuntimeModelReference(`openai:foo${character}bar`)).toThrow(
      "model reference must not contain control or formatting characters",
    );
  });

  /**
   * The content rule is ABSOLUTE, which means it cannot be outrun. Length is the axis a value
   * would use to try: with no ceiling left a hostile id may be any size it likes, and a scan
   * that sampled a prefix, or a check some fast path skipped for a value that "obviously" needs
   * no inspection, would still pass every case above. So the same code points are re-checked
   * buried in the middle of ids two and five orders of magnitude past any real one.
   */
  it.each(UNQUOTABLE)("rejects a %s however long the id carrying it is", (_label, character) => {
    for (const padding of [400, 70_000, 270_000]) {
      const half = "a".repeat(padding);
      expect(() => parseRuntimeModelReference(`openai:${half}${character}${half}`)).toThrow(
        "model reference must not contain control or formatting characters",
      );
    }
  });

  it("rejects a formatting code point sitting between astral-plane characters", () => {
    // The unsafe set is matched with the `u` flag, so it walks code points rather than UTF-16
    // code units. A surrogate-pair neighbourhood is where a code-unit scan goes wrong.
    expect(() => parseRuntimeModelReference("openai:\u{1F9E0}\u200D\u{1F9E0}")).toThrow(
      "model reference must not contain control or formatting characters",
    );
  });

  /**
   * The deliberate ABSENCE of a length rule, pinned as an acceptance rather than left implicit.
   *
   * This is the case a re-added ceiling has to break, and it is written as literal sizes rather
   * than as arithmetic over some constant: the previous round's boundary tests derived their
   * inputs from the very ceiling they were checking, which is why they survived changing it.
   * Nothing here can -- whatever number a future ceiling picked, one of these lengths is past it.
   */
  it.each([
    ["the longest reference Ollama's own component limits allow", OLLAMA_168_BYTE_REFERENCE],
    ["a real 100-byte Hugging Face GGUF repo", HF_GGUF_100_BYTE_REFERENCE],
    ["407 bytes", `openai:${"a".repeat(400)}`],
    ["a 400-byte provider half", `${"a".repeat(400)}:gpt-4`],
    ["70,007 bytes", `openai:${"a".repeat(70_000)}`],
    ["270,007 bytes", `openai:${"a".repeat(270_000)}`],
  ])("imposes no length rule of its own, so it accepts %s", (_label, authored) => {
    const parsed = parseRuntimeModelReference(authored);
    // Returned WHOLE: not truncated, not clamped, not marked. What a renderer does about the
    // size is the renderer's business, and it does it to a copy.
    expect(parsed.reference).toBe(authored);
    expect(utf8(parsed.reference)).toBe(utf8(authored));
  });

  it("accepts a multibyte id whose byte length far exceeds its code-unit length", () => {
    // A ceiling counted in UTF-16 code units rather than UTF-8 bytes was the specific bug the
    // old boundary case guarded. With no ceiling at all the failure mode inverts: what must not
    // happen is the parser mangling a multibyte id on the way through.
    const wide = `openai:${"\u{1F9E0}".repeat(500)}`;
    expect(wide.length).toBeLessThan(utf8(wide));
    expect(parseRuntimeModelReference(wide)).toEqual({
      provider: "openai",
      model: "\u{1F9E0}".repeat(500),
      reference: wide,
    });
  });

  it.each([
    ["codex:gpt\nbar", "use openai-codex:gpt\nbar"],
    [`codex:${"a".repeat(400)}`, `use openai-codex:${"a".repeat(400)}`],
    ["vercel:anthropic:claude\u2028opus", "use anthropic:claude\u2028opus directly"],
  ])("still names the replacement for a retired backend carrying a bad value: %j", (authored, repair) => {
    // Order is load-bearing: the content check runs AFTER the retired-backend check so an
    // operator gets the concrete repair rather than a generic complaint. That message carries
    // the operator's own text, and is bounded where it is rendered, by runtime-adapter's
    // `sanitizeModelReferenceText` -- not by re-checking the shape first here.
    expect(() => parseRuntimeModelReference(authored)).toThrow(repair);
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
  });

  it("exposes GPT-6 Astra for OpenAI API keys and Codex subscriptions", () => {
    const expectedLevels = {
      openai: ["low", "medium", "high", "xhigh", "max"],
      "openai-codex": ["minimal", "low", "medium", "high", "xhigh", "max"],
    };

    for (const [provider, levels] of Object.entries(expectedLevels)) {
      expect(listPiBuiltinModels(provider).some((model) => model.id === "gpt-6-astra")).toBe(true);
      const model = getPiBuiltinModel(provider, "gpt-6-astra");
      expect(model).toMatchObject({
        id: "gpt-6-astra",
        name: "GPT-6 Astra",
        provider,
        reasoning: true,
      });
      expect(reasoningLevelsForPiModel(model)).toEqual(levels);
    }
  });
});
