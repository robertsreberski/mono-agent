// @ts-check
import { projectContext, projectInheritedContext, inspectCurrentEvidence } from "./request-projection.js";

/** @param {any} rawSession */
export function createPiSessionAdapter(rawSession) {
  let driver = null;
  let inherited;
  let closePromise = null;
  return {
    rawSession,
    get metadata() { return rawSession.metadata; },
    attach(nextDriver) { driver = nextDriver; },
    setInheritedProjection(projection) { inherited = structuredClone(projection); },
    async buildContext() {
      const entries = await rawSession.getEntries(), options = { includeFailed: true, repairs: await rawSession.getRepairEntries() };
      return inherited === undefined ? projectContext(entries, options) : projectInheritedContext(entries, inherited, options);
    },
    getEntries: async () => (await inspectCurrentEvidence(rawSession)).entries,
    getLeafId: () => rawSession.getLeafId(),
    appendMessage: (message) => rawSession.appendMessage(message),
    moveTo: (targetId) => rawSession.moveTo(targetId),
    getMetadata: () => Promise.resolve(rawSession.metadata),
    close() {
      if (!closePromise) closePromise = (async () => {
        if (driver) { await driver.abort(); await driver.waitForIdle(); }
        await rawSession.close();
      })();
      return closePromise;
    },
  };
}
