import type { TuiRestartAuthority, TuiRestartSupport } from "@mono-agent/operator-adapter";
import { createSupervisedRestartLatch, type SupervisedRestartLatch } from "./supervised-restart-latch.js";
import { verifySupervisedRestart, type PreparedSupervisedRestartInputs, type SupervisedRestartDeps } from "./supervised-restart.js";

const INSPECTION_TIMEOUT_MS = 1_000;
const CAPABILITY_TTL_MS = 30_000;
const INPUT_TIMEOUT_MS = 5_000;
const INPUT_REFUSAL = "Startup input validation failed. Run `mono-agent validate` from its folder.";
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
  const freshTokens = new WeakMap<TuiRestartSupport, { expiresAt: number; prepared?: PreparedSupervisedRestartInputs; timer: ReturnType<typeof setTimeout> }>();
  let fresh: Promise<TuiRestartSupport> | undefined;

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
    verifyFresh() {
      if (fresh !== undefined) return fresh;
      fresh = (async () => {
        const ticket = ++revision;
        let verdict = { ...await inspect() };
        let prepared: PreparedSupervisedRestartInputs | undefined;
        if (verdict.supported && (deps.prepareStartupInputs !== undefined || deps.verifyStartupInputs !== undefined)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const controller = new AbortController();
          const preparation = (async () => {
            const result = deps.prepareStartupInputs === undefined
              ? { ...await deps.verifyStartupInputs!(), dispose: async () => undefined }
              : await deps.prepareStartupInputs(controller.signal);
            if (controller.signal.aborted) {
              await result.dispose().catch(() => undefined);
              return { supported: false, reason: "Startup input validation timed out." };
            }
            prepared = result;
            return { supported: result.supported, ...(result.reason === undefined ? {} : { reason: result.reason }) };
          })().catch(() => ({ supported: false, reason: INPUT_REFUSAL }));
          try {
            verdict = { ...await Promise.race([
              preparation,
              new Promise<TuiRestartSupport>((resolve) => {
                timer = setTimeout(() => {
                  controller.abort();
                  resolve({ supported: false, reason: "Startup input validation timed out. The old worker is still serving." });
                }, INPUT_TIMEOUT_MS);
                timer.unref();
              }),
            ]) };
          } finally { if (timer !== undefined) clearTimeout(timer); }
        }
        if (ticket === revision) cached = { verdict: { ...verdict }, expiresAt: Date.now() + CAPABILITY_TTL_MS };
        const timer = setTimeout(() => {
          freshTokens.delete(verdict);
          void prepared?.dispose().catch(() => undefined);
        }, INSPECTION_TIMEOUT_MS);
        timer.unref();
        freshTokens.set(verdict, { expiresAt: Date.now() + INSPECTION_TIMEOUT_MS, timer,
          ...(prepared === undefined ? {} : { prepared }) });
        return verdict;
      })().finally(() => { fresh = undefined; });
      return fresh;
    },
    accept(verified) {
      // A committed operation always wins, even when another independent POST
      // completed a fresher inspection or the relaunch policy changed later.
      const conflict = latch.accept({ supported: false });
      if (conflict.kind === "conflict") return conflict;
      if (verified.supported !== true) {
        return { kind: "refused", reason: verified.reason ?? "Supervisor verification failed." };
      }
      const token = freshTokens.get(verified);
      if (token === undefined || token.expiresAt < Date.now()) {
        return { kind: "refused", reason: "Supervisor verification is no longer current." };
      }
      freshTokens.delete(verified);
      clearTimeout(token.timer);
      const result = latch.accept(verified, token.prepared?.publish);
      void token.prepared?.dispose().catch(() => undefined);
      return result;
    },
    processIdentity: () => ({ pid: deps.pid ?? process.pid, startedAt: deps.startedAt }),
    beginStop: (operationId) => latch.beginStop(operationId),
  };
}
