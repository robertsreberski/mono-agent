#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConfiguredAgentHarness, createConfiguredAgentRuntime } from "@mono-agent/agent-app";

const WORKTREE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = new Set(["multi-turn", "durable-reopen", "stateless", "concurrent", "recall-changing", "capability-change"]);
const TRANSPORTS = new Set(["auto", "sse", "websocket", "websocket-cached"]);
const MAX_REPORT_EVENTS = 1_024;

const piAiPackageRoot = () => resolve(dirname(fileURLToPath(import.meta.resolve("@mono-agent/agent-app"))), "..", "node_modules", "@earendil-works", "pi-ai");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error("Arguments must use --name value or --name=value syntax.");
    const separator = argument.indexOf("=");
    if (separator > 2) result[argument.slice(2, separator)] = argument.slice(separator + 1);
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith("--")) result[argument.slice(2)] = argv[++index];
    else result[argument.slice(2)] = true;
  }
  return result;
}

function boundedInteger(value, fallback, name, min, max) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}

function outputPath(value) {
  const path = resolve(WORKTREE, String(value ?? ".mono-agent/cache-benchmark/report.json"));
  const rel = relative(WORKTREE, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("--output must name a file inside the worktree.");
  return path;
}

function modelReference(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]*:[^:\s][^\s]*$/iu.test(value)) throw new Error("Live mode requires exact --model provider:model.");
  const split = value.indexOf(":");
  return { provider: value.slice(0, split), model: value.slice(split + 1), reference: value };
}

async function validateLiveAuthorization(args) {
  const model = modelReference(args.model);
  const transport = String(args.transport ?? "sse");
  if (!TRANSPORTS.has(transport)) throw new Error("--transport must be auto, sse, websocket, or websocket-cached.");
  const ceiling = Number(args["spend-ceiling-usd"]);
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("Live mode requires a positive --spend-ceiling-usd.");
  if (args["authorize-spend"] !== "YES") throw new Error("Live mode requires --authorize-spend=YES.");
  const credentialEnv = args["credential-env"];
  const piAuth = args["pi-auth"];
  if ((credentialEnv === undefined) === (piAuth === undefined)) throw new Error("Live mode requires exactly one of --credential-env or --pi-auth.");
  let runtimeOptions = {};
  if (credentialEnv !== undefined) {
    if (typeof credentialEnv !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(credentialEnv) || !process.env[credentialEnv]) {
      throw new Error("The explicitly named credential environment variable is unavailable.");
    }
    const credentialValue = process.env[credentialEnv];
    const compatPath = join(piAiPackageRoot(), "dist", "compat.js");
    const { findEnvKeys, getEnvApiKey } = await import(pathToFileURL(compatPath).href);
    const mappedNames = findEnvKeys(model.provider, process.env) ?? [];
    if (!mappedNames.includes(credentialEnv) || getEnvApiKey(model.provider, process.env) !== credentialValue) {
      throw new Error("The explicitly named credential environment variable is not Pi's active API-key source for the selected provider.");
    }
    // Keep the selected value authoritative even if the provider process has
    // unrelated ambient credentials. It remains only in this closure and is
    // never copied into config, state, diagnostics, or reports.
    runtimeOptions = {
      resolvePiApiKey: async (provider) => provider === model.provider ? credentialValue : undefined,
    };
  }
  let piAuthPath;
  if (piAuth !== undefined) {
    piAuthPath = resolve(String(piAuth));
    const metadata = await stat(piAuthPath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size <= 0) throw new Error("The explicitly named Pi auth file is unavailable or empty.");
    await access(piAuthPath);
    let auth;
    try {
      auth = JSON.parse(await readFile(piAuthPath, "utf8"));
    } catch {
      throw new Error("The explicitly named Pi auth file is not valid JSON.");
    }
    const credential = auth && typeof auth === "object" && !Array.isArray(auth) ? auth[model.provider] : undefined;
    if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
      throw new Error("The explicitly named Pi auth file has no credential for the selected provider.");
    }
  }
  return { model, transport, ceiling, piAuthPath, runtimeOptions };
}

function refuseUnboundedLiveDispatch() {
  throw new Error(
    "Live provider dispatch is disabled: --spend-ceiling-usd cannot be enforced before dispatch without explicit provider pricing and request-token bounds.",
  );
}

