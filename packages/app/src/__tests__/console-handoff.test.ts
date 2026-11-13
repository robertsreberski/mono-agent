import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { consoleHandoffUrl, existingConsoleHandoff, offerConsoleHandoff, startManagedConsoleHandoff, type ConsoleHandoffChoice } from "../setup/console-handoff.js";

const options = { sourceId: "fictional-agent", agentReady: true, env: { DISPLAY: ":0" } };
describe("guided init console handoff", () => {
  it.each(["darwin", "linux", "win32"] as const)("does nothing without explicit consent on %s", async (platform) => {
    const events: string[] = [];
    const managed = vi.fn(); const foreground = vi.fn(); const open = vi.fn();
    await offerConsoleHandoff(options, {
      existing: async () => undefined, platform, hasUserManager: async () => true,
      write: (text) => events.push(text), choose: async (choices) => {
        expect(choices[0]).toBe("later");
        expect(events.join("")).toContain("there is no login");
        expect(events.join("")).toContain("proxy, tunnel or Serve");
        return "later";
      }, managed, foreground, open,
    });
    expect(managed).not.toHaveBeenCalled(); expect(foreground).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it.each([
    ["darwin", false, ["later", "managed", "foreground"]],
    ["linux", true, ["later", "managed", "foreground"]],
    ["linux", false, ["later", "foreground"]],
    ["win32", true, ["later", "foreground"]],
  ] as const)("offers platform-supported choices on %s with manager=%s", async (platform, manager, expected) => {
    await offerConsoleHandoff({ ...options, agentReady: false }, {
      existing: async () => undefined, platform, hasUserManager: async () => manager, write: vi.fn(),
      choose: async (choices) => { expect(choices).toEqual(expected); return "later"; },
    });
  });
  it.each(["managed", "foreground"] as const)("reuses a verified existing console before %s without launch/rebind", async (choice) => {
    const actions: string[] = [];
    const managed = vi.fn(); const foreground = vi.fn(); const open = vi.fn();
    await offerConsoleHandoff(options, {
      platform: "darwin", choose: async () => choice, write: vi.fn(),
      existing: () => existingConsoleHandoff({}, async (args, deps) => {
        actions.push(args.positionals[0]!);
        deps?.stdout?.write(JSON.stringify({ listener: { provenRunning: true, url: "http://127.0.0.1:6060/", source: "verified live listener" } }));
        return 0;
      }), managed, foreground, health: async () => true, open,
    });
    expect(actions).toEqual(["status"]);
    expect(managed).not.toHaveBeenCalled(); expect(foreground).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:6060/?agent=fictional-agent&settings=capabilities");
  });
  it.each([["Enter", "\r"], ["Ctrl-D", "\x04"], ["EOF", "end"]])("real Clack prompt maps %s to Not now", async (_label, key) => {
    const input = new PassThrough();
    let outputText = ""; let sent = false;
    const output = new Writable({ write(chunk, _encoding, callback) {
      outputText += String(chunk);
      if (!sent && outputText.includes("Open the browser console?")) {
        sent = true; queueMicrotask(() => key === "end" ? input.end() : input.write(key));
      }
      callback();
    } });
    const existing = vi.fn(); const managed = vi.fn(); const foreground = vi.fn(); const open = vi.fn();
    try {
      await offerConsoleHandoff(options, { platform: "darwin", write: vi.fn(), promptIO: { input, output }, existing, managed, foreground, open });
      expect(outputText).toContain("Not now");
      expect(existing).not.toHaveBeenCalled(); expect(managed).not.toHaveBeenCalled();
      expect(foreground).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    } finally { input.destroy(); output.destroy(); }
  });
  it("opens only after health and deep-links by identity", async () => {
    const events: string[] = [];
    await offerConsoleHandoff(options, {
      existing: async () => undefined, platform: "darwin", choose: async () => "managed", write: () => {},
      managed: async () => { events.push("start"); return "http://127.0.0.1:5050/"; },
      health: async (url) => { expect(url).toBe("http://127.0.0.1:5050/healthz"); events.push("health"); return true; },
      open: async (url) => { expect(new URL(url).searchParams.get("agent")).toBe(options.sourceId); expect(url).toContain("settings=capabilities"); events.push("open"); },
    });
    expect(events).toEqual(["start", "health", "open"]);
  });
  it.each(["headless", "ssh", "open-failure", "unhealthy"] as const)("prints a usable fallback for %s", async (kind) => {
    const write = vi.fn();
    const open = vi.fn(async () => { if (kind === "open-failure") throw new Error("untrusted failure"); });
    await offerConsoleHandoff({ ...options, agentReady: false, env: kind === "ssh" ? { SSH_CONNECTION: "synthetic" } : kind === "headless" ? {} : { DISPLAY: ":0" } }, {
      existing: async () => undefined, platform: "linux", hasUserManager: async () => false,
      choose: async () => "foreground", write,
      foreground: async (ready) => { await ready("http://127.0.0.1:5050/"); },
      health: async () => kind !== "unhealthy", open,
    });
    const output = write.mock.calls.flat().join("");
    expect(output).toContain("mono-agent start");
    expect(output).toContain("agent=fictional-agent");
    if (kind !== "unhealthy") expect(output).toContain("ssh -N -L");
    if (kind === "unhealthy" || kind === "ssh" || kind === "headless") expect(open).not.toHaveBeenCalled();
    expect(output).not.toContain("untrusted failure");
  });
  it("never restarts or changes an existing managed listener, including a stopped definition", async () => {
    for (const running of [true, false]) {
      const actions: string[] = [];
      const result = await startManagedConsoleHandoff({}, async (options, deps) => {
        actions.push(options.positionals[0]!);
        deps?.stdout?.write(JSON.stringify({ listener: { url: "http://127.0.0.1:6060/", source: "installed unit", provenRunning: running } }));
        return running ? 0 : 1;
      });
      expect(actions).toEqual(["status"]);
      expect(result).toBe(running ? "http://127.0.0.1:6060/" : undefined);
    }
  });
  it("does not repair or recreate a recorded sharing route during fresh managed handoff", async () => {
    const actions: string[] = [];
    expect(await startManagedConsoleHandoff({}, async (options, deps) => {
      actions.push(options.positionals[0]!);
      deps?.stdout?.write(JSON.stringify({ listener: { source: "fresh default", provenRunning: false }, ownedTailscaleRoute: { state: "missing" } }));
      return 1;
    })).toBeUndefined();
    expect(actions).toEqual(["status"]);
  });
  it("starts only a fresh loopback managed console and rechecks its identity", async () => {
    const actions: string[] = [];
    const result = await startManagedConsoleHandoff({}, async (options, deps) => {
      actions.push(options.positionals[0]!);
      if (options.positionals[0] === "start") expect(options.loopback).toBe(true);
      else deps?.stdout?.write(JSON.stringify({ ownedTailscaleRoute: { state: "none" }, listener: { url: "http://127.0.0.1:5050/", source: actions.length === 1 ? "fresh default" : "installed unit", provenRunning: actions.length > 1 } }));
      return 0;
    });
    expect(actions).toEqual(["status", "start", "status"]);
    expect(result).toBe("http://127.0.0.1:5050/");
  });
  it("preserves readiness on launch failure and rejects an unavailable managed choice", async () => {
    const write = vi.fn(); const managed = vi.fn(async (): Promise<string> => { throw new Error("private detail"); });
    await offerConsoleHandoff(options, { existing: async () => undefined, platform: "darwin", choose: async () => "managed", managed, write });
    expect(write.mock.calls.flat().join("")).toContain("readiness is unchanged");
    managed.mockClear();
    await offerConsoleHandoff(options, { existing: async () => undefined, platform: "win32", choose: async () => "managed" as ConsoleHandoffChoice, managed, write });
    expect(managed).not.toHaveBeenCalled();
    expect(consoleHandoffUrl("http://127.0.0.1:5050/", "garden & studio")).toContain("agent=garden+%26+studio");
  });
});
