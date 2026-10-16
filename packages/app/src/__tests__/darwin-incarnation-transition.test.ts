import { spawn,type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod,mkdir,mkdtemp,readFile,realpath,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

import {
baselineOwnerRecord,
baselineOwnerRecordBytes,
baselineProcessJobIncarnationsAccepted,
baselineSubagentIncarnationAccepted,
baselineWebLeaseAccepted,
} from "./fixtures/baseline-a3cb9a611-incarnation-readers.js";

// Records written by new binaries must stay readable by old ones (sidecar), and
// a live owner must never be reclaimed because of Darwin identity drift (#1264).
const identity = vi.hoisted(() => ({ override: undefined as undefined | ((schema?: string) => unknown) }));
vi.mock("@mono-agent/conversation/process-incarnation", async (original) => {
  const real = await original<typeof import("@mono-agent/conversation/process-incarnation")>();
  return {
    ...real,
    currentProcessIncarnation: async (schema?: Parameters<typeof real.currentProcessIncarnation>[0]) =>
      identity.override?.(schema) ?? await real.currentProcessIncarnation(schema),
  };
});

import { acquireOwnerPrivateLock,type LegacyLockHolder } from "../owner-private-lock.js";
import { createHostWebRequestCoordinator } from "../web-request-coordinator.js";
import { openProcessJobStore,type DurableProcessJobRecord } from "../process-jobs-store.js";
import { isSubagentExecutionOwnership } from "../subagent-execution-ownership.js";
import { type SubagentExecutionOwnership } from "../subagents/types.js";

const hostPlatform = process.platform, platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const V1 = { schema: "mono-agent.process-incarnation.v1", bootSessionId: "darwin:1700000000:0", processStartId: "posix-lstart:Mon Jan 5 13:34:56 2026" } as const;
const V2 = { schema: "mono-agent.process-incarnation.v2", bootSessionId: "darwin-uuid:12345678-1234-1234-1234-123456789abc", processStartId: "posix-utc-lstart:Mon Jan 5 12:34:56 2026" } as const;
const SCHEMA = "mono-agent.fictional-transition-lock.v1";
const directories: string[] = [];
const children: ChildProcess[] = [];

function platform(value: NodeJS.Platform) { Object.defineProperty(process, "platform", { value }); }
async function temporary(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "mono-agent-darwin-incarnation-")));
  directories.push(path);
  return path;
}
async function liveOwner(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  children.push(child);
  await once(child, "spawn");
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}
/** Write an owner record exactly as a baseline (a3cb9a611) binary would. */
async function baselineLock(path: string, pid: number, extra: Record<string, unknown> = {}): Promise<string> {
  await mkdir(path, { mode: 0o700 });
  const content = baselineOwnerRecordBytes({ schemaTag: SCHEMA, pid, token: "fictional-token", createdAt: "2026-01-05T12:34:56.000Z", incarnation: V1 })
    .replace(/\}\n$/u, Object.keys(extra).length === 0 ? "}\n" : `,${JSON.stringify(extra).slice(1)}\n`);
  await writeFile(join(path, "owner.json"), content, { mode: 0o600 });
  await chmod(join(path, "owner.json"), 0o600);
  return content;
}
function lockOptions(path: string, extra: Partial<Parameters<typeof acquireOwnerPrivateLock>[0]> = {}) {
  return { path, label: "Fictional transition lock", schemaTag: SCHEMA, ownerlessGraceMs: 60_000, invalidOwner: "error" as const, ...extra };
}

