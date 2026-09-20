import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { exporterSection } from "../doctor-observability.js";
import { agentAppPackageVersion } from "../package-version.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mono-agent-phoenix-doctor-")); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(cwd, { recursive: true, force: true });
});

async function input(exporters: readonly unknown[]) {
  const configPath = join(cwd, "mono-agent.config.json");
  await writeFile(configPath, JSON.stringify({ observability: { exporters } }));
  return { cwd, configPath, env: {} };
}

async function installedPlugin(version: string, code?: string): Promise<void> {
  const root = join(cwd, "node_modules", "@mono-agent", "observability-phoenix");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@mono-agent/observability-phoenix", version, type: "module",
    exports: { ".": { import: "./dist/index.js" }, "./package.json": "./package.json" },
  }));
  if (code !== undefined) await writeFile(join(root, "dist/index.js"), code);
}

describe("Phoenix doctor plugin diagnostics", () => {
  it("does not load an installed broken plugin when no exporter is selected", async () => {
    await installedPlugin("9.9.9");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await exporterSection(await input([]), true)).status).toBe("disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports matching-version installation without probing an incompatible plugin", async () => {
    await installedPlugin("9.9.9");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await exporterSection(await input([{ type: "phoenix" }]), true);
    expect(result.status).toBe("error");
    expect(result.details.join("\n")).toContain(
      `npm install @mono-agent/observability-phoenix@${agentAppPackageVersion()}`,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves installed plugin initialization diagnostics", async () => {
    await installedPlugin(agentAppPackageVersion()!, "throw new Error('broken internal dependency');");
    const result = await exporterSection(await input([{ type: "phoenix" }]), false);
    expect(result.status).toBe("error");
    expect(result.details[0]).toBe("broken internal dependency");
  });

  it("checks the immutable app-side plugin for managed workers", async () => {
    await installedPlugin("9.9.9");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await exporterSection(await input([{ type: "phoenix" }]), false, true)).status).toBe("ok");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps exporter network rejection non-fatal and local recording explicit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const result = await exporterSection(await input([{ type: "phoenix" }]), true);
    expect(result.status).toBe("waiting");
    expect(result.details.join("\n")).toContain("HTTP 503");
    expect(result.details.join("\n")).toContain("JSONL artifacts remain local");
  });
});
