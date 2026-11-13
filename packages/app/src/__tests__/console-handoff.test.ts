import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { consoleHandoffUrl, existingConsoleHandoff, offerConsoleHandoff, startManagedConsoleHandoff, type ConsoleHandoffChoice } from "../setup/console-handoff.js";

const options = { sourceId: "fictional-agent", agentReady: true, env: { DISPLAY: ":0" } };
describe("guided init console handoff", () => {
  it.each(["darwin", "linux", "win32"] as const)("does nothing without explicit consent on %s", async (platform) => {
    const events: string[] = [];
    const managed = vi.fn(); const foreground = vi.fn(); const open = vi.fn();
    const choose = vi.fn(async (choices: readonly ConsoleHandoffChoice[]) => {
      expect(choices[0]).toBe("later");
      expect(events.join("")).toContain("there is no login");
      expect(events.join("")).toContain("proxy, tunnel or Serve");
      return "later" as const;
    });
    await offerConsoleHandoff(options, {
      existing: async () => undefined, platform, hasUserManager: async () => true,
      write: (text) => events.push(text), choose, managed, foreground, open,
    });
    expect(choose).toHaveBeenCalledTimes(1);
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
  it.each([
    ["127.0.0.1", "exact", "https://garden-console.example.test/", true],
    ["0.0.0.0", "none", undefined, true],
    ["192.0.2.20", "none", undefined, false],
  ] as const)("warns on reused listener %s / route %s and forwards through loopback when available", async (host, state, routeUrl, forwards) => {
    const write = vi.fn(); const foreground = vi.fn(); const managed = vi.fn();
    const url = `http://${host}:6060/`;
    await offerConsoleHandoff({ ...options, env: { SSH_CONNECTION: "fictional" } }, {
      platform: "darwin", choose: async () => "foreground", write, foreground, managed,
      existing: () => existingConsoleHandoff({}, async (_args, deps) => {
        deps?.stdout?.write(JSON.stringify({ listener: { provenRunning: true, url, host }, ownedTailscaleRoute: { state, url: routeUrl } }));
        return 0;
      }), health: async () => true, open: vi.fn(),
    });
    const output = write.mock.calls.flat().join("");
    expect(output).toContain("This existing console is reachable beyond this computer");
    expect(output).toContain(host);
    if (routeUrl) { expect(output).toContain(routeUrl); expect(output).toContain("state exact"); }
    expect(output.includes("ssh -N -L")).toBe(forwards);
    expect(foreground).not.toHaveBeenCalled(); expect(managed).not.toHaveBeenCalled();
  });
  it.each([["0.0.0.0", "127.0.0.1"], ["::", "[::1]"]])("opens wildcard bind %s through loopback %s without hiding exposure", async (host, destination) => {
    const write = vi.fn(); const open = vi.fn();
    const health = vi.fn(async () => true);
    await offerConsoleHandoff(options, {
      platform: "darwin", choose: async () => "foreground", write, health, open,
      existing: async () => ({ host, url: `http://${host === "::" ? "[::]" : host}:6060/` }),
    });
    expect(health).toHaveBeenCalledWith(`http://${destination}:6060/healthz`);
    expect(open).toHaveBeenCalledWith(`http://${destination}:6060/?agent=fictional-agent&settings=capabilities`);
    expect(write.mock.calls.flat().join("")).toContain(`listener "${host}"`);
    expect(write.mock.calls.flat().join("")).toContain("reachable beyond this computer");
  });
  it.each([["0.0.0.0", "127.0.0.1"], ["::", "[::1]"]])("offers a loopback SSH hint for headless wildcard %s without hiding exposure", async (host, destination) => {
    const write = vi.fn(); const open = vi.fn();
    await offerConsoleHandoff({ ...options, env: { SSH_CONNECTION: "fictional" } }, {
      platform: "darwin", choose: async () => "foreground", write, health: async () => true, open,
      existing: async () => ({ host, url: `http://${host === "::" ? "[::]" : host}:6060/` }),
    });
    const output = write.mock.calls.flat().join("");
    expect(output).toContain(`ssh -N -L 6060:${destination}:6060`);
    expect(output).toContain(`listener "${host}"`);
    expect(output).toContain("reachable beyond this computer");
    expect(open).not.toHaveBeenCalled();
  });
  it.each([["Enter", "\r", false], ["Ctrl-D", "\x04", false], ["EOF", "end", false], ["Ctrl-D on TTY", "\x04", true], ["EOF on TTY", "end", true]] as const)("real Clack prompt maps %s to Not now", async (_label, key, tty) => {
    const setRawMode = vi.fn();
    const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode });
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
      if (tty) {
        // @clack/core 1.4.3 Prompt.close/cancel restore raw mode on abort.
        expect(setRawMode).toHaveBeenCalledWith(true);
        expect(setRawMode).toHaveBeenLastCalledWith(false);
      }
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
      expect(result).toEqual(running ? { url: "http://127.0.0.1:6060/", host: "127.0.0.1" } : undefined);
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
    expect(result).toEqual({ url: "http://127.0.0.1:5050/", host: "127.0.0.1", routeState: "none" });
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
