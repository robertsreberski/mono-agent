import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  DATA_MODE_STORAGE_KEY,
  LEAN_SUGGESTION_STORAGE_KEY,
  currentDataMode,
  cycleDataModeSetting,
  markLeanDataModeOffered,
  nextDataModeSetting,
  readDataModeSetting,
  resetDataModeSession,
  resolveDataMode,
  shouldOfferLeanDataMode,
  useDataMode,
  useDataModeSetting,
  writeDataModeSetting,
} from "./data-mode";

/**
 * jsdom implements no Network Information API at all, which is also what iOS
 * Safari ships — so the absent case is the one the console actually runs in.
 */
const withConnection = (value: unknown): void => {
  Object.defineProperty(navigator, "connection", { configurable: true, value });
};

const withStandalone = (standalone: boolean): void => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: standalone && query.includes("standalone"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
};

afterEach(() => {
  Reflect.deleteProperty(navigator, "connection");
  Reflect.deleteProperty(window, "matchMedia");
  localStorage.clear();
  writeDataModeSetting("auto");
});

describe("resolveDataMode", () => {
  it("lets an explicit choice win over whatever the browser reports", () => {
    expect(resolveDataMode("lean", { effectiveType: "4g" })).toBe("lean");
    expect(resolveDataMode("full", { saveData: true, effectiveType: "2g" })).toBe("full");
  });

  it("reads Auto off the connection when the browser describes one", () => {
    expect(resolveDataMode("auto", { saveData: true })).toBe("lean");
    expect(resolveDataMode("auto", { saveData: true, effectiveType: "4g" })).toBe("lean");
    expect(resolveDataMode("auto", { effectiveType: "slow-2g" })).toBe("lean");
    expect(resolveDataMode("auto", { effectiveType: "2g" })).toBe("lean");
    expect(resolveDataMode("auto", { effectiveType: "3g" })).toBe("lean");
    expect(resolveDataMode("auto", { effectiveType: "4g" })).toBe("full");
    expect(resolveDataMode("auto", { saveData: false })).toBe("full");
    expect(resolveDataMode("auto", {})).toBe("full");
  });

  it("resolves Auto to Full where there is nothing to read, and never pretends otherwise", () => {
    // iOS Safari — the phone this console is installed on — has no Network
    // Information API. Auto CANNOT know it is on cellular there, so it must not
    // guess: it stays Full, and the operator gets a visible toggle instead.
    expect(resolveDataMode("auto", undefined)).toBe("full");
  });
});

describe("the stored setting", () => {
  it("defaults to auto, round-trips, and refuses a value it did not write", () => {
    expect(readDataModeSetting()).toBe("auto");
    writeDataModeSetting("lean");
    expect(localStorage.getItem(DATA_MODE_STORAGE_KEY)).toBe("lean");
    expect(readDataModeSetting()).toBe("lean");
    localStorage.setItem(DATA_MODE_STORAGE_KEY, "cheap");
    expect(readDataModeSetting()).toBe("auto");
  });

  it("cycles Auto → Lean → Full → Auto", () => {
    expect(nextDataModeSetting("auto")).toBe("lean");
    expect(nextDataModeSetting("lean")).toBe("full");
    expect(nextDataModeSetting("full")).toBe("auto");
  });
});

describe("useDataMode", () => {
  it("publishes the resolved mode and survives a write from anywhere", () => {
    withConnection(undefined);
    const mode = renderHook(() => useDataMode());
    const setting = renderHook(() => useDataModeSetting());
    expect(mode.result.current).toBe("full");
    expect(setting.result.current).toBe("auto");

    act(() => { cycleDataModeSetting(); });

    expect(setting.result.current).toBe("lean");
    expect(mode.result.current).toBe("lean");
  });

  it("follows the connection where the browser reports changes", () => {
    const listeners = new Set<() => void>();
    const connection = {
      saveData: false,
      effectiveType: "4g",
      addEventListener: (_type: string, listener: () => void) => { listeners.add(listener); },
      removeEventListener: (_type: string, listener: () => void) => { listeners.delete(listener); },
    };
    withConnection(connection);
    const mode = renderHook(() => useDataMode());
    expect(mode.result.current).toBe("full");

    connection.effectiveType = "2g";
    act(() => { for (const listener of listeners) listener(); });

    expect(mode.result.current).toBe("lean");
    mode.unmount();
    expect(listeners.size).toBe(0);
  });
});

