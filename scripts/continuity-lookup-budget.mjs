#!/usr/bin/env node
// Offline sizing only. External artifacts contain sizes, hashes, IDs and classifications, not text.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { armById } from "./lib/continuity-arms.mjs";
import { digest, loadTraces, makePlan, traceTokenShape } from "./lib/continuity-dataset.mjs";
import { LOOKUP_MODE, LOOKUP_DEFAULT_ARMS, LOOKUP_BUDGET, SOUL_BINDING, referenceFeasibility, externalPathFeasibility, sourceAnnotation, LOOKUP_ROLES, LOOKUP_SOULS, assertFixedBudget, assertExternalPolicy, sha256 } from "./lib/continuity-lookup.mjs";
import { lookupWorkload, prepareLookupCodes, requireLookup } from "./lib/continuity-lookup-roles.mjs";
import { parseLookupOptions, workloadOptions, WORKLOAD_FLAGS, lookupOutputPath } from "./continuity-lookup-compare.mjs";
import { buildCheckpoint, productionModules, runProbe } from "./lib/continuity-runner.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const MAX_TURNS = 100;
export const CALL_CAP = Math.min(96, MAX_TURNS - 2);
export const BYTE_CAP = 8 * 1024 * 1024;
export function freezeBudget(inventory) {
  const paths = inventory.paths;
  if (!paths.length) throw new Error("empty_lookup_inventory");
  const callBudget = Math.min(CALL_CAP, Math.max(...paths.map(path => path.calls)) + 2);
  const largestResponse = Math.max(...paths.flatMap(path => path.responseBytes));
  const maxPathBytes = Math.max(...paths.map(path => path.bytes));
  const byteBudget = Math.min(BYTE_CAP, Math.ceil((maxPathBytes + 2 * largestResponse) / 1024) * 1024);
  const budget = { schema: "continuity-lookup-budget-v1", status: "frozen", protocol: "query-first-packed-id-otherwise-one-source-query-10-and-8192-get-v1",
    callBudget, byteBudget, contextWindowTokens: 272000, contextMarginTokens: 16000,
    feasibilityTokenBound: "observed-initial-context-json-bytes/3-or-trace-estimate; one-token-per-response-byte-plus-300-per-round; native-at-least-150000-every-round",
    corpus: inventory.corpus, soul: SOUL_BINDING, inventorySha256: digest(inventory),
    measurement: { paths: paths.length, largestResponse, maxPathBytes, maxPathCalls: Math.max(...paths.map(path => path.calls)),
      retainedSizes: distribution(inventory.retained.map(row => row.retainedBytes)), responseSizes: distribution(paths.flatMap(path => path.responseBytes)) } };
  budget.paths = paths.map(path => ({ traceId: path.traceId, probeId: path.probeId, arm: path.arm, sourceSha256: path.sourceSha256,
    calls: path.calls, bytes: path.bytes, cumulativeBytes: path.cumulativeBytes, discovered: path.discovered, initialContextBytes: path.initialContextBytes ?? null, initialTokens: path.initialTokens, admissionCap: path.admissionCap,
    feasibility: referenceFeasibility(path, budget, { initialTokens: path.initialTokens, admissionCap: path.admissionCap }) }));
  return budget;
}
export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] ?? null, max: sorted.at(-1) ?? null };
}

function retainedInventory(modules, checkpoint) {
  const reader = new modules.conversation.ToolHistoryReader(join(checkpoint.work, "history"));
  const scope = { logicalConversationId: checkpoint.record.conversationId, currentConversationId: checkpoint.record.conversationId, currentRunId: "inventory" };
  const rows = []; let before;
  do {
    const page = reader.searchContinuity({ ...scope, limit: 10, ...(before === undefined ? {} : { before }) });
    if (!page.available) throw new Error("inventory_store_unavailable");
    rows.push(...page.items.map(({ recordId, sha256, retainedBytes, originalBytes, kind, redacted, truncated }) => ({ recordId, sha256, retainedBytes, originalBytes, kind, redacted, truncated })));
    before = page.next;
  } while (before !== undefined);
  return rows;
}

