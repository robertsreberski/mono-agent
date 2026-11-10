import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const calls = vi.hoisted(() => ({ run: vi.fn(async () => ({ stop: "completed" })), reconcile: vi.fn(async () => ({ reconciliation: true })) }));
vi.mock("../lib/continuity-guarded-controller.mjs", () => ({ guardedController: id => { if (id !== "e2-validation") throw Error("unexpected_protocol"); return { runLookupPilot: calls.run, reconcileLookupPilot: calls.reconcile }; } }));
import { runE2Paid, reconcileE2Paid } from "../lib/continuity-e2-paid-entry.mjs";
import { parseE2Args } from "../continuity-e2.mjs";
import { digest } from "../lib/continuity-recorded-schema.mjs";
let root, args, pilot;
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", undefined);
  root = await realpath(await mkdtemp(join(tmpdir(), "e2-entry-selection-"))); vi.stubEnv("HOME", join(root, "home")); await mkdir(join(root, "home"), { mode: 0o700 });
  pilot = { registration: { schedule: [{ kind: "replay", index: 0 }, { kind: "proof", index: 1 }] } };
  const registrationPath = join(root, "registration.json"), raw = JSON.stringify(pilot); await writeFile(registrationPath, raw, { mode: 0o600 });
  args = { command: "run", registrationPath, registrationSha256: digest(raw), authorizationPath: join(root, "missing-authorization.json"), credentialPath: join(root, "missing-credential.json"), outputRoot: join(root, "output") };
  await mkdir(args.outputRoot, { mode: 0o700 });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
const flags = ["--registration", "registration.json", "--sha256", "a".repeat(64), "--authorization", "authorization.json", "--credentials", "credentials.json", "--output", "output"];
it("parses only whole-schedule real commands and read-only reconciliation", () => {
  expect(parseE2Args(["run", "--summary", "real", ...flags])).toMatchObject({ command: "run", summary: "real", real: true });
  expect(parseE2Args(["proofs", "--real", ...flags])).toMatchObject({ command: "proofs", real: true });
  expect(parseE2Args(["reconcile", "--output", "output"])).toEqual({ command: "reconcile", output: "output" });
  for (const extra of [["--arm", "switch"], ["--checkpoint", "B1"], ["--resume", "yes"], ["--real"]]) expect(() => parseE2Args(["proofs", "--real", ...flags, ...extra])).toThrow("E2_ARGUMENTS_INVALID");
});
it("forwards the complete frozen registration, never a subset, to the closed E2 controller", async () => {
  await runE2Paid(args);
  expect(calls.run).toHaveBeenCalledOnce(); expect(calls.run.mock.calls[0][0]).toMatchObject({ pilot, real: true, outputRoot: args.outputRoot });
  expect(calls.run.mock.calls[0][0].authorization.registrationSha256).toBe(args.registrationSha256);
});
it("refuses a mixed proof selection before the controller, lease or burn", async () => {
  await expect(runE2Paid({ ...args, command: "proofs" })).rejects.toMatchObject({ code: "e2_registration_invalid" });
  expect(calls.run).not.toHaveBeenCalled(); expect(await readdir(args.outputRoot)).toEqual([]); expect(await readdir(join(root, "home"))).toEqual([]);
});
it("allows a whole proof-only registration without creating or reading approval itself", async () => {
  pilot.registration.schedule = [{ kind: "proof", index: 0 }]; const raw = JSON.stringify(pilot); await writeFile(args.registrationPath, raw, { mode: 0o600 });
  await runE2Paid({ ...args, command: "proofs", registrationSha256: digest(raw) }); expect(calls.run.mock.calls[0][0].pilot).toEqual(pilot);
  await expect(readFile(args.authorizationPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects direct subset selectors and hash substitutions before controller setup", async () => {
  await expect(runE2Paid({ ...args, arm: "switch" })).rejects.toMatchObject({ code: "e2_registration_invalid" });
  await expect(runE2Paid({ ...args, registrationSha256: "0".repeat(64) })).rejects.toMatchObject({ code: "e2_registration_invalid" });
  expect(calls.run).not.toHaveBeenCalled();
});
it("CI/debug refuse without dispatch, and reconciliation has no execution options", async () => {
  vi.stubEnv("CI", "1"); await expect(runE2Paid(args)).rejects.toMatchObject({ code: "paid_mode_refused_in_ci" });
  vi.stubEnv("CI", undefined); vi.stubEnv("CONTINUITY_DEBUG", "1"); await expect(runE2Paid(args)).rejects.toMatchObject({ code: "e2_debug_forbidden" });
  expect(calls.run).not.toHaveBeenCalled(); await reconcileE2Paid(args.outputRoot); expect(calls.reconcile).toHaveBeenCalledWith(args.outputRoot);
  expect(JSON.parse(await readFile(args.registrationPath, "utf8"))).toEqual(pilot);
});
