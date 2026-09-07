import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createFakeSandbox, testSandboxPolicy as failClosedSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  createToolContext,
  updateToolContext,
  resolveSandboxPolicy,
} from "../../agent/tools/shared/tool-context.js";
import { DEFAULT_RUNTIME_BRAND } from "../../runtime-brand.js";
import { bashToolImpl, execToolImpl, readToolImpl, webFetchToolImpl, webSearchToolImpl } from "../../agent/tools/index.js";
import { prepareMcpStdioCommand } from "../../agent/tools/pi-bridge.js";
import { createNodeReplController } from "../../agent/tools/node-repl.js";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-tool-ctx-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("createToolContext", () => {
  it("copies recognized data keys and resolves the brand", () => {
    const ctx = createToolContext({
      workspace: "/tmp/w",
      repoRoot: "/tmp/r",
      ripgrepPath: "/usr/bin/rg",
      qaOutputDir: "/tmp/qa",
      runId: "run-1",
      toolArtifactDir: "/tmp/art",
      runtimeBrand: { schemaPrefix: "demo" },
    });
    expect(ctx.workspace).toBe("/tmp/w");
    expect(ctx.repoRoot).toBe("/tmp/r");
    expect(ctx.ripgrepPath).toBe("/usr/bin/rg");
    expect(ctx.qaOutputDir).toBe("/tmp/qa");
    expect(ctx.runId).toBe("run-1");
    expect(ctx.toolArtifactDir).toBe("/tmp/art");
    expect(ctx.runtimeBrand.schemaPrefix).toBe("demo");
    // Unspecified brand fields fall back to the defaults.
    expect(ctx.runtimeBrand.tempdirPrefix).toBe(DEFAULT_RUNTIME_BRAND.tempdirPrefix);
  });

  it("defaults the brand to DEFAULT_RUNTIME_BRAND and ignores unknown keys", () => {
    const ctx = createToolContext({ workspace: "/tmp/w", bogus: "nope" });
    expect(ctx.runtimeBrand).toEqual(DEFAULT_RUNTIME_BRAND);
    expect(ctx.bogus).toBeUndefined();
  });
});

