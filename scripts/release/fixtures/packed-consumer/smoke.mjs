import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePackedSmokeArgs,
  publicExportSpecifiers,
} from "./public-exports.mjs";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const { target } = parsePackedSmokeArgs(process.argv.slice(2));
const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
if (target !== null && !dependencyNames.includes(target)) {
  throw new Error(`Packed smoke target ${target} is not installed as a direct consumer dependency.`);
}
const packageNames = target === null ? dependencyNames : [target];
const packageManifests = new Map();
for (const name of packageNames) {
  packageManifests.set(name, await readInstalledManifest(name));
}
const importSpecifiers = packageNames.flatMap((name) =>
  publicExportSpecifiers(name, packageManifests.get(name)));

// Prove the installed lightweight entry before loading any memory/storage modules.
if (packageNames.includes("@mono-agent/memory")) {
  const targetUrl = import.meta.resolve("@mono-agent/memory/health-metadata");
  const count = execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import { registerHooks } from "node:module";
    const target = ${JSON.stringify(targetUrl)};
    const allowed = new Set([target, new URL("./conversation.js", target).href]);
    registerHooks({ load(url, context, next) {
      if (!allowed.has(url)) throw new Error("Health metadata imported another module: " + url);
      return next(url, context);
    } });
    const metadata = await import(target);
    console.log(metadata.MEMORY_HEALTH_ISSUE_CODES.length);
  `], { encoding: "utf8" });
  assert.equal(count.trim(), "25");
}

// Exercise pure routing in a fresh process before any SDK entry is loaded.
if (packageNames.includes("@mono-agent/channel-telegram")) {
  const targetUrl = import.meta.resolve("@mono-agent/channel-telegram/conversation");
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const target = ${JSON.stringify(targetUrl)};
    const allowed = new Set([target, new URL("./conversation.js", target).href]);
    registerHooks({ load(url, context, next) {
      if (!allowed.has(url)) throw new Error("Conversation routing loaded another module: " + url);
      return next(url, context);
    } });
    const routing = await import(target);
    assert.deepEqual(Object.keys(routing).sort(), ["formatTelegramConversationTarget", "parseTelegramConversationId", "telegramMessageThreadId"]);
    const topic = routing.parseTelegramConversationId("telegram:-1001:12#bucket");
    assert.deepEqual(topic, { chatId: -1001, messageThreadId: 12 });
    assert.equal(routing.formatTelegramConversationTarget(topic), "telegram:-1001:12");
    assert.equal(routing.telegramMessageThreadId({ message_thread_id: 12, is_topic_message: true }), 12);
    assert.equal(routing.parseTelegramConversationId("telegram:1:0"), undefined);
  `], { encoding: "utf8" });
}

for (const specifier of importSpecifiers) {
  if (specifier.endsWith("/package.json")) {
    await import(specifier, { with: { type: "json" } });
  } else {
    await import(specifier);
  }
}

if (packageNames.includes("@mono-agent/conversation")) {
  const api = await import("@mono-agent/conversation");
  for (const name of ["createConversationHarness", "createConversationResponder", "ConversationHarnessError", "ConversationHarnessFailureError"]) {
    assert.equal(typeof api[name], "function");
  }
  for (const name of ["createAgentHarness", "createAgentResponder", "AgentHarnessError", "AgentHarnessFailureError"]) {
    assert.equal(Object.hasOwn(api, name), false);
  }
  assert.equal(new api.ConversationHarnessError("fixture", "Fixture failure").name, "ConversationHarnessError");
  assert.equal(new api.ConversationHarnessFailureError({ kind: "fixture", message: "Fixture failure" }).name, "ConversationHarnessFailureError");
}

