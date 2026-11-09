// All artifacts/accounts are fictional, in a temporary HOME. No real registry is opened.
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, readdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedAuthorization } from "../lib/continuity-guarded-authorization.mjs";
import { digest } from "../lib/continuity-dataset.mjs";
import { digest as hash } from "../lib/continuity-recorded-schema.mjs";
import { ROOT } from "../lib/continuity-observation-input.mjs";
import { E2_REGISTRATION_SCHEMA, E2_PLAN_SCHEMA, E2_ASSUMPTIONS, E2_AUTHORIZATION_SCHEMA } from "../lib/continuity-e2-policy.mjs";
import { E2_TOOL_POLICIES, e2CodeDigest, e2ProbeCounts, e2PhaseSchedule } from "../lib/continuity-e2-registration.mjs";
import { e2AuthorizationBindings } from "../lib/continuity-e2-authorization.mjs";
import { loadE2Catalog } from "../lib/continuity-e2-pricing.mjs";
import { shippingSoul } from "../lib/continuity-e2-models.mjs";
import { registrationTrace } from "./fixtures/continuity-e2-registration.mjs";
const build = vi.hoisted(() => ({ verify: vi.fn(async () => {}), state: vi.fn(() => ({ head: "b".repeat(40), dirty: false })) }));
// Only source/build attestation is mocked: no build is authorized in this assignment.
vi.mock("../lib/memory-e2e-build.mjs", () => ({ BUILD_POLICY: "fresh-clean-head-agent-app-closure-v1", sourceState: build.state, verifyRealBuild: build.verify }));
let f; const roots = [];
const save = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2-authorization-"))), home = join(root, "home");
  roots.push(root); await mkdir(home, { mode: 0o700 }); vi.stubEnv("HOME", home); vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  const snapshots = join(root, "snapshots"); await mkdir(snapshots, { mode: 0o700 });
  const trace = await registrationTrace(snapshots);
  const component = JSON.parse(await readFile(new URL("./fixtures/continuity-e2-cap-sizing.json", import.meta.url)));
  const bind = async (name, value) => { const path = join(root, `${name}.json`), raw = JSON.stringify(value); await writeFile(path, raw, { mode: 0o600 }); return { path, sha256: hash(raw) }; };
  const source = await bind("source", trace.source), protocol = await bind("protocol", trace.protocol);
  const probes = await bind("probes", { schema: "continuity-recorded-questions-v1", questions: [] }), keys = await bind("keys", { schema: "continuity-recorded-evaluator-keys-v1", keys: [] });
  const sizing = [await bind("sizing", component.sizing)], catalog = await loadE2Catalog(), soul = await shippingSoul();
  const probeCounts = trace.protocol.branches.flatMap(b => b.checkpoints).map((_, checkpoint) => ({ checkpoint, questions: 0 }));
  const pilot = { schema: E2_REGISTRATION_SCHEMA, registration: {
    code: { path: ROOT, revision: "b".repeat(40), sha256: await e2CodeDigest() },
    build: { policy: "fresh-clean-head-agent-app-closure-v1", sourceHead: "b".repeat(40), command: ["pnpm", "--filter", "@mono-agent/app...", "run", "build"], packages: ["packages/app", "packages/turn"], outputRoots: ["packages/app/dist", "packages/turn/dist"], outputSha256: "a".repeat(64), node: process.version },
    catalog, source, protocol, probes, keys, soul: { rawDigest: soul.rawDigest, normalizedDigest: soul.normalizedDigest }, roles: component.roles,
    sizing, probeCounts, schedule: e2PhaseSchedule(trace.protocol, [component.sizing], probeCounts), toolPolicies: E2_TOOL_POLICIES,
  }, descriptor: { schema: E2_PLAN_SCHEMA, assumptions: E2_ASSUMPTIONS, capUnits: "5000000000", deadlines: { deadlineMs: 120000, childWatchdogMs: 130000, runDeadlineMs: 600000 } } };
  const outputRoot = join(root, "output"); await mkdir(outputRoot, { mode: 0o700 });
  const credentialPath = join(root, "credential.json"), account = "fictional-e2-account";
  const token = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fictional`;
  await save(credentialPath, { "openai-codex": { type: "oauth", access: token, refresh: "fictional-refresh", expires: 0 } });
  const artifact = { schema: E2_AUTHORIZATION_SCHEMA, authorizationId: "fictional-e2-authorization", salt: "c".repeat(64), accountCommitment: "", timestamp: "2042-03-01T09:00:00.000Z", approver: "fictional-maintainer", numericApprovalReference: "fictional-test-only", bindings: {} };
  artifact.accountCommitment = hash(`mono-agent/lcc-e2/account-v1\0${artifact.salt}\0${account}`);
  const authorizationPath = join(root, "authorization.json"), registrationPath = join(root, "registration.json");
  const args = { authorizationPath, registrationPath, registrationSha256: "", outputRoot, credentialPath, controllerRoot: ROOT };
  const result = { root, home, pilot, artifact, args, trace, account };
  result.persist = async () => { const raw = JSON.stringify(pilot); await writeFile(registrationPath, raw, { mode: 0o600 }); args.registrationSha256 = hash(raw);
    artifact.bindings = e2AuthorizationBindings(pilot, args.registrationSha256, { outputRoot, credentialPath, salt: artifact.salt, accountCommitment: artifact.accountCommitment }); await save(authorizationPath, artifact); };
  await result.persist(); return result;
}
beforeEach(async () => { build.verify.mockReset().mockResolvedValue(undefined); build.state.mockReset().mockReturnValue({ head: "b".repeat(40), dirty: false }); f = undefined; f = await fixture(); });
afterEach(async () => { if (f) { expect(await readdir(f.home)).toEqual([]); expect(await readdir(f.args.outputRoot)).toEqual([]); } for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("validates the real binding/account policy with opaque core handles and no consumption or credential refresh", async () => {
  const before = await readFile(f.args.credentialPath), core = guardedAuthorization("e2-validation");
  const handle = await core.validate(f.args);
  expect(core.bindsRegistration(handle, f.pilot)).toBe(true); expect(core.bindsRegistration({ ...handle }, f.pilot)).toBe(false);
  expect(core.binds(handle, f.pilot.descriptor, f.pilot.registration.catalog)).toBe(true);
  expect(core.matchesAccountHandle(handle, f.account)).toBe(true); expect(core.matchesAccountHandle(handle, "other-fictional-account")).toBe(false);
  expect(build.verify).toHaveBeenCalledWith(ROOT, f.pilot.registration.build); expect(await readFile(f.args.credentialPath)).toEqual(before);
});
it.each(["code", "build", "catalog", "protocol", "source", "probes", "keys", "soul", "roles", "schedule", "account", "tools", "deadlines", "capUnits", "descriptor", "outputRoot", "credentialPath", "registrationRawSha256", "registrationSha256"])("rejects %s authorization-binding substitution", async field => {
  f.artifact.bindings[field] = { substituted: true }; await save(f.args.authorizationPath, f.artifact);
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_authorization_binding_mismatch" });
});
it("refuses missing paidRole and phase evidence and smaller unenforced Codex ceilings", async () => {
  const r = f.pilot.registration, sizing = JSON.parse(await readFile(r.sizing[0].path));
  const change = async () => { const raw = JSON.stringify(sizing); await writeFile(r.sizing[0].path, raw); r.sizing[0].sha256 = hash(raw); await f.persist(); };
  delete sizing.variants[0].requests[0].paidRole; await change();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "E2_SIZING_PAID_ROLE_REQUIRED" });
  sizing.variants[0].requests[0].paidRole = null; delete sizing.variants[0].requests[0].phase; await change();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "E2_SIZING_PHASE_REQUIRED" });
  sizing.variants[0].requests[0].phase = "whole"; r.roles[0].maxOutputTokens = 4096; await change();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "E2_OUTPUT_LIMIT_UNENFORCED" });
});
it("rejects non-integer caps, schedule/catalog/tool/soul substitutions and stale builds", async () => {
  const baseline = structuredClone(f.pilot);
  for (const mutate of [p => { p.descriptor.capUnits = 1.25; }, p => { p.registration.schedule[0].budgets[0].maxRequests++; }, p => { p.registration.catalog[0].cost.input++; }, p => { p.registration.toolPolicies = {}; }, p => { p.registration.soul.rawDigest = "d".repeat(64); }]) {
    Object.assign(f.pilot, structuredClone(baseline)); mutate(f.pilot); await f.persist();
    await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_registration_invalid" });
  }
  Object.assign(f.pilot, baseline); await f.persist(); build.verify.mockRejectedValueOnce(Error("fictional stale build"));
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_registration_invalid" });
});
it("binds source bytes and validates genuine C1 source evidence, not just protocol metadata", async () => {
  const binding = f.pilot.registration.protocol, protocol = structuredClone(f.trace.protocol); protocol.branches[0].transitions[0].evidence[0].part = 999;
  const raw = JSON.stringify(protocol); await writeFile(binding.path, raw); binding.sha256 = hash(raw); await f.persist();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_registration_invalid" });
});
it("refuses a public-mode source and CI before any credential resolution", async () => {
  await chmod(f.pilot.registration.source.path, 0o644);
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_registration_invalid" });
  vi.stubEnv("CI", "1"); await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "paid_mode_refused_in_ci" });
});
it("cross-binds private question/key ids to uniquely resolved checkpoint ordinals", () => {
  const questions = { schema: "continuity-recorded-questions-v1", questions: [{ id: "fictional-item", checkpoint: "B1", prompt: "State the fictional value." }] };
  const keys = { schema: "continuity-recorded-evaluator-keys-v1", keys: [{ id: "fictional-item", checkpoint: "B1", kind: "exact", expected: "Fictional response", availability: "available", rate: true, dependsOnSteps: [], forbidden: [] }] };
  expect(e2ProbeCounts(f.trace.protocol, questions, keys, f.trace.source).map(c => c.questions)).toEqual([1, 0, 0, 0]);
  keys.keys[0].id = "different-fictional-item";
  expect(() => e2ProbeCounts(f.trace.protocol, questions, keys, f.trace.source)).toThrow("e2_registration_invalid");
});

it("rejects actual credential account substitution and protocol-handle reuse", async () => {
  const core = guardedAuthorization("e2-validation"), handle = await core.validate(f.args);
  expect(guardedAuthorization("lookup-pilot").bindsRegistration(handle, f.pilot)).toBe(false);
  const credentials = JSON.parse(await readFile(f.args.credentialPath));
  credentials["openai-codex"].access = `fictional.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "other-fictional-account" } })).toString("base64url")}.fictional`;
  await save(f.args.credentialPath, credentials);
  await expect(core.validate(f.args)).rejects.toMatchObject({ code: "e2_account_mismatch" });
});
it("uses the source-only 128 MiB read allowance without enlarging ordinary authorization reads", async () => {
  const source = structuredClone(f.trace.source), row = source.web.messages.find(m => m.role === "user");
  row.parts_json = JSON.stringify([{ type: "text", text: "s".repeat(4 * 1024 * 1024) }]);
  const raw = JSON.stringify(source); expect(Buffer.byteLength(raw)).toBeGreaterThan(4 * 1024 * 1024);
  await writeFile(f.pilot.registration.source.path, raw); f.pilot.registration.source.sha256 = hash(raw); await f.persist();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).resolves.toBeDefined();
  // The authorization artifact keeps the shared 4 MiB ceiling.
  f.artifact.numericApprovalReference = "s".repeat(4 * 1024 * 1024); await save(f.args.authorizationPath, f.artifact);
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_unsafe_authorization_file" });
});

it("refuses pre-approved future summary digests instead of treating them as generated receipts", async () => {
  f.pilot.registration.summaryDigests = ["e".repeat(64)]; await f.persist();
  await expect(guardedAuthorization("e2-validation").validate(f.args)).rejects.toMatchObject({ code: "e2_registration_invalid" });
});
