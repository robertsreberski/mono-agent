import type { TuiRestartAuthority, TuiRestartSupport } from "@mono-agent/operator-adapter";
import { createSupervisedRestartLatch, type SupervisedRestartLatch } from "./supervised-restart-latch.js";
import { verifySupervisedRestart, type SupervisedRestartDeps } from "./supervised-restart.js";

const INSPECTION_TIMEOUT_MS = 1_000;
const CAPABILITY_TTL_MS = 30_000;
const TIMED_OUT: TuiRestartSupport = { supported: false, reason: "Supervisor verification timed out." };
const PENDING: TuiRestartSupport = { supported: false, reason: "Supervisor verification is pending." };

/** Supervision probes are bounded; a hung inspector cannot make agent info or web turns appear dead. */
export function createSupervisedRestartAuthority(
  deps: SupervisedRestartDeps,
  latch: SupervisedRestartLatch = createSupervisedRestartLatch(),
): TuiRestartAuthority {
  let cached: { readonly verdict: TuiRestartSupport; readonly expiresAt: number } | undefined;
  let background: Promise<void> | undefined;
  let revision = 0;
  const freshTokens = new WeakMap<TuiRestartSupport, number>();

  const inspect = async (): Promise<TuiRestartSupport> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<TuiRestartSupport>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), INSPECTION_TIMEOUT_MS);
      timer.unref();
    });
    try {
      return await Promise.race([
        verifySupervisedRestart(deps).catch(() => ({ supported: false, reason: "Supervisor verification failed." })),
        timedOut,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const refresh = (): void => {
    if (background !== undefined) return;
    const ticket = ++revision;
    background = inspect().then((verdict) => {
      if (ticket === revision) cached = { verdict, expiresAt: Date.now() + CAPABILITY_TTL_MS };
    }).finally(() => { background = undefined; });
  };
  // Start checking immediately, without making startup or /v1/info await it.
  refresh();
  return {
    async verify() {
      // Stale-while-revalidate: an expired verdict is still served while one
      // bounded refresh runs, so the advertised capability does not flip to
      // "pending" every TTL. Only a worker that has never finished an
      // inspection reports pending. Acceptance never relies on this path;
      // POST uses verifyFresh().
      if (cached === undefined || cached.expiresAt <= Date.now()) refresh();
      return cached?.verdict ?? PENDING;
    },
    async verifyFresh() {
      const ticket = ++revision;
      const verdict = { ...await inspect() };
      if (ticket === revision) cached = { verdict, expiresAt: Date.now() + CAPABILITY_TTL_MS };
      freshTokens.set(verdict, Date.now() + INSPECTION_TIMEOUT_MS);
      return verdict;
    },
    accept(verified) {
      // A committed operation always wins, even when another independent POST
      // completed a fresher inspection or the relaunch policy changed later.
      const conflict = latch.accept({ supported: false });
      if (conflict.kind === "conflict") return conflict;
      if (verified.supported !== true) {
        return { kind: "refused", reason: verified.reason ?? "Supervisor verification failed." };
      }
      const expiresAt = freshTokens.get(verified);
      if (expiresAt === undefined || expiresAt < Date.now()) {
        return { kind: "refused", reason: "Supervisor verification is no longer current." };
      }
      freshTokens.delete(verified);
      return latch.accept(verified);
    },
    processIdentity: () => ({ pid: deps.pid ?? process.pid, startedAt: deps.startedAt }),
    beginStop: (operationId) => latch.beginStop(operationId),
  };
}
