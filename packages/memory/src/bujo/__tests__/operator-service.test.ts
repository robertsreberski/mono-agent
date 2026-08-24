import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MemoryOperatorMutationAdmission } from "@mono-agent/agent-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMemoryBundleImport,
  appendGraphBatch,
  createBujoMemoryOperatorService,
  createBujoMemoryStore,
  exportMemoryBundle,
  prepareMemoryBundleImport,
  safeRebuildMemoryIndex,
  type BuiltinMemoryOperatorService,
  type BujoMemoryStore,
  type MemoryOperatorIntegrityFailure,
} from "../index.js";
import { appendBullet, readBullet } from "../daily.js";
import {
  initializeReplayProjection,
  prepareReplayProjectionDelta,
  publishPreparedReplayProjection,
  readReplayProjectionStrict,
  replayProjectionAuthorityId,
  type ReplayProjectionAuthorityKind,
  type ReplayProjectionTerminal,
} from "../replay-projection.js";
import type { Bullet, BujoTier } from "../types.js";
import { fakeEmbeddings, fakeLlm } from "./helpers.js";

const DIM = 16;
const CREATED_AT = "2026-08-01T09:00:00.000Z";
const GRAPH_AT = "2026-08-01T09:00:01.000Z";
const ORIGINAL_ID = "MEM-OPERATOR-001";
const roots: string[] = [];
const stores: BujoMemoryStore[] = [];
const services: BuiltinMemoryOperatorService[] = [];

afterEach(async () => {
  for (const service of services.splice(0).reverse()) await service.close().catch(() => undefined);
  for (const store of stores.splice(0).reverse()) await store.close().catch(() => undefined);
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe("built-in memory operator reads", { timeout: 20_000 }, () => {
  it("serves authoritative sanitized pages for Lite, Journal, and BuJo while gating actions by actual tier", async () => {
    for (const tier of ["lite", "journal", "bujo"] as const) {
      const fixture = await managedFixture(tier, [
        baseBullet({
          id: `${ORIGINAL_ID}-${tier}-A`,
          text: `Newest ${tier} operator memory.`,
          createdAt: "2026-08-03T09:00:00.000Z",
        }),
        baseBullet({
          id: `${ORIGINAL_ID}-${tier}-B`,
          text: `Middle ${tier} operator memory.`,
          createdAt: "2026-08-02T09:00:00.000Z",
        }),
        baseBullet({
          id: `${ORIGINAL_ID}-${tier}-C`,
          text: `Oldest ${tier} operator memory.`,
          createdAt: "2026-08-01T09:00:00.000Z",
        }),
      ]);
      const service = operator(fixture.store, { actionsEnabled: true });

      expect(service.capability()).toMatchObject({
        schema: 1,
        tier,
        status: "ready",
        read: true,
        actions: tier === "bujo",
        graph: tier === "bujo" ? "captured" : "unavailable",
      });
      await expect(service.overview()).resolves.toMatchObject({
        counts: { total: 3, active: 3, superseded: 0, forgotten: 0 },
      });
      const first = await service.records({ limit: 2 });
      expect(first.records).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await service.records({ limit: 2, before: first.nextCursor! });
      expect(second.records).toHaveLength(1);
      expect(new Set([...first.records, ...second.records].map((record) => record.id))).toHaveProperty("size", 3);

      const exposed = JSON.stringify(first.records[0]);
      expect(exposed).toContain("web:conversation-42");
      expect(exposed).not.toContain(fixture.root);
      expect(exposed).not.toMatch(/memory\.db|daily\/|vector|embedding/iu);
      expect(first.records[0]?.source).toEqual({ conversationId: "web:conversation-42" });

      if (tier !== "bujo") {
        expect(() => service.edit(first.records[0]!.id, {
          expectedRevision: first.records[0]!.revision,
          idempotencyKey: `disabled-${tier}`,
          patch: { text: "This must not be written." },
        })).toThrow(expect.objectContaining({ code: "actions_disabled" }));
        await expect(service.graph({})).resolves.toEqual({ fidelity: "unavailable", nodes: [], edges: [] });
      } else {
        const disabled = operator(fixture.store, { actionsEnabled: false });
        expect(disabled.capability()).toMatchObject({ read: true, actions: false, status: "ready" });
        expect(() => disabled.edit(first.records[0]!.id, {
          expectedRevision: first.records[0]!.revision,
          idempotencyKey: "disabled-by-config",
          patch: { text: "This must not be written." },
        })).toThrow(expect.objectContaining({ code: "actions_disabled" }));
      }
    }
  });

  it("fails read and action capability closed when the durable operation ledger is malformed", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    writeFileSync(ledger, "not-json\n", { encoding: "utf8", mode: 0o600 });
    chmodSync(ledger, 0o600);
    const failures: MemoryOperatorIntegrityFailure[] = [];

    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => {
        failures.push(failure);
        throw new Error("notification consumers cannot mask the integrity failure");
      },
    });
    expect(service.capability()).toMatchObject({
      status: "degraded",
      read: false,
      actions: false,
      graph: "unavailable",
    });
    expect(failures).toEqual([{
      code: "unavailable",
      reason: "ledger_startup",
      message: "Memory action state could not be loaded safely.",
    }]);
    expect(JSON.stringify(failures)).not.toContain(fixture.root);
    await expect(service.records({})).rejects.toMatchObject({ code: "unavailable" });
  });

  it("rejects a non-builtin persisted failure code before it can escape through operation history", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const leakedCode = "/private/provider/secret-token";
    const completedAt = "2026-08-19T10:00:00.000Z";
    const operation = {
      ...terminalOperation("leaky-failure-op", {
        expectedRevision: "0".repeat(64),
        idempotencyKey: "leaky-failure-key",
        patch: { text: "Never exposed." },
      }, completedAt),
      status: "failed",
      errorCode: leakedCode,
      errorMessage: "Memory action failed safely.",
    };
    writeLedger(join(fixture.root, ".memory-operator-v1.json"), {
      schemaVersion: 2,
      operations: [operation],
      expiredReplays: [],
    });
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
    });

    expect(service.capability()).toMatchObject({ status: "degraded", read: false, actions: false });
    expect(() => service.operation(operation.id)).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(failures).toEqual([{
      code: "unavailable",
      reason: "ledger_startup",
      message: "Memory action state could not be loaded safely.",
    }]);
    expect(JSON.stringify(failures)).not.toContain(leakedCode);
  });

  it("rejects aggregate overflow and duplicate replay commitments across the ledger", async () => {
    const expiresAt = "2026-09-19T10:00:00.000Z";
    const overflow = {
      schemaVersion: 2,
      operations: [],
      expiredReplays: Array.from({ length: 1_025 }, (_, index) => ({
        operationId: `expired-operation-${index}`,
        idempotencyKey: `expired-key-${index}`,
        requestHash: createHash("sha256").update(`expired-${index}`).digest("hex"),
        expiresAt,
      })),
    };
    const queued = queuedOperation(0, "0".repeat(64), 16);
    const crossDuplicate = {
      schemaVersion: 2,
      operations: [queued],
      expiredReplays: [{
        operationId: queued.id,
        idempotencyKey: queued.idempotencyKey,
        requestHash: queued.requestHash,
        expiresAt,
      }],
    };
    const invalidBase = queuedOperation(1, "0".repeat(64), 16);
    const invalidIds = [
      { ...invalidBase, id: "" },
      { ...invalidBase, recordId: "control\nrecord" },
      { ...invalidBase, resultRecordId: "x".repeat(513) },
    ].map((operation) => ({ schemaVersion: 2, operations: [operation], expiredReplays: [] }));
    for (const [index, ledger] of [overflow, crossDuplicate, ...invalidIds].entries()) {
      const fixture = await managedFixture("bujo", [baseBullet({ id: `${ORIGINAL_ID}-invalid-${index}` })]);
      writeLedger(join(fixture.root, ".memory-operator-v1.json"), ledger);
      const service = operator(fixture.store, { actionsEnabled: true });
      expect(service.capability()).toMatchObject({ status: "degraded", read: false, actions: false });
      await expect(service.records({})).rejects.toMatchObject({ code: "unavailable" });
    }
  });
});