if (packageNames.includes("@mono-agent/app")) {
  const api = await import("@mono-agent/app");
  assert.equal(typeof api.createConfiguredConversationHarness, "function");
  assert.equal(Object.hasOwn(api, "createConfiguredAgentHarness"), false);
  const appManifest = packageManifests.get("@mono-agent/app");
  if (typeof appManifest.bin === "object" && appManifest.bin["mono-agent-memory-recall"] !== undefined) {
    throw new Error("Packed app still publishes the retired memory-recall binary.");
  }
  if (appManifest.dependencies?.["@mono-agent/tui"] !== undefined) {
    throw new Error("Packed app still depends on the retired @mono-agent/tui package.");
  }
  await assertRemovedImport("@mono-agent/observability/otel", "ERR_PACKAGE_PATH_NOT_EXPORTED");
  await assertRemovedImport("@mono-agent/observability/run-export", "ERR_PACKAGE_PATH_NOT_EXPORTED");
  if (target === "@mono-agent/app") {
    await assertRemovedImport("@mono-agent/observability-phoenix", "ERR_MODULE_NOT_FOUND");
    await assertRemovedImport("@opentelemetry/otlp-transformer", "ERR_MODULE_NOT_FOUND");
    await assertRemovedImport("@opentelemetry/sdk-trace-base", "ERR_MODULE_NOT_FOUND");
    await assertRemovedImport("@mono-agent/tui", "ERR_MODULE_NOT_FOUND");
    await assertRemovedImport("@earendil-works/pi-tui", "ERR_MODULE_NOT_FOUND");
  }
  await verifyRetiredTuiAndRunInspection();
}

if (packageNames.includes("@mono-agent/turn")) {
  await assertRemovedImport("@mono-agent/runtime-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/agent-app", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/agent-harness", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/agent-runtime", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/agent-contracts", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/slack-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/telegram-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/openai-api-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/operator-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/cron-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/webhook-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/whatsapp-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/messenger-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/a2a-adapter", "ERR_MODULE_NOT_FOUND");
  await assertRemovedImport("@mono-agent/agent-orchestrator", "ERR_MODULE_NOT_FOUND");

  for (const removed of ["@mono-agent/engine", "@mono-agent/engine/sessions.js", "@mono-agent/engine/owned-fs.js"]) {
    await assertRemovedImport(removed, "ERR_MODULE_NOT_FOUND");
  }
  const root = await import("@mono-agent/turn");
  assert.equal(typeof root.createRuntime, "function");
  assert.equal("generateEngineTurnResponse" in root, false);
  const ai = await import("@mono-agent/turn/ai");
  for (const api of [root, ai]) {
    for (const removed of ["resolveRuntimeBridge", "generatePiNativeResponse", "piNativeRuntimeBridge", "assertEngineTurnModelRef"]) {
      assert.equal(removed in api, false);
    }
  }
  assert.equal(typeof ai.generateEngineTurnResponse, "function");
  assert.equal(ai.engineTurnAdapter.execute, ai.generateEngineTurnResponse);
  assert.equal(ai.engineTurnAdapter.id, "pi");
  assert.equal(await ai.resolveEngineTurnAdapter({ provider: "fictional", model: "fixture", reference: "fictional:fixture" }), ai.engineTurnAdapter);
  assert.equal(typeof ai.createCodexAppServerClient, "function");
  const tools = await import("@mono-agent/turn/tools");
  assert.equal(typeof tools.createToolContext, "function");
  assert.equal(typeof tools.execToolRun, "function");
  for (const removed of [
    "ai/failure.js", "ai/cost.js", "ai/runtime/model-refs.js", "ai/runtime/registry.js", "ai/live-input-prompt.js",
    "ai/file-change-stats.js", "ai/providers/codex/app-server-client.js", "agent/tools/index.js", "agent/tools/shared/ripgrep.js",
    "agent/prompt/skill-index.js", "agent/allowlists.js", "agent/transcript.js", "agent/compaction.js", "agent/tools/shared/tool-context.js",
    "agent/tools/shared/runtime-context.js",
  ]) await assertRemovedImport("@mono-agent/turn/" + removed, "ERR_PACKAGE_PATH_NOT_EXPORTED");
}

if (packageNames.includes("@mono-agent/turn")) {
  await verifyEngineRoundTrip();
}

if (packageNames.includes("@mono-agent/observability")) {
  await verifyLocalRecorderRoundTrip();
}

if (packageNames.includes("@mono-agent/config")) {
  await verifyRetiredExporterMigration();
}

