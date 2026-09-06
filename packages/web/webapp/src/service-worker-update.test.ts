import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyServiceWorkerUpdate,
  registerServiceWorkerUpdates,
  resetServiceWorkerUpdates,
  serviceWorkerUpdateWaiting,
  subscribeToServiceWorkerUpdate,
} from "./service-worker-update";

afterEach(() => {
  resetServiceWorkerUpdates();
});

describe("service worker updates", () => {
  it("registers immediately and waits to be told a new build is ready", () => {
    const apply = vi.fn(async () => undefined);
    const register = vi.fn(() => apply);

    registerServiceWorkerUpdates(register);

    expect(register).toHaveBeenCalledWith(expect.objectContaining({ immediate: true }));
    expect(serviceWorkerUpdateWaiting()).toBe(false);
    expect(apply).not.toHaveBeenCalled();
  });

  it("never applies a build on its own", () => {
    const apply = vi.fn(async () => undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeToServiceWorkerUpdate(listener);
    let needRefresh = (): void => undefined;
    registerServiceWorkerUpdates((options) => {
      needRefresh = options.onNeedRefresh ?? needRefresh;
      return apply;
    });

    needRefresh();

    expect(serviceWorkerUpdateWaiting()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // The whole point of `prompt`: the new shell is downloaded and staged, and
    // nothing takes the page from under the operator until something asks.
    expect(apply).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("applies the staged build once, and tells its subscribers it is gone", () => {
    const apply = vi.fn(async () => undefined);
    const listener = vi.fn();
    let needRefresh = (): void => undefined;
    registerServiceWorkerUpdates((options) => {
      needRefresh = options.onNeedRefresh ?? needRefresh;
      return apply;
    });
    needRefresh();
    const unsubscribe = subscribeToServiceWorkerUpdate(listener);

    applyServiceWorkerUpdate();
    applyServiceWorkerUpdate();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(true);
    expect(serviceWorkerUpdateWaiting()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("offers the build again when the hand-over is refused", async () => {
    // A refused `updateSW` does not unstage anything -- the new worker is still
    // waiting -- so withdrawing the notice would leave the operator holding an
    // update the console had quietly stopped mentioning.
    const apply = vi.fn(async () => { throw new Error("The worker refused to activate."); });
    const listener = vi.fn();
    let needRefresh = (): void => undefined;
    registerServiceWorkerUpdates((options) => {
      needRefresh = options.onNeedRefresh ?? needRefresh;
      return apply;
    });
    needRefresh();
    const unsubscribe = subscribeToServiceWorkerUpdate(listener);

    applyServiceWorkerUpdate();
    expect(serviceWorkerUpdateWaiting()).toBe(false);

    await Promise.resolve();
    await Promise.resolve();

    expect(serviceWorkerUpdateWaiting()).toBe(true);
    // Withdrawn, then offered again: both are news.
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does nothing at all when no build is staged", () => {
    const apply = vi.fn(async () => undefined);
    registerServiceWorkerUpdates(() => apply);

    applyServiceWorkerUpdate();

    expect(apply).not.toHaveBeenCalled();
  });

  it("survives a registration this browser refuses", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    expect(() => {
      registerServiceWorkerUpdates(() => {
        throw new Error("Service workers are unavailable.");
      });
    }).not.toThrow();
    expect(serviceWorkerUpdateWaiting()).toBe(false);
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it("counts one staged build once, however often the worker says so", () => {
    const apply = vi.fn(async () => undefined);
    const listener = vi.fn();
    const unsubscribe = subscribeToServiceWorkerUpdate(listener);
    let needRefresh = (): void => undefined;
    registerServiceWorkerUpdates((options) => {
      needRefresh = options.onNeedRefresh ?? needRefresh;
      return apply;
    });

    needRefresh();
    needRefresh();

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