describe("built-in memory operator actions", { timeout: 30_000 }, () => {
  it("edits, forgets, and restores with CAS, idempotency, confirmation, history, and graph lifecycle", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()], true);
    const integrityFailures: MemoryOperatorIntegrityFailure[] = [];
    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { integrityFailures.push(failure); },
    });
    const original = (await service.record(ORIGINAL_ID)).record;

    expect(() => service.edit(ORIGINAL_ID, {
      expectedRevision: "0".repeat(64),
      idempotencyKey: "edit-wrong-revision",
      patch: { text: "Wrong revision." },
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));

    const editInput = {
      expectedRevision: original.revision,
      idempotencyKey: "edit-one",
      patch: {
        text: "Morgan maintains the revised memory operator.",
        type: "task" as const,
        tags: ["operator", "revised"],
        salience: 0.91,
        collection: "Release Work",
        dueAt: "2026-09-01T12:00:00.000Z",
        validFrom: "2026-08-15T00:00:00.000Z",
      },
    };
    const edit = queued(await service.edit(ORIGINAL_ID, editInput));
    expect(await service.edit(ORIGINAL_ID, editInput)).toMatchObject({
      kind: "queued",
      operation: { id: edit.id, resultRecordId: edit.resultRecordId },
    });
    expect(() => service.edit(ORIGINAL_ID, {
      ...editInput,
      patch: { text: "A conflicting use of the same key." },
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(integrityFailures).toEqual([]);
    await service.drain();

    expect(await service.operation(edit.id)).toMatchObject({ status: "succeeded" });
    const oldAfterEdit = (await service.record(ORIGINAL_ID)).record;
    expect(oldAfterEdit).toMatchObject({
      lifecycle: "superseded",
      status: "invalidated",
      supersededBy: edit.resultRecordId,
      supersededAt: expect.any(String),
    });
    const replacement = (await service.record(edit.resultRecordId!)).record;
    expect(replacement).toMatchObject({
      lifecycle: "active",
      type: "task",
      text: editInput.patch.text,
      tags: ["operator", "revised"],
      salience: 0.91,
      collection: "release-work",
      dueAt: editInput.patch.dueAt,
      validFrom: editInput.patch.validFrom,
      source: { conversationId: "web:conversation-42" },
    });
    const replacementBullet = readBullet(
      fixture.root,
      `daily/${replacement.createdAt.slice(0, 10)}.md`,
      replacement.id,
    );
    expect(replacementBullet?.refs).toEqual(["conversation:evidence-1"]);
    expect(JSON.stringify(await service.record(replacement.id))).not.toMatch(/memory\.db|daily\/|vector/iu);

    const historicalGraph = await service.graph({ includeHistory: true, limit: 100 });
    expect(new Set(historicalGraph.edges.map((edge) => edge.kind))).toEqual(
      new Set(["relation", "association", "supports", "supersedes"]),
    );
    expect(historicalGraph.nodes).toContainEqual(expect.objectContaining({ id: ORIGINAL_ID, lifecycle: "superseded" }));
    const activeGraph = await service.graph({ limit: 100 });
    expect(activeGraph.nodes.some((node) => node.id === ORIGINAL_ID)).toBe(false);
    expect(activeGraph.nodes.some((node) => node.id === replacement.id)).toBe(true);
    const bounded = await service.graph({ includeHistory: true, limit: 2 });
    expect(bounded.nodes.length).toBeLessThanOrEqual(2);
    expect(bounded.edges.length).toBeLessThanOrEqual(2);
    expect(bounded.truncated).toBe(true);

    const confirmation = confirm(await service.forget(replacement.id, {
      expectedRevision: replacement.revision,
      idempotencyKey: "forget-one",
    }));
    expect(Buffer.from(confirmation.token, "base64url")).toHaveLength(32);
    const forget = queued(await service.forget(replacement.id, {
      expectedRevision: replacement.revision,
      idempotencyKey: "forget-one",
      confirmationToken: confirmation.token,
    }));
    await service.drain();
    expect(await service.operation(forget.id)).toMatchObject({ status: "succeeded" });
    const forgotten = (await service.record(replacement.id)).record;
    expect(forgotten).toMatchObject({ lifecycle: "forgotten", status: "dropped" });
    expect((await fixture.store.recall("revised memory operator", { topK: 10, trackAccess: false }))
      .some((hit) => hit.record.id === replacement.id)).toBe(false);
    expect((await service.graph({ limit: 100 })).nodes.some((node) => node.id === replacement.id)).toBe(false);

    // A durable idempotency receipt is replayed before stale revision or a new
    // destructive confirmation can be considered.
    expect(await service.forget(replacement.id, {
      expectedRevision: replacement.revision,
      idempotencyKey: "forget-one",
    })).toEqual({ kind: "queued", operation: await service.operation(forget.id) });

    // The exact operator terminal and committed action history remain the
    // restore authority after both the service and writable store restart.
    await service.close();
    await fixture.store.close();
    const restoreStore = trackStore(createBujoMemoryStore({
      root: fixture.root,
      tier: "bujo",
      embeddings: fixture.embeddings,
      dim: DIM,
      llm: fakeLlm([]),
      clock: fixture.clock,
    }));
    const restoreService = operator(restoreStore, { actionsEnabled: true });
    const forgottenAfterRestart = (await restoreService.record(replacement.id)).record;
    const restore = queued(await restoreService.restore(replacement.id, {
      expectedRevision: forgottenAfterRestart.revision,
      idempotencyKey: "restore-one",
    }));
    await restoreService.drain();
    expect(await restoreService.operation(restore.id)).toMatchObject({ status: "succeeded" });
    const restored = (await restoreService.record(restore.resultRecordId!)).record;
    expect(restored).toMatchObject({
      lifecycle: "active",
      status: "open",
      text: replacement.text,
      type: replacement.type,
      tags: replacement.tags,
      salience: replacement.salience,
      collection: replacement.collection,
      dueAt: replacement.dueAt,
      validFrom: replacement.validFrom,
    });
    expect((await restoreService.record(replacement.id)).record.lifecycle).toBe("forgotten");
    expect(new Set((await restoreService.record(replacement.id)).history.map((item) => item.action)))
      .toEqual(new Set(["edit", "forget", "restore"]));
    expect((await restoreService.record(restored.id)).history.map((item) => item.action)).toEqual(["restore"]);
    expect((await restoreService.graph({ limit: 100 })).nodes.some((node) => node.id === restored.id)).toBe(true);

    // Prove canonical source + replay projection can rebuild the same lifecycle,
    // including the retained tombstone and the new active restore identity.
    await restoreService.close();
    await restoreStore.close();
    await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fixture.embeddings,
      dim: DIM,
    });
    const restartedStore = trackStore(createBujoMemoryStore({
      root: fixture.root,
      tier: "bujo",
      embeddings: fixture.embeddings,
      dim: DIM,
      llm: fakeLlm([]),
      clock: fixture.clock,
    }));
    const restarted = operator(restartedStore, { actionsEnabled: true });
    await restarted.drain();
    expect((await restarted.record(replacement.id)).record.lifecycle).toBe("forgotten");
    expect((await restarted.record(restored.id)).record.lifecycle).toBe("active");
    expect((await restarted.record(ORIGINAL_ID)).record.lifecycle).toBe("superseded");
  });

  it("rejects manual and migration tombstones without exact operator replay authority", async () => {
    const terminalAt = "2026-08-10T10:00:00.000Z";
    for (const authorityKind of [undefined, "migration"] as const) {
      const label = authorityKind ?? "manual";
      const recordId = `${ORIGINAL_ID}-${label}-dropped`;
      const terminals = authorityKind === undefined
        ? []
        : [replayTerminal(recordId, terminalAt, authorityKind)];
      const fixture = await managedFixture("bujo", [baseBullet({
        id: recordId,
        status: "dropped",
        priorStatus: "open",
      })], false, terminals);
      const service = operator(fixture.store, { actionsEnabled: true });
      const beforeRestore = (await service.record(recordId)).record;
      const foundTerminal = readReplayProjectionStrict(fixture.root).projection.terminals
        .find((terminal) => terminal.id === recordId);
      if (authorityKind === undefined) {
        expect(beforeRestore).not.toHaveProperty("validTo");
        expect(foundTerminal).toBeUndefined();
      } else {
        expect(beforeRestore.validTo).toBe(terminalAt);
        expect(foundTerminal).toMatchObject({ id: recordId, at: terminalAt, authorityKind });
      }

      await expectRestoreRejected(service, recordId, `restore-${label}`);
      expect((await service.record(recordId)).record.lifecycle).toBe("forgotten");
    }
  });

  it("reclassifies an imported operator tombstone so it cannot authorize restore in the destination", async () => {
    const importedId = `${ORIGINAL_ID}-imported-dropped`;
    const source = await managedFixture("bujo", [baseBullet({ id: importedId })]);
    const sourceOperator = operator(source.store, { actionsEnabled: true });
    const sourceRecord = (await sourceOperator.record(importedId)).record;
    const confirmation = confirm(await sourceOperator.forget(importedId, {
      expectedRevision: sourceRecord.revision,
      idempotencyKey: "forget-before-export",
    }));
    const forgotten = queued(await sourceOperator.forget(importedId, {
      expectedRevision: sourceRecord.revision,
      idempotencyKey: "forget-before-export",
      confirmationToken: confirmation.token,
    }));
    await sourceOperator.drain();
    expect(sourceOperator.operation(forgotten.id)).toMatchObject({ status: "succeeded" });
    const sourceTombstone = (await sourceOperator.record(importedId)).record;
    const terminalAt = sourceTombstone.validTo!;
    expect(readReplayProjectionStrict(source.root).projection.terminals)
      .toContainEqual(expect.objectContaining({
        id: importedId,
        at: terminalAt,
        authorityKind: "operator",
      }));
    await sourceOperator.close();
    await source.store.close();
    const bundleParent = mkdtempSync(join(tmpdir(), "memory-operator-import-bundle-"));
    roots.push(bundleParent);
    const bundlePath = join(bundleParent, "bundle");
    await exportMemoryBundle({ root: source.root, bundlePath });

    const destination = await managedFixture("bujo", [baseBullet({
      id: `${ORIGINAL_ID}-import-destination`,
    })]);
    await destination.store.close();
    const preview = prepareMemoryBundleImport({ root: destination.root, bundlePath });
    const applied = await applyMemoryBundleImport({
      root: destination.root,
      bundlePath,
      expectedRootFingerprint: preview.rootFingerprint,
      expectedSourceFingerprint: preview.destinationSourceFingerprint,
      expectedBundleDigest: preview.bundleDigest,
      expectedMergeDigest: preview.mergeDigest,
      expectedMergedSourceFingerprint: preview.mergedSourceFingerprint,
      planDigest: createHash("sha256").update("operator-import-negative").digest("hex"),
      embeddings: destination.embeddings,
      dimension: DIM,
    });
    roots.push(applied.backupPath);

    const repeatPreview = prepareMemoryBundleImport({ root: destination.root, bundlePath });
    expect(repeatPreview.counts).toMatchObject({ newMemories: 0, identicalMemories: 1 });
    const repeated = await applyMemoryBundleImport({
      root: destination.root,
      bundlePath,
      expectedRootFingerprint: repeatPreview.rootFingerprint,
      expectedSourceFingerprint: repeatPreview.destinationSourceFingerprint,
      expectedBundleDigest: repeatPreview.bundleDigest,
      expectedMergeDigest: repeatPreview.mergeDigest,
      expectedMergedSourceFingerprint: repeatPreview.mergedSourceFingerprint,
      planDigest: createHash("sha256").update("operator-import-negative-repeat").digest("hex"),
      embeddings: destination.embeddings,
      dimension: DIM,
    });
    roots.push(repeated.backupPath);
    expect(repeated).toMatchObject({ imported: 0, identical: 1 });

    const importedStore = trackStore(createBujoMemoryStore({
      root: destination.root,
      tier: "bujo",
      embeddings: destination.embeddings,
      dim: DIM,
      llm: fakeLlm([]),
      clock: destination.clock,
    }));
    const service = operator(importedStore, { actionsEnabled: true });
    expect((await service.record(importedId)).record.validTo).toBe(terminalAt);
    expect(readReplayProjectionStrict(destination.root).projection.terminals)
      .toContainEqual(expect.objectContaining({
        id: importedId,
        at: terminalAt,
        authorityKind: "import",
      }));

    await expectRestoreRejected(service, importedId, "restore-imported");
    expect((await service.record(importedId)).record.lifecycle).toBe("forgotten");
  });

  it("binds forget confirmations to one request and consumes an invalid attempt", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
    });
    const revision = (await service.record(ORIGINAL_ID)).record.revision;
    const confirmation = confirm(await service.forget(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "forget-confirmed",
    }));

    expect(() => service.forget(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "forget-different-request",
      confirmationToken: confirmation.token,
    })).toThrow(expect.objectContaining({ code: "confirmation_invalid" }));
    expect(() => service.forget(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "forget-confirmed",
      confirmationToken: confirmation.token,
    })).toThrow(expect.objectContaining({ code: "confirmation_invalid" }));
    expect(failures).toEqual([]);
  });

  it("rejects malformed and out-of-bound wire values with the shared invalid-request code", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const service = operator(fixture.store, { actionsEnabled: true });
    const revision = (await service.record(ORIGINAL_ID)).record.revision;
    const invalidPatches: unknown[] = [
      {},
      { status: "done" },
      { text: "x".repeat(4_001) },
      { text: "line\nbreak" },
      { tags: new Array(33).fill("tag") },
      { tags: ["x".repeat(65)] },
      { salience: 1.01 },
      { collection: "not/a/slug" },
      { dueAt: "2026-08-01T00:00:00Z" },
      { validFrom: 42 },
    ];
    for (const [index, patch] of invalidPatches.entries()) {
      expect(() => service.edit(ORIGINAL_ID, {
        expectedRevision: revision,
        idempotencyKey: `invalid-patch-${index}`,
        patch: patch as never,
      })).toThrow(expect.objectContaining({ code: "invalid_request" }));
    }
    await expect(service.records({ query: 42 as never })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.records({ limit: 101 })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(service.graph({ includeHistory: "yes" as never })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("fails closed without a phantom replay when the ledger path is replaced before or after publication", async () => {
    for (const phase of ["before", "after"] as const) {
      const fixture = await managedFixture("bujo", [baseBullet({ id: `${ORIGINAL_ID}-${phase}` })]);
      const ledger = join(fixture.root, ".memory-operator-v1.json");
      const failures: MemoryOperatorIntegrityFailure[] = [];
      const service = operator(fixture.store, {
        actionsEnabled: true,
        onIntegrityFailure: (failure) => { failures.push(failure); },
        hooks: {
          ...(phase === "before"
            ? {
                beforeLedgerPublication: () => {
                  rmSync(ledger, { recursive: true, force: true });
                  mkdirSync(ledger, { mode: 0o700 });
                },
              }
            : {
                afterLedgerPublication: () => {
                  rmSync(ledger, { force: true });
                  mkdirSync(ledger, { mode: 0o700 });
                },
              }),
        },
      });
      const record = (await service.record(`${ORIGINAL_ID}-${phase}`)).record;
      const input = {
        expectedRevision: record.revision,
        idempotencyKey: `ledger-path-${phase}`,
        patch: { text: `Ledger ${phase} fault.` },
      };

      expect(() => service.edit(record.id, input)).toThrow(expect.objectContaining({ code: "unavailable" }));
      expect(service.capability()).toMatchObject({ status: "degraded", read: false, actions: false });
      expect(() => service.edit(record.id, input)).toThrow(expect.objectContaining({ code: "unavailable" }));
      expect(failures).toEqual([{
        code: "unavailable",
        reason: "ledger_publication",
        message: "Memory action state publication could not be proven.",
      }]);
      expect(JSON.stringify(failures)).not.toContain(fixture.root);
      await expect(service.record(record.id)).rejects.toMatchObject({ code: "unavailable" });
      expect(fixture.store.operatorEngine().db.get(record.id)?.text).toBe(record.text);
    }
  });

  it("recovers one durably published admission after an uncertain read-back without exposing it live", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    let inject = true;
    const original = operator(fixture.store, {
      actionsEnabled: true,
      hooks: {
        afterLedgerPublication: () => {
          if (!inject) return;
          inject = false;
          throw new Error("injected ledger read-back uncertainty");
        },
      },
    });
    const record = (await original.record(ORIGINAL_ID)).record;
    const input = {
      expectedRevision: record.revision,
      idempotencyKey: "uncertain-admission",
      patch: { text: "Recovered exactly once after uncertain admission." },
    };

    expect(() => original.edit(record.id, input)).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(original.capability()).toMatchObject({ status: "degraded", read: false, actions: false });
    expect(() => original.edit(record.id, input)).toThrow(expect.objectContaining({ code: "unavailable" }));
    const raw = JSON.parse(readFileSync(join(fixture.root, ".memory-operator-v1.json"), "utf8")) as {
      operations: Array<{ id: string; resultRecordId: string }>;
    };
    expect(raw.operations).toHaveLength(1);
    await original.close();

    const restarted = operator(fixture.store, { actionsEnabled: true });
    await restarted.drain();
    expect(restarted.operation(raw.operations[0]!.id)).toMatchObject({ status: "succeeded" });
    expect((await restarted.record(raw.operations[0]!.resultRecordId)).record.text).toBe(input.patch.text);
    expect(await restarted.edit(record.id, input)).toMatchObject({
      kind: "queued",
      operation: { id: raw.operations[0]!.id, status: "succeeded" },
    });
  });

  it("does not expose a false terminal receipt when its durable read-back is uncertain", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    let injected = false;
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const original = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
      hooks: {
        afterLedgerPublication: () => {
          if (injected) return;
          const parsed = JSON.parse(readFileSync(ledger, "utf8")) as {
            operations: Array<{ status: string }>;
          };
          if (parsed.operations[0]?.status !== "succeeded") return;
          injected = true;
          throw new Error("injected terminal receipt uncertainty");
        },
      },
    });
    const record = (await original.record(ORIGINAL_ID)).record;
    const admitted = queued(await original.edit(record.id, {
      expectedRevision: record.revision,
      idempotencyKey: "uncertain-terminal",
      patch: { text: "Terminal receipt recovered on restart." },
    }));

    await expect(original.drain()).rejects.toMatchObject({ code: "unavailable" });
    expect(injected).toBe(true);
    expect(failures.map((failure) => failure.reason)).toEqual(["ledger_publication"]);
    expect(() => original.operation(admitted.id)).toThrow(expect.objectContaining({ code: "unavailable" }));
    await original.close();

    const restarted = operator(fixture.store, { actionsEnabled: true });
    await restarted.drain();
    expect(restarted.operation(admitted.id)).toMatchObject({ status: "succeeded" });
    expect((await restarted.record(admitted.resultRecordId!)).record.text)
      .toBe("Terminal receipt recovered on restart.");
  });

  it("clears nullable semantic fields in live, canonical, and rebuilt state", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const service = operator(fixture.store, { actionsEnabled: true });
    const original = (await service.record(ORIGINAL_ID)).record;
    const edit = queued(await service.edit(original.id, {
      expectedRevision: original.revision,
      idempotencyKey: "clear-nullable-fields",
      patch: { collection: null, dueAt: null, validFrom: null },
    }));
    await service.drain();

    const replacement = (await service.record(edit.resultRecordId!)).record;
    expect(replacement).not.toHaveProperty("collection");
    expect(replacement).not.toHaveProperty("dueAt");
    expect(replacement).not.toHaveProperty("validFrom");
    const bullet = readBullet(
      fixture.root,
      `daily/${replacement.createdAt.slice(0, 10)}.md`,
      replacement.id,
    );
    expect(bullet).not.toHaveProperty("collection");
    expect(bullet).not.toHaveProperty("dueAt");
    expect(bullet).not.toHaveProperty("validFrom");

    await service.close();
    await fixture.store.close();
    await safeRebuildMemoryIndex({
      root: fixture.root,
      tier: "bujo",
      embeddings: fixture.embeddings,
      dim: DIM,
    });
    const rebuiltStore = trackStore(createBujoMemoryStore({
      root: fixture.root,
      tier: "bujo",
      embeddings: fixture.embeddings,
      dim: DIM,
      llm: fakeLlm([]),
      clock: fixture.clock,
    }));
    const rebuilt = operator(rebuiltStore, { actionsEnabled: true });
    const rebuiltRecord = (await rebuilt.record(replacement.id)).record;
    expect(rebuiltRecord).not.toHaveProperty("collection");
    expect(rebuiltRecord).not.toHaveProperty("dueAt");
    expect(rebuiltRecord).not.toHaveProperty("validFrom");
  });

  it("compacts terminal history into bounded replay-expired commitments across restart", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const reader = operator(fixture.store, { actionsEnabled: false });
    const revision = (await reader.record(ORIGINAL_ID)).record.revision;
    await reader.close();
    const historicalInput = {
      expectedRevision: revision,
      idempotencyKey: "history-key-0100",
      patch: { text: "Historical edit 0100." },
    };
    const operations = terminalOperations(1_024, revision, historicalInput);
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    writeLedger(ledger, { schemaVersion: 1, operations });

    const first = operator(fixture.store, { actionsEnabled: true });
    expect(first.capability()).toMatchObject({ status: "ready", read: true, actions: true });
    expect(() => first.edit(ORIGINAL_ID, historicalInput)).toThrow(
      expect.objectContaining({ code: "replay_expired" }),
    );
    expect(() => first.edit(ORIGINAL_ID, {
      ...historicalInput,
      patch: { text: "Conflicting historical edit." },
    })).toThrow(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(() => first.operation("history-op-0100")).toThrow(
      expect.objectContaining({ code: "replay_expired" }),
    );
    const compacted = readLedger(ledger);
    expect(compacted.schemaVersion).toBe(2);
    expect(compacted.operations).toHaveLength(512);
    expect(compacted.expiredReplays).toHaveLength(512);
    expect(compacted.operations.length + compacted.expiredReplays.length).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(readFileSync(ledger))).toBeLessThanOrEqual(4 * 1024 * 1024);
    await first.close();

    const restarted = operator(fixture.store, { actionsEnabled: true });
    expect(() => restarted.edit(ORIGINAL_ID, historicalInput)).toThrow(
      expect.objectContaining({ code: "replay_expired" }),
    );
    const admitted = queued(await restarted.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "history-new-admission",
      patch: { text: "A new edit after bounded compaction." },
    }));
    await restarted.drain();
    expect(restarted.operation(admitted.id)).toMatchObject({ status: "succeeded" });
    const afterAdmission = readLedger(ledger);
    expect(afterAdmission.operations.length + afterAdmission.expiredReplays.length)
      .toBeLessThanOrEqual(1_024);
    expect(afterAdmission.expiredReplays.some((replay) => replay.operationId === "history-op-0000"))
      .toBe(false);
    expect(afterAdmission.expiredReplays.some((replay) => replay.operationId === "history-op-0100"))
      .toBe(true);
  });

  it("expires full history before idempotency and deliberately releases keys after 30 days", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const reader = operator(fixture.store, { actionsEnabled: false });
    const revision = (await reader.record(ORIGINAL_ID)).record.revision;
    await reader.close();
    const retainedInput = {
      expectedRevision: revision,
      idempotencyKey: "retained-window",
      patch: { text: "Within the idempotency window." },
    };
    const expiredInput = {
      expectedRevision: revision,
      idempotencyKey: "expired-window",
      patch: { text: "Outside the idempotency window." },
    };
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    writeLedger(ledger, {
      schemaVersion: 2,
      operations: [
        terminalOperation("retained-window-op", retainedInput, "2026-08-10T10:00:00.000Z"),
        terminalOperation("expired-window-op", expiredInput, "2026-07-01T10:00:00.000Z"),
      ],
      expiredReplays: [],
    });

    const service = operator(fixture.store, { actionsEnabled: true });
    expect(() => service.edit(ORIGINAL_ID, retainedInput)).toThrow(
      expect.objectContaining({ code: "replay_expired" }),
    );
    expect(() => service.operation("retained-window-op")).toThrow(
      expect.objectContaining({ code: "replay_expired" }),
    );
    expect(() => service.operation("expired-window-op")).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
    const admitted = queued(await service.edit(ORIGINAL_ID, expiredInput));
    await service.drain();
    expect(service.operation(admitted.id)).toMatchObject({ status: "succeeded" });
  });

  it("degrades action capacity only while all 1,024 durable entries are nonterminal", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const reader = operator(fixture.store, { actionsEnabled: false });
    const revision = (await reader.record(ORIGINAL_ID)).record.revision;
    await reader.close();
    const operations = queuedOperations(1_024, revision, 32);
    operations[0] = { ...operations[0]!, expectedRevision: "0".repeat(64) };
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    writeLedger(ledger, { schemaVersion: 2, operations, expiredReplays: [] });
    const releaseFirst = deferred<void>();
    const enteredSecond = deferred<void>();
    const releaseSecond = deferred<void>();
    let gateReservation = 0;
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
      gate: {
        runExclusive: async (mutation) => {
          gateReservation += 1;
          if (gateReservation === 1) await releaseFirst.promise;
          else {
            enteredSecond.resolve();
            await releaseSecond.promise;
          }
          return await mutation();
        },
      },
    });

    expect(service.capability()).toMatchObject({ status: "degraded", read: true, actions: false });
    expect(service.operation("pending-op-0000")).toMatchObject({ status: "draining" });
    const before = readFileSync(ledger, "utf8");
    expect(() => service.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "pending-over-capacity",
      patch: { text: "Must not become a phantom operation." },
    })).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(failures).toEqual([]);
    releaseFirst.resolve();
    await enteredSecond.promise;
    expect(service.capability()).toMatchObject({ status: "ready", read: true, actions: true });
    expect(service.operation("pending-op-0000")).toMatchObject({ status: "failed" });
    const recoveredAdmission = queued(await service.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "pending-after-recovery",
      patch: { text: "Admission resumes after one terminal operation." },
    }));
    expect(service.operation(recoveredAdmission.id)).toMatchObject({ status: "queued" });
    expect(failures).toEqual([]);
    await service.close();
    releaseSecond.resolve();
    await Promise.resolve();
  });

  it("pauses a transition at the exact byte cap without an integrity notification or hot loop", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const reader = operator(fixture.store, { actionsEnabled: false });
    const revision = (await reader.record(ORIGINAL_ID)).record.revision;
    await reader.close();
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    const operations = exactLedgerByteLimit(revision);
    writeLedger(ledger, { schemaVersion: 2, operations, expiredReplays: [] });
    const before = readFileSync(ledger, "utf8");
    expect(Buffer.byteLength(before)).toBe(4 * 1024 * 1024);
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const service = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
    });

    await expect(service.drain()).rejects.toMatchObject({
      code: "unavailable",
      details: { reason: "capacity" },
    });
    expect(service.capability()).toMatchObject({ status: "degraded", read: true, actions: false });
    expect(service.operation(operations[0]!.id)).toMatchObject({ status: "queued" });
    await expect(service.overview()).resolves.toMatchObject({ counts: { total: 1, active: 1 } });
    expect(failures).toEqual([]);
    expect(readFileSync(ledger, "utf8")).toBe(before);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(readFileSync(ledger, "utf8")).toBe(before);
  });

  it("rejects an over-4-MiB candidate transactionally and permits a smaller retry of the same key", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const reader = operator(fixture.store, { actionsEnabled: false });
    const revision = (await reader.record(ORIGINAL_ID)).record.revision;
    await reader.close();
    const operations = nearLedgerByteLimit(revision);
    const ledger = join(fixture.root, ".memory-operator-v1.json");
    writeLedger(ledger, { schemaVersion: 2, operations, expiredReplays: [] });
    const seededBytes = Buffer.byteLength(readFileSync(ledger));
    expect(seededBytes).toBeGreaterThan(4 * 1024 * 1024 - 2_000);
    expect(seededBytes).toBeLessThan(4 * 1024 * 1024);
    const release = deferred<void>();
    const service = operator(fixture.store, {
      actionsEnabled: true,
      gate: { runExclusive: async (mutation) => { await release.promise; return await mutation(); } },
    });
    const before = readFileSync(ledger, "utf8");

    expect(() => service.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "byte-cap-retry",
      patch: { text: "z".repeat(4_000) },
    })).toThrow(expect.objectContaining({ code: "unavailable" }));
    expect(readFileSync(ledger, "utf8")).toBe(before);
    expect(service.capability()).toMatchObject({ status: "ready", actions: true });
    const admitted = queued(await service.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "byte-cap-retry",
      patch: { text: "Fits." },
    }));
    expect(service.operation(admitted.id)).toMatchObject({ status: "queued" });
    expect(Buffer.byteLength(readFileSync(ledger))).toBeLessThanOrEqual(4 * 1024 * 1024);
    await service.close();
    release.resolve();
    await Promise.resolve();
  });

  it("recovers an applying action after semantic commit but before its terminal receipt", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const failures: MemoryOperatorIntegrityFailure[] = [];
    const originalService = operator(fixture.store, {
      actionsEnabled: true,
      onIntegrityFailure: (failure) => { failures.push(failure); },
      hooks: { afterMutationCommitted: () => { throw new Error("injected receipt failure"); } },
    });
    const revision = (await originalService.record(ORIGINAL_ID)).record.revision;
    const admitted = queued(await originalService.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "edit-recover-after-commit",
      patch: { text: "Recovered semantic state." },
    }));
    await expect(originalService.drain()).rejects.toMatchObject({ code: "unavailable" });
    expect(originalService.capability()).toMatchObject({ status: "degraded", read: false, actions: false });
    expect(failures).toEqual([{
      code: "unavailable",
      reason: "pump",
      message: "Memory action recovery did not complete.",
    }]);

    const restarted = operator(fixture.store, { actionsEnabled: true });
    await restarted.drain();
    expect(await restarted.operation(admitted.id)).toMatchObject({
      status: "succeeded",
      resultRecordId: admitted.resultRecordId,
    });
    expect((await restarted.record(admitted.resultRecordId!)).record.text).toBe("Recovered semantic state.");
    const ledger = readFileSync(join(fixture.root, ".memory-operator-v1.json"), "utf8");
    expect(ledger).not.toContain("Recovered semantic state.");
    expect(ledger).not.toContain(revision);
  });

  it("persists queued work, reserves the mutation gate synchronously, and replays it after close", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const release = deferred<void>();
    let gateReservations = 0;
    const first = operator(fixture.store, {
      actionsEnabled: true,
      gate: {
        runExclusive: async (mutation) => {
          gateReservations += 1;
          await release.promise;
          return await mutation();
        },
      },
    });
    const revision = (await first.record(ORIGINAL_ID)).record.revision;
    const admitted = queued(await first.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "edit-queued-restart",
      patch: { text: "Durably queued state." },
    }));
    expect(gateReservations).toBe(1);
    await first.close();
    expect((await first.operation(admitted.id)).status).toBe("draining");

    const restarted = operator(fixture.store, { actionsEnabled: true });
    await restarted.drain();
    expect((await restarted.operation(admitted.id)).status).toBe("succeeded");
    expect((await restarted.record(admitted.resultRecordId!)).record.text).toBe("Durably queued state.");
    release.resolve();
    await Promise.resolve();
  });

  it("leaves durable work unchanged in Journal and Lite, then resumes it once in BuJo with actions disabled", async () => {
    for (const tier of ["journal", "lite"] as const) {
      const recordId = `${ORIGINAL_ID}-${tier}-pending`;
      const fixture = await managedFixture("bujo", [baseBullet({ id: recordId })]);
      const releaseGate = deferred<void>();
      const gateExited = deferred<void>();
      const first = operator(fixture.store, {
        actionsEnabled: true,
        gate: {
          runExclusive: async (mutation) => {
            await releaseGate.promise;
            try {
              return await mutation();
            } finally {
              gateExited.resolve();
            }
          },
        },
      });
      const original = (await first.record(recordId)).record;
      const admitted = queued(await first.edit(recordId, {
        expectedRevision: original.revision,
        idempotencyKey: `cross-tier-${tier}`,
        patch: { text: `Recovered from ${tier} without a duplicate.` },
      }));
      expect(first.operation(admitted.id)).toMatchObject({ status: "draining" });

      await first.close();
      await fixture.store.close();
      const ledgerPath = join(fixture.root, ".memory-operator-v1.json");
      const pendingLedger = readFileSync(ledgerPath, "utf8");
      releaseGate.resolve();
      await gateExited.promise;

      await safeRebuildMemoryIndex({
        root: fixture.root,
        tier,
        ...(tier === "lite" ? {} : { embeddings: fixture.embeddings, dim: DIM }),
      });
      const unsupportedStore = trackStore(createBujoMemoryStore({
        root: fixture.root,
        tier,
        ...(tier === "lite" ? {} : { embeddings: fixture.embeddings, dim: DIM }),
        clock: fixture.clock,
      }));
      const unsupportedFailures: MemoryOperatorIntegrityFailure[] = [];
      let unsupportedIntentWrites = 0;
      const unsupported = operator(unsupportedStore, {
        actionsEnabled: true,
        onIntegrityFailure: (failure) => { unsupportedFailures.push(failure); },
        hooks: { afterIntentDurable: () => { unsupportedIntentWrites += 1; } },
      });
      await unsupported.drain();
      expect(unsupported.capability()).toMatchObject({ tier, status: "ready", actions: false, read: true });
      expect(unsupported.operation(admitted.id)).toMatchObject({ status: "draining" });
      expect(readFileSync(ledgerPath, "utf8")).toBe(pendingLedger);
      expect(readBullet(fixture.root, "daily/2026-08-01.md", recordId)?.text).toBe(original.text);
      expect(readFileSync(join(fixture.root, "daily/2026-08-01.md"), "utf8"))
        .not.toContain(admitted.resultRecordId!);
      expect(unsupportedIntentWrites).toBe(0);
      expect(unsupportedFailures).toEqual([]);
      await unsupported.close();
      await unsupportedStore.close();

      await safeRebuildMemoryIndex({
        root: fixture.root,
        tier: "bujo",
        embeddings: fixture.embeddings,
        dim: DIM,
      });
      const recoveredStore = trackStore(createBujoMemoryStore({
        root: fixture.root,
        tier: "bujo",
        embeddings: fixture.embeddings,
        dim: DIM,
        llm: fakeLlm([]),
        clock: fixture.clock,
      }));
      const recovered = operator(recoveredStore, { actionsEnabled: false });
      await recovered.drain();
      expect(recovered.capability()).toMatchObject({ tier: "bujo", status: "ready", actions: false, read: true });
      expect(recovered.operation(admitted.id)).toMatchObject({
        status: "succeeded",
        resultRecordId: admitted.resultRecordId,
      });
      expect((await recovered.record(admitted.resultRecordId!)).record.text)
        .toBe(`Recovered from ${tier} without a duplicate.`);
      expect((await recovered.overview()).counts.total).toBe(2);
      expect(readReplayProjectionStrict(fixture.root).projection.supersedes
        .filter((edge) => edge.src === recordId && edge.dst === admitted.resultRecordId))
        .toHaveLength(1);
      await recovered.close();
      await recoveredStore.close();

      const provenOnceStore = trackStore(createBujoMemoryStore({
        root: fixture.root,
        tier: "bujo",
        embeddings: fixture.embeddings,
        dim: DIM,
        llm: fakeLlm([]),
        clock: fixture.clock,
      }));
      const provenOnce = operator(provenOnceStore, { actionsEnabled: false });
      await provenOnce.drain();
      expect(provenOnce.operation(admitted.id)).toMatchObject({ status: "succeeded" });
      expect((await provenOnce.overview()).counts.total).toBe(2);
      await provenOnce.close();
      await provenOnceStore.close();
    }
  });

  it("orders an in-flight consolidation through the same root mutation queue", async () => {
    const fixture = await managedFixture("bujo", [baseBullet()]);
    const service = operator(fixture.store, { actionsEnabled: true });
    const engine = fixture.store.operatorEngine();
    const entered = deferred<void>();
    const release = deferred<void>();
    const blocker = engine.runMutation(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let consolidated = false;
    const consolidation = fixture.store.consolidate().then(() => { consolidated = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(consolidated).toBe(false);

    const revision = (await service.record(ORIGINAL_ID)).record.revision;
    const edit = queued(await service.edit(ORIGINAL_ID, {
      expectedRevision: revision,
      idempotencyKey: "edit-after-consolidation",
      patch: { text: "Published after the admitted consolidation." },
    }));
    release.resolve();
    await blocker;
    await consolidation;
    await service.drain();
    expect((await service.operation(edit.id)).status).toBe("succeeded");
    expect((await service.record(edit.resultRecordId!)).record.text)
      .toBe("Published after the admitted consolidation.");
  });
});

interface Fixture {
  readonly root: string;
  readonly store: BujoMemoryStore;
  readonly embeddings: ReturnType<typeof fakeEmbeddings>;
  readonly clock: () => Date;
}

async function managedFixture(
  tier: BujoTier,
  bullets: readonly Bullet[],
  graph = false,
  replayTerminals: readonly ReplayProjectionTerminal[] = [],
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `memory-operator-${tier}-`));
  roots.push(root);
  const embeddings = fakeEmbeddings(DIM);
  if (tier === "bujo") {
    initializeReplayProjection(root);
    if (replayTerminals.length > 0) {
      publishPreparedReplayProjection(root, prepareReplayProjectionDelta(root, {
        terminals: replayTerminals,
        supersedes: [],
        threads: [],
      }));
    }
  }
  for (const bullet of bullets) appendBullet(root, bullet, new Date(bullet.createdAt));
  if (graph) {
    const supportBullet: Bullet = {
      id: "GRAPH-SUPPORT",
      type: "note",
      status: "migrated",
      text: "A migrated collection supplies canonical support evidence.",
      salience: 0.5,
      isInsight: false,
      createdAt: "2026-07-31T09:00:00.000Z",
      refs: [],
    };
    appendBullet(root, supportBullet, new Date(supportBullet.createdAt));
    appendGraphBatch(root, {
      entities: [
        { id: "person:morgan", name: "Morgan", type: "person", createdAt: GRAPH_AT },
        { id: "project:mono-agent", name: "mono-agent", type: "project", createdAt: GRAPH_AT },
        { id: "collection:support", name: "support", type: "collection", createdAt: GRAPH_AT },
      ],
      relations: [{
        src: "person:morgan",
        dst: "project:mono-agent",
        relation: "maintains",
        createdAt: GRAPH_AT,
      }],
      associations: [
        { memoryId: ORIGINAL_ID, entityId: "person:morgan", provenance: "capture", createdAt: GRAPH_AT },
        { memoryId: supportBullet.id, entityId: "collection:support", provenance: "capture", createdAt: GRAPH_AT },
      ],
    });
  }
  await safeRebuildMemoryIndex({
    root,
    tier,
    ...(tier === "lite" ? {} : { embeddings, dim: DIM }),
  });
  let millis = Date.parse("2026-08-20T10:00:00.000Z");
  const clock = (): Date => new Date(millis += 1_000);
  const store = trackStore(createBujoMemoryStore({
    root,
    tier,
    ...(tier === "lite" ? {} : { embeddings, dim: DIM }),
    ...(tier === "bujo" ? { llm: fakeLlm([]) } : {}),
    clock,
  }));
  return { root, store, embeddings, clock };
}

