import { authorizeSubagentVerificationMetadata, authorizeSubagentObservationPath, observeSubagentVerification, registerSubagentVerification, sameSubagentVerificationTargetIdentity } from "./subagent-verification-observer.js";
import type { ProcessJobsServiceHandle } from "./process-jobs-service.js";
import type { SubagentRecoveryFacts, SubagentRecoverySubject } from "./subagent-instances.js";
import type { SubagentVerificationDeclaration } from "./subagent-verification-observer.js";

/** Composition-private current-policy boundary. Never opens a root supplied by a job. */
export function createSubagentRecoveryAccess(options: {
  readonly privateRoots: () => Promise<readonly string[]>;
  readonly service?: ProcessJobsServiceHandle;
  readonly hostAccess: () => unknown;
}) {
  const snapshot = async (subject: SubagentRecoverySubject) => {
    if (!subject.owner) return undefined;
    if (!options.service?.inspectSubagentRecovery || subject.owner.storeRoot !== options.service.settings.stateDir) throw new Error("observation_unavailable");
    const result = await options.service.inspectSubagentRecovery(subject.owner);
    if (!result) throw new Error("observation_unavailable");
    if (JSON.stringify(result.verification) !== JSON.stringify(subject.verification)) throw new Error("observation_unavailable");
    return result;
  };
  const authorize = async (subject: SubagentRecoverySubject, access: unknown): Promise<boolean | "unavailable"> => {
    try {
      const roots = await options.privateRoots();
      const input = access as { workspace?: string; sandboxEngine?: { isAvailable(): Promise<boolean> }; sandboxPolicy?: unknown; runProbe?: unknown } | undefined;
      if (!input?.workspace) return "unavailable";
      await authorizeSubagentObservationPath(input.workspace, access, roots);
      const state = await snapshot(subject);
      if (subject.verification) {
        const target = subject.verification;
        const current = await registerSubagentVerification({ workdir: target.workdir, ...(target.reportPath ? { reportPath: target.reportPath } : {}) }, access, roots);
        if (!sameSubagentVerificationTargetIdentity(current, target)) return false;
        await authorizeSubagentVerificationMetadata(target, access, roots);
        if (!input.sandboxPolicy || !input.sandboxEngine || !await input.sandboxEngine.isAvailable()) return "unavailable";
      }
      for (const command of state?.commands?.commands ?? []) await authorizeSubagentObservationPath(command.cwd, access, roots);
      return true;
    } catch (error) { return error instanceof Error && error.message === "observation_policy_denied" ? false : "unavailable"; }
  };
  return {
    registerVerification: async (declaration: SubagentVerificationDeclaration, access: unknown) =>
      await registerSubagentVerification(declaration, access, await options.privateRoots()),
    authorizeRecovery: authorize,
    authorizeClosure: async (subject: SubagentRecoverySubject) => await authorize(subject, options.hostAccess()) === true,
    refreshOwner: async (identity: NonNullable<SubagentRecoverySubject["owner"]>) => { await options.service?.refreshSubagentOwner?.(identity); },
    observeRecovery: async (subject: SubagentRecoverySubject, access: unknown): Promise<SubagentRecoveryFacts> => {
      try {
        const first = await authorize(subject, access);
        if (first !== true) return { status: first === false ? "observation_policy_denied" : "observation_unavailable" };
        const state = await snapshot(subject);
        const observation = subject.verification ? await observeSubagentVerification(subject.verification, access, await options.privateRoots()) : undefined;
        if (observation && subject.owner) await options.service!.recordSubagentObservation!(subject.owner, observation);
        // Disclosure is a new authorization decision, not permission inherited
        // from either the admission or a previously persisted observation.
        const current = await authorize(subject, access);
        if (current !== true) return { status: current === false ? "observation_policy_denied" : "observation_unavailable" };
        if (observation && observation.status !== "observed") return { status: observation.status };
        const publicObservation = observation ? (({ schemaVersion: _schema, policyRevision: _policy, ...value }) => value)(observation) : undefined;
        const facts: SubagentRecoveryFacts = { status: "observed", ...(state?.commands ? { commands: structuredClone(state.commands) } : {}), ...(publicObservation ? { observation: publicObservation } : {}) };
        // Leave room for the registry's tuple/reason/token envelope within 16 KiB.
        while (facts.commands?.commands.length && Buffer.byteLength(JSON.stringify(facts)) > 14 * 1024) {
          facts.commands.commands.shift(); facts.commands.omitted = Math.min(Number.MAX_SAFE_INTEGER, facts.commands.omitted + 1);
        }
        if (Buffer.byteLength(JSON.stringify(facts)) > 14 * 1024) return { status: "observation_truncated" };
        return facts;
      } catch { return { status: "observation_unavailable" }; }
    },
  };
}
