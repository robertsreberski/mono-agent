import { createManagedNativeJournalStorage as nativeStorage } from "@mono-agent/agent-runtime";
import type { RuntimeNativeJournalStorage } from "./types.js";
/** Administrative storage capability. No runtime/configured host opts in here. */
export function createManagedNativeJournalStorage(options: {
  readonly sessionsRoot: string; readonly onPhase?: (phase: string) => Promise<void>;
}): RuntimeNativeJournalStorage {
  const storage = nativeStorage(options);
  return { planColdEpoch: (chain, context) => storage.planColdEpoch([...chain], context),
    verifyColdEpoch: (chain, context) => storage.verifyColdEpoch([...chain], context),
    publishColdEpoch: (chain, context) => storage.publishColdEpoch([...chain], context),
    deletionBlocked: (chain, authority) => storage.deletionBlocked([...chain], authority),
    deleteJournals: (chain, context) => storage.deleteJournals([...chain], context),
    freeze: (source) => storage.freeze(source),
    measureSwitch: (sources, context) => storage.measureSwitch([...sources], context),
    verifySwitchSources: (chain, sources, context) => storage.verifySwitchSources([...chain], [...sources], context),
    verifySwitch: (chain, sources, context) => storage.verifySwitch([...chain], [...sources], context),
    publishSwitch: (sources, context) => storage.publishSwitch([...sources], context),
    inventory: (ids) => storage.inventory(ids === undefined ? undefined : [...ids]) };
}
