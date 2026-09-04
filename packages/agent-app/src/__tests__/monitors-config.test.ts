import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadMonitorsSettings,
  MONITORS_CAPS,
  MONITORS_DEFAULTS,
  parseMonitorsSettings,
} from "../monitors-config.js";

const dirs: string[] = [];

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function configFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mono-monitors-config-"));
  dirs.push(dir);
  const path = join(dir, "mono-agent.config.json");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("monitors config", () => {
  it("is disabled and unconfigured when the block is absent", () => {
    const settings = parseMonitorsSettings({});
    expect(settings.configured).toBe(false);
    expect(settings.enabled).toBe(false);
    expect(settings.maxActive).toBe(MONITORS_DEFAULTS.maxActive);
    expect(settings.rateLimit).toEqual(MONITORS_DEFAULTS.rateLimit);
  });

  it("accepts a narrowed block and reports it as configured", () => {
    const settings = parseMonitorsSettings({
      monitors: {
        enabled: true,
        maxActivePerConversation: 3,
        persistentMaxRuntimeMs: 43_200_000,
        rateLimit: { maxLinesPerWindow: 50 },
      },
    });
    expect(settings).toMatchObject({
      configured: true,
      enabled: true,
      maxActivePerConversation: 3,
      persistentMaxRuntimeMs: 43_200_000,
    });
    expect(settings.rateLimit).toEqual({
      windowMs: MONITORS_DEFAULTS.rateLimit.windowMs,
      maxLinesPerWindow: 50,
      sustainedWindows: MONITORS_DEFAULTS.rateLimit.sustainedWindows,
    });
  });

  it("fails closed on unknown keys at both levels", () => {
    expect(() => parseMonitorsSettings({ monitors: { enable: true } })).toThrow(/unknown key: enable/u);
    expect(() => parseMonitorsSettings({ monitors: { rateLimit: { perMinute: 5 } } }))
      .toThrow(/unknown key: perMinute/u);
  });

  it("rejects a value above its compiled cap or below one", () => {
    expect(() => parseMonitorsSettings({ monitors: { maxActive: MONITORS_CAPS.maxActive + 1 } }))
      .toThrow(/cannot exceed 32/u);
    expect(() => parseMonitorsSettings({ monitors: { maxActive: 0 } })).toThrow(/positive safe integer/u);
    expect(() => parseMonitorsSettings({ monitors: { coalesceMs: 1.5 } })).toThrow(/positive safe integer/u);
    expect(() => parseMonitorsSettings({ monitors: { enabled: "yes" } })).toThrow(/must be a boolean/u);
    expect(() => parseMonitorsSettings({ monitors: [] })).toThrow(/must be an object/u);
  });

  it("caps a timed monitor at one hour and a persistent one at a day", () => {
    expect(MONITORS_CAPS.maxRuntimeMs).toBe(60 * 60 * 1_000);
    expect(MONITORS_CAPS.persistentMaxRuntimeMs).toBe(24 * 60 * 60 * 1_000);
    expect(() => parseMonitorsSettings({ monitors: { maxRuntimeMs: 3_600_001 } })).toThrow(/cannot exceed/u);
    expect(() => parseMonitorsSettings({ monitors: { persistentMaxRuntimeMs: 86_400_001 } }))
      .toThrow(/cannot exceed/u);
  });

  it("loads from disk and stays disabled for an unreadable config", async () => {
    const path = await configFile(JSON.stringify({ monitors: { enabled: true, maxActive: 5 } }));
    expect(await loadMonitorsSettings({ configPath: path })).toMatchObject({ enabled: true, maxActive: 5 });

    const broken = await configFile("{ not json");
    expect(await loadMonitorsSettings({ configPath: broken })).toMatchObject({ configured: false, enabled: false });
  });
});
