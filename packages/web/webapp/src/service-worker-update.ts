import { useSyncExternalStore } from "react";

/**
 * A new build of the console, staged and waiting for a moment that is not now.
 *
 * The service worker used to register with `autoUpdate`: the moment a deploy
 * landed, Workbox took the waiting worker, claimed the clients and reloaded the
 * page. On the phone this console is installed on, that is a reload in the
 * middle of whatever the operator was reading -- and if a turn was streaming,
 * the transcript on screen went with it.
 *
 * `prompt` mode stages the build and says nothing. Applying it is a decision
 * this module does not make on its own: it reports that one is waiting, and
 * `App` applies it when the document has just come back to the foreground with
 * nothing running, or when the operator taps the toast. The bytes are already
 * downloaded either way, so waiting costs nothing but the wait.
 */
export type ServiceWorkerUpdateApplier = (reloadPage?: boolean) => Promise<void>;

/** Exactly the shape of `registerSW` from `virtual:pwa-register`. */
export type ServiceWorkerRegistrar = (options: {
  readonly immediate?: boolean;
  readonly onNeedRefresh?: () => void;
}) => ServiceWorkerUpdateApplier;

let stagedApplier: ServiceWorkerUpdateApplier | undefined;
let waiting = false;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/**
 * Register the worker and hold on to what applies a staged build.
 *
 * `immediate: true` so the worker is registered without waiting for `load`:
 * the console is a single-page shell and the registration is what makes the
 * next cold start free. A browser that refuses service workers outright throws
 * here, and a console that cannot cache its shell still works -- so the failure
 * is contained rather than allowed to take the app entry point down with it.
 */
export const registerServiceWorkerUpdates = (register: ServiceWorkerRegistrar): void => {
  try {
    stagedApplier = register({
      immediate: true,
      onNeedRefresh: () => {
        // One staged build is one piece of news, however many times the worker
        // repeats it: a second notification would re-render every subscriber
        // for nothing.
        if (waiting) return;
        waiting = true;
        notify();
      },
    });
  } catch (registerError) {
    // One line, once -- the same treatment the device store gives a browser
    // that will not keep anything. Nothing about the console needs the worker.
    console.debug(`[mono-agent] service worker registration refused: ${String(registerError)}`);
  }
};

/** Whether a new build is downloaded and waiting to take over. */
export const serviceWorkerUpdateWaiting = (): boolean => waiting;

export const subscribeToServiceWorkerUpdate = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/**
 * Take the staged build. This reloads the page, so every caller is a place that
 * has decided the operator will not lose anything by it.
 */
export const applyServiceWorkerUpdate = (): void => {
  if (!waiting) return;
  waiting = false;
  notify();
  const apply = stagedApplier;
  if (apply === undefined) return;
  void apply(true).catch(() => {
    // The build is STILL staged: nothing about a failed hand-over unstages it,
    // and the page carries on perfectly well on the build it has. Withdrawing
    // the notice as well would leave the operator with a console that had
    // silently stopped offering an update it is still holding, so it comes
    // back and they can ask again.
    if (waiting) return;
    waiting = true;
    notify();
  });
};

export const useServiceWorkerUpdateWaiting = (): boolean =>
  useSyncExternalStore(subscribeToServiceWorkerUpdate, serviceWorkerUpdateWaiting, () => false);

/** Test hook: the module owns document-lifetime state by design. */
export const resetServiceWorkerUpdates = (): void => {
  stagedApplier = undefined;
  waiting = false;
  listeners.clear();
};
