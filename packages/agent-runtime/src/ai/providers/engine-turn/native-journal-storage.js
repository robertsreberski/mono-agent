import { createManagedNativeJournalStorage as storage } from "@mono-agent/engine/sessions.js";
import { checkNativeInheritedPrefix } from "./handoff-producer.js";
export { NativeEvidenceCapacityError } from "@mono-agent/engine/sessions.js";
/** @param {Parameters<typeof storage>[0]} options
 * @returns {ReturnType<typeof storage> & {checkInheritedPrefix: typeof checkNativeInheritedPrefix}} */
export function createManagedNativeJournalStorage(options) {
  return { ...storage(options), checkInheritedPrefix: checkNativeInheritedPrefix };
}
