import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isPathUnderTmpdir,
  resolveAppTraceGlobalDiscovery,
  resolveGlobalTraceRegistryDir,
  resolveTraceTmpdirRoot,
  shouldMirrorTraceSourceGlobally,
} from "../app-config.js";

describe("resolveGlobalTraceRegistryDir", () => {
  it("defaults to the host-shared registry under the home directory", () => {
    expect(resolveGlobalTraceRegistryDir({})).toBe(join(homedir(), ".mono-agent", "trace-sources"));
  });

  it("honors MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR (test/ops injection seam)", () => {
    expect(resolveGlobalTraceRegistryDir({ MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/fake/global-registry" })).toBe(
      "/fake/global-registry",
    );
  });
});

describe("resolveTraceTmpdirRoot", () => {
  it("defaults to the real OS tmp directory", () => {
    expect(resolveTraceTmpdirRoot({})).toBe(resolve(tmpdir()));
  });

  it("honors MONO_AGENT_TRACE_TMPDIR_ROOT (test injection seam)", () => {
    expect(resolveTraceTmpdirRoot({ MONO_AGENT_TRACE_TMPDIR_ROOT: "/fake/tmp-root" })).toBe("/fake/tmp-root");
  });
});

describe("resolveAppTraceGlobalDiscovery", () => {
  const configPath = "/nowhere/mono-agent.config.json";

  it("defaults to true when unset", async () => {
    await expect(
      resolveAppTraceGlobalDiscovery({ env: {}, cwd: "/nowhere", configPath }),
    ).resolves.toBe(true);
  });

  it("honors the MONO_AGENT_TRACE_GLOBAL_DISCOVERY env override", async () => {
    await expect(
      resolveAppTraceGlobalDiscovery({ env: { MONO_AGENT_TRACE_GLOBAL_DISCOVERY: "false" }, cwd: "/nowhere", configPath }),
    ).resolves.toBe(false);
  });

  it("rejects a non-boolean env override", async () => {
    await expect(
      resolveAppTraceGlobalDiscovery({ env: { MONO_AGENT_TRACE_GLOBAL_DISCOVERY: "sometimes" }, cwd: "/nowhere", configPath }),
    ).rejects.toThrow(/must be true or false/u);
  });
});

describe("isPathUnderTmpdir", () => {
  it("is true for a path nested under the given tmp root", () => {
    expect(isPathUnderTmpdir("/tmp/xyz/registry", "/tmp")).toBe(true);
    expect(isPathUnderTmpdir("/tmp", "/tmp")).toBe(true);
  });

  it("is false for a path outside the given tmp root", () => {
    expect(isPathUnderTmpdir("/Users/me/personal-agent/.mono-agent/trace-sources", "/tmp")).toBe(false);
    // A sibling directory that merely shares a string prefix must not false-positive.
    expect(isPathUnderTmpdir("/tmpfoo/registry", "/tmp")).toBe(false);
  });
});

describe("shouldMirrorTraceSourceGlobally", () => {
  const FAKE_TMP_ROOT = "/fake-os-tmp";

  it("mirrors when the registry differs, discovery is enabled, and it is not under tmp", () => {
    expect(
      shouldMirrorTraceSourceGlobally({
        registryDir: "/Users/me/personal-agent/.mono-agent/trace-sources",
        globalRegistryDir: "/Users/me/.mono-agent/trace-sources",
        globalDiscovery: true,
        tmpdirRoot: FAKE_TMP_ROOT,
      }),
    ).toBe(true);
  });

  it("does not mirror when the registry already IS the global one", () => {
    expect(
      shouldMirrorTraceSourceGlobally({
        registryDir: "/Users/me/.mono-agent/trace-sources",
        globalRegistryDir: "/Users/me/.mono-agent/trace-sources",
        globalDiscovery: true,
        tmpdirRoot: FAKE_TMP_ROOT,
      }),
    ).toBe(false);
  });

  it("does not mirror when globalDiscovery is false", () => {
    expect(
      shouldMirrorTraceSourceGlobally({
        registryDir: "/Users/me/personal-agent/.mono-agent/trace-sources",
        globalRegistryDir: "/Users/me/.mono-agent/trace-sources",
        globalDiscovery: false,
        tmpdirRoot: FAKE_TMP_ROOT,
      }),
    ).toBe(false);
  });

  it("does not mirror when the registry lives under the tmp root", () => {
    expect(
      shouldMirrorTraceSourceGlobally({
        registryDir: join(FAKE_TMP_ROOT, "agent-test-1234", "trace-sources"),
        globalRegistryDir: "/Users/me/.mono-agent/trace-sources",
        globalDiscovery: true,
        tmpdirRoot: FAKE_TMP_ROOT,
      }),
    ).toBe(false);
  });
});