/** Fictional-only sizing regression, independent of any corpus-loading loops. */
export async function measureSizingRegressions({ modules, root, handleConversationHistoryRequest }) {
  // Regression records use the real writer, handler and wire response splitter too.
  const { ToolHistoryWriter, ToolHistoryReader, continuityRecordId, continuityGenerationId } = modules.conversation;

  const texts = ["Cobalt 🔷 rectangle. ".repeat(1200), '\"\n'.repeat(5000)];
  const inventory = { corpus: { regressions: digest(texts) }, paths: [], retained: [] };
  const conversationId = "web:lookup-sizing-fiction";
  await mkdir(root, { recursive: true });
  const fixtureRoot = await mkdtemp(join(root, "sizing-regression-"));
  let writer;
  try {
    writer = await ToolHistoryWriter.open({ root: fixtureRoot, continuityEnabled: true });
    const generationId = continuityGenerationId();
    const records = texts.map((text, sequence) => ({ text, sequence, recordId: continuityRecordId(conversationId, `regression-${sequence}`), runId: "lookup-sizing-regression", kind: "assistant", provenance: "assistant" }));
    await writer.prepareContinuity({ generationId, conversationId, logicalConversationId: conversationId, beforeDigest: null, afterDigest: sha256("regressions"), records });
    await writer.commitContinuity({ generationId, conversationId, canonicalDigest: sha256("regressions") });
    const binding = { reader: new ToolHistoryReader(fixtureRoot), conversationId, logicalConversationId: conversationId, runId: "lookup-sizing-regression" };
    for (const [index, record] of records.entries()) {
      for (const arm of LOOKUP_DEFAULT_ARMS) {
        const path = { traceId: `regression-${index}`, probeId: "p01", arm, sourceSha256: sha256(record.text), retainedSha256: sha256(record.text),
          recordId: record.recordId, retainedBytes: Buffer.byteLength(record.text), initialContextBytes: null, initialTokens: arm === "native-lookup" ? 150000 : 12000, admissionCap: 6000000,
          calls: 0, bytes: 0, cumulativeBytes: 0, responseBytes: [], responseSha256: [], searchPages: 0, getChunks: 0, discovered: false };
        // No packed id in these regression fixtures: one query-first search then get.
        let result = handleConversationHistoryRequest(binding, { action: "search", query: index === 0 ? "Cobalt" : '\"', limit: 10 });
        const measure = result => { const serialized = JSON.stringify(result.content), bytes = Buffer.byteLength(serialized); path.calls++; path.bytes += bytes; path.cumulativeBytes += path.bytes; path.responseBytes.push(bytes); path.responseSha256.push(sha256(serialized)); };
        measure(result); path.searchPages++;
        const found = result.structuredContent.items?.find(item => item.sha256 === path.retainedSha256);
        path.discovered = found !== undefined;
        if (!path.discovered) throw new Error("regression_source_not_discovered");
        // Get only an ID that discovery actually returned, never the planted ID.
        path.recordId = found.recordId;
        let args = { action: "get", recordId: found.recordId, chunkBytes: 8192 }, recovered = "";
        do {
          result = handleConversationHistoryRequest(binding, args); measure(result); path.getChunks++;
          recovered += result.structuredContent.chunk;
          args = result.structuredContent.navigation.nextActions[0]?.arguments;
        } while (args);
        path.verified = sha256(recovered) === path.retainedSha256;
        if (!path.verified) throw new Error("regression_digest_mismatch");
        inventory.paths.push(path);
      }
      inventory.retained.push({ traceId: `regression-${index}`, recordId: record.recordId, sha256: sha256(record.text), retainedBytes: Buffer.byteLength(record.text), originalBytes: Buffer.byteLength(record.text) });
    }
  } finally {
    try { await writer?.close(); } finally { await rm(fixtureRoot, { recursive: true, force: true }); }
  }
  return inventory;
}