describe("direct execution requires context", () => {
  it.each([
    ["Bash", () => bashToolImpl({ command: "exit 0" })],
    ["Exec", () => execToolImpl({ executable: process.execPath, args: ["-e", "process.exit(0)"] })],
    ["WebFetch", () => webFetchToolImpl({ url: "https://example.invalid", render: "never" })],
    ["WebSearch", () => webSearchToolImpl({ query: "context regression" })],
    ["MCP stdio", () => prepareMcpStdioCommand({ command: process.execPath })],
  ])("rejects missing context for %s before execution", async (_name, run) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      await expect(run()).rejects.toThrow("explicit ToolContext");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("rejects missing context before constructing a Node REPL controller", () => {
    expect(() => createNodeReplController()).toThrow("explicit ToolContext");
  });

  it("binds direct MCP command preparation to the context workspace, engine, and policy", async () => {
    const workspace = tempDir();
    const engine = {};
    const policy = failClosedSandboxPolicy({ root: workspace });
    const prepareCommand = vi.fn(async (input) => ({ ...input.command, sandboxed: true }));
    const ctx = createToolContext({
      workspace,
      sandboxEngine: engine,
      sandboxPolicy: policy,
      sandbox: { ...createFakeSandbox(), prepareCommand },
    });
    await prepareMcpStdioCommand({ command: process.execPath }, { ctx });
    expect(prepareCommand).toHaveBeenCalledWith(expect.objectContaining({
      engine,
      policy: expect.objectContaining({ root: workspace }),
      command: expect.objectContaining({ cwd: workspace }),
    }));
  });

  it("copies direct request environments so caller mutations cannot change tool execution", () => {
    const values = { TASK_ID: "first" };
    const pathPrepend = ["/tmp/first/bin"];
    const ctx = createToolContext({ toolEnvironment: { schema: 1, values, pathPrepend } });
    values.TASK_ID = "changed";
    pathPrepend.push("/tmp/changed/bin");
    expect(ctx.toolEnvironment).toEqual({ schema: 1, values: { TASK_ID: "first" }, pathPrepend: ["/tmp/first/bin"] });
    updateToolContext(ctx, { toolEnvironment: undefined });
    expect(ctx.toolEnvironment).toBeUndefined();
  });
});

describe("updateToolContext", () => {
  it("mutates in place, leaving untouched keys and returning the same reference", () => {
    const ctx = createToolContext({ workspace: "/tmp/w", ripgrepPath: "/usr/bin/rg" });
    const returned = updateToolContext(ctx, { workspace: "/tmp/updated" });
    expect(returned).toBe(ctx);
    expect(ctx.workspace).toBe("/tmp/updated");
    expect(ctx.ripgrepPath).toBe("/usr/bin/rg");
  });

  it("re-resolves the brand only when runtimeBrand is present", () => {
    const ctx = createToolContext({ runtimeBrand: { schemaPrefix: "one" } });
    updateToolContext(ctx, { workspace: "/tmp/w" });
    expect(ctx.runtimeBrand.schemaPrefix).toBe("one");
    updateToolContext(ctx, { runtimeBrand: { schemaPrefix: "two" } });
    expect(ctx.runtimeBrand.schemaPrefix).toBe("two");
  });
});

describe("resolveSandboxPolicy (I13 monotonic merge)", () => {
  it("returns the context policy when no request policy tightens it", () => {
    const ctx = createToolContext({
      sandbox: createFakeSandbox(),
      sandboxPolicy: failClosedSandboxPolicy({ root: "/tmp/host" }),
    });
    const resolved = resolveSandboxPolicy(ctx, undefined);
    expect(resolved?.mode).toBe("native");
  });

  it("delegates the merge to ctx.sandbox.mergePolicies, passing both policies through untouched", () => {
    const calls = [];
    const hostPolicy = failClosedSandboxPolicy({ root: "/tmp/host" });
    const requestPolicy = failClosedSandboxPolicy({ root: "/tmp/host/sub" });
    const fake = createFakeSandbox();
    const ctx = createToolContext({
      sandboxPolicy: hostPolicy,
      sandbox: {
        ...fake,
        mergePolicies(configured, request) {
          calls.push([configured, request]);
          return fake.mergePolicies(configured, request);
        },
      },
    });
    const resolved = resolveSandboxPolicy(ctx, requestPolicy);
    expect(calls).toEqual([[hostPolicy, requestPolicy]]);
    // The delegated merge tightens readableRoots to the more specific request
    // root rather than weakening back to the host root (I13).
    expect(resolved?.readableRoots).toEqual([requestPolicy.root]);
  });

  it("falls back to passthroughSandbox's own monotonic merge when ctx carries no sandbox impl", () => {
    // A bare ToolContext-shaped object built without createToolContext (e.g. a
    // hand-rolled host object) still gets a safe default merge.
    const hostPolicy = { mode: "native", network: { mode: "none" } };
    const resolved = resolveSandboxPolicy({ sandboxPolicy: hostPolicy }, undefined);
    expect(resolved).toEqual(hostPolicy);
  });

  it("returns undefined when neither context nor request supplies a policy", () => {
    expect(resolveSandboxPolicy(createToolContext({}), undefined)).toBeUndefined();
    expect(resolveSandboxPolicy(undefined, undefined)).toBeUndefined();
  });
});

describe("per-instance context isolation", () => {
  it("two contexts do not clobber each other", () => {
    const a = createToolContext({ workspace: "/tmp/a", runtimeBrand: { schemaPrefix: "aa" } });
    const b = createToolContext({ workspace: "/tmp/b", runtimeBrand: { schemaPrefix: "bb" } });
    updateToolContext(a, { workspace: "/tmp/a-updated" });
    expect(a.workspace).toBe("/tmp/a-updated");
    expect(b.workspace).toBe("/tmp/b");
    expect(a.runtimeBrand.schemaPrefix).toBe("aa");
    expect(b.runtimeBrand.schemaPrefix).toBe("bb");
  });

  it("a real tool resolves against its explicit context and rejects missing context", async () => {
    const ctxWs = tempDir();
    // The target file exists ONLY inside the per-instance workspace.
    writeFileSync(resolve(ctxWs, "target.txt"), "hello from ctx", "utf8");

    const ctx = createToolContext({ workspace: ctxWs });
    // With the instance ctx threaded, the relative path resolves under ctxWs.
    const withCtx = await readToolImpl({ file_path: "target.txt" }, { ctx });
    expect(withCtx).toContain("hello from ctx");

    // Omitting ctx must fail before an unconfined filesystem read.
    await expect(readToolImpl({ file_path: "target.txt" }, {})).rejects.toThrow("explicit ToolContext");
  });
});
