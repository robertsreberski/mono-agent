import { E2_RETRY_POLICY } from "../../lib/continuity-e2-retry.mjs";
// Fictional source/build/account artifacts, exclusively beneath the caller's temporary root.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../../lib/continuity-dataset.mjs";
import { digest as hash } from "../../lib/continuity-recorded-schema.mjs";
import { ROOT } from "../../lib/continuity-observation-input.mjs";
import { E2_REGISTRATION_SCHEMA, E2_PLAN_SCHEMA, E2_ASSUMPTIONS, E2_AUTHORIZATION_SCHEMA } from "../../lib/continuity-e2-policy.mjs";
import { E2_TOOL_POLICIES, e2CodeDigest, e2PhaseSchedule } from "../../lib/continuity-e2-registration.mjs";
import { e2AuthorizationBindings } from "../../lib/continuity-e2-authorization.mjs";
import { loadE2Catalog } from "../../lib/continuity-e2-pricing.mjs";
import { shippingSoul } from "../../lib/continuity-e2-models.mjs";
import { estimateE2SizingSet } from "../../lib/continuity-e2-sizing.mjs";
import { runE2Sizing } from "../../lib/continuity-e2-replay.mjs";
import { registrationTrace } from "./continuity-e2-registration.mjs";
const save = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
// Measured Linux quarter-core runs need 16–17s to reach the first send and
// 22s for a completed phase. Keep a finite 30s phase watchdog; the 90s test
// budget also covers C1's pre-controller sizing (62s end-to-end when throttled).
export const E2_NATIVE_TEST_TIMEOUT_MS = 90_000;
export const E2_NATIVE_DEADLINES = Object.freeze({ requestDeadlineMs: 30_000, phaseDeadlineMs: 30_000, childWatchdogMs: 30_000, runDeadlineMs: 60_000 });
export async function e2NativeFixture(root, { arm = "pressure", capUnits = "1000000000000", rows = null, replay = false, probeLookupRounds = 1, deadlines = E2_NATIVE_DEADLINES } = {}) {
  const home = join(root, "home"); await mkdir(home, { mode: 0o700 });
  const snapshots = join(root, "snapshots"); await mkdir(snapshots, { mode: 0o700 });
  const trace = await registrationTrace(snapshots);
  trace.protocol.probeLookupRounds = probeLookupRounds;
  if (replay) for (const branch of trace.protocol.branches) branch.exclusions.coverage = trace.source.coverage.flatMap((gap, index) => gap.tier === "replay" ? [index] : []);
  const component = JSON.parse(await readFile(new URL("./continuity-e2-cap-sizing.json", import.meta.url)));
  const bind = async (name, value) => { const path = join(root, `${name}.json`), raw = JSON.stringify(value); await writeFile(path, raw, { mode: 0o600 }); return { path, sha256: hash(raw) }; };
  const source = await bind("source", trace.source), protocol = await bind("protocol", trace.protocol);
  const questions = { schema: "continuity-recorded-questions-v1", questions: replay ? [{ id: "fictional-native-item", checkpoint: "B1", prompt: "PRIVATE-FROZEN-FICTIONAL-QUESTION: state the fictional recorded response." }] : [] };
  const evaluator = { schema: "continuity-recorded-evaluator-keys-v1", keys: replay ? [{ id: "fictional-native-item", checkpoint: "B1", kind: "exact", expected: "Fictional response", availability: "available", rate: true, dependsOnSteps: [], forbidden: [] }] : [] };
  const probes = await bind("probes", questions), keys = await bind("keys", evaluator);
  component.sizing.arm = arm;
  if (rows) component.sizing.variants[0].requests = rows.map((row, ordinal) => {
    const original = component.sizing.variants[0].requests.find(r => r.paidRole === row.role && r.model === row.model) ?? component.sizing.variants[0].requests.find(r => r.paidRole === row.role);
    return { ...original, role: row.role, paidRole: row.role, model: row.model, ordinal, phase: row.phase ?? "whole" };
  });
  for (const role of component.roles) role.maxInputTokens = 272000;
  const sizingHomes = [];
  if (replay) {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = home;
      component.sizing = await runE2Sizing({ source: trace.source, protocol: trace.protocol, output: join(root, "faux-sizing"), summary: "faux-short", onContext: () => sizingHomes.push(process.env.HOME) });
    } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
  }
  const sizing = [await bind("sizing", component.sizing)], catalog = await loadE2Catalog(), soul = await shippingSoul();
  const probeCounts = trace.protocol.branches.flatMap(b => b.checkpoints).map((_, checkpoint) => ({ checkpoint, questions: replay && checkpoint === 0 ? 1 : 0, lookupRounds: trace.protocol.probeLookupRounds }));
  estimateE2SizingSet({ protocol: trace.protocol, roles: component.roles, records: [component.sizing], catalog, probeCounts });
  const pilot = { schema: E2_REGISTRATION_SCHEMA, registration: {
    code: { path: ROOT, revision: "b".repeat(40), sha256: await e2CodeDigest() },
    build: { policy: "fresh-clean-head-agent-app-closure-v1", sourceHead: "b".repeat(40), command: ["pnpm", "--filter", "@mono-agent/app...", "run", "build"], packages: ["packages/app", "packages/turn"], outputRoots: ["packages/app/dist", "packages/turn/dist"], outputSha256: "a".repeat(64), node: process.version },
    catalog, source, protocol, probes, keys, soul: { rawDigest: soul.rawDigest, normalizedDigest: soul.normalizedDigest }, roles: component.roles,
    sizing, probeCounts, schedule: e2PhaseSchedule(trace.protocol, [component.sizing], probeCounts), toolPolicies: E2_TOOL_POLICIES,
  }, descriptor: { schema: E2_PLAN_SCHEMA, retryPolicy: E2_RETRY_POLICY, assumptions: E2_ASSUMPTIONS, capUnits, deadlines } };
  const outputRoot = join(root, "output"); await mkdir(outputRoot, { mode: 0o700 });
  const credentialPath = join(root, "credential.json"), account = "fictional-e2-account";
  const token = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fictional`;
  await save(credentialPath, { "openai-codex": { type: "oauth", access: token, refresh: "fictional-refresh", expires: 0 } });
  const artifact = { schema: E2_AUTHORIZATION_SCHEMA, authorizationId: "fictional-e2-authorization", salt: "c".repeat(64), accountCommitment: "", timestamp: "2042-03-01T09:00:00.000Z", approver: "fictional-maintainer", numericApprovalReference: "fictional-test-only", bindings: {} };
  artifact.accountCommitment = hash(`mono-agent/lcc-e2/account-v1\0${artifact.salt}\0${account}`);
  const authorizationPath = join(root, "authorization.json"), registrationPath = join(root, "registration.json");
  const args = { authorizationPath, registrationPath, registrationSha256: "", outputRoot, credentialPath, controllerRoot: ROOT };
  const result = { root, home, pilot, artifact, args, trace, account, sizingHomes };
  result.persist = async () => { const raw = JSON.stringify(pilot); await writeFile(registrationPath, raw, { mode: 0o600 }); args.registrationSha256 = hash(raw);
    artifact.bindings = e2AuthorizationBindings(pilot, args.registrationSha256, { outputRoot, credentialPath, salt: artifact.salt, accountCommitment: artifact.accountCommitment }); await save(authorizationPath, artifact); };
  await result.persist(); return result;
}