export async function measureBudget({ output, onProgress = () => {} }) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const modules = await productionModules(ROOT);
  const inventory = { schema: "continuity-lookup-inventory-v1", protocol: "query-first-packed-id-otherwise-one-source-query-10-and-8192-get-v1", soul: SOUL_BINDING,
    corpus: {}, retained: [], paths: [], unavailable: [] };
  // The complete four originals and both generated suites, seeds 101–108; no outcome-dependent selection.
  for (const suite of ["original", "hard", "hard-distractors"]) {
    const corpus = await loadTraces({ suite }); inventory.corpus[suite] = corpus.sha256;
    const plan = makePlan({ ...corpus, probeMode: LOOKUP_MODE, profile: { judge: null } });
    // Measurement ceilings are the registered hard caps, NOT the trial budgets being estimated.
    plan.lookup.budget = { ...LOOKUP_BUDGET, callBudget: CALL_CAP, byteBudget: BYTE_CAP }; plan.lookup.maxTurns = CALL_CAP + 2;
    for (const trace of corpus.traces) for (const id of LOOKUP_DEFAULT_ARMS) {
      onProgress(`${suite}/${trace.id}/${id}`);
      const arm = armById(id), dir = join(output, "scratch", `${trace.id}-${id}`);
      try {
        const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir, plan, mode: "offline" });
        inventory.retained.push(...retainedInventory(modules, checkpoint).map(row => ({ suite, traceId: trace.id, arm: id, ...row })));
        for (const probe of trace.probes) {
          const annotation = sourceAnnotation(trace, probe);
          if (annotation.availability !== "annotated") {
            inventory.unavailable.push({ traceId: trace.id, probeId: probe.id, arm: id, classification: annotation.availability }); continue;
          }
          const trial = await runProbe({ modules, trace, arm, repeat: 1, probe, checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
            checkpointContinuity: checkpoint.record.continuity, checkpointConversationId: checkpoint.record.conversationId, forkDir: join(dir, "probe"),
            plan, mode: "offline", root: ROOT, lookupReference: true });
          if (trial.failure || !trial.store?.healthy || !trial.lookup || trial.lookup.exhausted) throw new Error(`inventory_reference_failed:${trial.failure ?? trial.lookup?.exhausted ?? "store_or_witness"}`);
          const lookup = trial.lookup;
          if (lookup.source.availability !== "retained") {
            inventory.unavailable.push({ traceId: trace.id, probeId: probe.id, arm: id, classification: lookup.source.availability }); continue;
          }
          if (!lookup.sourceReturned) throw new Error("inventory_source_digest_unverified");
          const shape = traceTokenShape(trace);
          inventory.paths.push({ traceId: trace.id, probeId: probe.id, arm: id, sourceSha256: annotation.sourceSha256,
            retainedSha256: lookup.source.sha256, recordId: lookup.source.recordId, retainedBytes: lookup.source.retainedBytes,
            initialContextBytes: lookup.initialContextBytes,
            // Observe the actual forwarded request, including wrappers/schema, not just source bytes.
            initialTokens: Math.max(Math.ceil(lookup.initialContextBytes / 3), id === "native-lookup" ? Math.max(150000, shape.full) : shape.cold + 12000),
            admissionCap: plan.limits.maxObservedInputTokensPerInvocation,
            calls: lookup.calls, bytes: lookup.bytes, cumulativeBytes: lookup.cumulativeBytes, responseBytes: lookup.responseBytes, responseSha256: lookup.responseSha256,
            searchPages: lookup.searchPages, getChunks: lookup.getChunks, discovered: lookup.reference.discovered,
            verified: lookup.sourceReturned });
        }
      } finally {
        try { await writeFile(join(output, "inventory-progress.json"), `${JSON.stringify(inventory)}\n`, { mode: 0o600 }); }
        finally { await rm(dir, { recursive: true, force: true }); }
      }
    }
  }
  const { handleConversationHistoryRequest } = await import(pathToFileURL(join(ROOT, "packages/app/dist/request-tools/conversation-history.js")).href);
  const regressions = await measureSizingRegressions({ modules, root: join(output, "scratch", "regressions"), handleConversationHistoryRequest });
  inventory.corpus.regressions = regressions.corpus.regressions;
  inventory.paths.push(...regressions.paths); inventory.retained.push(...regressions.retained);
  const budget = freezeBudget(inventory);
  await writeFile(join(output, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(output, "budget.json"), `${JSON.stringify(budget, null, 2)}\n`, { mode: 0o600 });
  return budget;
}

