import { spawn } from "node:child_process";
import { once } from "node:events";
import * as files from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireAgentRootOwnership, agentRootLeasePath, releaseAgentRootOwnershipWhenIdle } from "../durable-state/agent-root-coordinator.js";
import { agentRootDigest, AGENT_ROOT_LEASE_MUTATION_GATE } from "../durable-state/agent-root-lease-policy.js";
import { createAgentRootLeaseSweepScheduler, sweepAgentRootLeases } from "../durable-state/agent-root-lease-sweep.js";
import { withOwnerLockMutationGate } from "../durable-state/owner-lock-mutation-gate.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), readlink: vi.fn(actual.readlink) };
});

const NOW = Date.parse("2026-01-10T12:00:00Z");
const HOUR = 60 * 60_000;
const incarnation = { schema: "mono-agent.process-incarnation.v1", bootSessionId: "fictional-boot", processStartId: "fictional-start" } as const;
const scratch: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await Promise.all(scratch.splice(0).map((path) => files.rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await files.mkdtemp(join(await files.realpath(tmpdir()), "agent-root-sweep-")); scratch.push(dir);
  const home = join(dir, "home"), root = join(dir, "absent-agent");
  const lease = agentRootLeasePath(root, home), leaseRoot = dirname(lease);
  await files.mkdir(leaseRoot, { recursive: true, mode: 0o700 });
  const seed = async (agentRoot = root, patch: Record<string, unknown> = {}) => {
    const path = agentRootLeasePath(agentRoot, home);
    await files.mkdir(path, { mode: 0o700 });
    const record = { schema: "mono-agent.agent-root-lease.v1", pid: 99999999, token: "fictional-owner", createdAt: new Date(NOW - 2 * HOUR).toISOString(),
      incarnation, rootDigest: agentRootDigest(agentRoot), agentRoot, ...patch };
    await files.writeFile(join(path, "owner.json"), JSON.stringify(record) + "\n", { mode: 0o600 });
    return path;
  };
  const options = { leaseRoot, context: "host" as const, platform: "darwin" as const, now: () => NOW, monotonicNow: () => 0, isSameProcessIncarnation: vi.fn(async () => false), onDiagnostic: vi.fn() };
  return { dir, home, root, lease, leaseRoot, seed, options };
}
const exists = async (path: string) => files.lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });

