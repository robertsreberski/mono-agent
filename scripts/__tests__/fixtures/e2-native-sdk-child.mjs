// Assigned SDK financial-boundary fixture. The phase actor, guard, IPC and send are production code.
import { readFile, mkdir } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { verifyE2Assignment, createE2PhaseAdapter } from "../../lib/continuity-e2-runtime.mjs";
import { productionModules } from "../../lib/continuity-runner.mjs";
import { loadE2Estimators, shippingSoul, createE2Models } from "../../lib/continuity-e2-models.mjs";
import { e2PhaseWork, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX } from "../../lib/continuity-e2-lineage.mjs";
import { JsonlSessionRepo } from "../../../packages/turn/dist/engine/session-store.js";
const profile = JSON.parse(await readFile(process.argv[2], "utf8"));
const assignment = once(process, "message"); process.send({ type: "loaded" }); const [a] = await assignment;
await verifyE2Assignment(a, false); const go = once(process, "message"); process.send({ type: "ready", epoch: a.epoch, slotId: a.slotId }); await go;
const actor = await createE2PhaseAdapter(a), work = e2PhaseWork(a.outputRoot, a.slot); await mkdir(work, { recursive: true, mode: 0o700 });
actor.assertConfig({ runtime: { workspace: work, model: { provider: "openai-codex", model: "gpt-6.1-sol" }, compaction: { enabled: true }, retry: { primaryAttempts: 1 }, fallbacks: [],
  session: { continuity: { ledgerEnabled: false, upkeep: { enabled: false } } } }, providers: { piAuthPath: a.authorization.credentialPath, piNative: { transport: "sse", piMaxRetries: 0 } }, tools: { allowedTools: ["ConversationHistory"] } });
const modules = await productionModules(profile.root), models = modules.pi.builtinModels(), model = models.getModel("openai-codex", "gpt-6.1-sol");
const context = { systemPrompt: "Fictional SDK boundary.", messages: [{ role: "user", content: "FICTIONAL-CONTEXT-CANARY", timestamp: 1 }] };
const opts = { transport: "sse", maxRetries: 0, reasoning: "high", maxTokens: 128000 };
actor.setPosition({ model: "openai-codex:gpt-6.1-sol", turn: 0, message: 0 });
let outcome = { terminal: "completed", score: 1, refusalCode: null }, caught = null;
try {
  if (["direct-model", "alternate-stream"].includes(profile.scenario)) {
    const route = createE2Models({ pi: modules.pi, estimators: await loadE2Estimators(), soul: await shippingSoul(), models: [{ model: "openai-codex:gpt-6.1-sol" }],
      limits: { sourceRequests: 8, probeRequests: 8, summaryRequests: 8, summaryRequestsPerCompaction: 2, compactions: 8 }, summary: "real", paidAdapter: actor });
    const facade = route.decorator(models);
    if (profile.scenario === "direct-model") facade.getProvider("openai-codex").streamSimple(model, context, opts);
    else facade.streamDeferred(model, context, opts);
  } else if (profile.scenario === "unauthorized-summary") await actor.stream(models, model, context, { ...opts, cacheRetention: "none" }, "summary").result();
  else if (["summary", "lineage-tamper"].includes(profile.scenario)) {
    actor.observe({ type: "context_compaction", status: "running", operationId: "fictional-operation" });
    const message = await actor.stream(models, model, context, { ...opts, cacheRetention: "none" }, "summary").result(), text = message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
    const repo = new JsonlSessionRepo({ sessionsRoot: join(work, "sessions") }), session = await repo.create({ id: "fictional-session", cwd: work });
    await session.beginTurn("fictional-turn"); await session.openOperation("fictional-native-operation", { model: { provider: model.provider, id: model.id, api: model.api } });
    await session.appendCompaction({ summary: text, retainedTail: [], tokensBefore: 100, details: { readFiles: [], modifiedFiles: [] } });
    await session.closeOperation("fictional-native-operation", "completed"); await session.endTurn("fictional-turn", "completed"); await session.sync(); await session.close(); await repo.close();
    actor.observe({ type: "context_compaction", status: "succeeded", operationId: "fictional-operation" }); await actor.flush();
    await actor.stream(models, model, { ...context, messages: [{ role: "user", content: E2_SUMMARY_PREFIX + text + (profile.scenario === "lineage-tamper" ? " altered" : "") + E2_SUMMARY_SUFFIX, timestamp: 1 }] }, opts, "probe").result();
  } else if (profile.scenario === "cancel") {
    const abort = new AbortController(); actor.setPosition({ model: "openai-codex:gpt-6.1-sol", turn: 0, message: 0, cancelForwarded: true, onNativeResponse: () => abort.abort() });
    try { await actor.stream(models, model, context, { ...opts, signal: abort.signal }, "continuation").result(); } catch (error) { if (!abort.signal.aborted) throw error; }
    outcome = { terminal: "own_abort_after_send", score: null, refusalCode: null };
  } else for (let i = 0; i < (profile.requests ?? 1); i++) await actor.stream(models, model, context, opts, "probe").result();
} catch (error) {
  caught = error.code;
  const code = error.code === "E2_MODELS_METHOD_REFUSED" ? "e2_method_forbidden" : error.code;
  await actor.stop(code); outcome = ["e2_method_forbidden", "e2_summary_not_authorized", "not_admitted_cap", "not_admitted_input_envelope", "e2_request_limit"].includes(code)
    ? { terminal: "refused_pre_send", score: null, refusalCode: code } : { terminal: "lost", score: null, refusalCode: null };
} finally { actor.close(); }
const ack = once(process, "message"); process.send({ type: "done", epoch: a.epoch, slotId: a.slotId, ...outcome, caught }); await ack; process.disconnect();