const hash = (value) => createHash("sha256").update(value).digest("hex");
const ratio = ({ input, cacheRead, cacheWrite }) => {
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? cacheRead / total : null;
};

function makeConfig(root, model, scenario, piAuthPath, toolsEnabled = true) {
  return {
    runtime: { model, maxTurns: 4, workspace: root, session: { mode: scenario === "stateless" ? "per-message" : "continuous", idleTimeoutMs: 60_000 } },
    providers: {
      ...(piAuthPath === undefined ? {} : { piAuthPath }),
      piNative: { piSessionsRoot: join(root, "pi-sessions") },
    },
    context: { identityPath: join(root, "IDENTITY.md"), selectedSkills: [] },
    tools: { allowedTools: toolsEnabled ? ["Read"] : [], disallowedTools: [] },
    artifacts: {
      dir: join(root, "artifacts"),
      retention: { maxAgeDays: 1, maxCount: 1_000, dryRun: false },
      memoryRetention: { maxAgeDays: 1, maxCount: 1_000, dryRun: false },
    },
    traceability: { registryDir: join(root, "trace-sources") },
  };
}

function recallFixture() {
  let reads = 0;
  return {
    async load() { reads += 1; return { kind: "markdown", content: `Controlled recall revision ${reads}.`, source: "benchmark", truncated: false }; },
    async appendHostSummary(conversationId) { return { conversationId, source: "benchmark-disabled", bytesWritten: 0 }; },
  };
}

function collectRun(events, response, labels) {
  const requests = [];
  const contextUsageSnapshots = [];
  let currentRequest;
  let historyMode = "unknown";
  const compactionEvents = [];
  const reseedEvents = [];
  const controlEvents = [];
  for (const event of events.slice(0, MAX_REPORT_EVENTS)) {
    if (event?.type === "turn_context") {
      historyMode = event.historyOmitted === true ? "provider-session" : Number(event.historyCount) > 0 ? "replayed" : "fresh";
      if (event.historyOmitted !== true && Number(event.historyCount) > 0) reseedEvents.push({ kind: "canonical_history_replay", historyCount: Number(event.historyCount) });
    }
    if (event?.type === "prompt_cache_diagnostic") {
      currentRequest = { ...event, input: null, cacheRead: null, cacheWrite: null, output: null, cacheHitRatio: null, costUsd: null, costSource: "unavailable", historyMode };
      requests.push(currentRequest);
    }
    if (event?.type === "context_usage") {
      const tokens = event.tokens ?? {};
      const snapshot = { input: tokens.input ?? null, cacheRead: tokens.cacheRead ?? null, cacheWrite: tokens.cacheCreation ?? null, output: tokens.output ?? null, total: tokens.total ?? null, costUsd: event.costUsd ?? null, costSource: event.costSource ?? "unavailable" };
      contextUsageSnapshots.push(snapshot);
      if (currentRequest) Object.assign(currentRequest, snapshot, { cacheHitRatio: ratio({ input: snapshot.input ?? 0, cacheRead: snapshot.cacheRead ?? 0, cacheWrite: snapshot.cacheWrite ?? 0 }) });
    }
    if (event?.type === "context_compaction") compactionEvents.push({ status: event.status ?? "unknown", trigger: event.trigger ?? "unknown", tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter });
    if (event?.type === "session_boundary" && event.kind === "resume_replay") reseedEvents.push({ kind: event.kind, reason: event.reason });
    if (event?.type === "memory_recalled") controlEvents.push({ type: event.type, source: event.source, bytes: event.bytes });
    if (event?.type === "capabilities_resolved") controlEvents.push({ type: event.type, capabilitiesUsed: event.capabilitiesUsed });
  }
  const usage = response.metadata.runtime?.usage ?? {};
  const totals = { input: usage.input_tokens ?? null, cacheRead: usage.cache_read_tokens ?? null, cacheWrite: usage.cache_creation_tokens ?? null, output: usage.output_tokens ?? null, costUsd: usage.cost_usd ?? null };
  return { ...labels, responseStatus: response.failure === undefined ? "ok" : "failed", historyMode, requests, contextUsageSnapshots, runTotals: { ...totals, cacheHitRatio: [totals.input, totals.cacheRead, totals.cacheWrite].every(Number.isFinite) ? ratio({ input: totals.input, cacheRead: totals.cacheRead, cacheWrite: totals.cacheWrite }) : null }, compactionEvents, reseedEvents, controlEvents };
}

