// Offline configured replay, with snapshots restored at the same absolute root.
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fail, object, ROOT } from "./continuity-observation-input.mjs";
import { callKey, digest, validateSource } from "./continuity-recorded-schema.mjs";
import { startRecordedTools, RECORDED_SERVER_NAME } from "./continuity-recorded-tools.mjs";
import { openHarness, productionModules } from "./continuity-runner.mjs";
import { createE2Models, estimatedReply, loadE2Estimators, shippingSoul, sizeContext } from "./continuity-e2-models.mjs";
import { SOL, parts, protocolDigest, validateProtocol } from "./continuity-e2-protocol.mjs";

export const PLACEHOLDER = "[recorded result unavailable for replay]";
const HISTORY = "mono-agent-conversation-history";
const PROBE_PROMPT = "Use retained conversation evidence to continue safely. Do not perform effects.";
export async function treeReceipt(root) {
  const files = [];
  async function visit(dir, prefix) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), relative = prefix ? `${prefix}/${name}` : name, s = await lstat(path);
      if (s.isSymbolicLink() || !s.isFile() && !s.isDirectory()) fail("E2_SNAPSHOT_PATH_REFUSED");
      if (s.isDirectory()) await visit(path, relative);
      else files.push([relative, digest(await readFile(path))]);
    }
  }
  await visit(root, "");
  return { digest: digest(JSON.stringify(files)), files: files.length };
}
async function privateModes(root) {
  await chmod(root, 0o700);
  for (const name of await readdir(root)) {
    const path = join(root, name), s = await lstat(path);
    if (s.isDirectory()) await privateModes(path);
    else if (s.isFile()) await chmod(path, 0o600);
    else fail("E2_SNAPSHOT_PATH_REFUSED");
  }
}
export async function freezeCheckpoint(work, snapshot) {
  const before = await treeReceipt(work);
  await cp(work, snapshot, { recursive: true, errorOnExist: true, force: false });
  await privateModes(snapshot);
  if (JSON.stringify(await treeReceipt(snapshot)) !== JSON.stringify(before)) fail("E2_SNAPSHOT_MISMATCH");
  return before;
}
export async function restoreCheckpoint(work, snapshot, receipt) {
  if (JSON.stringify(await treeReceipt(snapshot)) !== JSON.stringify(receipt)) fail("E2_SNAPSHOT_MISMATCH");
  // The engine pins directory identities in-process. Mirror bytes without
  // replacing existing directories; never weaken the engine's ownership check.
  async function mirror(from, to) {
    const names = await readdir(from), wanted = new Set(names);
    for (const name of await readdir(to)) if (!wanted.has(name)) await rm(join(to, name), { recursive: true, force: true });
    for (const name of names) {
      const src = join(from, name), dest = join(to, name), s = await lstat(src);
      let existing; try { existing = await lstat(dest); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (existing?.isSymbolicLink() || existing && existing.isDirectory() !== s.isDirectory()) fail("E2_SNAPSHOT_PATH_REFUSED");
      if (s.isDirectory()) { if (!existing) await mkdir(dest, { mode: 0o700 }); await mirror(src, dest); }
      else await copyFile(src, dest);
    }
  }
  await treeReceipt(work); await mirror(snapshot, work);
  if (JSON.stringify(await treeReceipt(work)) !== JSON.stringify(receipt)) fail("E2_SNAPSHOT_MISMATCH");
}
function stepRow(source, step) {
  return source.web.messages.find(row => row.id === step.messageId) ?? source.web.messages.find(row => step.calls.some(index => source.tools[index].provenance.some(p => p.source === "web" && p.messageId === row.id)));
}
export function recordedTurns(source) {
  validateSource(source);
  const journals = new Map((source.journal?.records ?? []).map(r => [r.id, r]));
  const byMessage = new Map();
  for (const [index, step] of source.steps.entries()) {
    const row = stepRow(source, step);
    if (!row) fail("E2_ASSISTANT_SOURCE_UNAVAILABLE");
    if (!byMessage.has(row.id)) byMessage.set(row.id, []);
    byMessage.get(row.id).push({ index, step });
  }
  return source.web.turns.map((turn, ordinal) => {
    const rows = source.web.messages.filter(row => row.turn_id === turn.id);
    const steeredRows = new Set(rows.filter(row => row.role === "assistant").flatMap(row => parts(row).filter(p => p.type === "steer").map(p => p.messageId)));
    const user = rows.filter(row => row.role === "user" && !steeredRows.has(row.id));
    // Inline steer markers identify duplicate standalone owner rows. Never
    // coalesce unrelated owners or invent attachment bytes.
    if (user.length !== 1) fail("E2_OWNER_SOURCE_UNAVAILABLE");
    const userParts = parts(user[0]);
    if (userParts.some(p => !["text", "attachment"].includes(p.type))) fail("E2_OWNER_SOURCE_UNAVAILABLE");
    const replies = []; const assignedSteers = new Set();
    for (const row of rows.filter(r => r.role === "assistant")) {
      const raw = parts(row), grouped = byMessage.get(row.id) ?? [];
      if (!grouped.length) {
        const content = visibleParts(raw); if (content.length) replies.push({ content, steers: raw.filter(p => p.type === "steer"), step: null, calls: [], message: source.web.messages.indexOf(row) });
        continue;
      }
      let end = -1;
      for (const [groupIndex, { index, step }] of grouped.entries()) {
        const native = journals.get(step.messageId)?.payload?.message;
        const selected = raw.slice(step.partStartIndex ?? 0, (step.partEndIndex ?? raw.length - 1) + 1);
        const content = native?.role === "assistant" && Array.isArray(native.content) ? structuredClone(native.content) : visibleParts(selected);
        // The importer-selected model arguments are authoritative, not web's
        // host-enriched arguments. Calls keep their original names and ids.
        const calls = [];
        for (const toolIndex of step.calls) {
          const t = source.tools[toolIndex];
          if (!object(t.args)) fail("E2_RECORDED_ARGUMENTS_UNAVAILABLE");
          calls.push({ type: "toolCall", id: t.id, name: t.name, arguments: structuredClone(t.args) });
        }
        const blocks = native ? content.map(p => {
          if (p.type !== "toolCall") return p;
          const call = calls.find(c => c.id === p.id); if (call) return call;
          const outcome = source.outcomes.find(o => o.toolCallId === p.id);
          if (p.name === "Agent" && outcome) return { type: "text", text: `[recorded parent-visible subagent outcome]\n${Object.hasOwn(outcome, "result") ? JSON.stringify(outcome.result) : "[outcome unavailable]"}` };
          fail("E2_ASSISTANT_SOURCE_UNAVAILABLE");
        }) : [...content, ...calls];
        const next = grouped[groupIndex + 1]?.step;
        const nextPart = next ? Math.min(...next.calls.flatMap(c => source.tools[c].provenance.filter(p => p.source === "web" && p.messageId === row.id).map(p => p.partIndex))) : raw.length;
        const steers = (native ? raw.slice(end + 1, nextPart) : selected).filter(p => p.type === "steer" && !assignedSteers.has(p.inputId));
        for (const steer of steers) assignedSteers.add(steer.inputId);
        replies.push({ content: blocks, steers, step: index, calls: step.calls, message: source.web.messages.indexOf(row) });
        const lastCallPart = Math.max(-1, ...step.calls.flatMap(c => source.tools[c].provenance.filter(p => p.source === "web" && p.messageId === row.id).map(p => p.partIndex)));
        end = Math.max(end, step.partEndIndex ?? lastCallPart);
      }
      const tail = visibleParts(raw.slice(end + 1));
      if (tail.length) replies.push({ content: tail, step: null, calls: [], message: source.web.messages.indexOf(row) });
    }
    if (!replies.length || replies.at(-1).calls.length) replies.push({ content: [], step: null, calls: [], message: source.web.messages.indexOf(rows.at(-1)) });
    return { ordinal, id: turn.id, user: userParts.map(p => p.type === "attachment" ? "[recorded attachment bytes unavailable]" : p.text ?? "").join("\n"), cancelled: ["cancelled", "canceled"].includes(turn.status), replies };
  });
}
function visibleParts(raw) {
  return raw.flatMap(p => p.type === "text" && typeof p.text === "string" ? [{ type: "text", text: p.text }]
    : p.type === "reasoning" && typeof (p.text ?? p.reasoning) === "string" ? [{ type: "thinking", thinking: p.text ?? p.reasoning }]
    : (p.type === "subagent" || p.type === "tool-call" && p.toolName === "Agent") && Object.hasOwn(p, "result") ? [{ type: "text", text: `[recorded parent-visible subagent outcome]\n${typeof p.result === "string" ? p.result : JSON.stringify(p.result)}` }] : []);
}
export function excludedDispatch(source, excludedSteps) {
  const excluded = new Set(excludedSteps), placeholder = { content: [{ type: "text", text: PLACEHOLDER }], isError: true };
  let pending = [], placeholderCalls = 0;
  return {
    begin(stepIndex, calls) {
      if (pending.length) fail("E2_TOOL_CALL_MISMATCH");
      pending = calls.map(index => ({ index, excluded: excluded.has(stepIndex) }));
    },
    dispatch(name, args, queue) {
      const at = pending.findIndex(p => callKey(source.tools[p.index].name, source.tools[p.index].args) === callKey(name, args));
      if (at < 0) fail("E2_TOOL_CALL_MISMATCH");
      const [next] = pending.splice(at, 1);
      if (next.excluded) { placeholderCalls++; return structuredClone(placeholder); }
      return queue.dispatch(name, args);
    },
    assertSettled() { if (pending.length) fail("E2_TOOL_CALL_MISMATCH"); },
    count: () => placeholderCalls,
  };
}
function exclusions(source, branch) {
  const steps = new Set(branch.exclusions.steps), coverage = new Set(branch.exclusions.coverage);
  for (const index of coverage) {
    const gap = source.coverage[index];
    if (gap.tier !== "replay") continue;
    for (const [i, step] of source.steps.entries()) {
      if (gap.location.stepIndex === i || ["turnId", "messageId"].some(k => gap.location[k] !== undefined && gap.location[k] === step[k])
        || step.calls.some(c => source.tools[c].id === gap.location.toolCallId || source.tools[c].provenance.some(p => ["turnId", "messageId"].some(k => gap.location[k] !== undefined && p[k] === gap.location[k])))) steps.add(i);
    }
  }
  return { steps: [...steps], coverage: [...coverage] };
}

/** No real routes, credential lookup overrides, or resolved-model overrides. */
export async function runE2Sizing({ source, protocol, output, summary = "faux-short", modules, onContext = () => {} }) {
  if (summary === "real") fail("E2_PAID_ENTRY_UNAVAILABLE");
  protocol = validateProtocol(protocol, source);
  const turns = recordedTurns(source), estimators = await loadE2Estimators(), soul = await shippingSoul();
  modules ??= await productionModules(ROOT);
  const report = { schema: "continuity-e2-sizing-v1", sourceDigest: digest(JSON.stringify(source)), protocolDigest: protocolDigest(protocol), summary,
    soul: { rawDigest: soul.rawDigest, normalizedDigest: soul.normalizedDigest }, usage: "estimated-not-measured", semanticQualification: false, branches: [] };
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [branchIndex, branch] of protocol.branches.entries()) {
      const base = join(output, `branch-${branchIndex}`), work = join(base, "work"), snapshots = join(base, "snapshots");
      await mkdir(work, { recursive: true, mode: 0o700 }); await mkdir(snapshots, { mode: 0o700 });
      await writeFile(join(work, "IDENTITY.md"), "Fictional isolated recorded-replay reader.\n", { mode: 0o600 });
      const excluded = exclusions(source, branch), active = new Set(turns.slice(branch.startTurn, branch.endTurn + 1).flatMap(t => t.replies.map(r => r.step).filter(i => i !== null)));
      const skipped = [...new Set([...excluded.steps, ...source.steps.map((_, i) => i).filter(i => !active.has(i))])];
      const dispatch = excludedDispatch(source, excluded.steps);
      const server = await startRecordedTools({ source, excludedSteps: skipped, excludedCoverage: excluded.coverage, dispatch: dispatch.dispatch });
      let opened, currentTurn, turnController, steerWaiter, pendingSteers = [], steerCount = 0, cursor = 0, binding = branch.models[0], position, firstProbeContext, probeMode = false, probeRound = 0, probeRequests = 0;
      const observed = [], historyExcluded = new Set(), observedTools = new Set(), toolIndices = new Map(source.tools.map((t, i) => [t.id, i]));
      const route = createE2Models({ pi: modules.pi, estimators, models: branch.models, limits: branch.limits, summary, soul,
        sourceContext(context) {
          if (!probeMode && pendingSteers.length) {
            const users = context.messages.filter(m => m.role === "user").slice(-pendingSteers.length).map(m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n")).join("\n");
            if (pendingSteers.some(text => !users.includes(text))) fail("E2_STEER_NOT_DELIVERED");
            pendingSteers = [];
          }
          const served = probeMode ? null : new Set(server.queue.report().served);
          if (!probeMode) for (const message of context.messages.filter(m => m.role === "toolResult")) {
            const index = toolIndices.get(message.toolCallId);
            if (index !== undefined && !observedTools.has(index) && served.has(index)) {
              server.queue.observe(index, message.content); observedTools.add(index);
            }
          }
          onContext({ branch: branchIndex, probe: probeMode, context });
          if (probeMode) {
            if (++probeRequests > branch.limits.probeRequests) fail("E2_PROBE_REQUEST_LIMIT");
            firstProbeContext ??= sizeContext(context, estimators);
            const offered = context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []);
            if (offered.length !== 1 || offered[0].name !== "ConversationHistory") fail("E2_PROBE_TOOLS_REFUSED");
          }
        },
        async sourceReply(context) {
          if (probeMode) {
            const offered = context.tools ?? context.messages.flatMap(m => m.toolsAdded ?? []);
            const body = probeRound++ === 0 ? [modules.pi.fauxToolCall(offered[0].name, { action: "search", query: "retained", limit: 1 }, { id: "e2-probe-history" })] : "Faux probe continuation; semantic correctness is not evaluated.";
            return estimatedReply(modules.pi, body, context, estimators, { stopReason: probeRound === 1 ? "toolUse" : "stop" });
          }
          dispatch.assertSettled();
          const reply = currentTurn.replies[cursor++]; if (!reply) fail("E2_SOURCE_REQUEST_LIMIT");
          dispatch.begin(reply.step, reply.calls);
          for (const steer of reply.steers ?? []) {
            if (typeof steer.text !== "string" || !steer.text || typeof steer.inputId !== "string") fail("E2_STEER_INVALID");
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { steerWaiter = null; reject(Object.assign(new Error("E2_STEER_NOT_DELIVERED"), { code: "E2_STEER_NOT_DELIVERED" })); }, branch.limits.timeoutMs);
              steerWaiter = () => { clearTimeout(timer); steerWaiter = null; resolve(); };
              const result = opened.harness.offerLiveInput({ conversationId: source.conversationId, id: steer.inputId, text: steer.text, ownerText: steer.text, receivedAt: steer.receivedAt ?? "2042-03-01T09:00:00.000Z" });
              if (result?.status !== "accepted") { clearTimeout(timer); steerWaiter = null; reject(Object.assign(new Error("E2_STEER_REFUSED"), { code: "E2_STEER_REFUSED" })); }
            });
            pendingSteers.push(steer.text); steerCount++;
          }
          if (excluded.steps.includes(reply.step)) historyExcluded.add(reply.step);
          return estimatedReply(modules.pi, reply.content, context, estimators,
            { stopReason: reply.calls.length ? "toolUse" : "stop" });
        } });
      const onEvent = event => {
        if (!probeMode && currentTurn?.cancelled && cursor === currentTurn.replies.length && event.type === "assistant_message_boundary") turnController.abort();
        if (probeMode && event.type === "context_compaction" && event.status === "running") fail("E2_PROBE_SUMMARY_FORBIDDEN");
        route.observe(event);
        };
      const onHostEvent = event => { if (event.type === "live_input_native_accepted") steerWaiter?.(); if (event.type === "session_boundary") observed.push({ turn: position.turn, reason: event.reason, context: event.context }); };
      const open = async () => {
        opened = await openHarness({ modules, work, authPath: join(base, "absent-auth.json"), model: branch.models[0].model, effort: branch.models[0].effort,
          clock: { value: new Date("2042-03-01T09:00:00Z") }, tools: false,
          configPatch: { runtime: { retry: { primaryAttempts: 1 }, fallbacks: [], compaction: { enabled: true }, session: { continuity: { enabled: true, ledgerEnabled: false, upkeep: { enabled: false } } } },
            tools: { allowedTools: probeMode ? ["ConversationHistory"] : [] }, providers: { piNative: { transport: "sse", piMaxRetries: 0 } } },
          onHistoryWarning: () => fail("E2_HISTORY_DEGRADED"),
          hostOptions: { runtimeOptionsForRequest: () => ({ runtimeOptions: { model: modules.host.parseMonoRuntimeModelReference(binding.model), effort: binding.effort } }) },
          route: async options => {
            if (options.piResolvedModel || options.piResolvedModels) fail("E2_MODELS_SEAM_REFUSED");
            return { piModelsDecorator: route.decorator, observers: [...(options.observers ?? []), { name: "e2.lifecycle", recordEvent: onEvent }],
              allowedTools: probeMode ? ["ConversationHistory"] : [], skills: [],
              mcpServers: probeMode ? { [HISTORY]: options.mcpServers?.[HISTORY] } : { [RECORDED_SERVER_NAME]: { type: "http", url: server.url } } };
          } });
      };
      const branchReport = { branch: branchIndex, models: branch.models, limits: branch.limits, boundaries: [], checkpoints: [], excludedSteps: excluded.steps.length, excludedCoverage: excluded.coverage.length };
      try {
        await open(); let modelIndex = 0;
        for (const turn of turns.slice(branch.startTurn, branch.endTurn + 1)) {
          currentTurn = turn; cursor = 0;
          const transitions = branch.transitions.filter(t => t.turn === turn.ordinal);
          for (const t of transitions) {
            if (t.kind === "cold_model_switch") binding = branch.models[++modelIndex];
            if (t.kind === "effort_only_non_boundary") binding = { ...binding, effort: t.effort };
            if (t.kind === "manual_compaction_skipped") {
              const next = branch.models[modelIndex + 1]; if (!next) fail("E2_BOUNDARY_MISMATCH");
              const skippedResult = await opened.harness.compactConversation(source.conversationId, { model: next.model });
              if (skippedResult.status !== "skipped" || skippedResult.reason !== "model_changed") fail("E2_BOUNDARY_MISMATCH");
              branchReport.boundaries.push({ turn: turn.ordinal, kind: t.kind, durableCompaction: false });
            }
          }
          position = { turn: turn.ordinal, message: turn.replies[0].message, model: binding.model }; route.setPosition(position);
          const before = observed.length; turnController = new AbortController();
          const response = await opened.harness.run({ conversationId: source.conversationId, userMessage: turn.user,
            metadata: { source: "web", web: { model: binding.model, effort: binding.effort } }, onEvent: onHostEvent, abortSignal: AbortSignal.any([turnController.signal, AbortSignal.timeout(branch.limits.timeoutMs)]) });
          route.assertSettled(); dispatch.assertSettled();
          if (pendingSteers.length || steerWaiter) fail("E2_STEER_NOT_DELIVERED");
          if (cursor !== turn.replies.length || turn.cancelled && (!turnController.signal.aborted || response.failure?.kind !== "cancelled") || response.failure && !(turn.cancelled && response.failure.kind === "cancelled")) fail("E2_REPLAY_FAILED");
          const actual = observed.slice(before).filter(e => ["model_change", "cancelled_turn_resume"].includes(e.reason));
          const expected = transitions.filter(t => ["cold_model_switch", "warm_cancel_resume"].includes(t.kind));
          if (actual.length !== expected.length || actual.some((e, i) => e.reason !== (expected[i].kind === "cold_model_switch" ? "model_change" : "cancelled_turn_resume")
            || expected[i].kind === "warm_cancel_resume" && e.context !== "retained"
            || expected[i].kind === "cold_model_switch" && !["reconstructed", "handoff"].includes(e.context))) fail("E2_BOUNDARY_MISMATCH");
          branchReport.boundaries.push(...expected.map(t => ({ turn: t.turn, kind: t.kind })), ...transitions.filter(t => t.kind === "effort_only_non_boundary").map(t => ({ turn: t.turn, kind: t.kind })));
          for (const checkpoint of branch.checkpoints.filter(c => c.turn === turn.ordinal)) {
            if (binding.model !== SOL || binding.effort !== "high") fail("E2_CHECKPOINT_MODEL_INVALID");
            // A named message must be the completed turn's last assistant row.
            if (checkpoint.message !== turn.replies.at(-1).message) fail("E2_CHECKPOINT_POSITION_INVALID");
            await opened.close(); opened = null;
            const snapshot = join(snapshots, `checkpoint-${branchReport.checkpoints.length}`), receipt = await freezeCheckpoint(work, snapshot);
            const measured = { checkpoint: branchReport.checkpoints.length, turn: turn.ordinal, message: checkpoint.message, snapshot: receipt,
              excludedStepsInHistory: [...historyExcluded].sort((a, b) => a - b),
              excludedCoverageInHistory: [...new Set([...excluded.coverage, ...source.coverage.map((g, i) => g.tier === "item" ? i : null).filter(i => i !== null)])].filter(i => {
                const location = source.coverage[i].location;
                const referenced = source.web.turns.findIndex(t => t.id === location.turnId || source.web.messages.some(m => m.id === location.messageId && m.turn_id === t.id));
                return referenced < 0 || referenced <= turn.ordinal;
              }), summaryChainRequests: route.report().summaryRequests.length, probes: [] };
            for (const repeat of [1, 2]) {
              await restoreCheckpoint(work, snapshot, receipt); probeMode = true; probeRound = 0; firstProbeContext = null;
              route.setPosition({ ...position, model: binding.model, probe: true }); await open();
              const response = await opened.harness.run({ conversationId: source.conversationId, userMessage: PROBE_PROMPT,
                metadata: { source: "web", web: { model: binding.model, effort: binding.effort } }, onEvent: onHostEvent, abortSignal: AbortSignal.timeout(branch.limits.timeoutMs) });
              route.assertSettled();
              if (response.failure || !firstProbeContext || probeRound !== 2) fail("E2_PROBE_FAILED");
              await opened.close(); opened = null;
              measured.probes.push({ repeat, initialContext: firstProbeContext, snapshotDigest: receipt.digest, requests: probeRound });
            }
            await restoreCheckpoint(work, snapshot, receipt); probeMode = false;
            branchReport.checkpoints.push(measured); await open();
          }
        }
        if (server.queue.report().pending) fail("E2_TOOL_CALL_MISMATCH");
        const transport = server.queue.report();
        Object.assign(branchReport, route.report(), { transport: { observed: transport.observations.length, possiblyClipped: transport.observations.filter(o => o.possiblyClipped).length,
          representationDifferences: transport.observations.filter(o => o.representationDifference).length, unobserved: transport.served.length - observedTools.size }, placeholderCalls: dispatch.count(), steerCount, probeRequests });
        report.branches.push(branchReport);
      } finally { try { await opened?.close(); } finally { await server.close(); } }
    }
    await privateModes(output);
    await writeFile(join(output, "sizing.json"), `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
    return report;
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
