import { dirname, basename, resolve } from "node:path";
import { verifyHoldout } from "../continuity-holdout-freeze.mjs";
import { validateTrace, digest, DEFAULT_READER, DEFAULT_ALTERNATE } from "./continuity-dataset.mjs";
import { externalFile, sha256, jsonBytes, readJson } from "./continuity-holdout-files.mjs";
import { HOLDOUT_ARMS, STATISTICAL_SPEC, validateStatisticalSpec, validateHoldoutConversations } from "./continuity-holdout-statistics.mjs";
const requireValue = (ok, code) => { if (!ok) throw new Error(code); };
export const corpusFor = group => ({ ordinary: "holdout-hard", distractor: "holdout-hard-distractors" })[group];
export function seeded(seed) {
  requireValue(Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffffffff, "invalid_registration_seed");
  let state = seed;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}
export function holdoutModels(profile = {}) {
  const reader = profile.reader ?? DEFAULT_READER;
  return { reader, extractor: profile.extractionModel ?? reader, alternate: profile.alternate ?? DEFAULT_ALTERNATE, readerEffort: profile.readerEffort ?? "low", judge: profile.judge ?? null };
}
/** Mechanics registrations may use scripted routes; real measurement may not. */
export function assertRealHoldoutModels(models) {
  requireValue([models?.reader, models?.extractor, models?.alternate].every(ref => typeof ref === "string"
    && !/^(?:fixture|faux)(?:[:/.-]|$)/iu.test(ref)), "holdout_measurement_requires_real_models");
}
export async function loadFrozenHoldout(manifestPath, manifestSha256, statisticalSpec = STATISTICAL_SPEC) {
  validateStatisticalSpec(statisticalSpec);
  const d = statisticalSpec.design, total = d.conversationsPerCorpus * d.corpora.length;
  requireValue(basename(manifestPath ?? "") === "manifest.json", "invalid_manifest_path");
  await verifyHoldout(dirname(manifestPath), manifestSha256); // Mandatory, before reading any trace.
  const manifest = await readJson(manifestPath), traces = [];
  requireValue(digest(manifest.statisticalSpec) === digest(statisticalSpec), "frozen_statistical_spec_mismatch");
  requireValue(manifest.conversations.length === total && new Set(manifest.conversations.map(c => c.id)).size === total, "invalid_holdout_inventory");
  for (const row of manifest.conversations) {
    requireValue(row.path === `conversations/${row.id}.json` && corpusFor(row.group), "invalid_holdout_inventory");
    const bytes = await externalFile(resolve(dirname(manifestPath), row.path));
    requireValue(sha256(bytes) === manifest.files[row.path]?.sha256, "conversation_hash_mismatch");
    const trace = JSON.parse(bytes.toString("utf8")); validateTrace(trace);
    requireValue(trace.id === row.id && trace.generated?.group === row.group && trace.generated?.scenario === row.family && trace.probes.length === d.probes, "holdout_trace_identity_mismatch");
    traces.push({ ...trace, corpus: corpusFor(row.group) });
  }
  validateHoldoutConversations(traces.map(conversationIdentity), statisticalSpec);
  return { manifest, traces };
}
const conversationIdentity = t => ({ id: t.id, corpus: t.corpus, family: t.generated?.scenario, probes: t.probes.map(p => p.id) });
export function createRegistration({ conversations, manifestSha256, rubricSha256, statisticalSpecSha256, statisticalSpec, seed, models, codeRevision }) {
  validateStatisticalSpec(statisticalSpec);
  requireValue([manifestSha256, rubricSha256, statisticalSpecSha256].every(v => /^[a-f0-9]{64}$/u.test(v)) && /^[a-f0-9]{40}$/u.test(codeRevision ?? ""), "invalid_registration_hash");
  requireValue(models && [models.reader, models.extractor, models.alternate].every(v => /^[a-z0-9-]+:[A-Za-z0-9._/-]+$/u.test(v))
    && models.readerEffort === "low" && models.judge === null, "invalid_holdout_models");
  validateHoldoutConversations(conversations, statisticalSpec);
  const d = statisticalSpec.design, next = seeded(seed), shards = Array.from({ length: d.shards }, (_, i) => ({ id: i + 1, costCapUSD: d.shardCostCapUSD, conversations: [] }));
  const ordered = [...conversations].sort((a, b) => a.id < b.id ? -1 : 1);
  for (const corpus of statisticalSpec.design.corpora) {
    const pool = ordered.filter(c => c.corpus === corpus);
    requireValue(pool.length === d.conversationsPerCorpus, "invalid_holdout_inventory");
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    pool.forEach((c, i) => shards[Math.floor(i / d.perCorpusPerShard)].conversations.push(c.id));
  }
  return { schema: "holdout-registration-v1", manifestSha256, rubricSha256, statisticalSpecSha256, statisticalSpec, seed, models, codeRevision, conversations: ordered, shards };
}
export async function registerFrozenHoldout({ manifestPath, manifestSha256, statisticalSpecPath, seed, models, codeRevision }) {
  const bytes = await externalFile(statisticalSpecPath), statisticalSpec = JSON.parse(bytes.toString("utf8"));
  const { manifest, traces } = await loadFrozenHoldout(manifestPath, manifestSha256, statisticalSpec);
  return createRegistration({ conversations: traces.map(conversationIdentity),
    manifestSha256, rubricSha256: manifest.files.rubric.sha256, statisticalSpecSha256: sha256(bytes), statisticalSpec, seed, models, codeRevision });
}
export async function loadRegisteredHoldout({ manifestPath, manifestSha256, registrationPath, registrationSha256, statisticalSpecPath, shard, profile, codeRevision, repeats, arms, probeLimit }) {
  const bytes = await externalFile(registrationPath);
  requireValue(sha256(bytes) === registrationSha256, "registration_hash_mismatch");
  const registration = JSON.parse(bytes.toString("utf8"));
  const statBytes = await externalFile(statisticalSpecPath), statisticalSpec = JSON.parse(statBytes.toString("utf8"));
  validateStatisticalSpec(statisticalSpec);
  requireValue(registration.manifestSha256 === manifestSha256 && registration.statisticalSpecSha256 === sha256(statBytes)
    && registration.codeRevision === codeRevision && digest(registration.models) === digest(holdoutModels(profile)), "registration_binding_mismatch");
  const frozen = await loadFrozenHoldout(manifestPath, manifestSha256, statisticalSpec);
  const expected = createRegistration({ conversations: frozen.traces.map(conversationIdentity),
    manifestSha256, rubricSha256: frozen.manifest.files.rubric.sha256, statisticalSpecSha256: sha256(statBytes), statisticalSpec, seed: registration.seed,
    models: holdoutModels(profile), codeRevision });
  requireValue(jsonBytes(expected) === bytes.toString("utf8"), "registration_binding_mismatch");
  if (shard !== undefined) {
    requireValue(Number.isSafeInteger(shard) && shard >= 1 && shard <= registration.shards.length, "invalid_shard");
    requireValue(repeats === statisticalSpec.design.repeats && (probeLimit === null || probeLimit === statisticalSpec.design.probes) && digest([...arms].sort()) === digest([...HOLDOUT_ARMS].sort()), "invalid_registered_workload");
  }
  const selected = shard === undefined ? frozen.traces : frozen.traces.filter(t => registration.shards[shard - 1].conversations.includes(t.id));
  return { suite: "holdout", traces: selected, sha256: manifestSha256, source: { kind: "frozen-holdout", manifestSha256, registrationSha256 },
    holdout: { registrationSha256, manifestSha256, rubricSha256: registration.rubricSha256, statisticalSpecSha256: registration.statisticalSpecSha256,
      statisticalSpec: registration.statisticalSpec, conversations: registration.conversations, shard: shard ?? null, shards: registration.shards, models: registration.models } };
}

/** Audit bytes bind after execution, not into the pre-execution confirmation. */
export async function readBoundAudit(path, registrationSha256) {
  if (!path) return { audit: null, binding: null };
  const bytes = await externalFile(path), audit = JSON.parse(bytes.toString("utf8"));
  requireValue(/^[a-f0-9]{64}$/u.test(registrationSha256 ?? "") && audit?.registrationSha256 === registrationSha256, "audit_registration_mismatch");
  return { audit, binding: { sha256: sha256(bytes), registrationSha256: audit.registrationSha256 } };
}
