export type RuntimeNativePreparationStorage = import("../../contracts/native-storage.js").RuntimeNativePreparationStorage;
import { createManagedNativeJournalStorage as storage } from "../../engine/native-journal-storage.js";
import { checkNativeInheritedPrefix } from "./handoff-producer.js";

/**
 * Administrative storage capability; the host owns policy/authority. Keep one
 * factory, including the readonly-input copies and exact-coordinate normalization.
 */
export function createManagedNativeJournalStorage(options: Parameters<typeof storage>[0]): RuntimeNativePreparationStorage & {
    checkInheritedPrefix: NonNullable<RuntimeNativePreparationStorage["checkInheritedPrefix"]>;
    inspectCurrentJournal: NonNullable<RuntimeNativePreparationStorage["inspectCurrentJournal"]>;
} {
  const native = storage(options);
  return (({
    ...native,
    checkInheritedPrefix: (messages, model, compaction, prefixTokenCap) =>
      checkNativeInheritedPrefix([...messages], model, compaction, prefixTokenCap),
    deletionBlocked: (journals, authority) => native.deletionBlocked([...journals], authority),
    deleteJournals: (journals, context) => native.deleteJournals([...journals], context),
    inspectCurrentJournal: (coordinates) => native.inspectCurrentJournal({
      handleId: coordinates.handleId,
      ...(coordinates.journalId === undefined ? {} : { journalId: coordinates.journalId }),
    }),
    inventory: (ids, owners) => native.inventory(
      ids === undefined ? undefined : [...ids],
      owners === undefined ? undefined : { ...owners, conversationKeys: [...owners.conversationKeys] },
    ),
  }) as ReturnType<typeof createManagedNativeJournalStorage>);
}
