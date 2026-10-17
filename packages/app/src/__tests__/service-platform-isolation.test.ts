import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as string[]);
vi.mock("../service/systemd/systemd-command.js", () => {
  events.push("load:systemd-command");
  return {
    runSystemdWebCommand: async () => {
      events.push("run:systemd-web");
      return 0;
    },
  };
});
vi.mock("../service/systemd/systemd.js", () => {
  events.push("load:systemd");
  return { isSystemdUserManagerUnavailable: () => false };
});

let home: string;
beforeEach(async () => {
  vi.resetModules();
  events.length = 0;
  home = await mkdtemp(join(tmpdir(), "mono-service-isolation-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const forbiddenEffects = () => ({
  launchctl: async () => { events.push("launchctl"); throw new Error("unexpected launchctl"); },
  tailscale: async () => { events.push("tailscale"); throw new Error("unexpected tailscale"); },
  ensureManagedRuntime: async () => { events.push("runtime"); throw new Error("unexpected runtime preparation"); },
  startServer: async () => { events.push("server"); throw new Error("unexpected server start"); },
  prepareState: async () => { events.push("prepare"); },
  resetState: async () => { events.push("reset"); },
  writePrivateFile: async () => { events.push("write"); },
  stdout: { write: (_text: string) => {} },
  stderr: { write: (_text: string) => {} },
});

describe("web platform import and effect isolation", () => {
  it.each(["darwin", "linux"] as const)("validates grammar before loading platform code on %s", async (platform) => {
    const { runWebCommand } = await import("../cli/commands/web-command.js");
    expect(events).toEqual([]);
    expect(await runWebCommand({ positionals: ["unknown"], env: {} }, {
      ...forbiddenEffects(), platform, homeDir: home,
    })).toBe(2);
    expect(events).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it("rejects Linux tailnet sharing before loading either platform implementation", async () => {
    const { runWebCommand } = await import("../cli/commands/web-command.js");
    expect(await runWebCommand({ positionals: ["start"], env: {}, shareTailnet: true }, {
      ...forbiddenEffects(), platform: "linux", homeDir: home,
    })).toBe(2);
    expect(events).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it("loads Linux owners only when dispatching, without launchd, Tailscale or publication effects", async () => {
    const { runWebCommand } = await import("../cli/commands/web-command.js");
    expect(events).toEqual([]);
    expect(await runWebCommand({ positionals: ["status"], env: {} }, {
      ...forbiddenEffects(), platform: "linux", homeDir: home,
    })).toBe(0);
    expect(events).toEqual(["load:systemd-command", "load:systemd", "run:systemd-web"]);
    expect(await readdir(home)).toEqual([]);
  });

  it("keeps Darwin status read-only and never loads Linux owners or changes services", async () => {
    const { runWebCommand } = await import("../cli/commands/web-command.js");
    expect(events).toEqual([]);
    expect(await runWebCommand({ positionals: ["status"], env: {} }, {
      ...forbiddenEffects(), platform: "darwin", homeDir: home, getuid: () => 501,
      launchctl: async (args) => {
        events.push(`launchctl:${args.join(" ")}`);
        return { code: 1, stdout: "", stderr: "not loaded" };
      },
      healthcheck: async () => { events.push("health"); return false; },
    })).toBe(1);
    expect(events).toEqual([
      "launchctl:print gui/501/com.mono-agent-web",
      "launchctl:print gui/501/com.mono-agent-web-maintenance",
    ]);
    expect(await readdir(home)).toEqual([]);
  });
});