async function fakeProvider(fixturePath) {
  const piRoot = join(piAiPackageRoot(), "dist", "index.js");
  const { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } = await import(pathToFileURL(piRoot).href);
  const faux = fauxProvider({ api: "openai-responses", provider: "benchmark-faux", models: [{ id: "cache-model", reasoning: false }], tokensPerSecond: undefined });
  faux.setResponses(Array.from({ length: 2_000 }, () => (context, _options, state) => {
    const last = context.messages.at(-1);
    return last?.role === "user" && context.tools?.some((tool) => tool.name === "Read")
      ? fauxAssistantMessage([fauxToolCall("Read", { file_path: fixturePath }, { id: `fixture-read-${state.callCount}` })])
      : fauxAssistantMessage([fauxText("fixture observed")]);
  }));
  const base = faux.provider;
  const provider = {
    ...base,
    streamSimple(model, context, options) {
      void options?.onPayload?.({ model: model.id, instructions: context.systemPrompt, input: context.messages, tools: context.tools ?? [], prompt_cache_key: options?.sessionId }, model);
      return base.streamSimple(model, context, options);
    },
  };
  const models = createModels();
  models.setProvider(provider);
  const model = { provider: "benchmark-faux", model: "cache-model", reference: "benchmark-faux:cache-model" };
  return { model, runtimeOptions: { piResolvedModel: faux.getModel(), piResolvedModels: models } };
}

async function runScenario({ args, root, model, transport, runtimeOptions, piAuthPath, ceiling }) {
  const scenario = String(args.scenario ?? "multi-turn");
  const turns = boundedInteger(args.turns, scenario === "stateless" ? 34 : 4, "turns", 1, 40);
  const repeats = boundedInteger(args.repeats, 1, "repeats", 1, 10);
  const conversations = boundedInteger(args.conversations, scenario === "concurrent" ? 2 : 1, "conversations", 1, 8);
  const effort = typeof args.effort === "string" ? args.effort : "none";
  const runs = [];
  const lifecycleEvents = [];
  const collectLifecycle = (event) => {
    if (lifecycleEvents.length < MAX_REPORT_EVENTS) lifecycleEvents.push({ kind: event.kind, reason: event.reason });
  };
  let spent = 0;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    let toolsEnabled = true;
    let config = makeConfig(root, model, scenario, piAuthPath, toolsEnabled);
    let runtime = createConfiguredAgentRuntime({ config, cwd: root });
    let harness = await createConfiguredAgentHarness({ config, cwd: root, runtime, memory: scenario === "recall-changing" ? recallFixture() : undefined, runtimeOptions: { ...runtimeOptions, effort, promptCacheDiagnostics: true, piTransport: transport }, onSessionEvent: collectLifecycle });
    try {
      for (let turn = 0; turn < turns; turn += 1) {
        if ((scenario === "durable-reopen" || scenario === "capability-change") && turn === Math.ceil(turns / 2)) {
          await harness.dispose?.();
          await runtime.disposeAllSessions?.();
          if (scenario === "capability-change") toolsEnabled = false;
          config = makeConfig(root, model, scenario, piAuthPath, toolsEnabled);
          runtime = createConfiguredAgentRuntime({ config, cwd: root });
          harness = await createConfiguredAgentHarness({ config, cwd: root, runtime, memory: scenario === "recall-changing" ? recallFixture() : undefined, runtimeOptions: { ...runtimeOptions, effort, promptCacheDiagnostics: true, piTransport: transport }, onSessionEvent: collectLifecycle });
        }
        const execute = async (conversation) => {
          const events = [];
          const repetitionMarker = hash(`${root}:${repeat}`).slice(0, 12);
          const response = await harness.run({
            conversationId: `cache-${repeat}-${conversation}`,
            userMessage: `Benchmark marker ${repetitionMarker}. Read fixture.txt and reply with at most three words. Turn ${turn}.`,
            abortSignal: new AbortController().signal,
            onEvent: (event) => {
              if (events.length >= MAX_REPORT_EVENTS) return;
              if (["prompt_cache_diagnostic", "context_usage", "turn_context", "context_compaction", "session_boundary", "memory_recalled", "capabilities_resolved"].includes(event?.type)) events.push(event);
            },
          });
          const collected = collectRun(events, response, { repeat: repeat + 1, turn: turn + 1, conversation: conversation + 1 });
          runs.push(collected);
          spent += Number(collected.runTotals.costUsd) || 0;
          if (ceiling !== undefined && spent > ceiling) {
            throw new Error("Observed spend exceeded the secondary post-response stop threshold; measurement stopped. This threshold is not a hard ceiling.");
          }
        };
        if (scenario === "concurrent") await Promise.all(Array.from({ length: conversations }, (_, conversation) => execute(conversation)));
        else await execute(0);
      }
    } finally {
      await harness.dispose?.();
      await runtime.disposeAllSessions?.();
    }
  }
  const aggregate = runs.reduce((sum, run) => ({ input: sum.input + (run.runTotals.input ?? 0), cacheRead: sum.cacheRead + (run.runTotals.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (run.runTotals.cacheWrite ?? 0), output: sum.output + (run.runTotals.output ?? 0), costUsd: sum.costUsd + (run.runTotals.costUsd ?? 0) }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 });
  return { runs, lifecycleEvents, cumulativeTotals: { ...aggregate, cacheHitRatio: ratio(aggregate) } };
}

