import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CRON_REPLY_RECOVERY_PERSISTED_LIMIT,
  findCronReplyRecoveryReference,
  forgetCronReplyRecoveryReference,
  readCronReplyRecoveryReferences,
  rememberCronReplyRecoveryReference,
  resetCronReplyRecoveryMemory,
  type CronReplyRecoveryReference,
} from "./cron-reply-recovery";

const reference = (index: number): CronReplyRecoveryReference => ({
  sourceId: `source-${index}`,
  jobId: `job-${index}`,
  runId: `run-${index}`,
  operationId: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  snapshotKind: "summary",
});

describe("cron Reply page-lifetime recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetCronReplyRecoveryMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetCronReplyRecoveryMemory();
  });

  it("keeps unresolved identities in memory when session storage is unavailable", () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key) {
      if (this === sessionStorage) throw new DOMException("Storage unavailable.", "SecurityError");
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === sessionStorage) throw new DOMException("Quota exhausted.", "QuotaExceededError");
      return setItem.call(this, key, value);
    });

    const unresolved = reference(1);
    rememberCronReplyRecoveryReference(unresolved);

    expect(findCronReplyRecoveryReference(unresolved.sourceId, unresolved.jobId, unresolved.runId))
      .toEqual(unresolved);
    expect(readCronReplyRecoveryReferences()).toEqual([unresolved]);
  });

  it("never evicts unresolved page identities at the persistence capacity boundary", () => {
    const references = Array.from(
      { length: CRON_REPLY_RECOVERY_PERSISTED_LIMIT + 3 },
      (_, index) => reference(index + 1),
    );
    for (const unresolved of references) rememberCronReplyRecoveryReference(unresolved);

    expect(JSON.parse(sessionStorage.getItem("mono-agent:web:cron-reply-recovery:v1") ?? "[]"))
      .toHaveLength(CRON_REPLY_RECOVERY_PERSISTED_LIMIT);
    expect(readCronReplyRecoveryReferences()).toHaveLength(references.length);
    expect(findCronReplyRecoveryReference(
      references[0]!.sourceId,
      references[0]!.jobId,
      references[0]!.runId,
    )).toEqual(references[0]);
  });

  it("does not rehydrate a terminal identity when removing stale persistence fails", () => {
    const completed = reference(1);
    rememberCronReplyRecoveryReference(completed);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, _key) {
      if (this === sessionStorage) throw new DOMException("Storage unavailable.", "SecurityError");
      return undefined;
    });

    forgetCronReplyRecoveryReference(completed.operationId);

    expect(findCronReplyRecoveryReference(completed.sourceId, completed.jobId, completed.runId))
      .toBeUndefined();
  });
});
