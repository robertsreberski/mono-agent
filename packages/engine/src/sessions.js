// @ts-check
export { resolveDurableNativeSessionRepo, resolveSession, discardUncommittedSession, commitSession, rollbackAbortedTurn, cleanupSessionOnThrow, captureSessionRecovery, recoverDurableNativeSession, reconcileNativeSessionTurn, retireDurableNativeSession, detachDurableNativeSession, nativeSessionRegistry } from "./session-lifecycle.js";
export { salvageDurableNativeSession } from "./session-salvage.js";
export { createManagedNativeJournalStorage, NativeEvidenceCapacityError } from "./native-journal-storage.js";
export { assertNativeSessionAccess } from "./session-authority.js";
export { normalizeDurableSessionsRoot } from "./sessions-root.js";
export { validateSessionTurn } from "./journal-schema.js";
export { isJournalStorageError } from "./storage-error.js";
export { NativeSuspendedError } from "./interruption.js";
export { settleNativeSession } from "./session-settlement.js";
export { createSessionRegistry } from "./session-registry.js";
