import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSandboxPolicy, type ProcessJobProcessResult, type SandboxCommandSpec, type SandboxPolicy } from "@mono-agent/runtime-adapter";
import { isSubagentVerificationObservation, observeSubagentVerification, registerSubagentVerification } from "../subagent-verification-observer.js";
import { createSubagentRecoveryAccess } from "../subagent-recovery-access.js";
import type { ProcessJobsServiceHandle } from "../process-jobs-service.js";
import { resolveSubagentObservationGit } from "../subagent-observation-git.js";
vi.mock("../subagent-observation-git.js", () => ({ resolveSubagentObservationGit: vi.fn(async () => ({ path: "/trusted/native/git", identity: "installed" })) }));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const sha = "a".repeat(40);
const completed = (stdout: string): ProcessJobProcessResult => ({ code: 0, signal: null, stdout, stderr: "", aborted: false, timedOut: false, bufferExceeded: false, truncated: false, bytes: stdout.length, storedBytes: stdout.length, spawnError: null, groupExitConfirmed: true, durationMs: 1 });
async function fixture() {
  vi.mocked(resolveSubagentObservationGit).mockReset().mockResolvedValue({ path: "/trusted/native/git", identity: "installed" });
  const root = await mkdtemp(resolve(process.cwd(), "node_modules/.verification-observer-")); roots.push(root);
  await mkdir(resolve(root, ".git/objects"), { recursive: true }); await mkdir(resolve(root, ".git/refs"));
  await writeFile(resolve(root, ".git/HEAD"), "ref: refs/heads/main\n"); await writeFile(resolve(root, ".git/config"), "[core]\nrepositoryformatversion = 0\n");
  const cleanup = vi.fn(async () => {});
  const prepareCommand = vi.fn(async (spec: SandboxCommandSpec, _policy: SandboxPolicy) => ({ ...spec, args: [...(spec.args ?? [])], cwd: spec.cwd!, sandboxed: true, cleanup }));
  const runProbe = vi.fn(async (prepared: { args: readonly string[] }) => completed(prepared.args.includes("config") ? "core.repositoryformatversion\0" : prepared.args.includes("status") ? " M tracked.txt\0?? new.txt\0" : sha + "\n"));
  const access = { workspace: root, readableRoots: [] as string[], sandboxPolicy: createSandboxPolicy({ root, mode: "native" }),
    sandboxEngine: { id: "srt" as const, isAvailable: vi.fn(async () => true), prepareCommand }, runProbe };
  const target = await registerSubagentVerification({ workdir: root, reportPath: "report.md" }, access, []);
  return { root, target, access, cleanup, prepareCommand, runProbe };
}
it("collects bounded fixed read-only probes and report presence, not report contents or a success verdict", async () => {
  const f = await fixture(); await writeFile(resolve(f.root, "report.md"), "PRIVATE REPORT BODY", { mode: 0o000 });
  const result = await observeSubagentVerification(f.target, f.access, []);
  expect(result).toMatchObject({ status: "observed", headBefore: sha, headAfter: sha, report: { path: "report.md", present: true }, paths: [{ path: "tracked.txt", status: "tracked" }, { path: "new.txt", status: "untracked" }] });
  expect(isSubagentVerificationObservation(result)).toBe(true);
  expect(JSON.stringify(result).includes("PRIVATE REPORT BODY")).toBe(false);
  expect(f.runProbe).toHaveBeenCalledTimes(4); expect(f.cleanup).toHaveBeenCalledTimes(4);
  for (const [spec, policy] of f.prepareCommand.mock.calls) {
    expect(spec.command).toBe("/trusted/native/git"); expect(spec.cwd).toBe(f.root);
    expect(policy.readableRoots).toEqual(f.access.sandboxPolicy.readableRoots);
    expect(f.access.readableRoots).toEqual([]); // Runtime access is not repository authority.
    expect(spec.args).toContain(`--work-tree=${f.root}`); // core.worktree cannot redirect the declared observation.
    expect(spec.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" });
    expect(spec.env).not.toHaveProperty("GIT_DIR"); expect(spec.env).not.toHaveProperty("NODE_OPTIONS");
    expect(policy).toMatchObject({ mode: "native", writableRoots: [], network: { mode: "none" }, fallback: "fail-closed", unsafeAllowHostProcess: false });
  }
});
it("distinguishes absence from denied or unsafe report targets", async () => {
  const f = await fixture(); expect((await observeSubagentVerification(f.target, f.access, [])).report).toEqual({ path: "report.md", present: false });
  await symlink(resolve(f.root, ".git/config"), resolve(f.root, "report.md"));
  expect(await observeSubagentVerification(f.target, f.access, [resolve(f.root, ".git/config")])).toMatchObject({ status: "observation_policy_denied" });
});
it("does not authorize a linked worktree's common Git root by admitting its workdir", async () => {
  const f = await fixture(); await rm(resolve(f.root, ".git"), { recursive: true });
  await writeFile(resolve(f.root, ".git"), "gitdir: ../not-authorized/common\n");
  const result = await observeSubagentVerification(f.target, f.access, []);
  expect(result.status).toBe("observation_policy_denied"); expect(result.workdir).toBeUndefined(); expect(f.runProbe).not.toHaveBeenCalled();
});
it("refuses unsupported object alternates before executing Git", async () => {
  const f = await fixture(); await mkdir(resolve(f.root, ".git/objects/info")); await writeFile(resolve(f.root, ".git/objects/info/alternates"), "/not-authorized");
  expect((await observeSubagentVerification(f.target, f.access, [])).status).toBe("observation_unavailable"); expect(f.runProbe).not.toHaveBeenCalled();
});
it("refuses filter helpers using config names, without collecting values", async () => {
  const f = await fixture(); f.runProbe.mockResolvedValueOnce(completed("filter.untrusted.clean\0"));
  expect((await observeSubagentVerification(f.target, f.access, [])).status).toBe("observation_unavailable"); expect(f.runProbe).toHaveBeenCalledOnce();
  expect(f.prepareCommand.mock.calls[0]![0].args).toContain("--name-only");
});
it.each(["missing-engine", "unsandboxed"])("never falls back to host execution for %s", async (mode) => {
  const f = await fixture();
  if (mode === "missing-engine") f.access.sandboxEngine.isAvailable.mockResolvedValue(false);
  else f.prepareCommand.mockImplementation(async (spec) => ({ ...spec, args: [...(spec.args ?? [])], cwd: spec.cwd!, sandboxed: false, cleanup: f.cleanup }));
  expect((await observeSubagentVerification(f.target, f.access, [])).status).toBe("observation_unavailable"); expect(f.runProbe).not.toHaveBeenCalled();
});
it("reports changing HEAD as inconsistent rather than acceptance", async () => {
  const f = await fixture(); let heads = 0;
  f.runProbe.mockImplementation(async (prepared) => completed(prepared.args.includes("config") ? "" : prepared.args.includes("status") ? "" : (++heads === 1 ? sha : "b".repeat(40))));
  expect((await observeSubagentVerification(f.target, f.access, [])).status).toBe("observation_inconsistent");
});
it("bounds path count and aggregate bytes without truncating a path into a different path", async () => {
  const f = await fixture();
  f.runProbe.mockImplementation(async (prepared) => completed(prepared.args.includes("config") ? "" : prepared.args.includes("status") ? Array.from({ length: 100 }, (_, i) => `?? ${i}-${"x".repeat(100)}\0`).join("") : sha));
  const result = await observeSubagentVerification(f.target, f.access, []);
  expect(result.status).toBe("observed"); expect(result.paths!.length).toBeLessThanOrEqual(64); expect(result.omitted).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
});
it.each(["private", "policy"])("checks explicit %s runtime protection before preparing a native probe", async (source) => {
  const f = await fixture();
  if (source === "policy") f.access.sandboxPolicy = { ...f.access.sandboxPolicy, protectedRoots: ["/trusted"] };
  const result = await observeSubagentVerification(f.target, f.access, source === "private" ? ["/trusted/native/git"] : []);
  expect(result.status).toBe("observation_policy_denied"); expect(result.workdir).toBeUndefined();
  expect(f.prepareCommand).not.toHaveBeenCalled(); expect(f.runProbe).not.toHaveBeenCalled();
});
it("withholds observations when the trusted native executable is unavailable", async () => {
  const f = await fixture();
  vi.mocked(resolveSubagentObservationGit).mockRejectedValue(new Error("untrusted installation"));
  expect((await observeSubagentVerification(f.target, f.access, [])).status).toBe("observation_unavailable");
  expect(f.prepareCommand).not.toHaveBeenCalled(); expect(f.runProbe).not.toHaveBeenCalled();
});
it.each(["before-probe", "after-probe"])("withholds facts on native executable replacement %s", async (when) => {
  const f = await fixture();
  vi.mocked(resolveSubagentObservationGit).mockResolvedValue({ path: "/trusted/native/git", identity: "changed" })
    .mockResolvedValueOnce({ path: "/trusted/native/git", identity: "installed" });
  if (when === "after-probe") vi.mocked(resolveSubagentObservationGit).mockResolvedValueOnce({ path: "/trusted/native/git", identity: "installed" });
  const result = await observeSubagentVerification(f.target, f.access, []);
  expect(result.status).toBe("observation_unavailable"); expect(result.workdir).toBeUndefined();
  expect(f.runProbe).toHaveBeenCalledTimes(when === "before-probe" ? 0 : 1);
  expect(f.cleanup).toHaveBeenCalledTimes(when === "before-probe" ? 0 : 1);
});
it("reauthorizes disclosure after capture and withholds newly protected paths", async () => {
  const f = await fixture(); let reads = 0;
  const subject = { conversationId: "conversation", instanceId: "child", incarnation: "incarnation", verification: f.target,
    owner: { conversationId: "conversation", instanceId: "child", instanceIncarnation: "incarnation", turnToken: "turn", jobId: "job", storeRoot: f.root } };
  const record = vi.fn(async () => {});
  const service = { settings: { stateDir: f.root }, inspectSubagentRecovery: async () => ({ verification: f.target }), recordSubagentObservation: record } as unknown as ProcessJobsServiceHandle;
  const ports = createSubagentRecoveryAccess({ service, privateRoots: async () => ++reads >= 3 ? [f.root] : [], hostAccess: () => f.access });
  const result = await ports.observeRecovery(subject, f.access);
  expect(record).toHaveBeenCalledOnce(); expect(result).toEqual({ status: "observation_policy_denied" });
  expect(JSON.stringify(result).includes(f.root)).toBe(false);
});
