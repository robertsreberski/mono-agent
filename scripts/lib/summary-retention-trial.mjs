// Fictional-only qualification. Never imports E2 private registrations or keys.
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { SOL, LUNA } from "./continuity-e2-protocol.mjs";
import { loadE2Catalog } from "./continuity-e2-pricing.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const need = (condition, code) => { if (!condition) throw new Error(code); };
const normalized = text => text.toLowerCase().replace(/\s+/gu, " ").trim();
const importBuilt = path => import(new URL(`../../packages/${path}`, import.meta.url));
export const DEFAULT_TRIAL_MODEL = SOL;
export const DEFAULT_TRIAL_EFFORT = "low";
export const CAPS = Object.freeze([2000, 4000]);
export const MAX_REQUEST_BYTES = 65536;
export const resolveTrialModels = (value = "sol") => {
  const result = value.split(",").map(value => ({ sol: SOL, luna: LUNA })[value] ?? value);
  need(result.length > 0 && result.length <= 8 && new Set(result).size === result.length && result.every(value => /^[a-z0-9-]+:[A-Za-z0-9_.-]+$/u.test(value)), "Invalid model list");
  return result;
};

export async function loadTrialFixtures() {
  const raw = await readFile(new URL("../fixtures/summary-retention/conversations.json", import.meta.url));
  const manifest = JSON.parse(await readFile(new URL("../fixtures/summary-retention/manifest.json", import.meta.url)));
  need(hash(raw) === manifest.sha256, "Frozen fictional fixture/assertion digest mismatch");
  const data = JSON.parse(raw);
  need(data.schema === "summary-retention-fixtures-v1" && data.fixtures.length === 3, "Invalid fixture inventory");
  for (const fixture of data.fixtures) {
    need(fixture.tuples.length === 12 && fixture.stages.length === 4, "Invalid tuple inventory");
    need(Buffer.byteLength(fixture.tuples.map(row => row.reference).join("\n")) <= 2400, "Reference inventory exceeds 2400 bytes");
  }
  return { ...data, sha256: manifest.sha256, assertionPolicy: ASSERTION_POLICY, fixtureAssertionPolicy: manifest.assertions };
}