const cliSmokes = [
  { packageName: "@mono-agent/app", binName: "mono-agent", args: ["--help"], statuses: [0] },
  {
    packageName: "@mono-agent/app",
    binName: "mono-agent",
    args: ["backfill"],
    statuses: [2],
    stderrIncludes: "removed with first-party Phoenix/OTLP export",
  },
  { packageName: "create-mono-agent", binName: "create-mono-agent", args: ["--help"], statuses: [0] },
];
const selectedCliSmokes = cliSmokes.filter((entry) => packageNames.includes(entry.packageName));
for (const entry of selectedCliSmokes) {
  const packageJson = packageManifests.get(entry.packageName);
  const relativeCli = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.[entry.binName];
  if (typeof relativeCli !== "string") {
    throw new Error(`Packed ${entry.packageName} is missing bin ${entry.binName}.`);
  }
  const cli = join(installedPackageDirectory(entry.packageName), relativeCli);
  const { status, stderr } = await runNodeCli(cli, entry.args);
  if (!entry.statuses.includes(status)) {
    throw new Error(`${cli} ${entry.args.join(" ")} exited ${status}: ${stderr}`);
  }
  if (entry.stderrIncludes !== undefined && !stderr.includes(entry.stderrIncludes)) {
    throw new Error(
      `${cli} ${entry.args.join(" ")} stderr must contain ${JSON.stringify(entry.stderrIncludes)}: ${stderr}`,
    );
  }
}

const ranCreateInfoForms = packageNames.includes("create-mono-agent");
if (ranCreateInfoForms) {
  const createManifest = packageManifests.get("create-mono-agent");
  if (typeof createManifest?.version !== "string") {
    throw new Error("Packed create-mono-agent is missing its version.");
  }
  await verifyCreateMonoAgentInfoForms(createManifest.version);
}

const scope = target === null ? "consumer" : `isolated ${target} consumer`;
const createInfoSummary = ranCreateInfoForms ? " and all 4 create-mono-agent info forms" : "";
console.log(
  `Packed ${scope} imported ${importSpecifiers.length} public export(s); `
  + `ran ${selectedCliSmokes.length} dist CLI smoke(s)${createInfoSummary}.`,
);

