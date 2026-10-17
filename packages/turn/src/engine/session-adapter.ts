// @ts-check
import { projectContext, projectInheritedContext, inspectCurrentEvidence } from "./request-projection.js";

/** @param {any} rawSession */
export function createPiSessionAdapter(rawSession: any): {
    rawSession: any;
    readonly metadata: any;
    attach(nextDriver: any): void;
    setInheritedProjection(projection: any): void;
    buildContext(): Promise<{
        entries: any[];
        messages?: undefined;
        coverage?: undefined;
    } | {
        messages: any[];
        coverage: {
            source: string;
            repair: string;
            entryCount: number;
        };
        entries?: undefined;
    } | {
        entries: any[];
        nonRetainablePrefixLength: any;
        messages: any;
    } | {
        messages: any[];
        entries: any[];
        coverage?: undefined;
        nonRetainablePrefixLength?: undefined;
    }>;
    getEntries: () => Promise<any>;
    getLeafId: () => any;
    appendMessage: (message: any) => any;
    moveTo: (targetId: any) => any;
    getMetadata: () => Promise<any>;
    close(): any;
} {
  let driver: any = null;
  let inherited: any;
  let closePromise: any = null;
  return {
    rawSession,
    get metadata(): any { return rawSession.metadata; },
    attach(nextDriver: any): void { driver = nextDriver; },
    setInheritedProjection(projection: any): void { inherited = structuredClone(projection); },
    async buildContext(): Promise<{ entries: any[]; messages?: undefined; coverage?: undefined; } | { messages: any[]; coverage: { source: string; repair: string; entryCount: number; }; entries?: undefined; } | { entries: any[]; nonRetainablePrefixLength: any; messages: any; } | { messages: any[]; entries: any[]; coverage?: undefined; nonRetainablePrefixLength?: undefined; }> {
      const entries = await rawSession.getEntries(), options = { includeFailed: true, repairs: await rawSession.getRepairEntries() };
      return inherited === undefined ? projectContext(entries, options) : projectInheritedContext(entries, inherited, options);
    },
    getEntries: async () => (await inspectCurrentEvidence(rawSession)).entries,
    getLeafId: () => rawSession.getLeafId(),
    appendMessage: (message: any) => rawSession.appendMessage(message),
    moveTo: (targetId: any) => rawSession.moveTo(targetId),
    getMetadata: () => Promise.resolve(rawSession.metadata),
    close(): any {
      if (!closePromise) closePromise = (async () => {
        if (driver) { await driver.abort(); await driver.waitForIdle(); }
        await rawSession.close();
      })();
      return closePromise;
    },
  };
}
