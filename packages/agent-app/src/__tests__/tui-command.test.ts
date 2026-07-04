import { describe, expect, it } from "vitest";

import type { TraceSourceListItem, TraceSourceListResult } from "@mono-agent/observability";

import { parseCliArgs } from "../cli.js";
import { resolveTuiLaunch, runTui, tuiEndpointOf } from "../tui-command.js";

function source(overrides: Partial<TraceSourceListItem> = {}): TraceSourceListItem {
  return {
    schema: "agent-runtime.trace-source.v1",
    sourceId: "agent-a",
    label: "agent-a",
    artifactDir: "/tmp/artifacts",
    pid: 123,
    status: "running",
    startedAt: "2026-07-01T00:00:00Z",
    updatedAt: new Date().toISOString(),
    transports: ["tui"],
    configPath: "/agents/a/mono-agent.config.json",
    metadata: { channels: { tui: { kind: "running", baseUrl: "http://127.0.0.1:5151/tui" } } },
    health: "running",
    warnings: [],
    ...overrides,
  };
}

describe("parseCliArgs tui", () => {
  it("parses the tui command with --agent and --conversation", () => {
    const args = parseCliArgs(["tui", "--agent", "personal-agent", "--conversation", "ops"]);
    expect(args.command).toBe("tui");
    expect(args.agent).toBe("personal-agent");
    expect(args.conversation).toBe("ops");
  });

  it("keeps tui flag-free invocation valid", () => {
    expect(parseCliArgs(["tui"]).command).toBe("tui");
  });
});

describe("resolveTuiLaunch", () => {
  it("returns none with a start hint when nothing is running", () => {
    const plan = resolveTuiLaunch([], ["/reg"], undefined);
    expect(plan.kind).toBe("none");
    expect((plan as { message: string }).message).toContain("mono-agent start");
    expect((plan as { message: string }).message).toContain("registry: /reg");
  });

  it("names both registries in the hint when merged and nothing is running", () => {
    const plan = resolveTuiLaunch([], ["/local", "/global"], undefined);
    expect(plan.kind).toBe("none");
    expect((plan as { message: string }).message).toContain("/local");
    expect((plan as { message: string }).message).toContain("/global");
  });

  it("auto-connects a single running agent", () => {
    const plan = resolveTuiLaunch([source()], ["/reg"], undefined);
    expect(plan).toEqual({ kind: "connect", source: source({ updatedAt: (plan as { source: TraceSourceListItem }).source.updatedAt }) });
  });

  it("opens the picker for several agents", () => {
    const sources = [source(), source({ sourceId: "agent-b", label: "agent-b" })];
    const plan = resolveTuiLaunch(sources, ["/reg"], undefined);
    expect(plan.kind).toBe("picker");
    expect((plan as { sources: readonly TraceSourceListItem[] }).sources).toHaveLength(2);
  });

  it("matches --agent by label or sourceId and errors with the available list", () => {
    const sources = [source(), source({ sourceId: "id-b", label: "beta" })];
    expect(resolveTuiLaunch(sources, ["/reg"], "beta").kind).toBe("connect");
    expect(resolveTuiLaunch(sources, ["/reg"], "id-b").kind).toBe("connect");

    const miss = resolveTuiLaunch(sources, ["/reg"], "nope");
    expect(miss.kind).toBe("error");
    expect((miss as { message: string }).message).toContain("beta");
  });

  it("ignores stopped sources everywhere", () => {
    const stopped = source({ status: "stopped", health: "stopped" });
    expect(resolveTuiLaunch([stopped], ["/reg"], undefined).kind).toBe("none");
    expect(resolveTuiLaunch([stopped], ["/reg"], "agent-a").kind).toBe("error");
  });
});

// mergeTraceSources itself lives in @mono-agent/observability (next to
// listTraceSources) and is unit-tested there; these tests cover runTui's use
// of it (the dual-registry union below).

describe("tuiEndpointOf", () => {
  it("reads a running tui channel's baseUrl and rejects non-running", () => {
    expect(tuiEndpointOf(source())).toBe("http://127.0.0.1:5151/tui");
    expect(tuiEndpointOf(source({ metadata: { channels: { tui: { kind: "disabled" } } } }))).toBeUndefined();
    expect(tuiEndpointOf(source({ metadata: {} }))).toBeUndefined();
  });

  it("treats a malformed empty baseUrl as no endpoint (discovery fallback)", () => {
    expect(
      tuiEndpointOf(source({ metadata: { channels: { tui: { kind: "running", baseUrl: "" } } } })),
    ).toBeUndefined();
  });
});

