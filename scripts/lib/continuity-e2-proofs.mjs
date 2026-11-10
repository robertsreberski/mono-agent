// Live-path proofs: faux by default, or bound paid phase actor under one controller.
// Production owns context, sessions, packs, compaction and effect containment.
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ROOT, fail } from "./continuity-observation-input.mjs";
import { privateOutput } from "./continuity-recorded-import.mjs";
import { openHarness, productionModules } from "./continuity-runner.mjs";
import { createE2Models, loadE2Estimators, shippingSoul, sizeContext, estimatedReply } from "./continuity-e2-models.mjs";
import { privateModes } from "./continuity-e2-replay.mjs";
import { LUNA, SOL } from "./continuity-e2-protocol.mjs";
import { lookupWitness, resolveSource, historyBody } from "./continuity-lookup.mjs";
import { E2_PROOF_PRESSURE_ARMS } from "./continuity-arms.mjs";
import { proofEnvironment, installProofIsolation } from "./continuity-e2-isolation.mjs";
import { startProofTools, PROOF_SERVER, SENTINEL, FACT, NEXT_ACTION, CANARY, FOREIGN } from "./continuity-e2-tools.mjs";
import { assertE2PhaseAdapter } from "./continuity-e2-runtime.mjs";
import { e2PaidRole } from "./continuity-e2-roles.mjs";
import { PROOF_CODES, requireProof, assertProofEvidence, assertSetupCompactions } from "./continuity-e2-checks.mjs";

export const PROOF_ARMS = Object.freeze(["switch", "cancel", "idle", "pressure"]);
export const PROOF_CHILD = fileURLToPath(new URL("./continuity-e2-fixture.mjs", import.meta.url));
const FAULTS = Object.freeze(["repeat", "early-idle", "pack", "leak"]);
const HISTORY = "mono-agent-conversation-history", CONVERSATION = "web:fictional-proof-owner", OTHER = "web:fictional-proof-foreign";
const LIMITS = Object.freeze({ sourceRequests: 64, probeRequests: 32, summaryRequests: 8, summaryRequestsPerCompaction: 2, compactions: 4, timeoutMs: 120_000 });
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
const offered = (context, pi) => context.tools ?? pi.getCurrentTools(context.messages);
const visible = context => JSON.stringify(context);

async function fixtureChild(base, phase) {
  const env = await proofEnvironment(join(base, "hermetic"));
  // One exact executable/entry/argv shape, shared by cancellation and pressure restart.
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROOF_CHILD, phase, base], { cwd: ROOT, env: { ...env, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_NO_WARNINGS: "1" }, stdio: "ignore", shell: false });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, 180_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve(code === 0 && !signal); });
  });
  if (!status) {
    let code = "E2_PROOF_FIXTURE_FAILED";
    try { const refusal = JSON.parse(await readFile(join(base, `${phase}-refusal.json`), "utf8")); if (PROOF_CODES.includes(refusal.code)) code = refusal.code; } catch { /* missing receipt is a failed fixture */ }
    fail(code);
  }
  return JSON.parse(await readFile(join(base, `${phase}.json`), "utf8"));
}

// Match only fixed product warning classes; never retain arbitrary warning text.
export function proofHistoryWarningClass(message) {
  if (typeof message !== "string") return "unknown";
  for (const reason of ["capture_bounds", "capture_quota", "sidecar_unavailable"]) {
    if (message.startsWith(`Continuity is degraded (${reason});`)) return `continuity_${reason}`;
  }
  for (const [prefix, kind] of [
    ["ConversationHistory endpoint could not start;", "endpoint_unavailable"],
    ["Tool lifecycle persistence failed (history_persistence_timeout)", "lifecycle_timeout"],
    ["Tool lifecycle persistence failed (", "lifecycle_failed"],
    ["Tool history writer acquisition failed (history_persistence_timeout)", "writer_acquisition_timeout"],
    ["Tool history writer acquisition failed (", "writer_acquisition_failed"],
    ["Tool history writer acquisition recovered;", "writer_acquisition_recovered"],
    ["Tool history run finalization failed:", "run_finalization_failed"],
    ["Upkeep accounting degraded:", "accounting_degraded"],
    ["Continuity is degraded: retention protection is unavailable;", "retention_unavailable"],
    ["Continuity coverage gap:", "preparation_abandoned"],
  ]) if (message.startsWith(prefix)) return kind;
  return "unknown";
}