function operator(
  store: BujoMemoryStore,
  options: Parameters<typeof createBujoMemoryOperatorService>[1],
): BuiltinMemoryOperatorService {
  const service = createBujoMemoryOperatorService(store, options);
  services.push(service);
  return service;
}

function trackStore(store: BujoMemoryStore): BujoMemoryStore {
  stores.push(store);
  return store;
}

function baseBullet(overrides: Partial<Bullet> = {}): Bullet {
  return {
    id: ORIGINAL_ID,
    type: "note",
    status: "open",
    text: "Morgan maintains the memory operator.",
    salience: 0.8,
    isInsight: false,
    createdAt: CREATED_AT,
    refs: ["conversation:evidence-1"],
    validFrom: "2026-07-01T00:00:00.000Z",
    dueAt: "2026-08-30T12:00:00.000Z",
    tags: ["operator", "memory"],
    collection: "alpha",
    conversationId: "web:conversation-42",
    ...overrides,
  };
}

function queued(admission: MemoryOperatorMutationAdmission) {
  if (admission.kind !== "queued") throw new Error("expected a queued memory operation");
  return admission.operation;
}

function confirm(admission: MemoryOperatorMutationAdmission) {
  if (admission.kind !== "confirmation_required") throw new Error("expected a memory confirmation");
  return admission.confirmation;
}

