import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as continuationStore from "../continuations/continuation-store.js";
import { MAX_MANIFEST_BYTES, type DurableContinuationRecord } from "../continuations/continuation-store-types.js";
import { canonicalContinuationJson, continuationDigest } from "../continuations/continuations.js";
import { inspectContinuationState } from "../continuations/state-inspection.js";
import * as ownerLock from "../durable-state/owner-private-lock.js";
import * as privateFiles from "../durable-state/private-files.js";
import * as sqliteLease from "../durable-state/sqlite-lease.js";
import * as processJobStore from "../process-jobs/process-jobs-store.js";
import { inspectProcessJobState } from "../process-jobs/state-inspection.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

let root: string;
const date = "2030-01-02T03:04:05.000Z";

function forbidden(): never {
  throw new Error("Read-only inspection attempted writer or lease entry.");
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "host-state-inspection-")));
  await chmod(root, 0o700);
  vi.spyOn(continuationStore, "openContinuationStore").mockImplementation(forbidden);
  vi.spyOn(processJobStore, "openProcessJobStore").mockImplementation(forbidden);
  vi.spyOn(processJobStore, "prepareProcessJobStateDirectory").mockImplementation(forbidden);
  vi.spyOn(processJobStore, "loadOrCreateProcessJobSecret").mockImplementation(forbidden);
  vi.spyOn(processJobStore, "recordProcessJobHealthIncident").mockImplementation(forbidden);
  vi.spyOn(processJobStore, "clearProcessJobHealthIncident").mockImplementation(forbidden);
  vi.spyOn(sqliteLease, "acquireSqliteLease").mockImplementation(forbidden);
  vi.spyOn(ownerLock, "acquireOwnerPrivateLock").mockImplementation(forbidden);
  vi.spyOn(privateFiles, "ensureOwnerOnlyDirectory").mockImplementation(forbidden);
  vi.spyOn(privateFiles, "writeJsonAtomic").mockImplementation(forbidden);
  vi.spyOn(privateFiles, "writeTextAtomic").mockImplementation(forbidden);
});