async function verifyRetiredTuiAndRunInspection() {
  const appManifest = packageManifests.get("@mono-agent/app");
  const relativeCli = typeof appManifest.bin === "string" ? appManifest.bin : appManifest.bin?.["mono-agent"];
  if (typeof relativeCli !== "string") throw new Error("Packed app is missing mono-agent bin.");
  const cli = join(installedPackageDirectory("@mono-agent/app"), relativeCli);
  const cwd = await mkdtemp(join(tmpdir(), "mono-agent-packed-retired-tui-"));
  const artifacts = join(cwd, "artifacts");
  const secret = `sk-${"A".repeat(48)}`;
  try {
    await writeFile(join(cwd, "mono-agent.config.json"), "{malformed", "utf8");
    await writeFile(join(cwd, ".env"), `PACKED_RETIRED_TUI_SECRET=${secret}\n`, "utf8");
    const retired = await runCapturedCli(process.execPath, [
      cli, "tui", "--local", "--conversation", secret, "--config", "mono-agent.config.json",
    ], cwd);
    if (retired.status !== 2
      || !retired.stderr.includes("`tui` was removed")
      || `${retired.stdout}${retired.stderr}`.includes(secret)) {
      throw new Error(`Packed retired tui contract failed: ${JSON.stringify(retired)}`);
    }

    await mkdir(artifacts, { recursive: true });
    await writeFile(join(artifacts, "packed-run.summary.json"), `${JSON.stringify({
      runId: "packed-run",
      conversationId: "packed",
      status: "succeeded",
      durationMs: 1,
      eventCount: 1,
      userInput: secret,
      artifactPaths: [],
    })}\n`, "utf8");
    await writeFile(join(artifacts, "packed-run.events.jsonl"), `${JSON.stringify({
      type: "runtime_warning",
      message: secret,
    })}\n`, "utf8");
    for (const args of [
      ["runs", "list", "--artifacts", artifacts, "--json"],
      ["runs", "show", "packed-run", "--artifacts", artifacts, "--json"],
    ]) {
      const result = await runCapturedCli(process.execPath, [cli, ...args], cwd);
      if (result.status !== 0 || result.stderr !== "" || result.stdout.includes(secret)) {
        throw new Error(`Packed ${args.join(" ")} failed safe inspection: ${JSON.stringify(result)}`);
      }
      const body = JSON.parse(result.stdout);
      if (body.ok !== true) throw new Error(`Packed ${args.join(" ")} did not return ok JSON.`);
    }
    const traversal = await runCapturedCli(process.execPath, [
      cli, "runs", "show", "../outside", "--artifacts", artifacts, "--json",
    ], cwd);
    if (traversal.status !== 2 || JSON.parse(traversal.stdout).error?.code !== "runs_usage") {
      throw new Error(`Packed traversal guard failed: ${JSON.stringify(traversal)}`);
    }
    const webHelp = await runCapturedCli(process.execPath, [cli, "help", "web"], cwd);
    if (webHelp.status !== 0 || webHelp.stderr !== ""
      || !webHelp.stdout.includes("Operate the always-on assistant-ui console")) {
      throw new Error(`Packed maintained web help failed: ${JSON.stringify(webHelp)}`);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function verifyLocalRecorderRoundTrip() {
  const { createJsonlRunRecorder, readRecordedRun } = await import("@mono-agent/observability");
  const artifactDir = await mkdtemp(join(tmpdir(), "mono-agent-packed-observability-"));
  try {
    const recorder = createJsonlRunRecorder({
      artifactDir,
      runId: "packed-round-trip",
      conversationId: "packed-consumer",
    });
    await recorder.start?.();
    recorder.onEvent({ type: "assistant", text: "packed recorder works" });
    const summary = await recorder.finish({});
    if (summary.status !== "succeeded" || summary.eventCount !== 1) {
      throw new Error(`Packed local recorder returned an invalid summary: ${JSON.stringify(summary)}`);
    }
    const history = await readRecordedRun({ artifactDir }, "packed-round-trip");
    if (history?.summary.runId !== "packed-round-trip" || history.events.length !== 1) {
      throw new Error(`Packed local recorder round trip failed: ${JSON.stringify(history?.summary)}`);
    }
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
}

async function verifyRetiredExporterMigration() {
  const { loadMonoAgentConfig } = await import("@mono-agent/config");
  const cwd = await mkdtemp(join(tmpdir(), "mono-agent-packed-config-"));
  const configPath = join(cwd, "mono-agent.config.json");
  const base = {
    runtime: { model: "pi:openai-codex:gpt-5.5" },
    context: { identityPath: "IDENTITY.md" },
  };
  try {
    await writeFile(configPath, `${JSON.stringify({ ...base, observability: { exporters: [] } })}\n`, "utf8");
    const config = await loadMonoAgentConfig({ cwd, jsonPath: configPath });
    if (Object.hasOwn(config, "observability")) {
      throw new Error("Inert exporter tombstone unexpectedly enabled observability config.");
    }

    const secret = "packed-secret-must-not-leak";
    await writeFile(configPath, `${JSON.stringify({
      ...base,
      observability: { exporters: [{ type: "phoenix", endpoint: `https://${secret}@example.invalid` }] },
    })}\n`, "utf8");
    try {
      await loadMonoAgentConfig({ cwd, jsonPath: configPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(secret) || message.includes("example.invalid")) {
        throw new Error(`Retired exporter rejection leaked legacy config: ${message}`);
      }
      if (!message.includes("observability.exporters") || !message.includes("was removed")) {
        throw new Error(`Retired exporter rejection lacked migration guidance: ${message}`);
      }
      return;
    }
    throw new Error("Active retired exporter config was accepted by the packed package.");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function readInstalledManifest(name) {
  return JSON.parse(await readFile(join(installedPackageDirectory(name), "package.json"), "utf8"));
}

async function assertRemovedImport(specifier, expectedCode) {
  try {
    await import(specifier);
  } catch (error) {
    if (error?.code === expectedCode) return;
    throw new Error(`Expected ${specifier} to be unavailable with ${expectedCode}, got ${error?.code}.`, { cause: error });
  }
  throw new Error(`Retired or unconfigured package surface remains importable: ${specifier}`);
}

function installedPackageDirectory(name) {
  return join(process.cwd(), "node_modules", ...name.split("/"));
}

async function runNodeCli(cli, args) {
  return await runCapturedCli(process.execPath, [cli, ...args], process.cwd());
}

async function verifyCreateMonoAgentInfoForms(version) {
  const createBin = join(process.cwd(), "node_modules", ".bin", "create-mono-agent");
  const cases = [
    { label: "help-long", args: ["--help"], kind: "help" },
    { label: "help-short", args: ["-h"], kind: "help" },
    { label: "version-long", args: ["--version"], kind: "version" },
    { label: "version-short", args: ["-v"], kind: "version" },
  ];

  for (const entry of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `create-mono-agent-${entry.label}-`));
    try {
      const beforeEntries = (await readdir(cwd)).sort();
      if (beforeEntries.length !== 0) {
        throw new Error(`Fresh create-mono-agent ${entry.label} cwd was not empty.`);
      }
      const result = await runCapturedCli(createBin, entry.args, cwd);
      const afterEntries = (await readdir(cwd)).sort();
      if (JSON.stringify(afterEntries) !== JSON.stringify(beforeEntries)) {
        throw new Error(
          `create-mono-agent ${entry.args.join(" ")} changed its cwd entries: `
          + `${JSON.stringify(beforeEntries)} -> ${JSON.stringify(afterEntries)}.`,
        );
      }
      if (result.status !== 0) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`,
        );
      }
      if (entry.kind === "help" && !result.stdout.includes("mono-agent init [--preset <id>]")) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} did not render the init help topic: ${result.stdout}`,
        );
      }
      if (entry.kind === "version" && result.stdout !== `mono-agent ${version}\n`) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} version output must be exactly `
          + `${JSON.stringify(`mono-agent ${version}\n`)}; found ${JSON.stringify(result.stdout)}.`,
        );
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