describe("runTui", () => {
  const baseOptions = {
    configPath: "/nowhere/mono-agent.config.json",
    cwd: "/nowhere",
    env: {},
  };

  it("connects with connection + instance for a single running agent", async () => {
    const started: Record<string, unknown>[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({ registryDir: "/reg", sources: [source()], warnings: [] }),
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
    });

    expect(code).toBe(0);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      connection: { baseUrl: "http://127.0.0.1:5151/tui" },
      instance: { label: "agent-a", artifactDir: "/tmp/artifacts" },
      conversationId: "tui-agent-a",
    });
  });

  it("passes discovery mode when several agents run", async () => {
    const started: Record<string, unknown>[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({
        registryDir: "/reg",
        sources: [source(), source({ sourceId: "agent-b", label: "agent-b" })],
        warnings: [],
      }),
      startTui: async (options) => {
        started.push(options);
        return { waitUntilExit: async () => {} };
      },
    });

    expect(code).toBe(0);
    expect(started[0]).toMatchObject({ discovery: { registryDirs: ["/reg"] } });
  });

  it("merges the configured and global registries by sourceId, opening the picker over the union with the fresher dupe winning", async () => {
    const started: Record<string, unknown>[] = [];
    const localOnly = source({ sourceId: "local-only", label: "local-only" });
    const globalOnly = source({ sourceId: "global-only", label: "global-only" });
    const staleDupe = source({ sourceId: "dupe", label: "stale-copy", updatedAt: "2026-07-01T00:00:00.000Z" });
    const freshDupe = source({ sourceId: "dupe", label: "fresh-copy", updatedAt: "2026-07-02T00:00:00.000Z" });

    const code = await runTui(
      {
        configPath: "/local-agent/mono-agent.config.json",
        cwd: "/local-agent",
        env: {
          MONO_AGENT_TRACE_REGISTRY_DIR: "/local-registry",
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/global-registry",
        },
      },
      {
        isTty: true,
        listSources: async (options): Promise<TraceSourceListResult> =>
          options.registryDir === "/global-registry"
            ? { registryDir: "/global-registry", sources: [globalOnly, freshDupe], warnings: [] }
            : { registryDir: "/local-registry", sources: [localOnly, staleDupe], warnings: [] },
        startTui: async (options) => {
          started.push(options);
          return { waitUntilExit: async () => {} };
        },
      },
    );

    expect(code).toBe(0);
    expect(started).toHaveLength(1);
    // The merge collapses the "dupe" sourceId to one entry (fresher wins) —
    // three total instances across both registries. The picker gets BOTH
    // registries: its in-TUI refresh must keep showing agents that exist only
    // in the local one (opt-outs, or agents on a pre-mirror build).
    const plan = started[0] as { discovery?: { registryDirs?: readonly string[] } };
    expect(plan.discovery?.registryDirs).toEqual(["/local-registry", "/global-registry"]);
  });

  it("hands the connect-path discovery fallback BOTH registries so an opt-out agent stays reachable", async () => {
    const started: Record<string, unknown>[] = [];
    // An opt-out agent (globalDiscovery:false) exists ONLY in its local
    // registry and has no tui stream endpoint: the discovery fallback's
    // registry union must include its local registry.
    const localOnly = source({ sourceId: "local-only", label: "local-only", metadata: {} });
    const globalOnly = source({ sourceId: "global-only", label: "global-only" });

    const code = await runTui(
      {
        configPath: "/local-agent/mono-agent.config.json",
        cwd: "/local-agent",
        env: {
          MONO_AGENT_TRACE_REGISTRY_DIR: "/local-registry",
          MONO_AGENT_GLOBAL_TRACE_REGISTRY_DIR: "/global-registry",
        },
        agent: "local-only",
      },
      {
        isTty: true,
        listSources: async (options): Promise<TraceSourceListResult> =>
          options.registryDir === "/global-registry"
            ? { registryDir: "/global-registry", sources: [globalOnly], warnings: [] }
            : { registryDir: "/local-registry", sources: [localOnly], warnings: [] },
        startTui: async (options) => {
          started.push(options);
          return { waitUntilExit: async () => {} };
        },
        stdout: { write: () => {} },
      },
    );

    expect(code).toBe(0);
    expect(started[0]).toMatchObject({
      discovery: { registryDirs: ["/local-registry", "/global-registry"] },
    });
  });

  it("does not re-list the global registry when it is identical to the configured one", async () => {
    const calls: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async (options) => {
        calls.push(options.registryDir);
        return { registryDir: "/reg", sources: [source()], warnings: [] };
      },
      startTui: async () => ({ waitUntilExit: async () => {} }),
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("exits 1 with a hint when nothing is running", async () => {
    const out: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: true,
      listSources: async () => ({ registryDir: "/reg", sources: [], warnings: [] }),
      startTui: async () => {
        throw new Error("must not start");
      },
      stdout: { write: (text) => void out.push(text) },
    });

    expect(code).toBe(1);
    expect(out.join("")).toContain("mono-agent start");
  });

  it("refuses without a TTY", async () => {
    const err: string[] = [];
    const code = await runTui(baseOptions, {
      isTty: false,
      stderr: { write: (text) => void err.push(text) },
    });

    expect(code).toBe(1);
    expect(err.join("")).toContain("TTY");
  });
});
