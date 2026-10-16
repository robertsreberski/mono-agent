import { createHash } from "node:crypto";
import { homedir } from "node:os";

import { describe, expect, it } from "vitest";

import { resolveJsonMonoAgentConfig, redactMonoAgentConfig } from "../config.js";
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
