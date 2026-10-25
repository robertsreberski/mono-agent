import { randomInt } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isProcessIncarnationLive, type SameProcessIncarnation } from "@mono-agent/conversation/process-incarnation";
import { agentRootDigest, agentRootLeaseLockOptions } from "./agent-root-lease-policy.js";
import { OwnerLockCoordinationBusyError } from "./owner-lock-mutation-gate.js";
import { reclaimOwnerPrivateLock, type OwnerPrivateLockMutationStep } from "./owner-private-lock.js";

// Linux include/linux/proc_ns.h: PROC_PID_INIT_INO = 0xEFFFFFFC.
const INITIAL_PID_NAMESPACE = "pid:[4026531836]";
const SAMPLE_LIMIT = 16;
const BUDGET_MS = 100;
// An age filter reduces startup churn, not a proof that a process is dead.
const MIN_AGE_MS = 60 * 60_000;
const DIAGNOSTIC = "Agent-root lease sweep could not finish safely; uncertain leases were retained.";

interface SweepOptions {
  readonly leaseRoot: string;
  /** App startup admission is necessary, but process-namespace visibility is checked independently. */
  readonly context: "host" | "sandbox";
  readonly platform?: NodeJS.Platform;
  readonly readNamespaceLink?: (path: string) => Promise<string>;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly budgetMs?: number;
  readonly randomIndex?: (upperBound: number) => number;
  readonly isSameProcessIncarnation?: SameProcessIncarnation;
  readonly lstatRoot?: (path: string) => Promise<unknown>;
  readonly onDiagnostic?: (message: string) => void;
  readonly mutationStep?: (step: OwnerPrivateLockMutationStep) => void | Promise<void>;
}

/** Internal maintenance only; never acquires ownership, creates roots or sweeps legacy records. */
export async function sweepAgentRootLeases(options: SweepOptions): Promise<void> {
  if (options.context !== "host") return;
  let diagnosed = false;
  const diagnose = (): void => {
    if (diagnosed) return;
    diagnosed = true;
    report(options);
  };
  try {
    const clock = options.monotonicNow ?? (() => performance.now());
    const deadline = clock() + Math.min(BUDGET_MS, Math.max(0, options.budgetMs ?? BUDGET_MS));
    const hasTime = (): boolean => clock() < deadline;
    if (!await hasUsableProcessNamespace(options) || !hasTime()) return;
    const now = options.now ?? Date.now;
    const index = options.randomIndex ?? randomInt;
    // Listing names is cheap; only the random sample gets owner reads/probes.
    // A prefix scan would be starved by permanently retained legacy records.
    const names = (await readdir(options.leaseRoot)).filter((name) => /^[a-f0-9]{64}\.lease$/u.test(name));
    for (let i = 0; i < Math.min(SAMPLE_LIMIT, names.length) && hasTime(); i += 1) {
      const selected = i + index(names.length - i);
      [names[i], names[selected]] = [names[selected]!, names[i]!];
      const digest = names[i]!.slice(0, -".lease".length);
      let root: string | undefined;
      const absent = async (): Promise<boolean> => {
        if (root === undefined || !hasTime()) return false;
        try { await (options.lstatRoot ?? lstat)(root); }
        catch (error) {
          // ENOTDIR and permission/sandbox denials are not proof of absence.
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return hasTime();
          throw error;
        }
        return false;
      };
      const policy = agentRootLeaseLockOptions(options.leaseRoot, digest);
      try {
        await reclaimOwnerPrivateLock({
          ...policy,
          mutationGate: { ...policy.mutationGate!, busyTimeoutMs: 0 },
          ...(options.mutationStep === undefined ? {} : { mutationStep: options.mutationStep }),
          // Use acquisition's actual predicate. A timed-out read-only probe is
          // uncertain/live; its late result has no authority to mutate anything.
          isSameProcessIncarnation: async (pid, incarnation) => {
            const remaining = deadline - clock();
            if (remaining <= 0) return true;
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                Promise.resolve().then(() => (options.isSameProcessIncarnation ?? isProcessIncarnationLive)(pid, incarnation)),
                new Promise<boolean>((done) => { timer = setTimeout(() => done(true), remaining); }),
              ]);
            } finally { if (timer !== undefined) clearTimeout(timer); }
          },
        }, {
          candidate: async (record) => {
            if (!hasTime() || typeof record.agentRoot !== "string" || record.agentRoot.length === 0) return false;
            root = resolve(record.agentRoot);
            if (agentRootDigest(root) !== digest) return false;
            // Check root existence before any liveness probe. The shared reader
            // has already validated the schema, rootDigest, owner and modes.
            if (!await absent()) return false;
            const createdAt = Date.parse(record.createdAt as string);
            return hasTime() && now() - createdAt >= MIN_AGE_MS;
          },
          // Inside the gate, after exact owner/directory revalidation and test
          // checkpoints, immediately before the shared quarantine rename.
          beforeRename: absent,
        });
      } catch (error) {
        if (!(error instanceof OwnerLockCoordinationBusyError)) diagnose();
      }
    }
  } catch { diagnose(); }
}

/** A separate factory keeps the process-global once flag testable without a production reset seam. */
export function createAgentRootLeaseSweepScheduler(
  sweep: (options: SweepOptions) => Promise<void> = sweepAgentRootLeases,
): (options: SweepOptions) => void {
  let scheduled = false;
  return (options) => {
    if (options.context !== "host" || scheduled) return;
    scheduled = true;
    setImmediate(() => { void Promise.resolve().then(() => sweep(options)).catch(() => report(options)); }).unref();
  };
}

export const scheduleAgentRootLeaseSweep = createAgentRootLeaseSweepScheduler();

function report(options: SweepOptions): void {
  try {
    if (options.onDiagnostic !== undefined) options.onDiagnostic(DIAGNOSTIC);
    else process.emitWarning(DIAGNOSTIC, "AgentRootLeaseSweepWarning");
  } catch { /* Best effort diagnostics must never affect acquisition or escape the sweep. */ }
}

/** A public app entrypoint may itself run inside a tool's PID/mount sandbox. */
async function hasUsableProcessNamespace(options: SweepOptions): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") return true;
  if (platform !== "linux") return false;
  try {
    return await (options.readNamespaceLink ?? readlink)("/proc/self/ns/pid") === INITIAL_PID_NAMESPACE;
  } catch { return false; } // Missing/unreadable procfs is not evidence of host PID visibility.
}