afterEach(async () => {
  // A caught writer failure must not make the inspector appear read-only.
  for (const entry of [
    continuationStore.openContinuationStore,
    processJobStore.openProcessJobStore,
    processJobStore.prepareProcessJobStateDirectory,
    processJobStore.loadOrCreateProcessJobSecret,
    processJobStore.recordProcessJobHealthIncident,
    processJobStore.clearProcessJobHealthIncident,
    sqliteLease.acquireSqliteLease,
    ownerLock.acquireOwnerPrivateLock,
    privateFiles.ensureOwnerOnlyDirectory,
    privateFiles.writeJsonAtomic,
    privateFiles.writeTextAtomic,
  ]) expect(entry).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function json(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
}

// Reads may update atime; all durable content and identity/metadata must stay put.
async function snapshot(): Promise<readonly unknown[]> {
  const entries: unknown[] = [];
  async function visit(path: string): Promise<void> {
    const info = await lstat(path, { bigint: true });
    entries.push({
      path: relative(root, path),
      dev: info.dev, ino: info.ino, mode: info.mode, uid: info.uid, gid: info.gid,
      nlink: info.nlink, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
      bytes: info.isFile() ? (await readFile(path)).toString("base64") : undefined,
      target: info.isSymbolicLink() ? await readlink(path) : undefined,
    });
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return entries;
}

function manifest(version: 2 | 3): unknown {
  return {
    schemaVersion: version,
    generation: "inspection-generation",
    updatedAt: date,
    rollbackGuardRequired: false,
    stats: {
      format: `per-record-v${version}`,
      records: 0, active: 0, unresolvedDelivery: 0, deadLettered: 0,
      terminalTombstones: 0, compacted: 0, capturedText: 0, historyDegraded: 0,
      limits: { terminalMaxRecords: 50_000, terminalMaxAgeMs: 31_536_000_000, capturedTextMaxRecords: 1_000, capturedTextMaxAgeMs: 2_592_000_000 },
    },
  };
}

function preparedRecord(id: string, originRunId = "group-run"): DurableContinuationRecord {
  const digest = continuationDigest("fictional-origin-snapshot");
  return {
    continuationId: id, serverName: "fixture", originRunId, originConversationId: "fixture:conversation",
    historyBoundary: "fixture-boundary", originContextState: "pending",
    originContextRef: { schemaVersion: 1, digest, bytes: 128, messageCount: 2 },
    originContextDigest: digest, originContextBindingMac: continuationDigest(`binding-${id}`),
    mode: "reply", taskKey: `task-${id}`, taskHash: continuationDigest(`task-${id}`),
    claimFingerprint: continuationDigest(`claim-${id}`), resultTokenHash: continuationDigest(`token-${id}`),
    createdAt: date, updatedAt: date, deadline: "2030-01-03T03:04:05.000Z", state: "claimed",
    synthesisAttempts: 0, synthesisDeferrals: 0, deliveryAttempts: 0,
  };
}

const continuationCases = [
  ["missing", "ok", "State has not been initialized"],
  ["empty", "ok", "No continuation ledger has been written"],
  ["v1", "ok", "0 total"],
  ["v2", "waiting", "Legacy store v2 awaiting v3 migration"],
  ["v3", "ok", "Store v3: 0 retained"],
  ["pending-v2", "waiting", "An interrupted durable v2 transaction is present"],
  ["pending-v3", "waiting", "An interrupted durable v3 transaction is present"],
  ["owner-evidence", "ok", "OS-backed exclusive ownership"],
  ["malformed", "error", "invalid JSON"],
  ["oversized", "error", "exceeds"],
  ["symlink", "error", "regular file"],
  ["hardlink", "error", "exactly one filesystem link"],
] as const;

describe("read-only continuation state inspection", () => {
  it.each(continuationCases)("preserves %s state bytes and filesystem identity", async (fixture, status, detail) => {
    const stateDir = join(root, "continuations");
    if (fixture !== "missing") await directory(stateDir);
    if (fixture === "v1") await json(join(stateDir, "continuations-v1.json"), { schemaVersion: 1, updatedAt: date, records: {} });
    if (fixture === "v2" || fixture === "v3" || fixture === "owner-evidence") {
      const version = fixture === "v2" ? 2 : 3;
      await directory(join(stateDir, `records-v${version}`));
      await json(join(stateDir, `continuation-store-v${version}.json`), manifest(version));
    }
    if (fixture === "pending-v2" || fixture === "pending-v3") {
      const version = fixture === "pending-v2" ? 2 : 3;
      await json(join(stateDir, `continuation-transaction-v${version}.json`), {
        schemaVersion: version, generation: "inspection-generation", createdAt: date, writes: [], deletes: [],
      });
    }
    if (fixture === "owner-evidence") await writeFile(join(stateDir, "continuations-owner.sqlite"), "owner evidence", { mode: 0o600 });
    const manifestPath = join(stateDir, "continuation-store-v3.json");
    if (fixture === "malformed") await writeFile(manifestPath, "{", { mode: 0o600 });
    if (fixture === "oversized") await writeFile(manifestPath, "x".repeat(MAX_MANIFEST_BYTES + 1), { mode: 0o600 });
    if (fixture === "symlink" || fixture === "hardlink") {
      const source = join(root, "manifest-evidence.json");
      await json(source, manifest(3));
      if (fixture === "symlink") await symlink(source, manifestPath);
      else await link(source, manifestPath);
    }
    const before = await snapshot();
    const result = await inspectContinuationState(stateDir, {});
    expect(await inspectContinuationState(stateDir, {})).toEqual(result);
    expect(result.status).toBe(status);
    expect(result.details.join("\n")).toContain(detail);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["v2", "v3", "manifested-v3", "mixed-v2-v3", "manifested-migration"] as const)(
    "preserves non-empty recovery projection: %s transaction, group, guard and retained records",
    async (fixture) => {
      const stateDir = join(root, "continuations");
      const version = fixture === "v2" ? 2 : 3;
      const recordsDir = join(stateDir, `records-v${version}`);
      await directory(recordsDir);
      const member = preparedRecord("written-member");
      const deleted = preparedRecord("deleted-member");
      // Both originally belong to the marker's group. Recovery must apply the
      // write AND delete before the one-member activation can be validated.
      await json(join(recordsDir, `${continuationDigest(deleted.continuationId)}.json`), deleted);
      const retained = preparedRecord("retained-record", "retained-run");
      await json(join(recordsDir, `${continuationDigest(retained.continuationId)}.json`), retained);
      const terminal = {
        ...preparedRecord("terminal-record", "terminal-run"),
        mode: "capture", state: "delivered", synthesizedText: "Fictional captured response.", resultPayload: { fixture: true },
      };
      await json(join(recordsDir, `${continuationDigest(terminal.continuationId)}.json`), terminal);
      await json(join(stateDir, `continuation-transaction-v${version}.json`), {
        schemaVersion: version, generation: "inspection-generation", createdAt: date,
        writes: [member], deletes: [deleted.continuationId],
      });
      const legacyRecordsDir = join(stateDir, "records-v2");
      await directory(legacyRecordsDir);
      await writeFile(join(legacyRecordsDir, "UPGRADED-TO-RECORDS-V3"),
        "This state directory uses continuation records v3. Older runtimes must not open records-v2.\n", { mode: 0o600 });
      if (fixture === "mixed-v2-v3" || fixture === "manifested-migration") {
        const legacy = preparedRecord("legacy-written", "legacy-run");
        const legacyDeleted = preparedRecord("legacy-deleted", "legacy-run");
        await json(join(legacyRecordsDir, `${continuationDigest(legacyDeleted.continuationId)}.json`), legacyDeleted);
        await json(join(stateDir, "continuation-store-v2.json"), manifest(2));
        await json(join(stateDir, "continuation-transaction-v2.json"), {
          schemaVersion: 2, generation: "legacy-generation", createdAt: date,
          writes: [legacy], deletes: [legacyDeleted.continuationId],
        });
      }
      if (fixture === "manifested-v3" || fixture === "manifested-migration") {
        await json(join(stateDir, "continuation-store-v3.json"), manifest(3));
      }
      const groupIdentity = {
        originRunId: member.originRunId,
        originConversationId: member.originConversationId,
        historyBoundary: member.historyBoundary,
      };
      const groupKey = continuationDigest(`mono-agent-origin-context-group-v1\0${canonicalContinuationJson(groupIdentity)}`);
      const groupsDir = join(stateDir, "origin-context-groups-v1");
      await directory(groupsDir);
      await json(join(groupsDir, `${groupKey}.json`), {
        schemaVersion: 1, groupKey, ...groupIdentity, snapshotDigest: member.originContextDigest,
        memberCount: 1,
        memberSetDigest: continuationDigest(`mono-agent-origin-context-members-v1\0${canonicalContinuationJson([member.continuationId])}`),
        activatedAt: "2030-01-02T03:05:05.000Z",
      });
      const before = await snapshot();
      const retention = { terminalMaxRecords: 0, capturedTextMaxRecords: 0 };
      const result = await inspectContinuationState(stateDir, retention);
      expect(await inspectContinuationState(stateDir, retention)).toEqual(result);
      // Check the snapshot before status, so accidental recovery writes are
      // identified as mutations even when they also alter the recovery verdict.
      expect(await snapshot()).toEqual(before);
      expect(result.status).toBe("waiting");
      expect(result.details.join("\n")).toContain(`interrupted durable v${version} transaction`);
      expect(result.details.join("\n")).toContain("durable marker awaiting idempotent recovery");
      expect(result.details).toContain("The owner-only v2 rollback guard prevents older runtimes from opening stale continuation records.");
      if (fixture === "manifested-migration") {
        expect(result.details).toContain("Legacy continuation state is awaiting idempotent v3 migration.");
      }
    },
  );

  it.skipIf(process.platform === "win32")("rejects permissive roots without repairing them", async () => {
    const stateDir = join(root, "continuations");
    await directory(stateDir);
    await chmod(stateDir, 0o755);
    const before = await snapshot();
    expect(await inspectContinuationState(stateDir, {})).toEqual({
      status: "error", details: ["Continuation state directory permissions must be 700."],
    });
    expect(await snapshot()).toEqual(before);
  });
});

const jobCases = [
  ["missing", "ok", "State has not been initialized"],
  ["empty", "ok", "No local process-job records"],
  ["records", "ok", "Local records: 1."],
  ["health", "error", "storage degraded during recovery"],
  ["quarantine", "error", "Quarantined unreplayable process-job transactions: 1."],
  ["malformed", "error", "unsafe or malformed"],
  ["oversized", "error", "exceeds 131072 bytes"],
  ["symlink", "error", "not one regular file"],
  ["hardlink", "error", "not one regular file"],
] as const;

describe("read-only process-job state inspection", () => {
  it.each(jobCases)("preserves %s state bytes and filesystem identity", async (fixture, status, detail) => {
    const stateDir = join(root, "process-jobs");
    if (fixture !== "missing") await directory(stateDir);
    if (fixture === "health") await json(join(stateDir, processJobStore.PROCESS_JOB_HEALTH_FILE), {
      schemaVersion: 1, state: "degraded", operation: "recovery", detectedAt: date,
    });
    if (fixture === "quarantine") {
      const quarantine = join(stateDir, processJobStore.PROCESS_JOB_QUARANTINE_DIRECTORY);
      await directory(quarantine);
      await json(join(quarantine, "transaction-2030-01-02T03.04.05.000Z-00000000-0000-0000-0000-000000000000.json"), {});
    }
    if (["records", "malformed", "oversized", "symlink", "hardlink"].includes(fixture)) {
      const records = join(stateDir, processJobStore.PROCESS_JOB_RECORDS_DIRECTORY);
      await directory(records);
      const record = join(records, "fixture-job.json");
      if (fixture === "records") await json(record, { jobId: "fixture-job", state: "queued" });
      if (fixture === "malformed") await json(record, { jobId: "wrong-job", state: "queued" });
      if (fixture === "oversized") await writeFile(record, "x".repeat(128 * 1024 + 1), { mode: 0o600 });
      if (fixture === "symlink" || fixture === "hardlink") {
        const source = join(root, "record-evidence.json");
        await json(source, { jobId: "fixture-job", state: "queued" });
        if (fixture === "symlink") await symlink(source, record);
        else await link(source, record);
      }
    }
    const before = await snapshot();
    const result = await inspectProcessJobState(root, stateDir);
    expect(await inspectProcessJobState(root, stateDir)).toEqual(result);
    expect(result.status).toBe(status);
    expect(result.details.join("\n")).toContain(detail);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects an escaping root without creating it or taking ownership", async () => {
    const stateDir = join(root, "..", `${basename(root)}-outside-fixture`);
    await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    const before = await snapshot();
    try {
      expect(await inspectProcessJobState(root, stateDir)).toEqual({
        status: "error", details: ["Process-job state must be a child directory inside the canonical agent root."],
      });
      await expect(lstat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await snapshot()).toEqual(before);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("read failures do not fall back to writer initialization", () => {
  it.each(["continuations", "process-jobs"])("reports deterministic EACCES for %s without mutation", async (kind) => {
    const stateDir = join(root, kind);
    await directory(stateDir);
    const before = await snapshot();
    const failure = Object.assign(new Error("Fixture read access denied."), { code: "EACCES" });
    // Process-job confinement resolves ancestors before examining the private root.
    const actualLstat = vi.mocked(lstat).getMockImplementation()!;
    vi.mocked(lstat).mockImplementation((...args: Parameters<typeof lstat>) => {
      if (args[0] === stateDir) return Promise.reject(failure);
      return actualLstat(...args);
    });
    const result = kind === "continuations"
      ? await inspectContinuationState(stateDir, {})
      : await inspectProcessJobState(root, stateDir);
    vi.mocked(lstat).mockImplementation(actualLstat);
    expect(result).toEqual({
      status: "error",
      details: [`${kind === "continuations" ? "Continuation state" : "Process-job state confinement"} cannot be inspected: Fixture read access denied.`],
    });
    expect(await snapshot()).toEqual(before);
  });
});

function inspectionTypes(
  continuation: Awaited<ReturnType<typeof inspectContinuationState>>,
  processJob: Awaited<ReturnType<typeof inspectProcessJobState>>,
): void {
  // @ts-expect-error diagnostic details stay readonly
  continuation.details.push("not allowed");
  // @ts-expect-error process-job details stay readonly
  processJob.details.push("not allowed");
  // @ts-expect-error process-job inspection does not return waiting
  const waiting: typeof processJob.status = "waiting";
  void waiting;
}
void inspectionTypes;