/** Measure only the explicit selection, once per role/slot. Never derive limits. */
export async function measureFixedBudget({ output, fixedBudgetSha256, checkouts, onProgress = () => {}, ...options }) {
  assertFixedBudget(fixedBudgetSha256);
  const inputRoots = [checkouts?.R0?.path, checkouts?.Rpack?.path];
  const workload = await lookupWorkload({ ...options, inputRoots });
  if (!workload.lookupSource || workload.policy) throw new Error("lookup_fixed_measurement_requires_source_without_policy");
  const { protocol, codes } = await prepareLookupCodes(checkouts);
  const selection = workload.corpora[0].traces;
  const inventory = { schema: "continuity-lookup-feasibility-v1", mode: "fixed-budget-feasibility-only", fixedBudgetSha256,
    source: workload.corpora[0].source, selection, lookupSelection: workload.lookupSelection, protocol, codes, reader: workload.reader,
    maxTurns: 10, budget: { ...LOOKUP_BUDGET, paths: [] } };
  const loaded = await loadTraces({ suite: "holdout", lookupSource: workload.lookupSource, selectionSeed: workload.lookupSelection.seed, perGroup: workload.lookupSelection.perGroup, inputRoots });
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  for (const role of LOOKUP_ROLES) {
    const code = codes[role.code], modules = await productionModules(code.path);
    for (const selected of selection) {
      const trace = loaded.traces.find(t => t.id === selected.id), arm = armById(role.arm);
      const plan = makePlan({ ...loaded, traces: [trace], probeMode: LOOKUP_MODE, profile: { ...workload.reader, reader: workload.reader.model, readerEffort: workload.reader.effort, judge: null }, probeLimit: workload.probeLimit });
      plan.lookup.soul = LOOKUP_SOULS[role.soul];
      const dir = join(output, "scratch", `${role.id}-${trace.id}`);
      try {
        const checkpoint = await buildCheckpoint({ modules, trace, arm, repeat: 1, dir, plan, mode: "offline" });
        retainedInventory(modules, checkpoint); // Independently verify this role's sanitized store.
        for (const probe of trace.probes.filter(p => selected.probes.includes(p.id))) {
          onProgress(`${role.id}/${trace.id}/${probe.id}`);
          const annotation = sourceAnnotation(trace, probe), identifier = annotation.availability === "annotated";
          const trial = await runProbe({ modules, trace, arm, repeat: 1, probe, checkpointWork: checkpoint.work, checkpointSnapshot: checkpoint.snapshot,
            checkpointContinuity: checkpoint.record.continuity, checkpointConversationId: checkpoint.record.conversationId,
            forkDir: join(dir, "probe"), plan, mode: "offline", root: code.path, lookupReference: identifier });
          const l = trial.lookup;
          if (!l?.initialContextBytes || (!trial.store?.healthy && !l.exhausted)) throw new Error("lookup_inventory_initial_context_unverified");
          const shape = traceTokenShape(trace);
          const initialTokens = Math.max(Math.ceil(l.initialContextBytes / 3), role.arm === "native-lookup" ? Math.max(150000, shape.full) : shape.cold + 12000);
          const base = { role: role.id, arm: role.arm, traceId: trace.id, probeId: probe.id, initialContextBytes: l.initialContextBytes,
            initialTokens, admissionCap: plan.limits.maxObservedInputTokensPerInvocation, initiallyPresent: l.initiallyPresent,
            sourceAvailability: l.source.availability, exhausted: l.exhausted ?? null, referenceFailure: Boolean(trial.failure), method: identifier ? "identifier-reference" : "conservative-full-budget" };
          // Provenance is not feasibility. Non-identifiers have no witnessed reference:
          // conservatively admit the entire 10-round envelope, never borrow a neighbour.
          const path = identifier ? { ...base, sourceSha256: annotation.sourceSha256, retainedSha256: l.source.sha256 ?? null, recordId: l.source.recordId ?? null, retainedBytes: l.source.retainedBytes ?? null,
            calls: l.calls, bytes: l.bytes, cumulativeBytes: l.cumulativeBytes, responseBytes: l.responseBytes,
            responseSha256: l.responseSha256, searchPages: l.searchPages, getChunks: l.getChunks,
            sourceReturned: l.sourceReturned, discovered: l.reference?.discovered === true }
            : { ...base, calls: LOOKUP_BUDGET.callBudget, bytes: LOOKUP_BUDGET.byteBudget,
              cumulativeBytes: 9 * LOOKUP_BUDGET.byteBudget, discovered: true };
          const initialAdmission = referenceFeasibility({ calls: 0, bytes: 0, cumulativeBytes: 0, discovered: true }, LOOKUP_BUDGET, base);
          const feasibility = externalPathFeasibility(path, LOOKUP_BUDGET);
          inventory.budget.paths.push({ ...path, initialAdmission, feasibility });
        }
      } finally { await rm(dir, { recursive: true, force: true }); }
    }
  }
  assertExternalPolicy(inventory, { source: loaded.source, selection, lookupSelection: workload.lookupSelection, codes, protocol });
  await writeFile(join(output, "budget.json"), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rm(join(output, "scratch"), { recursive: true, force: true });
  return inventory;
}
export async function main(argv = process.argv.slice(2), { stdout = console.log } = {}) {
  const f = parseLookupOptions(argv, ["--output", "--fixed-budget-sha256", "--r0", "--r0-revision", "--rpack", "--rpack-revision", ...WORKLOAD_FLAGS]);
  if (!f["--output"]) throw new Error("usage: continuity-lookup-budget --output DIR");
  requireLookup(f["--fixed-budget-sha256"] === undefined || f["--fixed-budget-sha256"].trim().length > 0, "lookup_empty_fixed_budget_sha256");
  const workload = workloadOptions(f);
  requireLookup(f["--fixed-budget-sha256"] === undefined || workload.lookupSource, "lookup_external_flag_requires_source");
  const output = resolve(f["--output"]);
  try { await readFile(join(output, "inventory.json")); throw new Error("inventory_already_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (f["--fixed-budget-sha256"]) {
    const external = await lookupOutputPath(output, [ROOT, f["--r0"], f["--rpack"]]);
    const result = await measureFixedBudget({ ...workload, output: external, fixedBudgetSha256: f["--fixed-budget-sha256"], checkouts: {
      R0: { path: f["--r0"], revision: f["--r0-revision"] }, Rpack: { path: f["--rpack"], revision: f["--rpack-revision"] } } });
    stdout(JSON.stringify({ policySha256: sha256(await readFile(join(external, "budget.json"))), planned: result.budget.paths.length,
      feasible: result.budget.paths.filter(p => p.feasibility.classification === "feasible").length,
      infeasible: result.budget.paths.filter(p => p.feasibility.classification === "budget-infeasible").length,
      unknown: result.budget.paths.filter(p => p.feasibility.classification === "unknown").length }));
  } else {
    if (Object.keys(f).length !== 1) throw new Error("lookup_fixed_budget_required");
    const budget = await measureBudget({ output, onProgress: message => console.error(`sizing ${message}`) });
    stdout(JSON.stringify({ callBudget: budget.callBudget, byteBudget: budget.byteBudget, inventorySha256: budget.inventorySha256, measurement: budget.measurement }, null, 2));
  }
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`continuity-lookup-budget: ${error.code ?? error.message}`); process.exitCode = 1; });
}
