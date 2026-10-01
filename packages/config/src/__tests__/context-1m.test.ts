import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveJsonMonoAgentConfig } from "../config.js";
import { readMonoAgentConfigJson, writeMonoAgentConfigJson, type MonoAgentConfigJson } from "../json-source.js";
const ref = "openai-codex:gpt-6.1-sol";
const load = (json: unknown) => resolveJsonMonoAgentConfig({ cwd: "/synthetic", json: { context: { identityPath: "IDENTITY.md" }, ...json as MonoAgentConfigJson } });
describe("model declarations with 1M context", () => {
  it("keeps string and unflagged object forms off", () => {
    for (const model of [ref, { model: ref }]) {
      const result = load({ runtime: { model } });
      expect(result.runtime.model.reference).toBe(ref);
      expect(result.runtime.context1MModels).toBeUndefined();
    }
  });
  it.each([true, false])("normalizes an explicit %s across all declaration forms", (context1M) => {
    const result = load({ runtime: { model: { model: ref, context1M }, fallbacks: [{ model: "openai:gpt-6-sol", context1M }] },
      subagents: { enabled: true, models: [{ name: "alternate", model: "openai:gpt-6.1-sol", context1M }],
        definitions: [{ name: "helper", description: "Synthetic helper", prompt: "Synthetic instructions", model: { model: "openai-codex:gpt-6-sol", context1M } }] } });
    expect(result.runtime.context1MModels).toEqual({ [ref]: context1M, "openai:gpt-6-sol": context1M, "openai:gpt-6.1-sol": context1M, "openai-codex:gpt-6-sol": context1M });
    expect(result.subagents?.definitions?.[0]?.model?.reference).toBe("openai-codex:gpt-6-sol");
  });
  it.each([null, [], 42, { model: ref, effort: "low" }, { model: ref, context1M: "true" }, { context1M: true }])("rejects a malformed selection object", (model) => {
    expect(() => load({ runtime: { model } })).toThrow();
  });
  it.each(["openai-codex:gpt-5.3-codex-spark", "anthropic:claude-sonnet-4-6", "openai:gpt-4.1", "openai:unknown"]) ("rejects a flag on %s, even false", (model) => {
    for (const context1M of [true, false]) expect(() => load({ runtime: { model: { model, context1M } } })).toThrow(/eligible/u);
  });
  it("rejects conflicting declarations with the second path and the first declaration named", () => {
    expect(() => load({ runtime: { model: { model: ref, context1M: true } }, subagents: { enabled: true, models: [{ model: ref, context1M: false }] } }))
      .toThrow(/subagents\.models\[0\]\.context1M conflicts with runtime\.model\.context1M/u);
  });
  it("normalizes legacy Pi prefixes to the same model-keyed policy", () => {
    expect(load({ runtime: { model: { model: `pi:${ref}`, context1M: true } } }).runtime.context1MModels).toEqual({ [ref]: true });
    expect(() => load({ runtime: { model: { model: `pi:${ref}`, context1M: true } }, subagents: { models: [{ model: ref, context1M: false }] } })).toThrow(/conflicts/u);
  });
  it("admits a built-in provider allowlist that does not shadow its endpoint", () => {
    expect(load({ runtime: { model: { model: ref, context1M: true } }, providers: { "openai-codex": { models: [{ name: "gpt-6.1-sol" }] } } }).runtime.context1MModels).toEqual({ [ref]: true });
  });
  it("rejects local shadows and nonboolean sibling declarations", () => {
    expect(() => load({ runtime: { model: { model: ref, context1M: false } }, providers: { local: [{ id: "openai-codex", type: "openai_compat", baseUrl: "http://localhost:9999", models: [{ name: "gpt-6.1-sol" }] }] } })).toThrow();
    expect(() => load({ runtime: { model: ref, fallbacks: [{ model: "openai:gpt-6-sol", context1M: 1 }] } })).toThrow(/boolean/u);
  });
  it("preserves the object form through the config reader/writer round trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "synthetic-context-1m-"));
    const path = join(root, "mono-agent.config.json");
    try {
      await writeFile(path, JSON.stringify({ runtime: { model: { model: ref, context1M: false }, effort: "low" } }));
      const source = await readMonoAgentConfigJson(path);
      await writeMonoAgentConfigJson({ path, patch: source.json });
      expect(JSON.parse(await readFile(path, "utf8")).runtime).toEqual({ model: { model: ref, context1M: false }, effort: "low" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
