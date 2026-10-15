import { createManagedNativeJournalStorage as storage } from "@mono-agent/engine/sessions.js";
import { checkNativeInheritedPrefix } from "./handoff-producer.js";
export { NativeEvidenceCapacityError } from "@mono-agent/engine/sessions.js";

/** @typedef {import('../../native-journal-types.js').RuntimeNativePreparationStorage} RuntimeNativePreparationStorage */
/** Administrative storage capability; the host owns policy/authority. Keep one
 * factory, including the readonly-input copies and exact-coordinate normalization.
 * @param {Parameters<typeof storage>[0]} options
 * @returns {RuntimeNativePreparationStorage & {checkInheritedPrefix: NonNullable<RuntimeNativePreparationStorage['checkInheritedPrefix']>}} */
export function createManagedNativeJournalStorage(options) {
  const native = storage(options);
  return /** @type {ReturnType<typeof createManagedNativeJournalStorage>} */ ({
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
  });
}
