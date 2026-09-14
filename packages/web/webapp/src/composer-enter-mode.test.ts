import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.resetModules(); });

describe.each([false, true])("Enter preference with touch-primary=%s", (touch) => {
  it.each(["send", "newline", null] as const)("resolves and remembers %s without a live device subscription", async (stored) => {
    const mode = await import("./composer-enter-mode");
    const media = { matches: touch };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    if (stored !== null) localStorage.setItem(mode.COMPOSER_ENTER_MODE_KEY, stored);
    const expected = stored ?? "newline";
    expect(mode.readComposerEnterMode()).toBe(expected);
    expect(localStorage.getItem(mode.COMPOSER_ENTER_MODE_KEY)).toBe(expected);
    media.matches = !touch;
    expect(mode.readComposerEnterMode()).toBe(expected);
    expect(window.matchMedia).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

it("keeps explicit changes when storage refuses writes", async () => {
  const mode = await import("./composer-enter-mode");
  localStorage.setItem(mode.COMPOSER_ENTER_MODE_KEY, "send");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  mode.writeComposerEnterMode("newline");
  expect(mode.readComposerEnterMode()).toBe("newline");
  expect(mode.composerEnterHint(mode.readComposerEnterMode(), "MacIntel")).toBe("⌘↵ to send · ↵ newline");
});


it.each([
  ["MacIntel", "⌘↵", "⌘⇧↵"],
  ["iPad", "⌘↵", "⌘⇧↵"],
  ["Win32", "Ctrl+↵", "Ctrl+Shift+↵"],
  ["Linux x86_64", "Ctrl+↵", "Ctrl+Shift+↵"],
])("describes sending and steering separately on %s", async (platform, send, steer) => {
  const mode = await import("./composer-enter-mode");
  expect(mode.defaultComposerEnterMode()).toBe("newline");
  expect(mode.composerEnterHint("newline", platform)).toBe(`${send} to send · ↵ newline`);
  expect(mode.composerEnterHint("send", platform)).toBe("↵ to send · ⇧↵ newline");
  expect(mode.composerSteerHint(platform)).toBe(`${steer} steer`);
});