const args = parseArgs(process.argv.slice(2));
const scenario = String(args.scenario ?? "multi-turn");
if (!SCENARIOS.has(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
if ((args["dry-run"] === true) === (args.live === true)) throw new Error("Select exactly one of --dry-run or --live.");
const output = outputPath(args.output);
const fixtureTokens = boundedInteger(args["fixture-tokens"], 8_192, "fixture-tokens", 1_024, 32_768);
const requestedTransport = String(args.transport ?? "sse");
if (!TRANSPORTS.has(requestedTransport)) throw new Error("--transport must be auto, sse, websocket, or websocket-cached.");
const live = args.live === true ? await validateLiveAuthorization(args) : undefined;
if (live !== undefined) refuseUnboundedLiveDispatch();
const tempParent = join(WORKTREE, ".mono-agent", "cache-benchmark");
await mkdir(tempParent, { recursive: true });
const root = await mkdtemp(join(tempParent, "state-"));
try {
  const fixture = Array.from({ length: fixtureTokens }, (_, index) => `cache-fixture-${index % 97}`).join(" ");
  const fixturePath = join(root, "fixture.txt");
  await writeFile(join(root, "IDENTITY.md"), "You are a bounded prompt-cache measurement agent.", { mode: 0o600 });
  await writeFile(fixturePath, fixture, { mode: 0o600 });
  const fake = live === undefined ? await fakeProvider(fixturePath) : undefined;
  const measured = await runScenario({ args, root, model: live?.model ?? fake.model, transport: live?.transport ?? requestedTransport, runtimeOptions: live?.runtimeOptions ?? fake?.runtimeOptions ?? {}, piAuthPath: live?.piAuthPath, ceiling: live?.ceiling });
  const piPackage = JSON.parse(await readFile(join(piAiPackageRoot(), "package.json"), "utf8"));
  const report = { schema: 2, mode: live === undefined ? "dry-run" : "live", scenario, model: (live?.model ?? fake.model).reference, effort: typeof args.effort === "string" ? args.effort : "none", transport: live?.transport ?? requestedTransport, piVersion: piPackage.version, sampling: { turns: boundedInteger(args.turns, scenario === "stateless" ? 34 : 4, "turns", 1, 40), repeats: boundedInteger(args.repeats, 1, "repeats", 1, 10), conversations: boundedInteger(args.conversations, scenario === "concurrent" ? 2 : 1, "conversations", 1, 8) }, fixture: { tokensRequested: fixtureTokens, bytes: Buffer.byteLength(fixture), sha256: hash(fixture) }, generatedAt: new Date().toISOString(), ...measured };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: relative(WORKTREE, output), mode: report.mode, scenario, runs: report.runs.length, requests: report.runs.reduce((sum, run) => sum + run.requests.length, 0), cacheHitRatio: report.cumulativeTotals.cacheHitRatio })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