function replayTerminal(
  id: string,
  at: string,
  authorityKind: ReplayProjectionAuthorityKind,
): ReplayProjectionTerminal {
  return {
    id,
    at,
    authorityKind,
    authorityId: replayProjectionAuthorityId({ test: "memory-operator-restore", id, at, authorityKind }),
  };
}

async function expectRestoreRejected(
  service: BuiltinMemoryOperatorService,
  recordId: string,
  idempotencyKey: string,
): Promise<void> {
  const record = (await service.record(recordId)).record;
  const restore = queued(await service.restore(recordId, {
    expectedRevision: record.revision,
    idempotencyKey,
  }));
  await service.drain();
  expect(service.operation(restore.id)).toMatchObject({
    status: "failed",
    errorCode: "invalid_request",
    errorMessage: "Memory action was not valid for this record.",
  });
  await expect(service.record(restore.resultRecordId!)).rejects.toMatchObject({ code: "not_found" });
  expect((await service.record(recordId)).history).toContainEqual(expect.objectContaining({
    id: restore.id,
    action: "restore",
    status: "failed",
    errorCode: "invalid_request",
  }));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

interface TestLedgerOperation {
  readonly id: string;
  readonly action: "edit";
  readonly recordId: string;
  readonly status: "queued" | "succeeded";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resultRecordId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly expectedRevision: string;
  readonly patch?: { readonly text: string };
  readonly appliedAt?: string;
  readonly completedAt?: string;
}

interface TestLedger {
  readonly schemaVersion: number;
  readonly operations: TestLedgerOperation[];
  readonly expiredReplays: Array<{
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly expiresAt: string;
  }>;
}

function terminalOperations(
  count: number,
  revision: string,
  historicalInput: {
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
    readonly patch: { readonly text: string };
  },
): TestLedgerOperation[] {
  const completedAt = "2026-08-19T10:00:00.000Z";
  return Array.from({ length: count }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const idempotencyKey = `history-key-${suffix}`;
    const requestHash = index === 100
      ? operatorActionHash({
          action: "edit",
          recordId: ORIGINAL_ID,
          expectedRevision: revision,
          idempotencyKey,
          patch: historicalInput.patch,
        })
      : createHash("sha256").update(`history-request-${suffix}`).digest("hex");
    return {
      id: `history-op-${suffix}`,
      action: "edit",
      recordId: ORIGINAL_ID,
      status: "succeeded",
      createdAt: completedAt,
      updatedAt: completedAt,
      resultRecordId: `history-result-${suffix}`,
      idempotencyKey,
      requestHash,
      expectedRevision: "",
      appliedAt: completedAt,
      completedAt,
    };
  });
}

