// Fictional frozen E2 snapshot for the History A/B harness. Every artifact is
// generated beneath the caller's temporary root from the fictional C1 trace.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registrationTrace } from "./continuity-e2-registration.mjs";
import { runE2Sizing } from "../../lib/continuity-e2-replay.mjs";
import { buildE2HistoryAbBinding, e2AbFrozenRecord } from "../../lib/continuity-e2-ab.mjs";
export const AB_ROWS = Object.freeze(["fictional-ab-exact", "fictional-ab-referent", "fictional-ab-control"]);
export const AB_PRIMARY = Object.freeze(["fictional-ab-exact"]);
export function abQuestions() {
  return { schema: "continuity-recorded-questions-v1", questions: [
    { id: "fictional-unselected", checkpoint: "B1", prompt: "State the fictional earlier response." },
    ...AB_ROWS.map(id => ({ id, checkpoint: "B4", prompt: `Fictional A/B question ${id}: state the recorded response.` })),
  ] };
}
export function abKeys() {
  const key = (id, checkpoint, extra = {}) => ({ id, checkpoint, kind: "exact", expected: "Fictional response", availability: "available", rate: true, dependsOnSteps: [], forbidden: [], ...extra });
  return { schema: "continuity-recorded-evaluator-keys-v1", keys: [key("fictional-unselected", "B1"), key(AB_ROWS[0], "B4"), key(AB_ROWS[1], "B4", { kind: "referent" }), key(AB_ROWS[2], "B4")] };
}
/** Freeze a fictional committed run at `root/frozen`, then bind the main B4 snapshot. */
export async function abFrozenFixture(root, { probeLookupRounds = 3, rows = AB_ROWS, primary = AB_PRIMARY, arms } = {}) {
  await mkdir(join(root, "frozen", "trace"), { recursive: true, mode: 0o700 });
  const trace = await registrationTrace(join(root, "frozen", "trace"));
  trace.protocol.probeLookupRounds = probeLookupRounds;
  for (const branch of trace.protocol.branches) branch.exclusions.coverage = trace.source.coverage.flatMap((gap, index) => gap.tier === "replay" ? [index] : []);
  const sized = await runE2Sizing({ source: trace.source, protocol: trace.protocol, output: join(root, "frozen", "replay"), summary: "faux-short" });
  // A committed replay record has the same branch/checkpoint receipt structure.
  const replayPath = join(root, "frozen", "replay.json");
  await writeFile(replayPath, JSON.stringify({ ...sized, schema: "continuity-e2-replay-v1" }), { mode: 0o600 });
  const snapshot = join(root, "frozen", "replay", "branch-0", "snapshots", "checkpoint-2");
  const binding = await buildE2HistoryAbBinding({ replayPath, snapshot, branch: 0, checkpoint: 2, rows, primary, ...(arms ? { arms } : {}) });
  return { trace, binding, frozen: await e2AbFrozenRecord(binding), replayPath, snapshot };
}
/** A complete fictional A/B registration and authorization over the frozen fixture. */
export async function abNativeFixture(root, { rows = AB_ROWS, primary = AB_PRIMARY, arms, deadlines, capUnits } = {}) {
  const [{ e2NativeFixture }, { runE2HistoryAbSizing, estimateE2HistoryAb, buildE2HistoryAbRegistration }, { loadE2Catalog }, { digest: hash }] = await Promise.all([
    import("./e2-native-registration.mjs"), import("../../lib/continuity-e2-ab.mjs"), import("../../lib/continuity-e2-pricing.mjs"), import("../../lib/continuity-recorded-schema.mjs")]);
  const f = await e2NativeFixture(root, deadlines ? { deadlines } : {});
  const ab = await abFrozenFixture(root, { rows, primary, arms });
  const bind = async (name, value) => { const path = join(root, `ab-${name}.json`), raw = JSON.stringify(value); await writeFile(path, raw, { mode: 0o600 }); return { path, sha256: hash(raw) }; };
  const questions = abQuestions(), keys = abKeys(), catalog = await loadE2Catalog();
  const record = await runE2HistoryAbSizing({ source: ab.trace.source, protocol: ab.trace.protocol, historyAb: ab.binding, frozen: ab.frozen, output: join(root, "ab-sizing") });
  // The fixture's registered build is fictional; bind the sizing to that exact identity.
  record.sizingIdentity = { sourceHead: "b".repeat(40), sourceDirty: false, codeSha256: f.pilot.registration.code.sha256, buildOutputSha256: "a".repeat(64), node: process.version };
  const roles = ["continuation", "probe"].map(role => ({ role, model: "openai-codex:gpt-6.1-sol", maxInputTokens: 272000, maxOutputTokens: 128000, expectedOutputTokens: 512 }));
  const artifacts = { source: await bind("source", ab.trace.source), protocol: await bind("protocol", ab.trace.protocol), probes: await bind("probes", questions), keys: await bind("keys", keys), sizing: [await bind("sizing", record)] };
  const registration = buildE2HistoryAbRegistration({ code: f.pilot.registration.code, build: f.pilot.registration.build, catalog, ...artifacts, roles, historyAb: ab.binding, protocolValue: ab.trace.protocol, records: [record] });
  const estimate = estimateE2HistoryAb({ protocol: ab.trace.protocol, roles, historyAb: ab.binding, records: [record], catalog });
  f.pilot.registration = registration; f.pilot.descriptor.capUnits = capUnits ?? estimate.minimumCapUnits;
  await f.persist();
  return { ...f, ab, record, questions, keys, estimate, artifacts, roles, bind };
}
