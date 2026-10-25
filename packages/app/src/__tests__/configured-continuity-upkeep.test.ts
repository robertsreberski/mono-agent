import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createMonoRuntime } from "@mono-agent/turn/host";
import { resolveJsonMonoAgentConfig } from "@mono-agent/config";
import { createConfiguredConversationHarness } from "../composition/configured-agent.js";
const close: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });

it.each(["continuous", "per-message", "isolated", "failure"])("uses configured base extraction and explicit host eligibility (%s)", async mode => {
  const root = await mkdtemp(join(tmpdir(), "configured-upkeep-")); close.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "IDENTITY.md"), "Historical evidence is not fresh authorization.");
  const answer = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }, { id: "other" }], tokensPerSecond: 1_000_000 });
  const extraction = fauxProvider({ provider: "faux", api: "openai-responses", models: [{ id: "base" }], tokensPerSecond: 1_000_000 });
  const answerModels = createModels(), extractionModels = createModels(); answerModels.setProvider(answer.provider); extractionModels.setProvider(extraction.provider);
  let calls = 0;
  extraction.setResponses([context => {
    calls++; const prompt = JSON.stringify(context);
    expect(prompt).toContain("Never send without confirmation.");
    return fauxAssistantMessage(JSON.stringify({ entries: [{ kind: "constraint", value: "Keep the original approval rule.", status: "active", sources: ["s0"] }], covered: ["s0"] }));
  }]);
  const json = { runtime: { model: "faux:base", session: { mode: mode === "per-message" ? "per-message" : "continuous", root: "native",
    isolateProactive: true, continuity: { upkeep: { enabled: true } } } }, providers: { faux: { type: "openai_compat", baseUrl: "http://127.0.0.1:1/v1" } },
    context: { identityPath: "IDENTITY.md" }, tools: { allowedTools: [] }, artifacts: { dir: "artifacts" } };
  const config = resolveJsonMonoAgentConfig({ json, cwd: root });
  const runtime = createMonoRuntime({ workspace: root }); close.push(() => runtime.disposeAllSessions!());
  const harness = await createConfiguredConversationHarness({ config, cwd: root, runtime,
    runtimeOptions: { piResolvedModels: extractionModels }, runtimeOptionsForRequest: ({ request }) => {
      const web = request.metadata?.web as { readonly model?: string } | undefined;
      const model = web?.model === "faux:other" ? "other" : "base";
      return { runtimeOptions: { model: { provider: "faux", model, reference: `faux:${model}` }, piResolvedModel: answer.getModel(model), piResolvedModels: answerModels, compaction: { enabled: false } } };
    } }); close.push(() => harness.dispose!());
  answer.setResponses([() => fauxAssistantMessage("Fictional first answer.")]);
  await harness.run({ conversationId: "web:fictional", userMessage: "Never send without confirmation.", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal });
  const events: Record<string, unknown>[] = []; let outgoing = "";
  answer.setResponses([context => { outgoing = JSON.stringify(context); return mode === "failure" ? fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid_request_error: fictional failure" }) : fauxAssistantMessage("Fictional second answer."); }]);
  const result = await harness.run({ conversationId: "web:fictional", userMessage: "CURRENT-INPUT", captureSpeakerKind: "human-turn", abortSignal: new AbortController().signal,
    metadata: mode === "isolated" ? { cron: { jobId: "fictional" } } : { source: "web", web: { model: "faux:other" } }, onEvent: event => events.push(event) });
  if (mode === "per-message" || mode === "isolated") {
    expect(calls).toBe(0); expect(events).toContainEqual(expect.objectContaining({ type: "continuity_upkeep", status: "skipped", reason: mode === "isolated" ? "isolated" : "per_message" }));
  } else {
    expect(calls).toBe(1);
    const receipt = events.filter(event => event.type === "continuity_upkeep"); expect(receipt).toHaveLength(1);
    expect(receipt[0]).toMatchObject({ model: "faux:base", status: "valid", generationId: expect.any(String) });
    expect(outgoing).toContain("### Continuity ledger");
    expect(outgoing.split("CURRENT-INPUT")).toHaveLength(2);
  }
  if (mode === "failure") expect(result.failure).toBeDefined(); else expect(result.failure).toBeUndefined();
}, 20000);