beforeEach(() => { identity.override = undefined; });
afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(directories.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("owner-private-lock sidecar", () => {
  it("a Darwin writer keeps the v1 incarnation and adds a v2 sibling that the frozen a3cb9a611 reader accepts unchanged", async () => {
    const path = join(await temporary(), "lock");
    const held = await acquireOwnerPrivateLock(lockOptions(path, { processIncarnation: V2, legacyProcessIncarnation: V1 }));
    const content = await readFile(join(path, "owner.json"), "utf8");
    expect(JSON.parse(content)).toMatchObject({ schema: SCHEMA, pid: process.pid, incarnation: V1, stableIncarnation: V2 });
    expect(baselineOwnerRecord(content, SCHEMA)).toEqual({ pid: process.pid, incarnation: V1 });
    await held!.release();
  });

  it("Linux, win32 and other v1 writers produce byte-identical owner records", async () => {
    const path = join(await temporary(), "lock");
    const linux = { schema: "mono-agent.process-incarnation.v1", bootSessionId: "linux:fictional-boot", processStartId: "linux-ticks:123456" } as const;
    const held = await acquireOwnerPrivateLock(lockOptions(path, {
      processIncarnation: linux, pid: 4242, now: () => Date.parse("2026-01-05T12:34:56.000Z"), randomToken: () => "fictional-token",
      ownerFields: () => ({ label: "fictional" }),
    }));
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(baselineOwnerRecordBytes({
      ownerFields: { label: "fictional" }, schemaTag: SCHEMA, pid: 4242, token: "fictional-token",
      createdAt: "2026-01-05T12:34:56.000Z", incarnation: linux,
    }));
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe(
      `{"label":"fictional","schema":"${SCHEMA}","pid":4242,"token":"fictional-token","createdAt":"2026-01-05T12:34:56.000Z",`
      + `"incarnation":{"schema":"mono-agent.process-incarnation.v1","bootSessionId":"linux:fictional-boot","processStartId":"linux-ticks:123456"}}\n`,
    );
    await held!.release();
  });

  it("a live Darwin v1 legacy owner is held throughout and named with its path and PID, then reclaimed only after ESRCH", async () => {
    platform("darwin");
    const path = join(await temporary(), "lock");
    const owner = await liveOwner();
    const content = await baselineLock(path, owner.pid!);
    const holders: LegacyLockHolder[] = [];
    for (let observation = 0; observation < 3; observation += 1) {
      await expect(acquireOwnerPrivateLock(lockOptions(path, {
        processIncarnation: V2, legacyProcessIncarnation: V1, waitTimeoutMs: 60, pollIntervalMs: 10,
        onLegacyOwnerHeld: (holder) => holders.push(holder),
      }))).resolves.toBeUndefined();
      expect(await readFile(join(path, "owner.json"), "utf8")).toBe(content);
    }
    expect(holders).toEqual(Array(3).fill({ label: "Fictional transition lock", path, pid: owner.pid }));
    await stop(owner);
    const held = await acquireOwnerPrivateLock(lockOptions(path, { processIncarnation: V2, legacyProcessIncarnation: V1 }));
    expect(held).toBeDefined();
    expect(JSON.parse(await readFile(join(path, "owner.json"), "utf8"))).toMatchObject({ incarnation: V1, stableIncarnation: V2 });
    await held!.release();
  });

  it("without a callback, a held legacy owner raises one warning naming the lock path and PID", async () => {
    platform("darwin");
    const path = join(await temporary(), "lock");
    const owner = await liveOwner();
    await baselineLock(path, owner.pid!);
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(acquireOwnerPrivateLock(lockOptions(path, { processIncarnation: V2, legacyProcessIncarnation: V1 }))).resolves.toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(path);
    expect(String(warn.mock.calls[0]![0])).toContain(`PID ${owner.pid}`);
  });

  it("an invalid sidecar never makes a live owner ownerless", async () => {
    platform("darwin");
    const path = join(await temporary(), "lock");
    const owner = await liveOwner();
    await baselineLock(path, owner.pid!, { stableIncarnation: { schema: "mono-agent.process-incarnation.v1", bootSessionId: "x", processStartId: "y" } });
    await expect(acquireOwnerPrivateLock(lockOptions(path, {
      processIncarnation: V2, legacyProcessIncarnation: V1, onLegacyOwnerHeld: () => undefined,
    }))).resolves.toBeUndefined();
  });

  it.skipIf(hostPlatform !== "darwin")("real Darwin probes: a v2 sidecar whose PID was reused is reclaimed; a matching one is held", async () => {
    const path = join(await temporary(), "lock");
    const owner = await liveOwner();
    await baselineLock(path, owner.pid!, { stableIncarnation: { ...V2, processStartId: "posix-utc-lstart:Thu Jan 1 00:00:00 1970" } });
    const held = await acquireOwnerPrivateLock(lockOptions(path));
    expect(held).toBeDefined();
    await held!.release();
    const { readProcessIncarnation } = await vi.importActual<typeof import("@mono-agent/conversation/process-incarnation")>("@mono-agent/conversation/process-incarnation");
    await baselineLock(path, owner.pid!, { stableIncarnation: await readProcessIncarnation(owner.pid!) });
    await expect(acquireOwnerPrivateLock(lockOptions(path))).resolves.toBeUndefined();
  });
});

describe("web-control lease sidecar", () => {
  it("a Darwin lease keeps v1 incarnation plus a v2 sibling, accepted by the frozen a3cb9a611 reader", async () => {
    identity.override = (schema) => schema === "mono-agent.process-incarnation.v1" ? V1 : V2;
    const directory = join(await temporary(), "web-control");
    const coordinator = createHostWebRequestCoordinator({ directory });
    await coordinator.acquire({ kind: "fetch", key: "fictional", deadlineMs: Date.now() + 60_000 } as Parameters<typeof coordinator.acquire>[0]);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as { buckets: Record<string, { leases: Array<Record<string, unknown>> }> };
    const [lease] = Object.values(state.buckets)[0]!.leases;
    expect(lease).toMatchObject({ pid: process.pid, incarnation: V1, stableIncarnation: V2 });
    expect(baselineWebLeaseAccepted(lease!)).toBe(true);
  });

  it("a v1 writer's lease bytes are unchanged", async () => {
    identity.override = () => V1;
    const directory = join(await temporary(), "web-control");
    const coordinator = createHostWebRequestCoordinator({ directory });
    await coordinator.acquire({ kind: "fetch", key: "fictional", deadlineMs: 4_000_000_000_000 } as Parameters<typeof coordinator.acquire>[0]);
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as { buckets: Record<string, { leases: Array<Record<string, unknown>> }> };
    const [lease] = Object.values(state.buckets)[0]!.leases;
    expect(Object.keys(lease!)).toEqual(["id", "pid", "incarnation", "expiresAt"]);
  });

  it("an unexpired lease from a live legacy Darwin owner is retained; ESRCH alone prunes it", async () => {
    platform("darwin");
    identity.override = (schema) => schema === "mono-agent.process-incarnation.v1" ? V1 : V2;
    const directory = join(await temporary(), "web-control");
    const coordinator = createHostWebRequestCoordinator({ directory });
    await coordinator.acquire({ kind: "fetch", key: "seed", deadlineMs: Date.now() + 60_000 } as Parameters<typeof coordinator.acquire>[0]);
    const owner = await liveOwner();
    const statePath = join(directory, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { buckets: Record<string, { leases: Array<Record<string, unknown>> }> };
    const bucket = Object.values(state.buckets)[0]!;
    bucket.leases = [{ id: "fictional-legacy", pid: owner.pid, incarnation: V1, expiresAt: Date.now() + 60_000 }];
    await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
    const active = async () => ((await coordinator.inspect()) as { buckets: Array<{ active: number }> }).buckets[0]!.active;
    await coordinator.writeQuota({ fictional: true }); // a transaction without pruning
    await coordinator.acquire({ kind: "fetch", key: "other", deadlineMs: Date.now() + 60_000 } as Parameters<typeof coordinator.acquire>[0]); // prunes
    expect(await active()).toBe(1);
    await stop(owner);
    await coordinator.acquire({ kind: "fetch", key: "third", deadlineMs: Date.now() + 60_000 } as Parameters<typeof coordinator.acquire>[0]);
    expect(await active()).toBe(0);
  });
});

describe("review regressions", () => {
  it("a rejected web-control owner capture is retried by the same coordinator", async () => {
    let failures = 1;
    identity.override = (schema) => {
      if (failures > 0) { failures -= 1; throw new Error("Fictional probe timeout"); }
      return schema === "mono-agent.process-incarnation.v1" ? V1 : V2;
    };
    const directory = join(await temporary(), "web-control");
    const coordinator = createHostWebRequestCoordinator({ directory });
    const request = { kind: "fetch", key: "fictional", deadlineMs: Date.now() + 60_000 } as Parameters<typeof coordinator.acquire>[0];
    await expect(coordinator.acquire(request)).rejects.toThrow("Fictional probe timeout");
    await expect(coordinator.acquire(request)).resolves.toBeDefined();
  });

  it("an old exact-key reader rejects new Darwin ProcessJobs records, which new binaries persist and reopen", async () => {
    const root = await temporary();
    const state = join(root, "jobs");
    const store = await openProcessJobStore(root, state);
    const id = randomUUID();
    const record: DurableProcessJobRecord = {
      schemaVersion: 1, generation: randomUUID(), jobId: id, tool: "Exec", state: "queued", summary: "fictional", agentIncarnation: V2,
      pid: null, pgid: null, sandboxSettingsPath: null, argvSummary: "exec", cwd: root, envKeys: [],
      origin: { conversationId: "web:fictional", baseConversationId: "web:fictional", bucket: null, replyToConversationId: "web:fictional", normalizedReplyTarget: "web:fictional", runId: "test", historyBoundary: "test", channel: "web" },
      chainDepth: 0, maxRuntimeMs: 1000, maxOutputBytes: 1024, previewChars: 100,
      admittedAt: "2026-01-01T00:00:00.000Z", queueDeadlineAt: "2026-01-01T00:01:00.000Z",
      startedAt: null, runtimeDeadlineAt: null, completedAt: null, exitCode: null, signal: null, durationMs: null,
      stdoutBytes: 0, stderrBytes: 0, truncated: false, preview: "", stdoutRef: `artifacts/${id}/stdout.log`, stderrRef: `artifacts/${id}/stderr.log`,
      cancelRequested: false, wake: { state: "pending", attempts: 0, deliveryKey: `process-job:${id}`, lastAttemptAt: null }, lastError: null,
    };
    await store.mutate((draft) => { draft.set(id, record); });
    await store.ensureArtifacts(id);
    const persisted = JSON.parse(await readFile(join(store.recordsDir, `${id}.json`), "utf8")) as Record<string, unknown>;
    expect(persisted.agentIncarnation).toEqual(V2);
    expect(baselineProcessJobIncarnationsAccepted(persisted)).toBe(false);
    expect(baselineProcessJobIncarnationsAccepted({ ...persisted, agentIncarnation: V1 })).toBe(true);
    await expect((await openProcessJobStore(root, state)).get(id)).resolves.toMatchObject({ agentIncarnation: V2 });
  });

  it("an old exact-key reader rejects new Darwin subagent ownership evidence that new binaries accept", () => {
    const ownership: SubagentExecutionOwnership = { schemaVersion: 1, instanceIncarnation: randomUUID(), turnToken: randomUUID(),
      owner: { pid: 123, incarnation: V2, settlement: "running" }, revoked: false, publication: { sequence: 1, state: "confirmed" }, seenCalls: [] };
    expect(isSubagentExecutionOwnership(ownership)).toBe(true);
    expect(baselineSubagentIncarnationAccepted(ownership.owner.incarnation)).toBe(false);
    expect(baselineSubagentIncarnationAccepted(V1)).toBe(true);
  });
});
