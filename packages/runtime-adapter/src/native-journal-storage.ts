import { createManagedNativeJournalStorage as nativeStorage } from "@mono-agent/agent-runtime";
import type { RuntimeNativePreparationStorage } from "./types.js";
/** Administrative storage capability. No runtime/configured host opts in here. */
export function createManagedNativeJournalStorage(options: {
  readonly sessionsRoot: string; readonly onPhase?: (phase: string) => Promise<void>;
}): RuntimeNativePreparationStorage {
  const storage = nativeStorage(options);
  return { nativeEvidence: "v1", captureEvidence: (sources, context) => storage.captureEvidence([...sources], context),
    createBudget: (input) => storage.createBudget(input), prepareHandoff: (view, options) => storage.prepareHandoff(view, options) as ReturnType<RuntimeNativePreparationStorage["prepareHandoff"]>,
    buildHandoff: (view, options) => storage.buildHandoff(view, options) as ReturnType<RuntimeNativePreparationStorage["buildHandoff"]>,
    projectChain: (view, options) => storage.projectChain(view, options) as ReturnType<RuntimeNativePreparationStorage["projectChain"]>,
    planColdEpoch: (chain, context) => storage.planColdEpoch([...chain], context),
    verifyColdEpoch: (chain, context) => storage.verifyColdEpoch([...chain], context),
    publishColdEpoch: (chain, context) => storage.publishColdEpoch([...chain], context),
    deletionBlocked: (chain, authority) => storage.deletionBlocked([...chain], authority),
    deleteJournals: (chain, context) => storage.deleteJournals([...chain], context),
    freeze: (source) => storage.freeze(source),
    hasSwitchReference: (sources, context) => storage.hasSwitchReference([...sources], context),
    measureSwitch: (sources, context) => storage.measureSwitch([...sources], context),
    verifySwitchSources: (chain, sources, context) => storage.verifySwitchSources([...chain], [...sources], context),
    verifySwitch: (chain, sources, context) => storage.verifySwitch([...chain], [...sources], context),
    publishSwitch: (sources, context) => storage.publishSwitch([...sources], context),
    inventory: (ids, owners) => storage.inventory(ids === undefined ? undefined : [...ids], owners === undefined ? undefined : { ...owners, conversationKeys: [...owners.conversationKeys] }) };
}