describe("the standalone-iOS suggestion", () => {
  it("is offered once to a home-screen install with no way to read the network", () => {
    withStandalone(true);
    withConnection(undefined);

    expect(shouldOfferLeanDataMode()).toBe(true);
    markLeanDataModeOffered();
    expect(localStorage.getItem(LEAN_SUGGESTION_STORAGE_KEY)).toBe("offered");
    expect(shouldOfferLeanDataMode()).toBe(false);
  });

  it("is never offered to a browser that can answer for itself, or to a chosen mode", () => {
    withStandalone(true);
    withConnection({ effectiveType: "4g" });
    expect(shouldOfferLeanDataMode()).toBe(false);

    withConnection(undefined);
    withStandalone(false);
    expect(shouldOfferLeanDataMode()).toBe(false);

    withStandalone(true);
    writeDataModeSetting("full");
    expect(shouldOfferLeanDataMode()).toBe(false);
  });
});

describe("a device that will not remember anything", () => {
  const denyStorage = (): (() => void) => {
    const setItem = localStorage.setItem.bind(localStorage);
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value: () => { throw new DOMException("QuotaExceededError"); },
    });
    return () => {
      Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value: setItem });
    };
  };

  afterEach(() => {
    resetDataModeSession();
    localStorage.clear();
  });

  it("still lets the operator change the mode for this session", () => {
    // Safari private browsing throws on the write, and the read then handed the
    // old value straight back: the control moved and nothing else did, on
    // exactly the kind of device this feature exists for.
    const restore = denyStorage();
    try {
      writeDataModeSetting("lean");
      expect(readDataModeSetting()).toBe("lean");
      expect(currentDataMode()).toBe("lean");
      writeDataModeSetting("full");
      expect(readDataModeSetting()).toBe("full");
    } finally {
      restore();
    }
  });

  it("still offers Lean only once", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("standalone"), media: query }),
    });
    const restore = denyStorage();
    try {
      expect(shouldOfferLeanDataMode()).toBe(true);
      markLeanDataModeOffered();
      expect(shouldOfferLeanDataMode()).toBe(false);
    } finally {
      restore();
      Reflect.deleteProperty(window, "matchMedia");
    }
  });

  it("keeps this session's answer over a stale value the device refused to replace", () => {
    // The stored value is the one the failed write was TRYING to overwrite, so
    // it is older than what the operator just said, not newer. It stops winning
    // only when something genuinely newer arrives.
    localStorage.setItem(DATA_MODE_STORAGE_KEY, "full");
    const restore = denyStorage();
    try {
      writeDataModeSetting("lean");
      expect(readDataModeSetting()).toBe("lean");
    } finally {
      restore();
    }

    // A write that lands clears the fallback, and the device is authoritative
    // again.
    writeDataModeSetting("auto");
    expect(readDataModeSetting()).toBe("auto");
  });

  it("gives way to another tab that really wrote the setting", () => {
    // A `storage` event is a different document saying something newer, which
    // this session's fallback -- a write this device refused -- is not.
    const view = renderHook(() => useDataModeSetting());
    const restore = denyStorage();
    try {
      act(() => { writeDataModeSetting("lean"); });
      expect(view.result.current).toBe("lean");
    } finally {
      restore();
    }

    localStorage.setItem(DATA_MODE_STORAGE_KEY, "full");
    act(() => { window.dispatchEvent(new StorageEvent("storage")); });

    expect(view.result.current).toBe("full");
    expect(readDataModeSetting()).toBe("full");
    view.unmount();
  });
});
