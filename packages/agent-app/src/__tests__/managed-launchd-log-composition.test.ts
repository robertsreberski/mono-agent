import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedLaunchdLogMonitorDependencies } from "../background-log-maintenance.js";
import { startManagedBackgroundLogMonitorForConfig } from "../cli-background-command.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("managed launchd log driver composition", () => {
  it("keeps the executable graph light and delays before the per-agent gate and heavy controller", async () => {
    const entryPath = fileURLToPath(new URL("../launchd-maintenance-entry.ts", import.meta.url));
    const graph = await staticRuntimeGraph(entryPath);
    const names = [...graph].map((path) => path.slice(path.lastIndexOf("/") + 1));
    expect(names).not.toEqual(expect.arrayContaining([
      "cli-background-command.ts",
      "background.ts",
      "background-runtime.ts",
      "background-snapshot.ts",
      "app.ts",
      "app-controller.ts",
      "app-config.ts",
      "doctor.ts",
    ]));

    const source = await readFile(entryPath, "utf8");
    expect(source).toContain('loadHeavy: async () => await import("./cli-background-command.js")');
    const dispersion = source.indexOf("await deps.sleep(launchdMaintenanceDispersionSeconds(label) * 1_000)");
    const gate = source.indexOf("return await withLaunchdMaintenanceControllerLock");
    const attestation = source.indexOf("await deps.verifyEntrypoint", gate);
    const heavyImport = source.indexOf("const heavy = await deps.loadHeavy()", attestation);
    const ownedHandler = source.indexOf("runLaunchdLogMaintenanceCommandWithLifecycleLease", heavyImport);
    expect(dispersion).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(dispersion);
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(attestation).toBeGreaterThan(gate);
    expect(heavyImport).toBeGreaterThan(attestation);
    expect(ownedHandler).toBeGreaterThan(heavyImport);

    const heavySource = await readFile(new URL("../cli-background-command.ts", import.meta.url), "utf8");
    const ownedStart = heavySource.indexOf("export async function runLaunchdLogMaintenanceCommandWithLifecycleLease");
    const ownedEnd = heavySource.indexOf("async function controllerCliAvailable", ownedStart);
    const ownedBody = heavySource.slice(ownedStart, ownedEnd);
    expect(ownedBody).toContain("assertLaunchdMaintenanceLifecycleLease(ownership, lockTarget)");
    expect(ownedBody).not.toContain("withLaunchdMaintenanceControllerLock(");
    expect(ownedBody.indexOf("assertLaunchdMaintenanceLifecycleLease"))
      .toBeLessThan(ownedBody.indexOf("loadDurableBackgroundEnvironment"));
    expect(ownedBody).toContain("return await maintainLaunchdController(target, deps, {");
    expect(ownedBody).toContain("}, ownership);");

    const controllerSource = await readFile(new URL("../background.ts", import.meta.url), "utf8");
    const controllerStart = controllerSource.indexOf("export async function maintainLaunchdController(");
    const controllerEnd = controllerSource.indexOf("function managedWorkerDefinitionMatchesTarget", controllerStart);
    const controllerBody = controllerSource.slice(controllerStart, controllerEnd);
    expect(controllerBody).toContain("assertLaunchdMaintenanceLifecycleLease(lifecycleLease, target)");
    expect(controllerBody).toContain("withLaunchdMaintenanceControllerLock(target, deps");
    expect(controllerBody).toContain("maintainLaunchdControllerWithLifecycleLease(target, deps, options)");
  });

  it("runs the real worker wiring as a metadata-only idle fast path", async () => {
    vi.useFakeTimers();
    const accessed: string[] = [];
    const launchctlCalls: readonly string[][] = [];
    let inspections = 0;
    const stream = {
      activeBytes: 0,
      retainedBytes: 0,
      totalBytes: 0,
      byteAccountingComplete: true,
      files: [],
    };
    const allowed: ManagedLaunchdLogMonitorDependencies = {
      inspectLaunchdLogs: async () => {
        inspections += 1;
        return {
          stdout: stream,
          stderr: stream,
          present: false,
          canMaintain: true,
          needsMaintenance: false,
          perAgentFileReasons: [],
          sharedDirectoryNeedsMaintenance: false,
          pendingTransaction: false,
          pendingMaintenance: false,
          pendingPreparation: false,
          issues: [],
        };
      },
      runner: async (args) => {
        (launchctlCalls as string[][]).push([...args]);
        throw new Error("idle composition must not call launchctl");
      },
      getuid: () => 501,
      stderr: () => undefined,
      recordStatus: () => undefined,
      monotonicNow: () => 0,
      wallClockNow: () => 0,
    };
    const deps = new Proxy(allowed as ManagedLaunchdLogMonitorDependencies & Record<string, unknown>, {
      get(target, property, receiver) {
        const name = String(property);
        accessed.push(name);
        if (["validateMonoAgentFolder", "captureSnapshot", "materializeBackgroundRuntimeInputs",
          "ensureManagedRuntime", "spawn"].includes(name)) {
          throw new Error(`heavy path ${name} was accessed`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const monitor = startManagedBackgroundLogMonitorForConfig(
      "/work/demo/mono-agent.config.json",
      deps,
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(inspections).toBe(1);
    expect(launchctlCalls).toEqual([]);
    expect(accessed).not.toEqual(expect.arrayContaining([
      "validateMonoAgentFolder",
      "captureSnapshot",
      "materializeBackgroundRuntimeInputs",
      "ensureManagedRuntime",
      "spawn",
    ]));
    monitor.stop();
  });
});

async function staticRuntimeGraph(entryPath: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [entryPath];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    const statements = source.matchAll(/(?:^|\n)\s*(?:import(?!\s*\()|export)\s+(?!type\b)[\s\S]*?;/gu);
    for (const match of statements) {
      const statement = match[0];
      const specifier = /\bfrom\s+["'](\.[^"']+)["']/u.exec(statement)?.[1]
        ?? /^\s*import\s+["'](\.[^"']+)["']/u.exec(statement)?.[1];
      if (specifier === undefined) continue;
      const candidate = resolve(dirname(path), specifier.replace(/\.js$/u, ".ts"));
      pending.push(candidate);
    }
  }
  return visited;
}
