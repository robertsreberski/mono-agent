import { afterEach, describe, expect, it } from "vitest";
import { mobileHistoryEntry, ownedSettingsEntry, pushMobileHistoryEntry, routeWriteState } from "./mobile-history";
import { closeSettingsHistory, parseSettingsParam, pushSettingsEntries, stripSettingsParam } from "./settings-navigation";

describe("settings history ownership", () => {
  afterEach(() => { window.history.replaceState(null, "", "/"); });
  it("recognizes only a settings entry at its own absolute URL", () => {
    window.history.replaceState({ anotherOwner: 1 }, "", "/");
    pushSettingsEntries("providers");
    expect(ownedSettingsEntry()).toMatchObject({ surface: "settings", section: "providers", depth: 2, href: window.location.href });
    expect(window.history.state.anotherOwner).toBe(1);
    window.history.replaceState(window.history.state, "", "/other");
    expect(mobileHistoryEntry(window.history.state)).toBeNull();
    expect(ownedSettingsEntry()).toBeNull();
  });
  it("normalizes pushes to conversation markers and updates href on replace without losing other state", () => {
    window.history.replaceState({ other: { value: 1 } }, "", "/");
    pushMobileHistoryEntry({ version: 1, surface: "settings", section: "agent", depth: 2 });
    const replaced = routeWriteState(window.history.state, "/agents/atlas/cron/example", "replace") as Record<string, unknown>;
    expect(replaced.other).toEqual({ value: 1 });
    expect((replaced.monoAgentMobileNavigation as { href: string }).href).toBe(new URL("/agents/atlas/cron/example", window.location.href).href);
    const pushed = routeWriteState(window.history.state, "/agents/atlas/cron/example", "push") as Record<string, unknown>;
    expect(pushed.monoAgentMobileNavigation).toEqual({ version: 1, surface: "conversation", href: new URL("/agents/atlas/cron/example", window.location.href).href });
    expect(pushed.other).toEqual({ value: 1 });
  });
  it("closes only owned entries, and parses the legacy restart link", () => {
    expect(parseSettingsParam("http://localhost/?settings=restart")).toBe("agent");
    expect(stripSettingsParam("http://localhost/?thread=fictional&settings=providers")).toBe("http://localhost/?thread=fictional");
    window.history.replaceState(null, "", "/");
    pushSettingsEntries("agent");
    const go = window.history.go;
    const calls: number[] = [];
    window.history.go = ((count: number) => { calls.push(count); }) as typeof window.history.go;
    try {
      closeSettingsHistory();
      window.history.replaceState(window.history.state, "", "/other");
      closeSettingsHistory();
      expect(calls).toEqual([-2]);
    } finally { window.history.go = go; }
  });
});
