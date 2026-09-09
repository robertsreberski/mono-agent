// Foreground producer/consumer smoke: built public packages, real Pi, no network.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createConfiguredAgentHarness } from "@mono-agent/agent-app";
import { createMonoRuntime } from "@mono-agent/runtime-adapter";
const [root, mode] = process.argv.slice(2);
await writeFile(join(root, "IDENTITY.md"), "You are Mono.");
await writeFile(join(root, "evidence.txt"), "DURABLE TOOL EVIDENCE");
const faux = fauxProvider({ provider: "faux", models: [{ id: "fixture", reasoning: true }] });
const models = createModels(); models.setProvider(faux.provider);
const controller = new AbortController();
let context;
const requests = [];
const runtime = createMonoRuntime();
const harness = await createConfiguredAgentHarness({ cwd: root,
  terminalRecoverySettlementMs: 30_000,
  config: {
    runtime: { model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, workspace: root,
      session: { mode: "continuous", idleTimeoutMs: 60000 }, compaction: { enabled: false }, maxTurns: 4 },
    providers: { piNative: { piSessionsRoot: join(root, "pi") } },
    context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] },
    tools: { allowedTools: ["Read"], disallowedTools: [] },
    artifacts: { dir: join(root, ".mono-agent", "artifacts") },
  },
  runtime: { ...runtime, async run(prompt, options) { requests.push(options.sessionId); return runtime.run(prompt, options); } },
  runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models, piMaxRetries: 0, effort: "none" },
});
try {
  if (mode === "produce") {
    faux.setResponses([
      fauxAssistantMessage([fauxText("warm answer")]),
      fauxAssistantMessage([{ ...fauxThinking("completed thinking"), thinkingSignature: "disk-signature" }, fauxToolCall("Read", { file_path: "evidence.txt" }, { id: "disk-read" })]),
      (value) => { context = structuredClone(value.messages); controller.abort(); return fauxAssistantMessage([], { stopReason: "aborted" }); },
    ]);
    await harness.run({ conversationId: "durable", userMessage: "warm", abortSignal: new AbortController().signal });
  } else {
    faux.setResponses([(value) => { context = structuredClone(value.messages); return fauxAssistantMessage([fauxText("resumed answer")]); }]);
  }
  const result = await harness.run({ conversationId: "durable", userMessage: mode === "produce" ? "cancelled ask" : "next ask", abortSignal: controller.signal });
  const historyRoot = join(root, ".mono-agent", "history");
  const records = await Promise.all((await readdir(historyRoot)).filter((name) => name.endsWith(".history.json")).map(async (name) => JSON.parse(await readFile(join(historyRoot, name), "utf8"))));
  process.stdout.write(JSON.stringify({ pid: process.pid, requests, context, runtimeWarnings: result.metadata?.runtime?.runtimeWarnings, status: result.failure?.kind ?? "success", records }));
} finally { await harness.dispose(); }