export const SCORER_VERSION = 2;
export const ASSERTION_POLICY = "v2: whole-token values and per-kind subject/value/state relationships in one line or indented tuple block; clause-scoped positive promotions; provenance limited to that chain's request inputs.";
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, match => `\\${match}`);
const token = text => `(?<![\\p{L}\\p{N}_-])${escape(normalized(text))}(?![\\p{L}\\p{N}_-])`;
const has = (text, value) => new RegExp(token(value), "u").test(text);
const clean = text => normalized(text.replace(/[*`]/gu, ""));
const clauses = text => text.split(/[;.!?\n]|,\s*|\b(?:but|however|yet)\b|\band\b/u).map(clean).filter(Boolean);
const qualified = text => /\b(?:not|no|never|without|neither|hypothetical|quoted|rehearsal|proposal|proposed|unestablished|unresolved|unapproved|unauthorized|unverified|absent|pending|unknown|unconfirmed|unselected|un-established|un-resolved|awaiting|denied|withheld|revoked|provisional|conditional|unavailable|lacking|lacks|cannot|would|could|might)\b|\b(?:isn|wasn|hasn|doesn|didn|can)[’']t\b/u.test(text);

/** Declarative roles derived from frozen metadata, not from model output.
 * This is a v2 assertion revision; fixture facts and their digest stay unchanged.
 */
export function tupleAssertion(tuple) {
  const [subject, first] = tuple.fields[0].split(": ");
  const base = { kind: tuple.kind, subject };
  switch (tuple.kind) {
    case "historical": return { ...base, date: first, event: tuple.fields[1] };
    case "decision": {
      const [selected, rejected] = first.replace(" selected", "").split(" over ");
      return { ...base, selected, rejected };
    }
    case "correction": return { ...base, predecessor: first.replace(" previously", ""), current: tuple.fields[2].replace("current ", "") };
    case "pending": {
      const [actor, action] = first.split(" to ");
      return { ...base, actor, action, state: tuple.fields[2] };
    }
    case "resolved": {
      const [actor, date] = first.split(" paid ");
      return { ...base, actor, date, state: tuple.fields[2] };
    }
    default: throw Error("Unknown frozen tuple kind");
  }
}

// Role slots allow bounded descriptive words, but cannot jump over another value
// or another role. Collect ALL slots so contradictory current values also fail.
const roleWords = "(?:the|reported|count|value|date|code|is|was|of|as|interpretation|remains)";
function roleValues(text, cue, valuePattern) {
  return [...text.matchAll(new RegExp(`\\b(?:${cue})\\b(?:\\s+${roleWords}){0,5}\\s*[:=]?\\s*(${valuePattern})(?![\\p{L}\\p{N}_-])`, "gu"))].map(match => match[1]);
}
function correctionRetained(text, assertion) {
  const { predecessor, current } = assertion;
  const pattern = /^\d{4}-/u.test(predecessor) ? "\\d{4}-[\\p{L}\\p{N}_-]+" : /^\d+$/u.test(predecessor) ? "\\d+[\\p{L}\\p{N}_-]*" : "[a-z]+\\d+[\\p{L}\\p{N}_-]*";
  const old = roleValues(text, "previously|earlier|formerly|previous|historical value", pattern);
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_-])(${pattern})\\s+(?:previously|earlier|formerly|superseded|replaced)\\b`, "gu"))) old.push(match[1]);
  const replacement = roleValues(text, "corrected to|replaced by|moved to|changed to|now", pattern);
  const present = roleValues(text, "current|now", pattern);
  return old.length > 0 && old.every(value => value === normalized(predecessor))
    && replacement.length > 0 && replacement.every(value => value === normalized(current))
    && (present.length === 0 || present.every(value => value === normalized(current)))
    && !/\b(?:not|never)\s+(?:corrected|replaced|moved|changed)\b/u.test(text);
}
function tupleRetained(text, a) {
  if (!has(text, a.subject)) return false;
  switch (a.kind) {
    case "historical": return has(text, a.date) && clauses(text).some(clause => has(clause, a.event) && !qualified(clause));
    case "decision": {
      const selected = token(a.selected);
      const choice = new RegExp(`(?:${selected}\\s+(?:was\\s+)?selected|(?:selected|chose)\\s+${selected})`, "u");
      const rejected = !a.rejected || new RegExp(`(?:${selected}\\s+(?:was\\s+)?selected\\s+over\\s+${token(a.rejected)}|(?:selected|chose)\\s+${selected}\\s+over\\s+${token(a.rejected)}|${token(a.rejected)}\\s+(?:was\\s+)?rejected|rejected\\s+${token(a.rejected)})`, "u").test(text);
      return has(text, "reported decision") && clauses(text).some(clause => choice.test(clause) && !qualified(clause)) && rejected
        && !(a.rejected && new RegExp(`(?:${token(a.rejected)}\\s+(?:was\\s+)?selected|selected\\s+${token(a.rejected)})`, "u").test(text));
    }
    case "correction": return correctionRetained(text, a);
    case "pending": return new RegExp(`(?:${token(a.actor)}\\s+(?:(?:is\\s+)?to|will|must|should|needs to)\\s+${token(a.action)}|${token(a.action)}\\s+(?:by|assigned to)\\s+${token(a.actor)})`, "u").test(text)
      && /\b(?:pending|unresolved|outstanding)\b/u.test(text) && !/\bnot (?:pending|unresolved|outstanding)\b/u.test(text) && !/\b(?:resolved|completed|done)\b/u.test(text.replace(/\bnot (?:yet )?(?:done|completed|resolved)\b/gu, ""))
      && (a.state === "no approval" ? /\b(?:no approval|not approved|approval (?:remains |is )?(?:absent|pending|unestablished|unresolved))\b/u.test(text) : /\b(?:not (?:yet )?(?:done|completed)|incomplete)\b/u.test(text));
    case "resolved": return has(text, a.date) && clauses(text).some(clause => new RegExp(`(?:${token(a.actor)}\\s+(?:(?:has|already)\\s+)*paid\\b|\\bpaid\\s+by\\s+${token(a.actor)})`, "u").test(clause) && !qualified(clause))
      && /\b(?:resolved|settled)\b/u.test(text) && !/\b(?:pending|unresolved|outstanding|not resolved|not settled)\b/u.test(text)
      && /\b(?:no repeat payment|must not pay again|no further payment)\b/u.test(text);
    default: return false;
  }
}

