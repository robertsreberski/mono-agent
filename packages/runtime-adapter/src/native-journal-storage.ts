import { createManagedNativeJournalStorage as nativeStorage } from "@mono-agent/agent-runtime";
import type { RuntimeNativeJournalPresence, RuntimeNativePreparationStorage } from "./types.js";
/** Administrative storage capability; configured APP opt-in owns policy/authority,
 * never inferred from this factory or runtime capability presence. */
export function createManagedNativeJournalStorage(options: {
  readonly sessionsRoot: string; readonly onPhase?: (phase: string) => Promise<void>;
}): RuntimeNativePreparationStorage & { readonly checkInheritedPrefix: NonNullable<RuntimeNativePreparationStorage["checkInheritedPrefix"]> } {
  const storage = nativeStorage(options);
  return { nativeEvidence: "v1", captureEvidence: (source, context) => storage.captureEvidence(source, context),
    createBudget: (input) => storage.createBudget(input), prepareHandoff: (view, options) => storage.prepareHandoff(view, options) as ReturnType<RuntimeNativePreparationStorage["prepareHandoff"]>,
    checkInheritedPrefix: async (messages, model, compaction, prefixTokenCap) => await storage.checkInheritedPrefix([...messages], model, compaction, prefixTokenCap) as Awaited<ReturnType<NonNullable<RuntimeNativePreparationStorage["checkInheritedPrefix"]>>>,
    buildHandoff: (view, options) => storage.buildHandoff(view, options) as ReturnType<RuntimeNativePreparationStorage["buildHandoff"]>,
    createEpoch: (context) => storage.createEpoch(context),
    deletionBlocked: (journals, authority) => storage.deletionBlocked([...journals], authority),
    deleteJournals: (journals, context) => storage.deleteJournals([...journals], context),
    freeze: (source) => storage.freeze(source),
    inspectCurrentJournal: async (coordinates) => await storage.inspectCurrentJournal({ handleId: coordinates.handleId,
      ...(coordinates.journalId === undefined ? {} : { journalId: coordinates.journalId }) }) as RuntimeNativeJournalPresence,
    inventory: (ids, owners) => storage.inventory(ids === undefined ? undefined : [...ids], owners === undefined ? undefined : { ...owners, conversationKeys: [...owners.conversationKeys] }) };
}