/** Internal fixture phases use only existing, owner-only roots created by runE2Proofs. */
export async function runProofPhase({ base, arm, phase = "whole", variant = "ceiling", fault, onContext = () => {}, paidAdapter }) {
  if (paidAdapter) { assertE2PhaseAdapter(paidAdapter); paidAdapter.assertProof({ base, arm, phase, variant }); if (fault !== undefined) fail("E2_ARGUMENTS_INVALID"); }
  if (fault !== undefined && !FAULTS.includes(fault)) fail("E2_ARGUMENTS_INVALID");
  if (!PROOF_ARMS.includes(arm) || !["whole", "seed", "resume"].includes(phase) || !["ceiling", "restart"].includes(variant)) fail("E2_ARGUMENTS_INVALID");
  const fixture = arm === "cancel" || arm === "pressure" && variant === "restart";
  requireProof(fixture ? phase !== "whole" : phase === "whole", "E2_ARGUMENTS_INVALID");
  const work = join(base, "work"), resumed = phase === "resume", needsPressure = arm !== "switch";
  const pressureArm = E2_PROOF_PRESSURE_ARMS.find(row => row.restart === (variant === "restart"));
  const seedReceipt = resumed ? JSON.parse(await readFile(join(base, "seed.json"), "utf8")) : null;
  if (resumed) {
    requireProof(seedReceipt.pid !== process.pid && seedReceipt.sentinel.completed && !seedReceipt.sentinel.repeated, "E2_PROOF_RESTART_MISSING");
    if (arm === "cancel") requireProof(seedReceipt.forwarded === true, "E2_PROOF_CANCEL_NOT_FORWARDED");
  }
  await mkdir(work, { recursive: true, mode: 0o700 });
  await writeFile(join(work, "IDENTITY.md"), "Fictional isolated continuity proof. Never disclose protected canaries or another conversation. Never repeat a completed sentinel.\n", { mode: 0o600 });
  const modules = await productionModules(ROOT), estimators = await loadE2Estimators(), soul = await shippingSoul();
  const tools = await startProofTools(base), requests = [], boundaries = [], sessions = [];
  const historyWarnings = [];
  let opened, historyDegraded = false, mode = "setup-scripted", binding = { model: arm === "switch" || arm === "pressure" && variant === "restart" ? LUNA : SOL, effort: "high" };
  if (resumed && arm === "pressure") binding = { model: SOL, effort: "high" };
  let setup = [], setupCursor = 0, requestSignal, controller, forwarded = false, witness, firstRequestSeen = false, firstPack = false, safe = true, readerRound = 0, readText = "", answer = "", sentinelOffered = false;
  const seen = new Set();
  const route = createE2Models({ pi: modules.pi, estimators, soul, paidAdapter, ...(paidAdapter ? { summary: "real" } : {}), models: [LUNA, SOL].map(model => ({ model })), limits: LIMITS,
    ...(paidAdapter ? { onRequest(model, context, options = {}, method) {
      requestSignal = options.signal;
      requests.push({ ordinal: requests.length, model: `${model.provider}:${model.id}`, role: method === "completeSimple" ? "summary" : mode === "cancel-forwarded" ? "setup-scripted" : mode,
        paidRole: e2PaidRole(mode, method), phase, size: sizeContext(context, estimators), maxOutputTokens: options.maxTokens ?? model.maxTokens });
    } } : {}),
    sourceContext(context) {
      onContext({ arm, phase, role: mode, context });
      if (["continuation", "probe", "cancel-forwarded"].includes(mode)) {
        const names = offered(context, modules.pi).map(t => t.name).sort(), allowed = mode === "continuation" && arm === "cancel" ? ["ConversationHistory", SENTINEL].sort() : ["ConversationHistory"];
        requireProof(JSON.stringify(names) === JSON.stringify(allowed), "E2_PROBE_TOOLS_REFUSED");
        if (mode === "continuation") {
          if (!firstRequestSeen) { firstRequestSeen = true; firstPack = context.messages.some(m => textOf(m).includes("### Conversation continuity pack")); witness.initial(context); sentinelOffered = names.includes(SENTINEL); }
          for (const m of context.messages.filter(m => m.role === "toolResult" && m.toolName === "ConversationHistory")) if (!seen.has(m.toolCallId)) { seen.add(m.toolCallId); witness.delivered({ content: m.content }); }
        }
        safe &&= !visible(context).includes(CANARY) && !visible(context).includes(FOREIGN);
      }
    },
    async sourceReply(context) {
      if (mode === "setup-scripted") {
        const body = setup[setupCursor++]; requireProof(body !== undefined, "E2_SOURCE_REQUEST_LIMIT");
        return estimatedReply(modules.pi, body, context, estimators, { stopReason: Array.isArray(body) ? "toolUse" : "stop" });
      }
      if (mode === "cancel-forwarded") {
        requireProof((await tools.receipt()).completed && requestSignal instanceof AbortSignal && !requestSignal.aborted, "E2_PROOF_CANCEL_NOT_FORWARDED");
        forwarded = true;
        // This callback runs inside Pi's faux backend, after streamSimple forwarded
        // the actual signal. Abort before generating any continuation response.
        await new Promise(resolve => { requestSignal.addEventListener("abort", resolve, { once: true }); queueMicrotask(() => controller.abort()); });
        return estimatedReply(modules.pi, "", context, estimators, { stopReason: "aborted" });
      }
      let body;
      if (mode === "probe") body = `${FACT}; next: ${NEXT_ACTION}.`;
      else if (fault === "repeat" && arm === "cancel") body = readerRound++ === 0 ? [modules.pi.fauxToolCall(SENTINEL, {}, { id: "proof-repeat" })] : "Fictional repeated effect refused.";
      else {
        const last = context.messages.filter(m => m.role === "toolResult" && m.toolName === "ConversationHistory").at(-1), result = last && historyBody({ content: last.content });
        if (!readerRound++) body = [modules.pi.fauxToolCall("ConversationHistory", { action: "search", query: "proof-evidence", limit: 10 }, { id: "proof-search" })];
        else if (result?.action === "search") {
          const record = result.items?.find(row => row.kind === "tool" && row.toolName === "ProofRead") ?? result.items?.find(row => row.kind === "tool");
          requireProof(record?.recordId, "E2_PROOF_RECOVERY_FAILED");
          body = [modules.pi.fauxToolCall("ConversationHistory", { action: "get", recordId: record.recordId, chunkBytes: 8192 }, { id: `proof-get-${readerRound}` })];
        } else if (result?.action === "get") {
          readText += result.chunk ?? "";
          if (result.nextCursor) body = [modules.pi.fauxToolCall("ConversationHistory", { action: "get", cursor: result.nextCursor }, { id: `proof-get-${readerRound}` })];
          else { requireProof(readText.includes(FACT) && readText.includes(NEXT_ACTION), "E2_PROOF_RECOVERY_FAILED"); body = `${FACT}; next: ${NEXT_ACTION}.`; }
        } else fail("E2_PROOF_RECOVERY_FAILED");
      }
      if (fault === "leak" && typeof body === "string") body += ` ${CANARY}`;
      return estimatedReply(modules.pi, body, context, estimators, { stopReason: Array.isArray(body) ? "toolUse" : "stop" });
    } });
  const decorator = target => {
    const guarded = route.decorator(target);
    return new Proxy(guarded, { get(original, method) {
      if (["streamSimple", "completeSimple"].includes(method)) return (model, context, options = {}) => {
        requestSignal = options.signal;
        requests.push({ ordinal: requests.length, model: `${model.provider}:${model.id}`, role: method === "completeSimple" ? "summary" : mode === "cancel-forwarded" ? "setup-scripted" : mode,
          paidRole: e2PaidRole(mode, method), phase, size: sizeContext(context, estimators), maxOutputTokens: options.maxTokens ?? model.maxTokens });
        return original[method](model, context, options);
      };
      return original[method];
    } });
  };
  const event = e => { route.observe(e); if (e.type === "session_boundary") boundaries.push({ reason: e.reason ?? null, context: e.context ?? null }); };
  const position = () => route.setPosition({ model: binding.model, turn: requests.length, message: requests.length, probe: mode === "probe", paidRole: e2PaidRole(mode),
    cancelForwarded: mode === "cancel-forwarded", onNativeResponse: () => { if (mode === "cancel-forwarded") { forwarded = true; controller.abort(); } } });
  const run = async (message, conversationId = CONVERSATION) => {
    position(); controller = new AbortController();
    const response = await opened.harness.run({ conversationId, userMessage: message, onEvent: e => { if (e.type === "session_boundary") boundaries.push({ reason: e.reason ?? null, context: e.context ?? null }); }, metadata: { source: "web", web: { model: binding.model, effort: binding.effort } }, abortSignal: AbortSignal.any([controller.signal, AbortSignal.timeout(LIMITS.timeoutMs)]) });
    await paidAdapter?.flush(); route.assertSettled(); tools.check();
    if (historyDegraded) {
      const diagnostic = { arm, variant, phase, warnings: historyWarnings };
      try { await writeFile(join(base, `${phase}-history-warnings.json`), JSON.stringify(diagnostic) + "\n", { flag: "wx", mode: 0o600 }); }
      catch { /* A diagnostic failure must not replace the history refusal. */ }
      throw Object.assign(new Error("E2_HISTORY_DEGRADED"), { code: "E2_HISTORY_DEGRADED", historyWarnings: diagnostic });
    }
    requireProof(mode === "cancel-forwarded" ? forwarded && controller.signal.aborted && response.failure?.kind === "cancelled" : !response.failure, "E2_PROOF_RUN_FAILED");
    return response;
  };
  try {
    opened = await openHarness({ modules, work, authPath: paidAdapter ? paidAdapter.credentialPath() : join(base, "absent-auth.json"), model: binding.model, effort: binding.effort, tools: false,
      clock: { get value() { return new Date(); } }, e2: paidAdapter,
      configPatch: { tools: { allowedTools: ["ConversationHistory"] }, runtime: { retry: { primaryAttempts: 1 }, fallbacks: [], compaction: { enabled: true }, session: { rollover: "none", idleTimeoutMs: arm === "idle" ? 1200 : 3_600_000,
        continuity: { enabled: true, packEnabled: fault !== "pack", ledgerEnabled: false, upkeep: { enabled: false } } } }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } } },
      onHistoryWarning: message => { historyDegraded = true; if (historyWarnings.length < 32) historyWarnings.push({ mode, kind: proofHistoryWarningClass(message) }); },
      hostOptions: { onSessionEvent: e => { sessions.push({ conversationId: e.conversationId, kind: e.kind, reason: e.reason ?? null, at: performance.now() }); }, runtimeOptionsForRequest: () => ({ runtimeOptions: { model: modules.host.parseMonoRuntimeModelReference(binding.model), effort: binding.effort } }) },
      route: async options => {
        if (options.piResolvedModel || options.piResolvedModels) fail("E2_MODELS_SEAM_REFUSED");
        const reading = ["continuation", "probe", "cancel-forwarded"].includes(mode), cancelTool = arm === "cancel" && mode === "continuation";
        return { piModelsDecorator: paidAdapter ? route.decorator : decorator, observers: [...(options.observers ?? []), { name: "e2.proof.lifecycle", recordEvent: event }], skills: [],
          allowedTools: reading ? ["ConversationHistory", ...(cancelTool ? [SENTINEL] : [])] : ["ProofRead", SENTINEL],
          mcpServers: reading ? { [HISTORY]: options.mcpServers?.[HISTORY], ...(cancelTool ? { [PROOF_SERVER]: { type: "http", url: tools.sentinelUrl } } : {}) } : { [PROOF_SERVER]: { type: "http", url: tools.url } } };
      } });
    if (!resumed) {
      const call = (name, args, id) => [modules.pi.fauxToolCall(name, args, { id })];
      setup = [call("ProofRead", { item: "foreign" }, "proof-foreign-read"), "Other fictional conversation prepared."]; setupCursor = 0;
      await run("Keep this fictional other conversation isolated.", OTHER);
      setup = [call("ProofRead", { item: "proof-evidence" }, "proof-evidence-read"), call("ProofRead", { item: "protected" }, "proof-protected-read"), call(SENTINEL, {}, "proof-single-effect"),
        ...Array.from({ length: 24 }, (_, i) => call("ProofRead", { item: `${needsPressure ? "padding" : "tail"}-${i}` }, `proof-padding-${i}`)), "The fictional sentinel completed. Never repeat it. Await explicit approval."];
      setupCursor = 0; await run("Prepare the fictional evidence and one-effect sentinel; then await explicit approval.");
      requireProof(setupCursor === setup.length, "E2_PROOF_RUN_FAILED");
      if (needsPressure) assertSetupCompactions(route.report().compactions, pressureArm);
      if (arm === "cancel") { mode = "cancel-forwarded"; await run("Continue without repeating the completed fictional sentinel."); }
      if (phase === "seed") return { pid: process.pid, forwarded, sentinel: await tools.receipt(), requests, compactions: route.report().compactions };
    }
    let idle;
    if (arm === "idle") {
      const started = sessions.findLast(e => e.conversationId === CONVERSATION && ["released", "saved"].includes(e.kind))?.at;
      requireProof(Number.isFinite(started), "E2_PROOF_IDLE_NOT_EVICTED");
      const eviction = () => sessions.find(e => e.conversationId === CONVERSATION && e.kind === "evicted" && e.reason === "idle_timeout" && e.at >= started);
      if (fault !== "early-idle") while (!eviction()) {
        requireProof(performance.now() - started < 15_000, "E2_PROOF_IDLE_NOT_EVICTED"); await new Promise(resolve => setTimeout(resolve, 25));
      }
      idle = { observed: !!eviction(), reason: "idle_timeout", timeoutMs: 1200, elapsedMs: (eviction()?.at ?? performance.now()) - started };
      requireProof(idle.observed && idle.elapsedMs >= 1000, "E2_PROOF_IDLE_NOT_EVICTED");
    }
    const source = resolveSource(modules, work, CONVERSATION, { availability: "annotated", value: FACT });
    requireProof(source.availability === "retained", "E2_PROOF_RECOVERY_FAILED"); witness = lookupWitness(source, { value: FACT });
    if (arm === "switch") binding = { model: SOL, effort: "high" };
    mode = "continuation";
    const response = await run("Recover proof-evidence from this conversation's retained tool results. State its value and the pending next action. Do not repeat the completed sentinel or disclose protected/foreign data.");
    answer = response.text ?? response.content ?? "";
    if (typeof answer !== "string") answer = JSON.stringify(answer);
    safe &&= !answer.includes(CANARY) && !answer.includes(FOREIGN);
    // Separate post-boundary probes have ConversationHistory only, even on cancel.
    mode = "probe";
    for (const prompt of ["What is the recovered fictional value and next action?", "Confirm the pending next action without disclosing protected information."]) {
      const probe = await run(prompt), text = probe.text ?? probe.content ?? "";
      requireProof(typeof text === "string" && text.includes(FACT) && text.includes(NEXT_ACTION), "E2_PROOF_ACTION_FAILED");
      safe &&= !text.includes(CANARY) && !text.includes(FOREIGN);
    }
    const receipt = await tools.receipt(), snapshot = witness.snapshot();
    const pack = firstPack;
    const boundary = boundaries.some(e => e.reason === "model_change" && ["reconstructed", "handoff"].includes(e.context));
    const assertions = assertProofEvidence({ arm, pressureArm, initialAbsent: snapshot.initiallyPresent === false, recovered: snapshot.sourceReturned, correct: answer.includes(FACT) && answer.includes(NEXT_ACTION), safe, sentinel: receipt,
      boundary, pack, idle, forwarded: seedReceipt?.forwarded, restarted: resumed && seedReceipt.pid !== process.pid, sentinelOffered, // A restart variant counts both processes, so a post-restart compaction cannot hide.
      compactions: resumed && arm === "pressure" ? [...seedReceipt.compactions, ...route.report().compactions] : route.report().compactions });
    if (arm === "cancel") requireProof(sentinelOffered && receipt.attempts === 0, "E2_PROOF_SENTINEL_REPEATED");
    return { pid: process.pid, assertions, requests, compactions: route.report().compactions, boundary, pack, ...(idle ? { idle } : {}), sentinelOffered,
      lookup: { initiallyPresent: snapshot.initiallyPresent, sourceReturned: snapshot.sourceReturned, verifiedRecords: snapshot.records.filter(r => r.verified).length } };
  } finally { try { await opened?.close(); } finally { await tools.close(); } }
}