function terminalOperation(
  id: string,
  input: {
    readonly expectedRevision: string;
    readonly idempotencyKey: string;
    readonly patch: { readonly text: string };
  },
  completedAt: string,
): TestLedgerOperation {
  return {
    id,
    action: "edit",
    recordId: ORIGINAL_ID,
    status: "succeeded",
    createdAt: completedAt,
    updatedAt: completedAt,
    resultRecordId: `${id}-result`,
    idempotencyKey: input.idempotencyKey,
    requestHash: operatorActionHash({
      action: "edit",
      recordId: ORIGINAL_ID,
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.idempotencyKey,
      patch: input.patch,
    }),
    expectedRevision: "",
    appliedAt: completedAt,
    completedAt,
  };
}

function queuedOperations(count: number, revision: string, textLength: number): TestLedgerOperation[] {
  return Array.from({ length: count }, (_, index) => queuedOperation(index, revision, textLength));
}

function queuedOperation(index: number, revision: string, textLength: number): TestLedgerOperation {
  const suffix = String(index).padStart(4, "0");
  const idempotencyKey = `pending-key-${suffix}`;
  const patch = { text: `${suffix}-${"x".repeat(Math.max(0, textLength - suffix.length - 1))}` };
  return {
    id: `pending-op-${suffix}`,
    action: "edit",
    recordId: ORIGINAL_ID,
    status: "queued",
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    resultRecordId: `pending-result-${suffix}`,
    idempotencyKey,
    requestHash: operatorActionHash({
      action: "edit",
      recordId: ORIGINAL_ID,
      expectedRevision: revision,
      idempotencyKey,
      patch,
    }),
    expectedRevision: revision,
    patch,
  };
}

