import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { resolveJsonMonoAgentConfig } from "../config.js";
import { redactMonoAgentConfig } from "../redact.js";
import { buildMonoAgentConfigView } from "../config-view.js";
import type { MonoAgentConfigJson } from "../json-types.js";

const base = {
  runtime: { model: "anthropic:claude-sonnet-4-6" },
  context: { identityPath: "IDENTITY.md" },
};
const memory = {
  path: "memory", mode: "bujo", embeddings: { provider: "ollama" },
  llm: { provider: "ollama", model: "fictional-model" },
};

// Frozen before extraction. Encode undefined and preserve insertion/array order:
// serializing ordinary JSON alone would hide absent-versus-present changes.
function fingerprint(value: unknown): string {
  const bytes = JSON.stringify(value, (_key, entry: unknown) => {
    if (entry === undefined) return { $undefined: true };
    if (typeof entry === "string") return entry.replaceAll(homedir(), "/fictional/home");
    return entry;
  });
  return createHash("sha256").update(bytes).digest("hex");
}

const valid: Record<string, unknown> = {
  defaults: base,
  sparse: { ...base, memory: {}, sandbox: {}, concurrency: {}, subagents: {},
    runtime: { ...base.runtime, maxTurns: 0, session: { rolloverNotice: false, isolateProactive: false } },
    tools: { allowedTools: [], disallowedTools: [], filesystem: { readableRoots: [] } } },
  domains: { ...base, agent: { name: "Morgan" }, memory,
    runtime: { ...base.runtime, retry: { primaryAttempts: 3, backoffMs: 0 }, session: { root: "sessions" } },
    tools: { conversationSearch: { datedSnippets: true }, filesystem: { readableRoots: ["a,b", "c"] },
      web: { search: { backend: ["ollama", "parallel"], parallel: { apiKeyEnv: "FICTIONAL_SEARCH_KEY" } } } },
    subagents: { definitions: [{ name: "researcher", description: "Research", prompt: "Read", allowedTools: ["Read"] }] },
    artifacts: { retention: { dryRun: true }, replyFiles: { maxStorageBytes: "unlimited" } } },
  providers: { ...base, providers: { piAuthPath: "~/fictional-auth.json",
    zebra: { type: "openai_compat", baseUrl: "http://127.0.0.1:11499/v1", enabled: false, apiKey: "fictional-secret" },
    alpha: { type: "openai_compat", baseUrl: "http://127.0.0.1:11498/v1" } },
    runtime: { ...base.runtime, fallbacks: [{ model: "zebra:fictional", attempts: 2 }] } },
};

// Preserve the pre-outage-budget view fingerprints as a differential guard:
// removing only the intentionally added row must recover every original byte,
// including field/section order and absent-versus-present properties.
const legacyViews: Record<string, string> = {
  defaults: "1b57115c7f3e1e6d5cd9fe777bb9009c9237c9223ff54399793727ca8baf6945",
  domains: "6abff74b3da455a00c07144859ff8ad376f84ce4c21892956e77f8c826a0abcb",
  providers: "47b5a6c08d6c6b43fc6e0beaf9f790d2cc9693b8ec6b4f88efa25d778fab52e3",
  sparse: "6ac10ec1ba6eab684cb887c4649f6d551e1e802b6a0706ce5b299af2d1288169",
};

const invalid: Record<string, { json: unknown; cwd?: string }> = {
  "retired before cwd": { json: { runtime: { permissionMode: "fictional" } }, cwd: "" },
  "cwd before model": { json: {}, cwd: "" },
  "model before identity": { json: {} },
  "fallback before retry": { json: { ...base, runtime: { ...base.runtime, fallbacks: false, retry: false } } },
  "retry before duplicate": { json: { ...base, runtime: { ...base.runtime, retry: false, fallbacks: [{ model: base.runtime.model }] } } },
  "identity before memory": { json: { runtime: base.runtime, memory: false } },
  "memory before tools": { json: { ...base, memory: false, tools: { computerUse: false } } },
  "tools before sandbox": { json: { ...base, tools: { computerUse: false }, sandbox: false } },
  "sandbox before artifacts": { json: { ...base, sandbox: false, artifacts: { replyFiles: { maxFileBytes: 0 } } } },
  "artifacts before providers": { json: { ...base, artifacts: { replyFiles: { maxFileBytes: 0 } }, providers: false } },
  "providers before effort": { json: { ...base, providers: false, runtime: { ...base.runtime, effort: "fictional" } } },
  "effort before subagents": { json: { ...base, runtime: { ...base.runtime, effort: "fictional" }, subagents: false } },
  "subagents before timeout": { json: { ...base, subagents: false, tools: { mcpCallTimeoutMs: -1 } } },
  "web before filesystem": { json: { ...base, tools: { web: { search: { endpoint: "invalid" } }, filesystem: { readableRoots: false } } } },
  "tool list before switch root": { json: { ...base, runtime: { ...base.runtime, session: { modelSwitch: { enabled: true } } }, tools: { allowedTools: false } } },
  "context1M before coverage": { json: { ...base, runtime: { model: { model: "fictional:model", context1M: true } } } },
  "coverage after domains": { json: { ...base, runtime: { model: "fictional:model" } } },
  "retired ordered diagnostics": { json: { ...base, runtime: { ...base.runtime, permissionMode: true }, observability: { exporters: ["fictional-secret"] } } },
};

describe("resolver extraction preservation", () => {
  for (const [name, json] of Object.entries(valid)) {
    it(`adds only the conversation outage-budget view row: ${name}`, () => {
      const config = resolveJsonMonoAgentConfig({ cwd: "/fictional/repo", json: json as MonoAgentConfigJson });
      const view = buildMonoAgentConfigView({ redacted: redactMonoAgentConfig(config), json: json as MonoAgentConfigJson });
      const id = "providers.piNative.requestRetryBudgetMs";
      expect(view.flatMap((section) => section.fields).filter((field) => field.id === id)).toEqual([
        { id, label: "Pi request outage budget (ms)", value: "120000", source: "default" },
      ]);
      const withoutBudgetRow = view.map((section) => ({ ...section, fields: section.fields.filter((field) => field.id !== id) }));
      expect(fingerprint(withoutBudgetRow)).toBe(legacyViews[name]);
    });
    it(`preserves complete shapes and ordered views: ${name}`, () => {
      const config = resolveJsonMonoAgentConfig({ cwd: "/fictional/repo", json: json as MonoAgentConfigJson });
      const redacted = redactMonoAgentConfig(config);
      expect({ config: fingerprint(config), redacted: fingerprint(redacted),
        view: fingerprint(buildMonoAgentConfigView({ redacted, json: json as MonoAgentConfigJson })) }).toMatchSnapshot();
    });
  }
  for (const [name, input] of Object.entries(invalid)) {
    it(`preserves first error: ${name}`, () => {
      let error: unknown;
      try { resolveJsonMonoAgentConfig({ cwd: input.cwd ?? "/fictional/repo", json: input.json as MonoAgentConfigJson }); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const typed = error as Error & { readonly code?: string; readonly details?: unknown };
      expect({ name: typed.name, message: typed.message, code: typed.code, details: typed.details }).toMatchSnapshot();
    });
  }
});