function tupleBlocks(summary, assertions) {
  const blocks = [];
  let block;
  for (const line of summary.split("\n")) {
    const text = clean(line);
    const subject = assertions.some(a => has(text, a.subject));
    if (/^\s+\S/u.test(line) && block !== undefined && !subject && !/^\s*(?:[-+*]|\d+[.)]|#)/u.test(line)) blocks[block] += `; ${text}`;
    else { blocks.push(text); block = subject ? blocks.length - 1 : undefined; }
  }
  // Multiple tuples on one line must not lend each other dates, values or states.
  return blocks.flatMap(text => {
    const subjects = assertions.flatMap(a => [...text.matchAll(new RegExp(token(a.subject), "gu"))].map(match => ({ index: match.index, subject: a.subject })))
      .sort((left, right) => left.index - right.index);
    const starts = [0];
    for (let index = 1; index < subjects.length; index++) if (subjects[index].subject !== subjects[index - 1].subject) starts.push(subjects[index].index);
    return starts.map((start, index) => text.slice(start, starts[index + 1]));
  });
}

const requestText = requests => requests.flatMap(request => [request.context?.systemPrompt ?? "",
  ...(request.context?.messages ?? []).flatMap(message => typeof message.content === "string" ? [message.content]
    : (message.content ?? []).filter(part => part.type === "text").map(part => part.text))]).join("\n");
const provenanceReferences = text => [...text.matchAll(/(?<![\p{L}\p{N}_-])(?:chr1_[a-z0-9_-]+|[a-f0-9]{64})(?![\p{L}\p{N}_-])|\b(?:record\s+(?:id|reference)|sha256)\s*[:=]\s*["'`]?([a-z0-9_-]+)/giu)].map(match => {
  const reference = match[1] ?? match[0];
  return /^[a-f0-9]{64}$/iu.test(reference) ? reference.toLowerCase() : reference;
});

export function scoreTrialSummary(fixture, checkpoint, summary, { requests = [] } = {}) {
  const lines = summary.split("\n").map(clean);
  const introduced = fixture.tuples.filter(tuple => tuple.introduced <= checkpoint);
  const assertions = introduced.map(tupleAssertion);
  const blocks = tupleBlocks(summary, assertions);
  const tuples = introduced.map((tuple, index) => ({ id: tuple.id, retained: blocks.some(text => tupleRetained(text, assertions[index])) }));
  const allowedDates = new Set(introduced.flatMap(tuple => tuple.reference.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? []));
  const inventedDates = [...new Set(summary.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [])].filter(date => !allowedDates.has(date));
  const authorityPromotions = lines.filter(line => clauses(line).some(clause => !qualified(clause)
    && /\b(?:approval|permission|owner authority|phantom-77)\b/u.test(clause)
    && /\b(?:granted|approved|authorized|established|confirmed|verified|attested|valid|given|exists|has authority)\b/u.test(clause)));
  const hypotheticalPromotions = lines.filter(line => clauses(line).some(clause => !qualified(clause)
    && /\b(?:current|now|replaced by|selected|active)\b/u.test(clause) && /\b(?:z0|ochre)\b/u.test(clause)));
  const allowedReferences = new Set(provenanceReferences(requestText(requests.filter(request => request.stage <= checkpoint))));
  const inventedProvenance = summary.split("\n").filter(line => /\b(?:attested by|verified owner)\b/iu.test(line)
    || provenanceReferences(line).some(reference => !allowedReferences.has(reference))).map(clean);
  return { scorerVersion: SCORER_VERSION, checkpoint, tuples, inventedDates, authorityPromotions, hypotheticalPromotions, inventedProvenance,
    pass: tuples.every(row => row.retained) && !inventedDates.length && !authorityPromotions.length && !hypotheticalPromotions.length && !inventedProvenance.length };
}

/** No runtime imports, credentials or network: preserve inputs/accounting, replace scores. */
export async function rescoreTrial(source) {
  const fixtures = await loadTrialFixtures();
  need(source.schema === "summary-retention-trial-v1" && source.fixturesSha256 === fixtures.sha256, "Unknown trial or fixture digest");
  const report = structuredClone(source);
  const rescoreChain = chain => {
    const fixture = fixtures.fixtures.find(row => row.id === chain.fixture);
    need(fixture && Array.isArray(chain.requests) && Array.isArray(chain.checkpoints), "Missing rescore inputs");
    chain.checkpoints = chain.checkpoints.map(row => {
      need(chain.requests.some(request => request.stage === row.checkpoint && request.context?.messages), "Missing checkpoint request inputs");
      return { ...row, ...scoreTrialSummary(fixture, row.checkpoint, row.summary, { requests: chain.requests }) };
    });
    chain.pass = chain.checkpoints.every(row => row.pass);
  };
  for (const chain of report.chains) rescoreChain(chain);
  if (report.progress) rescoreChain(report.progress);
  report.rescoredFromVersion = source.scorerVersion ?? 1;
  report.scorerVersion = SCORER_VERSION;
  report.assertionPolicy = ASSERTION_POLICY;
  report.qualificationLimit = QUALIFICATION_LIMIT;
  if (["pass", "fail"].includes(report.status)) report.status = report.chains.every(chain => chain.pass) ? "pass" : "fail";
  return report;
}
const QUALIFICATION_LIMIT = "Deterministic fixture-specific value/relationship assertions; not a general semantic or provenance verifier. Dry-run controls prove mechanics only, not model retention.";

/** Offline control derives lines ONLY from the actual request, never from fixtures. */
export function controlSummary(context, lossy = false) {
  const text = context.messages.flatMap(message => message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
  const texts = [text];
  for (const line of text.split("\n")) {
    const match = /Generated summary evidence id="[^"]+" sha256="[a-f0-9]+": (".*")$/u.exec(line);
    if (match) texts.push(JSON.parse(match[1]));
  }
  const lines = [...new Set(texts.flatMap(text => text.split("\n")).map(line => line.replace(/^\[User\]: /u, ""))
    .filter(line => /^[a-z][a-z ]{1,40}: .*; /iu.test(line) && !line.startsWith("Morgan:") && !line.startsWith("Avery:") && !/^(Untrusted metadata|Coverage):/u.test(line)))];
  return ["## Historical events and corrections", ...lines.filter(line => !lossy || !line.includes("arrived; historical.")), "## Pending items"].join("\n");
}

export async function loadTrialModules() {
  const [kit, summaries, policy, driver, engine, pack, pi] = await Promise.all([
    importBuilt("turn/dist/engine/compaction-kit/compaction.js"),
    importBuilt("turn/dist/execution/pi/compaction/compaction-summary.js"),
    importBuilt("turn/dist/execution/pi/compaction/summary-policy.js"),
    importBuilt("turn/dist/execution/pi/compaction/compaction-driver.js"),
    import("@mono-agent/turn/engine"), importBuilt("conversation/dist/continuity/pack.js"),
    importBuilt("turn/node_modules/@earendil-works/pi-ai/dist/providers/all.js"),
  ]);
  return { ...kit, ...summaries, ...policy, ...driver, ...engine, ...pack, ...pi };
}

export async function resolveTrialCatalog(modules, models) {
  const e2 = await loadE2Catalog();
  return models.map(reference => {
    const split = reference.indexOf(":"), provider = reference.slice(0, split), id = reference.slice(split + 1);
    const model = modules.getBuiltinModel(provider, id);
    need(model && model.maxTokens > 0 && model.contextWindow > 0, "Model absent from installed shipping catalog");
    const cost = structuredClone(model.cost);
    for (const row of [cost, ...(cost.tiers ?? [])]) for (const key of ["input", "output", "cacheRead", "cacheWrite"]) need(Number.isFinite(row[key]) && row[key] >= 0, "Invalid catalog rates");
    const catalog = { reference, id, provider, api: model.api, baseUrl: model.baseUrl, reasoning: model.reasoning,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost,
      identitySha256: hash(JSON.stringify(model)), catalogFileSha256: e2.find(row => row.model === reference)?.fileSha256 ?? null,
      providerEnforcesOutputCeiling: model.api !== "openai-codex-responses" };
    return { model, catalog };
  });
}

/** Cache-free conservative rate maximum (including every catalog tier). */
export function requestReservation(catalog, inputBytes, outputAllowance) {
  need(Number.isSafeInteger(inputBytes) && inputBytes <= MAX_REQUEST_BYTES && inputBytes > 0, "Summary request exceeds 64 KiB");
  need(Number.isSafeInteger(outputAllowance) && outputAllowance > 0 && outputAllowance <= catalog.maxTokens, "Invalid output allowance");
  const rates = [catalog.cost, ...(catalog.cost.tiers ?? [])];
  const inputRate = Math.max(...rates.flatMap(row => [row.input, row.cacheRead, row.cacheWrite]));
  const outputRate = Math.max(...rates.map(row => row.output));
  // One token per serialized UTF-8 byte; no cache credit. This is a spending
  // reservation, not a claim that Codex enforces its requested output allowance.
  return (inputBytes * inputRate + outputAllowance * outputRate) / 1e6;
}

export function createTrialBudget(capUsd) {
  need(Number.isFinite(capUsd) && capUsd > 0, "A positive --spend-cap-usd is required");
  // Round liabilities up and the cap down to nanodollars, never float under it.
  const units = usd => Math.ceil(usd * 1e9);
  const cap = Math.floor(capUsd * 1e9);
  need(Number.isSafeInteger(cap) && cap > 0, "Invalid spend-cap precision/range");
  let accounted = 0, reserved = 0, dispatched = 0;
  return {
    snapshot: () => ({ capUsd: cap / 1e9, accountedUsd: accounted / 1e9, reservedUsd: reserved / 1e9, dispatched }),
    reserve(usd) {
      const liability = units(usd);
      need(Number.isFinite(usd) && usd >= 0 && Number.isSafeInteger(liability) && accounted + reserved + liability <= cap, "Spend cap refuses next dispatch");
      reserved += liability; dispatched++;
      return liability / 1e9;
    },
    settle(reservation, usage, catalog) {
      // Unknown outcomes retain the entire reservation; the caller stops, never retries.
      need(usage && ["input", "output", "cacheRead", "cacheWrite"].every(key => Number.isFinite(usage[key]) && usage[key] >= 0), "Usage missing; reservation retained");
      const rows = [catalog.cost, ...(catalog.cost.tiers ?? [])];
      const computed = ["input", "output", "cacheRead", "cacheWrite"].reduce((total, key) => total + usage[key] * Math.max(...rows.map(row => row[key])) / 1e6, 0);
      const billed = usage.cost?.total;
      const actual = Number.isFinite(billed) && billed >= 0 ? Math.max(computed, billed) : computed;
      reserved = Math.max(0, reserved - Math.round(reservation * 1e9)); accounted += units(actual);
      need(accounted + reserved <= cap, "Accounted spend exceeded cap; stopping (provider ceiling unenforced)");
    },
  };
}

const user = (content, timestamp = 1) => ({ role: "user", content, timestamp });
const distractor = "Routine fictional progress: sort labels and arrange folders. ".repeat(15);
const trialFocus = "Preserve each introduced compact tuple on its own line, with the original subject and all semicolon-separated fields verbatim, for deterministic fictional qualification. Quoted hypotheticals are not permission. Do not invent provenance.";

/** Real shipping cut/preparation/generation, durable native journal and cold pack renderer.
 * The only injected seam is the one-request completion boundary; no archive backfill.
 */
export async function runTrialChain({ modules, fixture, model, cap, repetition, complete, onCheckpoint = async () => {}, onRequest = () => {}, coldReseeds = true }) {
  const root = await mkdtemp(join(tmpdir(), "summary-retention-"));
  const repo = new modules.JsonlSessionRepo({ sessionsRoot: root });
  let raw;
  const checkpoints = [], requests = [], reseeds = [];
  try {
    raw = await repo.create({ cwd: "/fictional/summary-retention" });
    for (let stage = 1; stage <= 4; stage++) {
      await raw.appendMessage(user(fixture.stages[stage - 1], stage));
      if (stage === 3) {
        // A completed, deliberately long assistant suffix forces a split turn.
        await raw.appendMessage({ role: "assistant", content: [{ type: "text", text: distractor }], timestamp: stage });
      } else await raw.appendMessage(user(distractor, stage));
      const prepared = modules.prepareCompaction(await raw.getEntries(), { reserveTokens: Math.ceil(cap / 0.8), keepRecentTokens: 128 });
      need(prepared.ok && prepared.value && prepared.value.isSplitTurn === (stage === 3), "Unexpected shipping cut shape");
      prepared.value.settings.reserveTokens = modules.piSummaryReserveTokens(cap, prepared.value.isSplitTurn);
      const input = modules.prepareSummaryInput(prepared.value);
      const telemetry = [];
      // The runtime's shipping facade adds focus, evidence and summary effort policy.
      const facade = modules.summaryModels({ completeSimple: async (selected, context, options) => {
        const bytes = Buffer.byteLength(JSON.stringify(context));
        need(bytes <= MAX_REQUEST_BYTES, "Summary request exceeds 64 KiB");
        // The facade has already applied shipping policy and recorded its wire
        // ceiling. Legacy adapters add thinking later: do not reapply policy or
        // change maxTokens, but reserve the full providerMaxTokens liability.
        const providerMaxTokens = telemetry.at(-1)?.providerMaxTokens;
        need(Number.isSafeInteger(providerMaxTokens) && providerMaxTokens > 0, "Summary provider ceiling unavailable");
        const request = { stage, bytes, maxTokens: options.maxTokens, providerMaxTokens, context, options: { maxTokens: options.maxTokens, reasoning: options.reasoning, transport: options.transport, maxRetries: options.maxRetries } };
        requests.push(request); onRequest(request);
        return complete(selected, context, options, { fixture: fixture.id, cap, repetition, stage, bytes, providerMaxTokens });
      } }, { operationId: `fictional-${stage}`, focus: `${input.focus}\n\n${trialFocus}`, evidence: input.evidence, requests: telemetry, effort: modules.trialEffort });
      const result = await modules.compactWithRequest(input.preparation, { model, thinkingLevel: modules.summaryThinkingLevel(model, modules.trialEffort) },
        (context, options) => facade.completeSimple(model, context, options), {});
      need(result.ok, "Shipping compaction failed");
      const id = await raw.appendCompaction(result.value);
      await raw.sync();
      // Read through a new handle after a real durability barrier.
      const journalId = raw.metadata.id;
      const metadata = raw.metadata;
      await raw.close(); raw = await repo.open(metadata);
      const entry = await raw.getEntry(id);
      need(entry.summary === result.value.summary, "Persisted summary changed");
      const score = scoreTrialSummary(fixture, stage, entry.summary, { requests });
      checkpoints.push({ ...score, summary: entry.summary, summaryBytes: Buffer.byteLength(entry.summary), isSplitTurn: input.preparation.isSplitTurn, telemetry });
      if (stage < 4 && coldReseeds) {
        // Construct the summary record only from the checkpoint read above. This
        // isolates summary carriage: original facts are intentionally not reseeded.
        const summaryRecord = { recordId: `chr1_${hash(journalId + id).slice(0, 43)}`, generationId: `fictional-${stage}`,
          conversationId: "fictional", runId: `finished-${stage}`, kind: "summary", provenance: "generated", sequence: 0, ordinal: stage,
          sha256: hash(entry.summary), originalBytes: Buffer.byteLength(entry.summary), retainedBytes: Buffer.byteLength(entry.summary),
          truncated: false, redacted: false, source: {}, untrusted: true, text: entry.summary,
          summary: { model: `${model.provider}:${model.id}`, operationId: `fictional-${stage}`, trigger: "manual", coverage: { sourceDigest: hash(JSON.stringify(await raw.getEntries())) } } };
        const pack = modules.renderContinuityPack({ records: [summaryRecord], omitted: 0, gaps: 0 }, [], 8000);
        need(pack.counts.summary === 1 && pack.text?.includes(JSON.stringify(entry.summary)), "Summary omitted from cold pack");
        reseeds.push({ stage, packBytes: Buffer.byteLength(pack.text), counts: pack.counts, summarySha256: hash(entry.summary) });
        await raw.close(); raw = await repo.create({ cwd: "/fictional/summary-retention" });
        await raw.appendMessage(user(pack.text));
      }
      await onCheckpoint({ checkpoints, requests, reseeds });
    }
    return { fixture: fixture.id, cap, repetition, checkpoints, requests, reseeds, pass: checkpoints.every(row => row.pass) };
  } finally { await raw?.close(); await repo.close(); await rm(root, { recursive: true, force: true }); }
}

export async function runTrial({ dryRun = false, confirm = false, capUsd, models = "sol", effort = DEFAULT_TRIAL_EFFORT, complete, publish = async () => {} } = {}) {
  need(dryRun || confirm, "Paid trial requires --confirm");
  need(["none", "low", "medium", "high", "xhigh", "ultra", "auto"].includes(effort), "Invalid effort");
  const modules = await loadTrialModules(); modules.trialEffort = effort;
  const fixtures = await loadTrialFixtures();
  const catalog = await resolveTrialCatalog(modules, resolveTrialModels(models));
  const budget = dryRun ? null : createTrialBudget(capUsd);
  const report = { schema: "summary-retention-trial-v1", scorerVersion: SCORER_VERSION, dryRun, fixturesSha256: fixtures.sha256, assertionPolicy: fixtures.assertionPolicy,
    requestedEffort: effort, identity: catalog.map(({ model, catalog }) => ({ ...catalog, effectiveEffort: modules.summaryThinkingLevel(model, effort) })),
    spendingDisclosure: "Reservations use one token per serialized input byte and the shipping providerMaxTokens output allowance (including adapter-added thinking) at maximum frozen catalog rates, without cache credit. Codex output ceiling is NOT enforced by the provider; the cap refuses further dispatch, but cannot interrupt an already sent request or guarantee its bill. Unknown outcomes retain reservations and stop. No retries.",
    qualificationLimit: QUALIFICATION_LIMIT,
    models: [], chains: [], dispatches: [], budget: budget?.snapshot() ?? null, status: "running" };
  await publish(report);
  try {
    for (const { model, catalog: identity } of catalog) {
      const measured = { model: identity.reference, chains: 0, checkpoints: 0, coldReseeds: 0, requests: 0, inputBytes: 0, outputAllowance: 0, estimatedUsd: 0, maximumInputUsd: 0 };
      report.models.push(measured);
      for (const fixture of fixtures.fixtures) for (const cap of CAPS) for (let repetition = 1; repetition <= 2; repetition++) {
        const chain = await runTrialChain({ modules, fixture, model, cap, repetition,
          complete: async (selected, context, options, meta) => {
            const reservation = requestReservation(identity, meta.bytes, meta.providerMaxTokens);
            measured.requests++; measured.inputBytes += meta.bytes; measured.outputAllowance += meta.providerMaxTokens; measured.estimatedUsd += reservation; measured.maximumInputUsd += requestReservation(identity, MAX_REQUEST_BYTES, meta.providerMaxTokens);
            if (dryRun) return { stopReason: "stop", content: [{ type: "text", text: controlSummary(context) }], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
            need(typeof complete === "function", "Paid completion boundary unavailable");
            const reserved = budget.reserve(reservation);
            const dispatch = { model: identity.reference, ...meta, outputAllowance: meta.providerMaxTokens, reservationUsd: reserved, status: "reserved", usage: null };
            report.dispatches.push(dispatch);
            report.budget = budget.snapshot(); await publish(report); // durable reservation before send
            const answer = await complete(selected, context, { ...options, maxRetries: 0, transport: "sse", cacheRetention: "none" });
            dispatch.usage = Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, answer?.usage?.[key] ?? null]));
            // Adapters can return error/abort responses with initialized zero
            // usage. Like the shipping facade, treat that as unknown, not free.
            if (["error", "aborted"].includes(answer?.stopReason)
              && ![...Object.values(dispatch.usage), answer?.usage?.cost?.total].some(value => Number.isFinite(value) && value > 0)) {
              dispatch.status = "unknown_outcome";
              dispatch.usage = Object.fromEntries(Object.keys(dispatch.usage).map(key => [key, null]));
              report.budget = budget.snapshot(); await publish(report);
              throw new Error("Unknown provider outcome; reservation retained");
            }
            budget.settle(reserved, answer?.usage, identity);
            dispatch.status = "accounted";
            report.budget = budget.snapshot(); await publish(report);
            return answer;
          },
          onCheckpoint: async ({ checkpoints, requests, reseeds }) => {
            report.progress = { model: identity.reference, fixture: fixture.id, cap, repetition, checkpoints, requests, reseeds };
            await publish(report);
          },
        });
        report.chains.push({ model: identity.reference, ...chain });
        measured.chains++; measured.checkpoints += chain.checkpoints.length; measured.coldReseeds += chain.reseeds.length;
        delete report.progress; await publish(report);
      }
    }
    report.total = report.models.reduce((total, row) => {
      for (const key of ["chains", "checkpoints", "coldReseeds", "requests", "inputBytes", "outputAllowance", "estimatedUsd"]) total[key] = (total[key] ?? 0) + row[key];
      return total;
    }, {});
    // Also report a conservative whole-matrix bound for unknown future summaries.
    report.maximumMatrixUsd = report.models.reduce((sum, row) => sum + row.maximumInputUsd, 0);
    report.status = dryRun ? "dry-run" : report.chains.every(chain => chain.pass) ? "pass" : "fail";
    await publish(report); return report;
  } catch (error) {
    report.status = "stopped"; report.budget = budget?.snapshot() ?? null;
    // Never persist provider errors, which may contain credentials or headers.
    report.failure = "Trial stopped; no retry or resume. Inspect last reservation and completed checkpoints.";
    await publish(report); throw error;
  }
}

// Separate offline entry point deliberately does not load the shipping runtime.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { rescore: { type: "string" } } });
    need(values.rescore, "Expected --rescore <trial.json>");
    const report = await rescoreTrial(JSON.parse(await readFile(values.rescore, "utf8")));
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "fail") process.exitCode = 1;
  } catch {
    console.error("Offline rescore refused: supply --rescore with a matching trial and its request inputs.");
    process.exitCode = 1;
  }
}