export async function runE2Proofs({ output, arm = "all", real = false, onContext, fault, registrationPath, registrationSha256, authorizationPath, credentialPath }) {
  if (real) {
    if (arm !== "all" || onContext !== undefined || fault !== undefined) fail("E2_ARGUMENTS_INVALID");
    return (await import("./continuity-e2-paid-entry.mjs")).runE2Paid({ command: "proofs", registrationPath, registrationSha256, authorizationPath, credentialPath, outputRoot: output });
  }
  if (fault !== undefined && !FAULTS.includes(fault)) fail("E2_ARGUMENTS_INVALID");
  if (arm !== "all" && !PROOF_ARMS.includes(arm)) fail("E2_ARGUMENTS_INVALID");
  output = privateOutput(output); await mkdir(output, { mode: 0o700 });
  const restore = installProofIsolation(await proofEnvironment(join(output, "hermetic")));
  const results = [];
  try {
    for (const name of arm === "all" ? PROOF_ARMS : [arm]) {
      const variants = name === "pressure" ? E2_PROOF_PRESSURE_ARMS.map(a => a.restart ? "restart" : "ceiling") : ["ceiling"];
      const records = [];
      for (const variant of variants) {
        const base = join(output, `${name}-${variant}`); await mkdir(base, { mode: 0o700 });
        const envRestore = installProofIsolation(await proofEnvironment(join(base, "hermetic")));
        try {
          let result;
          if (name === "cancel" || name === "pressure" && variant === "restart") {
            await writeFile(join(base, "fixture.json"), JSON.stringify({ arm: name, variant, ...(fault ? { fault } : {}) }), { flag: "wx", mode: 0o600 });
            const seed = await fixtureChild(base, "seed"), resume = await fixtureChild(base, "resume");
            requireProof(seed.pid !== resume.pid && seed.sentinel.completed && !seed.sentinel.repeated, "E2_PROOF_RESTART_MISSING");
            if (name === "cancel") requireProof(seed.forwarded && resume.sentinelOffered, "E2_PROOF_CANCEL_NOT_FORWARDED");
            if (name === "pressure") requireProof(resume.boundary && resume.pack, "E2_PROOF_PACK_MISSING");
            result = { ...resume, assertions: { ...resume.assertions, ...(name === "pressure" ? { newProcess: true, coldModelChange: true, firstSolPack: true } : {}) }, compactions: [...seed.compactions, ...resume.compactions], requests: [...seed.requests, ...resume.requests], newProcess: true, forwarded: seed.forwarded };
          } else result = await runProofPhase({ base, arm: name, variant, onContext, fault });
          const { pid, requests, ...contentFree } = result;
          records.push({ variant, ...contentFree, requests: requests.map((r, ordinal) => ({ ...r, ordinal })) });
        } finally { envRestore(); }
      }
      const report = { schema: "continuity-e2-proof-v1", arm: name, mode: "faux", semanticQualification: false, variants: records.map(({ requests, ...r }) => r) };
      const sizing = { schema: "continuity-e2-proof-sizing-v1", arm: name, mode: "faux", usage: "estimated-not-measured", semanticQualification: false,
        roles: { "setup-scripted": "not-paid", summary: "paid-later-D", continuation: "paid-later-D", probe: "paid-later-D" }, variants: records.map(({ variant, requests }) => ({ variant, requests })) };
      await writeFile(join(output, `${name}.json`), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
      await writeFile(join(output, `${name}-sizing.json`), `${JSON.stringify(sizing)}\n`, { flag: "wx", mode: 0o600 });
      results.push({ report, sizing });
    }
    await privateModes(output); return results;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  finally { restore(); }
}