function nearLedgerByteLimit(revision: string): TestLedgerOperation[] {
  const targetBytes = 4 * 1024 * 1024 - 1_024;
  const operations: TestLedgerOperation[] = [];
  while (operations.length < 1_023) {
    const candidate = queuedOperation(operations.length, revision, 4_000);
    const next = [...operations, candidate];
    if (ledgerBytes(next) > targetBytes) break;
    operations.push(candidate);
  }
  let low = 1;
  let high = 4_000;
  let best: TestLedgerOperation | undefined;
  while (low <= high && operations.length < 1_023) {
    const middle = Math.floor((low + high) / 2);
    const candidate = queuedOperation(operations.length, revision, middle);
    if (ledgerBytes([...operations, candidate]) <= targetBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) operations.push(best);
  return operations;
}

function exactLedgerByteLimit(revision: string): TestLedgerOperation[] {
  const targetBytes = 4 * 1024 * 1024;
  const operations: TestLedgerOperation[] = [];
  while (operations.length < 1_024) {
    const candidate = queuedOperation(operations.length, revision, 4_000);
    if (ledgerBytes([...operations, candidate]) > targetBytes) break;
    operations.push(candidate);
  }
  let remaining = targetBytes - ledgerBytes(operations);
  const fields = [
    ["id", 512],
    ["recordId", 512],
    ["resultRecordId", 512],
    ["idempotencyKey", 200],
  ] as const;
  for (let index = 0; index < operations.length && remaining > 0; index += 1) {
    let operation = operations[index]!;
    for (const [field, maximum] of fields) {
      const value = operation[field];
      const growth = Math.min(remaining, maximum - value.length);
      if (growth <= 0) continue;
      operation = { ...operation, [field]: `${value}${"x".repeat(growth)}` };
      remaining -= growth;
    }
    operations[index] = operation;
  }
  if (remaining !== 0 || ledgerBytes(operations) !== targetBytes) {
    throw new Error("failed to construct an exact-capacity operator ledger fixture");
  }
  return operations;
}

function ledgerBytes(operations: TestLedgerOperation[]): number {
  return Buffer.byteLength(JSON.stringify({
    schemaVersion: 2,
    operations,
    expiredReplays: [],
  }) + "\n");
}

function operatorActionHash(input: {
  readonly action: "edit";
  readonly recordId: string;
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
  readonly patch: { readonly text: string };
}): string {
  return createHash("sha256")
    .update("mono-agent-memory-operator-action-v1\0")
    .update(JSON.stringify(input))
    .digest("hex");
}

function writeLedger(path: string, ledger: unknown): void {
  writeFileSync(path, `${JSON.stringify(ledger)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function readLedger(path: string): TestLedger {
  return JSON.parse(readFileSync(path, "utf8")) as TestLedger;
}