describe("conservative absent-root lease sweep", () => {
  it("reclaims a validated dead owner with an absent root through the shared quarantine", async () => {
    const f = await fixture(); await f.seed();
    const step = vi.fn();
    await sweepAgentRootLeases({ ...f.options, mutationStep: step });
    expect(await exists(f.lease)).toBe(false);
    expect(f.options.isSameProcessIncarnation).toHaveBeenCalledWith(99999999, incarnation);
    expect(step.mock.calls.map(([value]) => value)).toEqual(["gate-acquired", "stale-verified", "stale-detached"]);
    expect(await files.readdir(f.leaseRoot)).toEqual([AGENT_ROOT_LEASE_MUTATION_GATE]);
    expect(f.options.onDiagnostic).not.toHaveBeenCalled();
  });

  it.each(["live", "uncertain"])("keeps an absent-root lease when liveness is %s", async (state) => {
    const f = await fixture(); await f.seed();
    const probe = vi.fn(async () => { if (state === "uncertain") throw new Error("fictional unavailable identity"); return true; });
    await sweepAgentRootLeases({ ...f.options, isSameProcessIncarnation: probe });
    expect(await exists(f.lease)).toBe(true); expect(probe).toHaveBeenCalledOnce();
  });

  it("checks for an existing root before liveness", async () => {
    const f = await fixture(); await f.seed(); await files.mkdir(f.root);
    await sweepAgentRootLeases(f.options);
    expect(await exists(f.lease)).toBe(true); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "ENOTDIR", "EIO"])("keeps the owner when root inspection returns %s, without probing liveness", async (code) => {
    const f = await fixture(); await f.seed();
    await sweepAgentRootLeases({ ...f.options, lstatRoot: async () => { throw Object.assign(new Error(f.root), { code }); } });
    expect(await exists(f.lease)).toBe(true); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
    expect(f.options.onDiagnostic).toHaveBeenCalledOnce();
    expect(f.options.onDiagnostic.mock.calls[0]![0]).not.toContain(f.root);
  });

  it.each(["legacy", "root-mismatch", "digest-mismatch", "invalid", "ownerless"])("keeps %s records", async (kind) => {
    const f = await fixture();
    await f.seed(f.root, kind === "legacy" ? { agentRoot: undefined }
      : kind === "root-mismatch" ? { agentRoot: join(f.dir, "another-agent") }
      : kind === "digest-mismatch" ? { rootDigest: "0".repeat(64) } : {});
    if (kind === "invalid") await files.writeFile(join(f.lease, "owner.json"), "invalid json");
    if (kind === "ownerless") await files.unlink(join(f.lease, "owner.json"));
    await sweepAgentRootLeases(f.options);
    expect(await exists(f.lease)).toBe(true); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
  });

  it.each([HOUR - 1, -HOUR, HOUR])("requires the one-hour createdAt floor (age %s)", async (age) => {
    const f = await fixture(); await f.seed(f.root, { createdAt: new Date(NOW - age).toISOString() });
    await sweepAgentRootLeases(f.options);
    expect(await exists(f.lease)).toBe(age < HOUR);
    expect(f.options.isSameProcessIncarnation).toHaveBeenCalledTimes(age < HOUR ? 0 : 1);
  });

  it("randomly samples at most 16 leases and never touches artifact directories", async () => {
    const f = await fixture();
    for (let i = 0; i < 40; i += 1) await f.seed(join(f.dir, `absent-${i}`));
    const artifactNames = [".fictional.stale", ".fictional.released", ".fictional.abandoned"];
    for (const name of artifactNames) await files.mkdir(join(f.leaseRoot, name));
    const names = (await files.readdir(f.leaseRoot)).filter((name) => name.endsWith(".lease"));
    const randomIndex = vi.fn((bound: number) => bound - 1);
    await sweepAgentRootLeases({ ...f.options, randomIndex });
    expect(randomIndex).toHaveBeenCalledTimes(16);
    expect(f.options.isSameProcessIncarnation).toHaveBeenCalledTimes(16);
    const remaining = await files.readdir(f.leaseRoot);
    expect(remaining.filter((name) => name.endsWith(".lease"))).toHaveLength(24);
    expect(remaining).not.toContain(names.at(-1)); // Not a fixed prefix scan.
    expect(remaining).toEqual(expect.arrayContaining(artifactNames));
  });

  it("skips a busy gate without queueing or an ownership error", async () => {
    const f = await fixture(); await f.seed();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((done) => { entered = done; });
    const gate = new Promise<void>((done) => { release = done; });
    const held = withOwnerLockMutationGate({ path: join(f.leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE) }, "Fictional holder", async () => { entered(); await gate; });
    await ready;
    try {
      await sweepAgentRootLeases(f.options);
      expect(await exists(f.lease)).toBe(true); expect(f.options.onDiagnostic).not.toHaveBeenCalled();
    } finally { release(); await held; }
  });

  it("skips SQLite BUSY while another process holds the agent-root gate", async () => {
    const f = await fixture(); await f.seed();
    const moduleUrl = new URL("../../dist/durable-state/owner-lock-mutation-gate.js", import.meta.url).href;
    const source = `
      import { withOwnerLockMutationGate } from ${JSON.stringify(moduleUrl)};
      await withOwnerLockMutationGate({ path: ${JSON.stringify(join(f.leaseRoot, AGENT_ROOT_LEASE_MUTATION_GATE))} }, "Fictional child holder", async () => {
        process.send("held");
        await new Promise((done) => process.once("message", done));
      });
      process.disconnect();
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const ready = once(child, "message"), exited = once(child, "exit");
    let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    try {
      expect((await Promise.race([ready, exited.then(() => { throw new Error(stderr || "gate holder exited early"); })]))[0]).toBe("held");
      const step = vi.fn();
      await sweepAgentRootLeases({ ...f.options, mutationStep: step });
      expect(f.options.isSameProcessIncarnation).toHaveBeenCalledOnce();
      expect(step).not.toHaveBeenCalled(); expect(f.options.onDiagnostic).not.toHaveBeenCalled();
      expect(await exists(f.lease)).toBe(true); expect(child.exitCode).toBeNull();
      child.send("release"); expect((await exited)[0], stderr).toBe(0);
      await sweepAgentRootLeases(f.options);
      expect(await exists(f.lease)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
  });

  it("never mutates on a liveness result arriving after the monotonic budget", async () => {
    const f = await fixture(); await f.seed();
    let finish!: (alive: boolean) => void;
    const probe = new Promise<boolean>((done) => { finish = done; });
    await sweepAgentRootLeases({ ...f.options, monotonicNow: () => performance.now(), budgetMs: 10, isSameProcessIncarnation: () => probe });
    expect(await exists(f.lease)).toBe(true);
    finish(false); await new Promise((done) => setTimeout(done, 20));
    expect(await exists(f.lease)).toBe(true);
  });

  it("rechecks its budget at the final gated rename boundary", async () => {
    const f = await fixture(); await f.seed(); let clock = 0;
    await sweepAgentRootLeases({ ...f.options, monotonicNow: () => clock, mutationStep: (step) => { if (step === "stale-verified") clock = 101; } });
    expect(await exists(f.lease)).toBe(true);
  });

  it("rechecks root absence under the gate and leaves exactly one concurrent official owner", async () => {
    const f = await fixture(); await f.seed();
    let child: ReturnType<typeof spawn> | undefined;
    const messages: string[] = []; let stderr = "";
    try {
      await sweepAgentRootLeases({ ...f.options, mutationStep: async (step) => {
        if (step !== "stale-verified") return;
        await files.mkdir(f.root);
        const moduleUrl = new URL("../../dist/durable-state/agent-root-coordinator.js", import.meta.url).href;
        const source = `
          import { acquireAgentRootOwnership, releaseAgentRootOwnershipWhenIdle } from ${JSON.stringify(moduleUrl)};
          process.send("starting");
          const held = await acquireAgentRootOwnership(${JSON.stringify(f.root)}, { homeDir: ${JSON.stringify(f.home)} });
          process.send("owned");
          await new Promise((done) => process.once("message", done));
          await releaseAgentRootOwnershipWhenIdle(held); process.disconnect();
        `;
        child = spawn(process.execPath, ["--input-type=module", "--eval", source], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
        child.on("message", (message: string) => messages.push(message));
        child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
        await vi.waitFor(() => expect(messages, stderr).toContain("starting"));
      } });
      await vi.waitFor(() => expect(messages, stderr).toContain("owned"), { timeout: 5000 });
      await expect(acquireAgentRootOwnership(f.root, { homeDir: f.home })).rejects.toThrow("already using this agent root");
      const record = JSON.parse(await files.readFile(join(f.lease, "owner.json"), "utf8"));
      expect(record.pid).toBe(child!.pid); expect(record.agentRoot).toBe(f.root);
      const exited = once(child!, "exit"); child!.send("stop"); expect((await exited)[0], stderr).toBe(0);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
    }
  });

  it("keeps a root that becomes inaccessible at the final gated check", async () => {
    const f = await fixture(); await f.seed();
    const lstatRoot = vi.fn().mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }))
      .mockRejectedValueOnce(Object.assign(new Error(f.root), { code: "EACCES" }));
    await sweepAgentRootLeases({ ...f.options, lstatRoot });
    expect(lstatRoot).toHaveBeenCalledTimes(2); expect(await exists(f.lease)).toBe(true);
    expect(f.options.onDiagnostic).toHaveBeenCalledOnce();
  });

  it("retains an owner replaced after its death proof but before gated identity verification", async () => {
    const f = await fixture(); await f.seed();
    await sweepAgentRootLeases({ ...f.options, mutationStep: async (step) => {
      if (step !== "gate-acquired") return;
      const owner = JSON.parse(await files.readFile(join(f.lease, "owner.json"), "utf8"));
      await files.writeFile(join(f.lease, "owner.json"), JSON.stringify({ ...owner, token: "replacement-owner" }));
    } });
    expect(await exists(f.lease)).toBe(true);
    expect(JSON.parse(await files.readFile(join(f.lease, "owner.json"), "utf8")).token).toBe("replacement-owner");
  });

  it("reports at most one bounded path-free diagnostic even when many entries fail", async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i += 1) await f.seed(join(f.dir, `bad-${i}`), { rootDigest: "invalid" });
    await sweepAgentRootLeases(f.options);
    expect(f.options.onDiagnostic).toHaveBeenCalledOnce();
    expect(f.options.onDiagnostic.mock.calls[0]![0]).not.toContain(f.dir);
    await expect(sweepAgentRootLeases({ ...f.options, onDiagnostic: () => { throw new Error("logger unavailable"); } })).resolves.toBeUndefined();
  });

  it("does no filesystem work in a sandboxed context", async () => {
    const f = await fixture(); await f.seed();
    const listing = vi.mocked(files.readdir);
    await sweepAgentRootLeases({ ...f.options, context: "sandbox" });
    expect(listing).not.toHaveBeenCalled(); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
  });
});

describe("process-namespace admission", () => {
  it.each([
    ["initial namespace", "pid:[4026531836]", true],
    ["container namespace", "pid:[4026532500]", false],
    ["malformed link", "pid:4026531836", false],
    ["empty link", "", false],
    ["unexpected suffix", "pid:[4026531836]\n", false],
  ] as const)("admits Linux's %s only when it matches the initial namespace identity", async (_label, link, admitted) => {
    const f = await fixture(); await f.seed();
    const readNamespaceLink = vi.fn(async () => link);
    await sweepAgentRootLeases({ ...f.options, platform: "linux", readNamespaceLink });
    expect(readNamespaceLink).toHaveBeenCalledExactlyOnceWith("/proc/self/ns/pid");
    expect(await exists(f.lease)).toBe(!admitted);
    expect(f.options.isSameProcessIncarnation).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect(files.readdir).toHaveBeenCalledTimes(admitted ? 1 : 0);
  });

  it.each(["ENOENT", "EACCES"])("skips Linux without listing leases when the namespace link returns %s", async (code) => {
    const f = await fixture(); await f.seed();
    await sweepAgentRootLeases({ ...f.options, platform: "linux", readNamespaceLink: async () => { throw Object.assign(new Error("namespace unavailable"), { code }); } });
    expect(await exists(f.lease)).toBe(true);
    expect(files.readdir).not.toHaveBeenCalled(); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
    expect(f.options.onDiagnostic).not.toHaveBeenCalled();
  });

  it("does not inspect leases after namespace admission exhausts the budget", async () => {
    const f = await fixture(); await f.seed(); let clock = 0;
    await sweepAgentRootLeases({ ...f.options, platform: "linux", monotonicNow: () => clock,
      readNamespaceLink: async () => { clock = 101; return "pid:[4026531836]"; } });
    expect(await exists(f.lease)).toBe(true);
    expect(files.readdir).not.toHaveBeenCalled(); expect(f.options.isSameProcessIncarnation).not.toHaveBeenCalled();
  });

  it.each(["darwin", "win32"] as const)("does not consult Linux procfs on %s", async (platform) => {
    const f = await fixture(); await f.seed();
    const readNamespaceLink = vi.fn(async () => "pid:[4026531836]");
    await sweepAgentRootLeases({ ...f.options, platform, readNamespaceLink });
    expect(readNamespaceLink).not.toHaveBeenCalled();
    expect(await exists(f.lease)).toBe(platform !== "darwin");
    expect(files.readdir).toHaveBeenCalledTimes(platform === "darwin" ? 1 : 0);
  });
});

describe("host-only asynchronous scheduling", () => {
  it("runs once, only after host admission, and contains a rejected sweep", async () => {
    const sweep = vi.fn(async () => { throw new Error("fictional-private-path"); });
    const schedule = createAgentRootLeaseSweepScheduler(sweep);
    const diagnostic = vi.fn();
    schedule({ context: "sandbox", leaseRoot: "/unused", onDiagnostic: diagnostic });
    expect(sweep).not.toHaveBeenCalled();
    schedule({ context: "host", leaseRoot: "/unused", onDiagnostic: diagnostic });
    schedule({ context: "host", leaseRoot: "/unused", onDiagnostic: diagnostic });
    expect(sweep).not.toHaveBeenCalled(); // Not run inline or awaited by the caller.
    await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledOnce());
    expect(sweep).toHaveBeenCalledOnce(); expect(diagnostic.mock.calls[0]![0]).not.toContain("fictional-private-path");
  });

  it("never rejects acquisition on a failed sweep, and schedules only once across successful acquisitions", async () => {
    const f = await fixture(); await files.mkdir(f.root);
    const listing = vi.mocked(files.readdir).mockRejectedValueOnce(new Error(f.dir));
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    // Exercise scheduler failure containment even if this suite runs inside a Linux container.
    vi.mocked(files.readlink).mockResolvedValueOnce("pid:[4026531836]");
    // Raw and explicitly sandboxed acquisitions do not opt into maintenance.
    const first = await acquireAgentRootOwnership(f.root, { homeDir: f.home });
    const sandboxed = await acquireAgentRootOwnership(f.root, { homeDir: f.home, sweepContext: "sandbox" });
    await new Promise((done) => setImmediate(done)); expect(listing).not.toHaveBeenCalled();
    const host = await acquireAgentRootOwnership(f.root, { homeDir: f.home, sweepContext: "host" });
    try {
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith(expect.any(String), "AgentRootLeaseSweepWarning"));
      const again = await acquireAgentRootOwnership(f.root, { homeDir: f.home, sweepContext: "host" });
      await releaseAgentRootOwnershipWhenIdle(again);
      const anotherRoot = join(f.dir, "another-agent"); await files.mkdir(anotherRoot);
      const another = await acquireAgentRootOwnership(anotherRoot, { homeDir: f.home, sweepContext: "host" });
      await releaseAgentRootOwnershipWhenIdle(another);
      await new Promise((done) => setImmediate(done));
      expect(listing).toHaveBeenCalledOnce(); expect(warning).toHaveBeenCalledOnce();
    } finally {
      await releaseAgentRootOwnershipWhenIdle(first); await releaseAgentRootOwnershipWhenIdle(sandboxed); await releaseAgentRootOwnershipWhenIdle(host);
    }
  });
});
