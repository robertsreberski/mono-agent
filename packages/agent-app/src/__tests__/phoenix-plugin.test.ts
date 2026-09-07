import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import * as phoenix from "@mono-agent/observability-phoenix";

import { agentAppPackageVersion } from "../package-version.js";
import {
  isPhoenixPluginInstalled,
  loadPhoenixPlugin,
  missingPhoenixPluginMessage,
  PHOENIX_PLUGIN_PACKAGE,
} from "../phoenix-plugin.js";
import type { PhoenixPluginModule } from "../phoenix-plugin.js";

// Compile-time check that the independently published plugin satisfies the app boundary.
const plugin: PhoenixPluginModule = phoenix;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scaffold(version: string | undefined = agentAppPackageVersion()): { cwd: string; manifest: string } {
  const cwd = mkdtempSync(join(tmpdir(), "mono-agent-phoenix-plugin-"));
  directories.push(cwd);
  const root = join(cwd, "node_modules", "@mono-agent", "observability-phoenix");
  mkdirSync(join(root, "dist"), { recursive: true });
  const manifest = join(root, "package.json");
  writeFileSync(manifest, JSON.stringify({
    name: PHOENIX_PLUGIN_PACKAGE,
    version,
    type: "module",
    exports: { ".": { import: "./dist/index.js" }, "./package.json": "./package.json" },
  }));
  writeFileSync(join(root, "dist/index.js"), [
    "export const marker = 'agent-local';",
    "export const createPhoenixRunExporter = () => ({});",
    "export const serializeRunTrace = () => ({body: new Uint8Array(), spanCount: 0});",
    "export const serializeEmptyTrace = () => new Uint8Array();",
    "export const postOtlpProtobuf = async () => ({ok: true, status: 200});",
  ].join("\n"));
  return { cwd, manifest };
}

describe("optional Phoenix plugin loading", () => {
  it("offers only an available matching plugin and gives exact installation guidance", () => {
    expect(isPhoenixPluginInstalled()).toBe(true);
    expect(isPhoenixPluginInstalled({ resolveModule: () => { throw new Error("absent"); } })).toBe(false);
    const { cwd } = scaffold("9.9.9");
    expect(isPhoenixPluginInstalled({ cwd })).toBe(false);
    expect(isPhoenixPluginInstalled({ cwd, preferAppInstall: true })).toBe(true);
    expect(missingPhoenixPluginMessage()).toContain(
      `npm install ${PHOENIX_PLUGIN_PACKAGE}@${agentAppPackageVersion()}`,
    );
  });

  it("loads the real matching plugin without exporting anything", async () => {
    const loaded = await loadPhoenixPlugin();
    expect(loaded.createPhoenixRunExporter).toBe(plugin.createPhoenixRunExporter);
    expect(loaded.serializeEmptyTrace()).toBeInstanceOf(Uint8Array);
  });

  it("prefers the explicit agent-folder install", async () => {
    const { cwd } = scaffold();
    const loaded = await loadPhoenixPlugin({ cwd }) as PhoenixPluginModule & { marker?: string };
    expect(loaded.marker).toBe("agent-local");
  });

  it("resolves relative and absolute agent folders to the same explicit plugin", async () => {
    const { cwd } = scaffold();
    const relativeCwd = relative(process.cwd(), cwd);
    const fromAbsolute = await loadPhoenixPlugin({ cwd });
    const fromRelative = await loadPhoenixPlugin({ cwd: relativeCwd });
    expect(fromRelative).toBe(fromAbsolute);
    expect((fromRelative as PhoenixPluginModule & { marker?: string }).marker).toBe("agent-local");
    expect(isPhoenixPluginInstalled({ cwd: relativeCwd })).toBe(true);
  });

  it("rejects a mismatched relative agent-folder install without app fallback", async () => {
    const { cwd } = scaffold("9.9.9");
    const relativeCwd = relative(process.cwd(), cwd);
    expect(isPhoenixPluginInstalled({ cwd: relativeCwd })).toBe(false);
    await expect(loadPhoenixPlugin({ cwd: relativeCwd })).rejects.toThrow("does not match");
  });

  it("ignores mutable agent-folder code in a managed runtime", async () => {
    const { cwd } = scaffold();
    const loaded = await loadPhoenixPlugin({ cwd, preferAppInstall: true }) as PhoenixPluginModule & { marker?: string };
    expect(loaded.marker).toBeUndefined();
    expect(loaded.createPhoenixRunExporter).toBe(plugin.createPhoenixRunExporter);
  });

  it("reports exact-version installation instructions for a missing selected plugin", async () => {
    let imported = false;
    await expect(loadPhoenixPlugin({
      resolveModule: () => { throw new Error("missing package"); },
      importModule: async () => { imported = true; return plugin; },
    })).rejects.toThrow(`npm install ${PHOENIX_PLUGIN_PACKAGE}@${agentAppPackageVersion()}`);
    expect(imported).toBe(false);
  });

  it("rejects a mismatched explicit install without falling back to the app package", async () => {
    const { cwd } = scaffold("9.9.9");
    let imported = false;
    await expect(loadPhoenixPlugin({
      cwd,
      importModule: async () => { imported = true; return plugin; },
    })).rejects.toThrow(`${PHOENIX_PLUGIN_PACKAGE}@9.9.9 does not match`);
    expect(imported).toBe(false);
  });

  it("rejects unverifiable version metadata before import", async () => {
    const { manifest } = scaffold();
    const raw = { name: PHOENIX_PLUGIN_PACKAGE, exports: { ".": "./dist/index.js" } };
    writeFileSync(manifest, JSON.stringify(raw));
    await expect(loadPhoenixPlugin({ resolveModule: () => manifest })).rejects.toThrow("version cannot be verified");
  });

  it("does not mislabel an installed plugin's missing internal dependency", async () => {
    const { manifest } = scaffold();
    const failure = Object.assign(new Error("missing internal dependency"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(loadPhoenixPlugin({
      resolveModule: () => manifest,
      importModule: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it("rejects an incomplete installed plugin API", async () => {
    const { manifest } = scaffold();
    await expect(loadPhoenixPlugin({
      resolveModule: () => manifest,
      importModule: async () => ({ createPhoenixRunExporter: plugin.createPhoenixRunExporter }),
    })).rejects.toThrow("expected Phoenix exporter and protobuf API");
  });

  it("rejects package entries outside the resolved package before import", async () => {
    const { manifest } = scaffold();
    writeFileSync(manifest, JSON.stringify({
      name: PHOENIX_PLUGIN_PACKAGE,
      version: agentAppPackageVersion(),
      exports: { ".": { import: "../outside.js" } },
    }));
    await expect(loadPhoenixPlugin({ resolveModule: () => manifest })).rejects.toThrow("outside its package");
  });
});