async function runCapturedCli(command, args, cwd) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function verifyEngineRoundTrip() {
  const entrypoints = {
    "@mono-agent/turn/engine": [
      "JsonlSessionRepo",
      "MemorySessionRepo",
      "createRunDriver",
      "projectContext",
      "projectInheritedContext",
      "digestTurnInput",
      "HANDOFF_SUMMARY_FIELDS",
      "estimateHandoffTokens",
      "validateHandoffSummary",
      "ENGINE_CONTEXT",
      "calculateContextTokens",
      "compact",
      "estimateContextTokens",
      "estimateTokens",
      "getLastAssistantUsage",
      "prepareCompaction",
      "shouldCompact",
      "generateSummaryWithRequest"
    ],
    "@mono-agent/turn/engine/sessions.js": [
      "resolveDurableNativeSessionRepo",
      "resolveSession",
      "discardUncommittedSession",
      "commitSession",
      "rollbackAbortedTurn",
      "cleanupSessionOnThrow",
      "captureSessionRecovery",
      "recoverDurableNativeSession",
      "reconcileNativeSessionTurn",
      "retireDurableNativeSession",
      "salvageDurableNativeSession",
      "detachDurableNativeSession",
      "createManagedNativeJournalStorage",
      "NativeEvidenceCapacityError",
      "assertNativeSessionAccess",
      "normalizeDurableSessionsRoot",
      "probeUnsupportedSessionsRoot",
      "validateSessionTurn",
      "isJournalStorageError",
      "NativeSuspendedError",
      "settleNativeSession",
      "createSessionRegistry",
      "nativeSessionRegistry"
    ],
    "@mono-agent/turn/engine/owned-fs.js": [
      "OwnedFileDamagedError",
      "assertIdentity",
      "isOwned",
      "listOwned",
      "publishAtomic",
      "readOwned",
      "sameIdentity",
      "syncDir",
      "unchanged"
    ]
  };
  for (const [specifier, expected] of Object.entries(entrypoints)) {
    const actual = Object.keys(await import(specifier)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw new Error(`Unexpected engine exports from ${specifier}: ${actual}`);
  }
  for (const removed of ["session-store.js", "legacy-import.js", "journal-types.js", "journal-schema.js", "run-driver.js", "retry-stream.js", "session-context.js", "context.js", "compaction-kit/compaction.js", "journal-reader.js"]) {
    await assertRemovedImport(`@mono-agent/turn/engine/${removed}`, "ERR_PACKAGE_PATH_NOT_EXPORTED");
  }
  const { JsonlSessionRepo, projectContext } = await import("@mono-agent/turn/engine");
  const sessionsRoot = await mkdtemp(join(tmpdir(), "engine-packed-"));
  const repo = new JsonlSessionRepo({ sessionsRoot });
  try {
    const session = await repo.create({ id: "packed-session" });
    await session.beginTurn("synthetic:packed");
    await session.openOperation("packed-operation", { model: { provider: "faux", id: "fictional-model" } });
    await session.appendMessage({ role: "user", content: "Fictional packed request.", timestamp: 1 });
    await session.closeOperation("packed-operation", "completed");
    await session.endTurn("synthetic:packed", "completed");
    await session.sync(); await session.close();
    const reopened = await repo.open((await repo.list())[0]);
    const context = projectContext(await reopened.getEntries());
    if (context.messages.length !== 1 || context.messages[0].content !== "Fictional packed request."
      || reopened.metadata.journalId !== session.metadata.journalId) throw new Error("Packed engine round trip failed.");
    await reopened.close();
  } finally { await repo.close(); await rm(sessionsRoot, { recursive: true, force: true }); }
}
