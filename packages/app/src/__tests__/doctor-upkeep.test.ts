import { afterEach, expect, it, vi } from "vitest";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { parseProviderAuthStatusSnapshot } from "@mono-agent/contracts";
import { runtimeSection } from "../doctor/runtime.js";
import { credentialsSection } from "../doctor/credentials.js";
import { collectUsedProviderReferences, providerAuthStatusSnapshot } from "../providers/provider-auth-status.js";
import { createProviderAuthObservationTracker } from "../providers/provider-auth-observations.js";
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])("discovers the effective extraction model without a request (override=%s)", async override => {
  const fetch = vi.fn(() => { throw new Error("Doctor must not buy extraction"); }); vi.stubGlobal("fetch", fetch);
  const config = resolveJsonMonoAgentConfig({ cwd: "/home/example", json: {
    context: { identityPath: "IDENTITY.md" },
    runtime: { model: "answer:base", session: { continuity: { upkeep: { enabled: true, ...(override ? { extractionModel: "extractor:small" } : {}) } } } },
    providers: { answer: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "FICTIONAL_ANSWER_KEY" }, extractor: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "FICTIONAL_EXTRACTOR_KEY" } },
  } });
  const model = override ? "extractor:small" : "answer:base";
  expect(runtimeSection(config).details.some(line => line.includes(`Continuity upkeep model ${model}`))).toBe(true);
  const env = { FICTIONAL_ANSWER_KEY: "fictional-key" };
  const credentials = await credentialsSection(config, env);
  expect(credentials.status).toBe(override ? "waiting" : "ok");
  expect(credentials.details.some(line => line.includes(`Continuity upkeep ${model}`))).toBe(true);
  const input = { cwd: "/home/example", configPath: "/home/example/config.json", env };
  expect((await collectUsedProviderReferences(config, [], input)).map(a => a.usage)).toContainEqual({ kind: "continuity_upkeep", model, label: "Continuity upkeep" });
  const snapshot = await providerAuthStatusSnapshot({ config, env, drivers: [], input, observations: createProviderAuthObservationTracker() });
  expect(parseProviderAuthStatusSnapshot(snapshot).providers.flatMap(p => p.usages)).toContainEqual({ kind: "continuity_upkeep", model, label: "Continuity upkeep" });
  if (override) expect(snapshot.providers.find(p => p.providerId === "extractor")?.state).toBe("missing");
  expect(fetch).not.toHaveBeenCalled();
});
it("ignores disabled extraction overrides and requires no extra credentials", async () => {
  const fetch = vi.fn(() => { throw new Error("Doctor must remain read-only"); }); vi.stubGlobal("fetch", fetch);
  const config = resolveJsonMonoAgentConfig({ cwd: "/home/example", json: {
    context: { identityPath: "IDENTITY.md" },
    runtime: { model: "answer:base", session: { continuity: { upkeep: { enabled: false, extractionModel: "extractor:small" } } } },
    providers: { answer: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "FICTIONAL_ANSWER_KEY" }, extractor: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "FICTIONAL_EXTRACTOR_KEY" } },
  } });
  const env = { FICTIONAL_ANSWER_KEY: "fictional-key" }, input = { cwd: "/home/example", configPath: "/home/example/config.json", env };
  expect(runtimeSection(config).details.join(" ")).not.toContain("Continuity upkeep");
  expect((await credentialsSection(config, env)).status).toBe("ok");
  expect((await collectUsedProviderReferences(config, [], input)).some(a => a.usage.kind === "continuity_upkeep")).toBe(false);
  const snapshot = await providerAuthStatusSnapshot({ config, env, drivers: [], input, observations: createProviderAuthObservationTracker() });
  expect(snapshot.providers.some(p => p.providerId === "extractor")).toBe(false); expect(fetch).not.toHaveBeenCalled();
});
