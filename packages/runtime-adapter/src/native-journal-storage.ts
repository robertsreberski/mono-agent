import { createManagedNativeJournalStorage as nativeStorage } from "@mono-agent/agent-runtime";
import type { RuntimeNativeJournalStorage } from "./types.js";
/** Administrative storage capability. No runtime/configured host opts in here. */
export function createManagedNativeJournalStorage(options: {
  readonly sessionsRoot: string; readonly onPhase?: (phase: string) => Promise<void>;
}): RuntimeNativeJournalStorage {
  const storage = nativeStorage(options);
  return { freeze: (source) => storage.freeze(source),
    measureSwitch: (sources, context) => storage.measureSwitch([...sources], context),
    publishSwitch: (sources, context) => storage.publishSwitch([...sources], context),
    inventory: () => storage.inventory() };
}
