// Configured production harness, faux provider, inert loopback MCP; no real data.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Socket } from "node:net";
import workerThreads from "node:worker_threads";
import { installProcessGuard, identityProbeAllowed } from "./fixtures/continuity-recorded/process-guard.mjs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { readRecordedSource } from "../lib/continuity-recorded-import.mjs";
import { startRecordedTools, RECORDED_SERVER_NAME } from "../lib/continuity-recorded-tools.mjs";
import { productionModules, openHarness, scriptedModels, pilotDispatchConfig } from "../lib/continuity-runner.mjs";
import { snapshots, tool, assistant, result, CONVERSATION } from "./fixtures/continuity-recorded/snapshots.mjs";
const cleanup = [];
afterEach(async () => { try { for (const fn of cleanup.splice(0).reverse()) await fn(); } finally { vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); } }, 60_000);

it("keeps Read/Exec/Bash/WebFetch names and args in outgoing contexts and configured retained capture", async () => {
  const parent = join(ROOT, ".worklab-tmp"); await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, "recorded-faux-")); cleanup.push(() => rm(work, { recursive: true, force: true }));
  for (const key of ["HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(key, work);
  const inputs = join(work, "fictional-inputs"); await mkdir(inputs);
  const calls = [tool("read", "Fictional retained read. ".repeat(2000)),
    tool("exec", "Fictional retained execution.", { toolName: "Exec", args: { executable: "DO_NOT_EXECUTE_fictional" } }),
    tool("bash", "Fictional command failed.", { toolName: "Bash", args: { command: "DO_NOT_EXECUTE_fictional" }, status: "error" }),
    tool("fetch", "Fictional retained page.", { toolName: "WebFetch", args: { url: "https://fictional.invalid/never-requested" } })];
  const f = snapshots(inputs, { parts: calls, journal: [assistant(calls), ...calls.map(result)] });
  const { source } = await readRecordedSource(f.manifest, CONVERSATION);
  const server = await startRecordedTools({ source }); cleanup.push(server.close);
  const rejected = [], originalConnect = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (...args) {
    const input = Array.isArray(args[0]) ? args[0][0] : args[0], host = input?.host ?? input?.hostname ?? args[1], port = Number(input?.port ?? input);
    if (host !== "127.0.0.1" || port !== Number(new URL(server.url).port)) { rejected.push("socket"); throw Error("fictional_egress_denied"); }
    return originalConnect.apply(this, args);
  });
  const unavailable = await fetch(new URL("/mcp", server.url)); expect(unavailable.status).toBe(404); await unavailable.text();
  const browser = await fetch(server.url, { headers: { origin: "https://fictional.invalid" } }); expect(browser.status).toBe(403); await browser.text();
  expect(server.queue.report().served).toEqual([]);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (url, init) => {
    if (new URL(String(url)).origin !== new URL(server.url).origin) { rejected.push("fetch"); throw Error("fictional_egress_denied"); }
    return realFetch(url, init);
  });
  vi.stubGlobal("WebSocket", class { constructor() { throw Error("fictional_egress_denied"); } });
  const probeHits = [], processRefusals = [], hit = command => probeHits.push(command), refuse = () => processRefusals.push("refused");
  cleanup.push(installProcessGuard({ hit, refuse }));
  const RealWorker = workerThreads.Worker;
  const workerErrors = []; let guardedWorkersReady = 0;
  const workerSpy = vi.spyOn(workerThreads, "Worker").mockImplementation(function GuardedWorker(url, options = {}) {
      if (!String(url).endsWith("/packages/conversation/dist/tool-history/writer-worker.js")) throw Error("fictional_worker_denied");
      const { port1, port2 } = new workerThreads.MessageChannel();
      port1.on("message", m => m.kind === "ready" ? guardedWorkersReady++ : m.kind === "allowed" ? hit(m.command) : refuse());
      cleanup.push(() => port1.close());
      const worker = new RealWorker(url, { ...options, workerData: { ...options.workerData, recordedTestGuardPort: port2 }, transferList: [...(options.transferList ?? []), port2],
        execArgv: [...(options.execArgv ?? process.execArgv), "--import", new URL("./fixtures/continuity-recorded/worker-guard.mjs", import.meta.url).href] });
      worker.on("error", e => workerErrors.push(e.message)); return worker;
  });
  syncBuiltinESMExports();
  const modules = await productionModules(ROOT), ref = { provider: "openai-codex", model: "gpt-6-luna" }, scripted = scriptedModels(modules.pi, [ref]);
  const contexts = [], captures = []; let step = 0, historyWarnings = 0;
  scripted.respondWith(ref, context => {
    contexts.push(structuredClone(context));
    return step++ === 0 ? modules.pi.fauxAssistantMessage(calls.map(c => modules.pi.fauxToolCall(c.toolName, c.args, { id: c.toolCallId })), { stopReason: "toolUse" })
      : modules.pi.fauxAssistantMessage("Fictional recorded turn completed.");
  });
  await writeFile(join(work, "IDENTITY.md"), "Fictional isolated harness.");
  const opened = await openHarness({ modules, work, authPath: join(work, "absent-auth.json"), model: `${ref.provider}:${ref.model}`, tools: false,
    clock: { value: new Date("2042-03-01T09:00:00Z") }, onHistoryWarning: () => { historyWarnings++; },
    configPatch: pilotDispatchConfig({ runtime: { session: { continuity: { enabled: true, ledgerEnabled: false, upkeep: { enabled: false } } } },
      memory: { mode: "bujo", path: join(work, "fictional-memory"), writeMode: "capture", embeddings: { provider: "ollama", model: "fictional" }, llm: { provider: "ollama", model: "fictional" }, rememberTool: { enabled: false } } }),
    hostOptions: { memory: { load: async () => undefined, persistCompletedTurn: async turn => { captures.push(turn); } }, runtimeOptions: { toolLimits: { mcpTextLimitChars: 1000 } } },
    route: async options => ({ piResolvedModel: scripted.route(options).model, piResolvedModels: scripted.models,
      allowedTools: [], skills: [], mcpServers: { [RECORDED_SERVER_NAME]: { type: "http", url: server.url } } }) });
  cleanup.push(opened.close);
  const response = await opened.harness.run({ conversationId: "web:fictional-replayed", userMessage: "Read the fictional note and report outcomes.", captureSpeakerKind: "human-turn", metadata: { source: "web" }, sender: { displayName: "Morgan" }, abortSignal: AbortSignal.timeout(30_000) });
  expect(response.failure).toBeUndefined(); expect(response.text).toBe("Fictional recorded turn completed."); expect(step).toBe(2);
  const names = calls.map(c => c.toolName).sort();
  for (const context of contexts) {
    const offered = context.tools ?? context.messages.flatMap(m => m.role === "system" ? m.toolsAdded ?? [] : []);
    expect(offered.map(t => t.name).sort()).toEqual(names);
  }
  const nativeCalls = contexts[1].messages.flatMap(m => m.role === "assistant" && Array.isArray(m.content) ? m.content.filter(p => p.type === "toolCall") : []);
  expect(nativeCalls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }))).toEqual(calls.map(c => ({ id: c.toolCallId, name: c.toolName, arguments: c.args })));
  expect(nativeCalls.map(c => JSON.stringify(c.arguments))).toEqual(calls.map(c => JSON.stringify(c.args)));
  const results = contexts[1].messages.filter(m => m.role === "toolResult"); expect(results).toHaveLength(4);
  for (const [index, call] of calls.entries()) {
    const observed = results.find(r => r.toolCallId === call.toolCallId); expect(observed.toolName).toBe(call.toolName);
    server.queue.observe(index, observed.content);
  }
  expect(server.queue.report()).toMatchObject({ pending: 0, refused: 0 });
  expect(server.queue.report().observations[0]).toMatchObject({ exact: false, possiblyClipped: true });
  expect(captures).toHaveLength(1);
  expect(captures[0].captureEvidence.toolOutcomes).toEqual(expect.arrayContaining([{ category: "read", outcome: "succeeded" }, { category: "execute", outcome: "failed" }, { category: "execute", outcome: "succeeded" }, { category: "search", outcome: "succeeded" }]));
  await opened.close();
  expect(workerSpy).toHaveBeenCalled(); expect(guardedWorkersReady).toBe(workerSpy.mock.calls.length);
  expect(workerErrors).toEqual([]); expect(processRefusals).toEqual([]); expect(historyWarnings).toBe(0);
  // Configured durable sidecar and continuity capture, not an observer-only mock.
  const db = new DatabaseSync(join(work, "history", "tool-history", "tool-lifecycles.sqlite"), { readOnly: true });
  try {
    expect(db.prepare("SELECT tool_name FROM tool_calls ORDER BY start_seq").all().map(r => r.tool_name).sort()).toEqual(names);
    const retained = db.prepare("SELECT retained_text FROM continuity_records WHERE kind='tool'").all().map(r => r.retained_text).join("\n");
    expect(retained).toContain("Fictional retained execution."); expect(retained).toContain("Fictional retained page.");
  } finally { db.close(); }
  expect(rejected).toEqual([]); expect(processRefusals).toEqual([]);
  expect(probeHits.every(command => ["ps", "sysctl"].includes(command))).toBe(true);
  console.info("Recorded faux ownership allowlist hits:", { ps: probeHits.filter(c => c === "ps").length, sysctl: probeHits.filter(c => c === "sysctl").length });
}, 60_000);

it("pins ownership probe executable, pid, environment and argument shapes", () => {
  const env = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    options = { encoding: "utf8", windowsHide: true, timeout: 5000, killSignal: "SIGKILL", env },
    stack = "/fictional/packages/conversation/dist/process-incarnation.js:1";
  expect(identityProbeAllowed("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], options, stack)).toBe(process.platform === "darwin");
  for (const [file, args, opts, trace] of [
    ["/bin/sh", ["-c", "fictional"], options, stack], ["/bin/ps", ["aux"], options, stack],
    ["/bin/ps", ["-p", "99999999", "-o", "lstart="], options, stack], ["/usr/sbin/sysctl", ["-n", "kern.secret"], options, stack],
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { ...options, shell: true }, stack],
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { ...options, env: { ...env, PATH: "/fictional" } }, stack],
    ["/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], options, "/fictional/recorded-tool.js"],
  ]) expect(identityProbeAllowed(file, args, opts, trace)).toBe(false);
});
