import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import sharp from "sharp";
import { createFakeSandbox, testSandboxPolicy as failClosedSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  coerceMcpContent,
  closePiMcpClients,
  getPiBuiltinTools,
  initPiMcpTools,
  normalizeMcpToolParams,
  normalizePiBuiltinToolParams,
  prepareMcpStdioCommand,
  resolveMcpStdioCwd,
} from "../../agent/tools/pi-bridge.js";
import {
  configureToolRuntime,
  resetToolRuntime,
} from "../../agent/tools/shared/runtime-context.js";
import { createApprovalManager } from "../../agent/approval.js";

function makeSink(runDir) {
  return ({ filename, buffer }) => {
    const dir = join(runDir, "tool-output");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, filename);
    writeFileSync(target, buffer);
    return target;
  };
}

const tempDirs = [];

function tempWorkspace() {
  const dir = mkdtempSync(resolve("/tmp", "agent-runtime-pi-bridge-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // The fake sandbox fixture gives tests that supply their own `sandboxEngine`
  // realistic engine-delegated command preparation — see helpers/fake-sandbox.js.
  // (passthroughSandbox, the kernel's zero-dependency default, fails closed on
  // any native-mode policy instead — see sandbox-seam.test.js.)
  configureToolRuntime({ sandbox: createFakeSandbox() });
});

afterEach(() => {
  resetToolRuntime();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("pi MCP tool helpers", () => {
  it("truncates oversized text results before returning them to the model", () => {
    const large = "x".repeat(80_000);
    const content = coerceMcpContent({ content: [{ type: "text", text: large }] });

    expect(content).toHaveLength(1);
    expect(content[0].text.length).toBeLessThan(large.length);
    expect(content[0].text).toContain("[truncated MCP tool result");
    expect(content[0].text).toContain("Use a more specific MCP tool");
  });

  it("leaves small text results unchanged", () => {
    const content = coerceMcpContent({ content: [{ type: "text", text: "ok" }] });

    expect(content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("persists oversized MCP images before replacing them with compact text", () => {
    const root = tempWorkspace();
    const runArtifactDir = join(root, ".mono-agent", "artifacts", "run-image");
    const imageBytes = Buffer.from("large screenshot payload");
    const truncations = [];

    const content = coerceMcpContent(
      { content: [{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" }] },
      {
        imageInlineMaxBytes: 10,
        persistArtifact: makeSink(runArtifactDir),
        toolName: "mcp__playwright__browser_take_screenshot",
        toolUseId: "shot-1",
        onTruncate: (event) => truncations.push(event),
      },
    );

    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("saved_to=");
    const files = readdirSync(join(runArtifactDir, "tool-output"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/mcp__playwright__browser_take_screenshot.*\.png$/);
    expect(readFileSync(join(runArtifactDir, "tool-output", files[0])).toString()).toBe("large screenshot payload");
    expect(truncations[0]).toMatchObject({
      tool: "mcp__playwright__browser_take_screenshot",
      tool_use_id: "shot-1",
      original_bytes: imageBytes.length,
      max_bytes: 10,
    });
  });

  it("hard-caps model-supplied built-in tool budgets during execution without schema maxima", () => {
    const toolLimits = {
      toolTextLimitChars: 16000,
      bashOutputLimitChars: 20000,
      searchResultLimit: 100,
    };

    expect(normalizePiBuiltinToolParams("Read", {
      file_path: "src/app.ts",
      max_output_chars: 50000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      file_path: "/repo/src/app.ts",
      max_output_chars: 16000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "npm test",
      timeout: 999999,
      max_output_chars: 50000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "npm test",
      workdir: "/repo",
      timeout: 120000,
      max_output_chars: 20000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout: 30,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "ls",
      workdir: "/repo",
      timeout: 30000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout: 120000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      command: "ls",
      workdir: "/repo",
      timeout: 120000,
    });
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
    }, { cwd: "/repo", toolLimits: { ...toolLimits, bashTimeoutMs: 5000 } })).toMatchObject({
      command: "ls",
      workdir: "/repo",
      timeout_ms: 5000,
    });
    expect(normalizePiBuiltinToolParams("Exec", {
      executable: "git",
      args: ["status"],
    }, { cwd: "/repo", toolLimits: { ...toolLimits, bashTimeoutMs: 5000 } })).toMatchObject({
      executable: "git",
      args: ["status"],
      workdir: "/repo",
      timeout_ms: 5000,
    });
    expect(normalizePiBuiltinToolParams("Glob", {
      pattern: "**/*",
      max_matches: 5000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      pattern: "**/*",
      path: undefined,
      limit: 100,
      workdir: "/repo",
    });
    expect(normalizePiBuiltinToolParams("Grep", {
      pattern: "needle",
      output_mode: "content",
      max_matches: 5000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({
      pattern: "needle",
      output_mode: "content",
      head_limit: 100,
      workdir: "/repo",
    });

    const tools = getPiBuiltinTools(["Read", "Bash"], { toolLimits });
    const readSchema = tools.find((tool) => tool.name === "Read").parameters;
    const bashSchema = tools.find((tool) => tool.name === "Bash").parameters;
    expect(readSchema.properties.max_output_chars.maximum).toBeUndefined();
    expect(readSchema.properties.start_line.type).toBe("integer");
    expect(bashSchema.properties.max_output_chars.maximum).toBeUndefined();
    expect(bashSchema.properties.timeout.maximum).toBeUndefined();
    expect(bashSchema.properties.timeout.description).toContain("milliseconds");
    expect(bashSchema.properties.workdir.type).toBe("string");
  });

  it("leaves a background hand-off's timeout to the host's process-job budget", () => {
    // Regression: the foreground default was injected/applied here too, so a
    // background job was capped at 120s no matter what the caller asked for.
    const toolLimits = { toolTextLimitChars: 16000, bashOutputLimitChars: 20000, searchResultLimit: 100 };

    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout_ms: 14_400_000,
      background: true,
    }, { cwd: "/repo", toolLimits })).toMatchObject({ timeout_ms: 14_400_000 });

    expect(normalizePiBuiltinToolParams("Exec", {
      executable: "git",
      args: ["status"],
      timeout_ms: 14_400_000,
      background: true,
    }, { cwd: "/repo", toolLimits })).toMatchObject({ timeout_ms: 14_400_000 });

    // No timeout requested: nothing is injected, so processJobs.maxRuntimeMs governs.
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      background: true,
    }, { cwd: "/repo", toolLimits })).not.toHaveProperty("timeout_ms");

    // Output limits are unrelated to the runtime budget and still apply.
    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      max_output_chars: 999_999,
      background: true,
    }, { cwd: "/repo", toolLimits })).toMatchObject({ max_output_chars: 20000 });
  });

  it("still narrows a background hand-off when the host configures bashTimeoutMs", () => {
    const toolLimits = { toolTextLimitChars: 16000, bashOutputLimitChars: 20000, searchResultLimit: 100 };

    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout_ms: 14_400_000,
      background: true,
    }, { cwd: "/repo", toolLimits: { ...toolLimits, bashTimeoutMs: 5000 } })).toMatchObject({ timeout_ms: 5000 });
  });

  it("keeps the foreground timeout ceiling in force", () => {
    const toolLimits = { toolTextLimitChars: 16000, bashOutputLimitChars: 20000, searchResultLimit: 100 };

    expect(normalizePiBuiltinToolParams("Bash", {
      command: "ls",
      timeout_ms: 14_400_000,
    }, { cwd: "/repo", toolLimits })).toMatchObject({ timeout_ms: 120_000 });
  });

  it("states the host's configured background ceiling in the tool schema", () => {
    // The model must be able to size the work BEFORE launching. Learning the
    // budget only from a start receipt means it has already committed to a plan.
    const [bash, exec] = ["Bash", "Exec"].map((name) => getPiBuiltinTools([name], {
      cwd: "/repo",
      processJobsController: {
        start: async () => ({ jobId: "pj", state: "queued", startedAt: null }),
        limits: { maxRuntimeMs: 28_800_000, maxOutputBytes: 1_048_576 },
      },
    }).find((tool) => tool.name === name));

    for (const tool of [bash, exec]) {
      expect(tool.parameters.properties.background.description).toContain("8h (28800000 ms)");
      expect(tool.parameters.properties.background.description).toContain("max_runtime_ms");
      expect(tool.parameters.properties.timeout_ms.description).toContain("2m (120000 ms)");
      expect(tool.parameters.properties.timeout_ms.description).toContain("8h (28800000 ms)");
    }
  });

  it("states no background ceiling when the host publishes none", () => {
    const bash = getPiBuiltinTools(["Bash"], {
      cwd: "/repo",
      processJobsController: { start: async () => ({ jobId: "pj", state: "queued", startedAt: null }) },
    }).find((tool) => tool.name === "Bash");

    expect(bash.parameters.properties.background.description).not.toContain("ms)");
    expect(bash.parameters.properties.timeout_ms.description).toContain("2m (120000 ms)");
  });

  it("returns image files read by the builtin Read tool as an image content block", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root });
    const pngBytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png().toBuffer();
    writeFileSync(join(root, "shot.png"), pngBytes);

    const read = getPiBuiltinTools(["Read"], { cwd: root }).find((tool) => tool.name === "Read");
    const result = await read.execute("Read:1", { file_path: "shot.png" });

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: pngBytes.toString("base64"),
    });
  });

  it("rejects corrupt Read images before creating image content blocks", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root });
    writeFileSync(join(root, "broken.png"), Buffer.from("not an image"));

    const read = getPiBuiltinTools(["Read"], { cwd: root }).find((tool) => tool.name === "Read");

    await expect(read.execute("Read:broken", { file_path: "broken.png" }))
      .rejects.toThrow(/^Error: Unable to read image .*broken\.png:/);
  });

  it("caps oversize Read images through the shared tool-result bloat guard", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root });
    const runArtifactDir = join(root, ".mono-agent", "artifacts", "run-read-image");
    const big = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png({ compressionLevel: 0 }).toBuffer();
    writeFileSync(join(root, "big.png"), big);
    const truncations = [];

    const read = getPiBuiltinTools(["Read"], {
      cwd: root,
      toolPayloadMaxBytes: 10,
      persistArtifact: makeSink(runArtifactDir),
      onTruncate: (event) => truncations.push(event),
    }).find((tool) => tool.name === "Read");
    const result = await read.execute("Read:2", { file_path: "big.png" });

    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("saved_to=");
    expect(truncations[0]).toMatchObject({ tool: "Read", max_bytes: 10 });
    // The oversize payload is persisted as an image (.png), proving it was an
    // image block — not the JSON-stringified object on the text path.
    const files = readdirSync(join(runArtifactDir, "tool-output"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);
  });

  it("lets large Read images through when imageInlineMaxBytes is high", async () => {
    const root = tempWorkspace();
    configureToolRuntime({ workspace: root });
    // Larger than toolPayloadMaxBytes but within imageInlineMaxBytes.
    const big = await sharp({
      create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
    }).png({ compressionLevel: 0 }).toBuffer();
    writeFileSync(join(root, "big.png"), big);

    const read = getPiBuiltinTools(["Read"], {
      cwd: root,
      toolPayloadMaxBytes: 256,
      imageInlineMaxBytes: 1_000_000,
      persistArtifact: makeSink(join(root, ".mono-agent", "artifacts", "run-big-img")),
    }).find((tool) => tool.name === "Read");
    const result = await read.execute("Read:big", { file_path: "big.png" });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: big.toString("base64"),
    });
  });

  it("resolves stdio MCP cwd from the run workdir", () => {
    expect(resolveMcpStdioCwd({}, "/repo/project")).toBe("/repo/project");
    expect(resolveMcpStdioCwd({ cwd: "tools" }, "/repo/project")).toBe("/repo/project/tools");
    expect(resolveMcpStdioCwd({ cwd: "/opt/mcp" }, "/repo/project")).toBe("/opt/mcp");
  });

  it("prepares stdio MCP commands through the configured sandbox engine", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/project" });
    const prepared = await prepareMcpStdioCommand(
      { command: "node", args: ["server.js"], cwd: "tools" },
      {
        cwd: "/repo/project",
        sandboxPolicy: policy,
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: "sandbox",
              args: [command.command, ...(command.args ?? [])],
              sandboxed: true,
            };
          },
        },
      },
    );

    expect(prepared).toMatchObject({
      command: "sandbox",
      args: ["node", "server.js"],
      cwd: "/repo/project/tools",
      sandboxed: true,
    });
  });

  it("forwards the non-serializable app-owned local-binding capability to only that MCP command", async () => {
    const policy = failClosedSandboxPolicy({ root: "/repo/project" });
    const cfg = { command: "node", args: ["adapter-send.js"] };
    Object.defineProperty(cfg, Symbol.for("@mono-agent/app-owned-local-binding"), {
      value: true,
      enumerable: false,
    });
    const seen = [];

    await prepareMcpStdioCommand(cfg, {
      cwd: "/repo/project",
      sandboxPolicy: policy,
      sandboxEngine: {
        id: "fake",
        async isAvailable() {
          return true;
        },
        async prepareCommand(command) {
          seen.push(command);
          return { ...command, sandboxed: true };
        },
      },
    });
    await prepareMcpStdioCommand({ command: "node", args: ["ordinary.js"] }, {
      cwd: "/repo/project",
      sandboxPolicy: policy,
      sandboxEngine: {
        id: "fake",
        async isAvailable() {
          return true;
        },
        async prepareCommand(command) {
          seen.push(command);
          return { ...command, sandboxed: true };
        },
      },
    });

    expect(seen[0]).toMatchObject({ allowLocalBinding: true });
    expect(seen[1]).not.toHaveProperty("allowLocalBinding");
    expect(JSON.stringify(cfg)).not.toContain("local-binding");
  });

  it("prepares stdio MCP commands under the context-configured sandbox policy without per-call options", async () => {
    const root = tempWorkspace();
    configureToolRuntime({
      workspace: root,
      sandboxPolicy: failClosedSandboxPolicy({ root }),
    });

    const prepared = await prepareMcpStdioCommand(
      { command: "node", args: ["server.js"] },
      {
        cwd: root,
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return { ...command, command: "sandbox", sandboxed: true };
          },
        },
      },
    );

    expect(prepared).toMatchObject({ command: "sandbox", sandboxed: true });
  });

  it("cleans up sandboxed stdio MCP commands when client connect fails", async () => {
    const root = tempWorkspace();
    const policy = failClosedSandboxPolicy({ root });
    let cleanupCalls = 0;
    const result = await initPiMcpTools(
      {
        broken: {
          command: "node",
          args: ["server.js"],
          cwd: ".",
        },
      },
      new Set(),
      {
        cwd: root,
        sandboxPolicy: policy,
        sandboxEngine: {
          id: "fake",
          async isAvailable() {
            return true;
          },
          async prepareCommand(command) {
            return {
              ...command,
              command: process.execPath,
              args: ["-e", "process.exit(1)"],
              cwd: root,
              sandboxed: true,
              cleanup: async () => {
                cleanupCalls += 1;
              },
            };
          },
        },
      },
    );

    expect(result.clients).toEqual([]);
    expect(result.warnings).toMatchObject([{ warning_kind: "mcp_init_failed", server: "broken" }]);
    expect(cleanupCalls).toBe(1);
  });

  it("never serializes or echoes a private request capability URL in MCP warnings", async () => {
    const secretUrl = "http://127.0.0.1:43199/mcp/11111111-1111-4111-8111-111111111111";
    const spec = { type: "http" };
    Object.defineProperty(spec, "url", { value: secretUrl, enumerable: false });
    Object.defineProperty(spec, Symbol.for("@mono-agent/private-capability-url"), {
      value: true,
      enumerable: false,
    });
    const connectSpy = vi.spyOn(McpClient.prototype, "connect")
      .mockRejectedValue(new Error(`Connection failed for ${secretUrl}`));
    try {
      const result = await initPiMcpTools({ private: spec });
      expect(JSON.stringify(spec)).toBe('{"type":"http"}');
      expect(result.warnings).toEqual([expect.objectContaining({
        warning_kind: "mcp_init_failed",
        server: "private",
        message: "Private request-scoped MCP server connection failed.",
      })]);
      expect(JSON.stringify(result.warnings)).not.toContain(secretUrl);
    } finally {
      connectSpy.mockRestore();
    }
  });

  it("passes an explicit request timeout to MCP callTool so the SDK's 60s default cannot pre-empt a long in-process tool", async () => {
    // The MCP SDK request timeout defaults to 60s (DEFAULT_REQUEST_TIMEOUT_MSEC) and would fire
    // -32001 before the outer wall-clock cap — fatal for tools that run a whole agent turn (e.g.
    // notify_conversation delivery). The bridge must pass the configured cap as the SDK timeout.
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "do_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        { limits: { mcpCallTimeoutMs: 90000 } },
      );
      const tool = tools.find((entry) => entry.name === "do_thing");
      expect(tool).toBeTruthy();
      const ac = new AbortController();
      await tool.execute("call-1", {}, ac.signal);

      expect(callSpy).toHaveBeenCalledTimes(1);
      const [params, resultSchema, requestOptions] = callSpy.mock.calls[0];
      expect(params).toMatchObject({ name: "do_thing" });
      // resultSchema is left at the SDK default so the third arg carries our timeout.
      expect(resultSchema).toBeUndefined();
      // maxTotalTimeout is the separate hard wall clock (default 45min), NOT the
      // inactivity timeout — otherwise progress-based keep-alive could never
      // extend a call past the inactivity cap.
      expect(requestOptions).toMatchObject({ timeout: 90000, maxTotalTimeout: 2_700_000 });
      // A signal DERIVED from the caller's is forwarded (not the caller's own),
      // so run teardown can cancel this one call without touching the caller's.
      // Forwarding in both directions is covered by the two tests below.
      expect(requestOptions.signal).toBeInstanceOf(AbortSignal);
      expect(requestOptions.signal).not.toBe(ac.signal);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  // CONTRACT PIN (not an endorsement): host approval gates cover BUILT-IN tools
  // only. `getPiBuiltinTools` wraps its tools with wrapToolsWithApprovalGate;
  // `initPiMcpTools` has no approvalManager option at all, and pi-native's
  // turn-runner passes one only to the built-ins. So declaring an MCP server —
  // not approving a call — is the authorization boundary for its tools.
  //
  // This test exists because the agent-runtime README once promised the
  // opposite ("Per-call gating is the host's onToolApprovalRequest callback"),
  // which no test contradicted. If MCP calls ever DO become gated, this test
  // must fail, and the README's MCP + "Approval gates" sections must be
  // rewritten in the same change rather than the test being relaxed.
  it("does not route MCP tool calls through the host approval gate, though built-ins with the same manager are gated", async () => {
    const approvalCalls = [];
    const approvalManager = createApprovalManager({
      // Highest tier + a blanket deny: nothing that reaches the gate can run.
      defaultRiskTier: "high",
      onToolApprovalRequest: async (payload) => {
        approvalCalls.push(payload.toolName);
        return { decision: "deny", reason: "test denies every gated call" };
      },
    });

    // Control. Without this, a passing MCP assertion below could equally be
    // explained by an approval manager that never fires for anything.
    const root = tempWorkspace();
    const [bash] = getPiBuiltinTools(["Bash"], {
      cwd: root,
      onEvent: () => {},
      toolLimits: {},
      approvalManager,
    });
    await expect(bash.execute("gated-call", { command: "echo should-not-run" }))
      .rejects.toThrow(/Tool call denied/);
    expect(approvalCalls).toEqual(["Bash"]);

    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "danger_wipe", description: "mutating", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockResolvedValue({ content: [{ type: "text", text: "wiped" }] });
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        // The same manager the built-in above was denied by, passed the same way
        // a host would expect it to apply everywhere.
        { cwd: root, limits: {}, approvalManager },
      );
      const tool = tools.find((entry) => entry.name === "danger_wipe");
      expect(tool).toBeTruthy();

      const result = await tool.execute("ungated-call", {});

      // The mutating MCP call completed under a blanket-deny approval manager.
      expect(callSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual([{ type: "text", text: "wiped" }]);
      // And the host was never consulted: still only the built-in's request.
      expect(approvalCalls).toEqual(["Bash"]);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  it("forwards a caller abort to the SDK request while the call is on the wire", async () => {
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "slow_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    let observedSignal = null;
    let sawCall = null;
    const callStarted = new Promise((resolve) => { sawCall = resolve; });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockImplementation(async (_params, _schema, requestOptions) => {
        observedSignal = requestOptions?.signal ?? null;
        sawCall();
        return await new Promise((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(observedSignal.reason ?? new Error("aborted"));
          }, { once: true });
        });
      });
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        {},
      );
      const tool = tools.find((entry) => entry.name === "slow_thing");
      const ac = new AbortController();
      const settled = tool.execute("call-1", {}, ac.signal).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
      await callStarted;
      expect(observedSignal.aborted).toBe(false);

      ac.abort(new Error("caller went away"));

      expect(observedSignal.aborted).toBe(true);
      expect((await settled).ok).toBe(false);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  // mono-agent#664: a run torn down mid-`tools/call` used to close the client
  // straight out from under the in-flight request. The MCP SDK rejects the
  // caller locally on close, but never tells the SERVER — so a stdio proxy is
  // SIGTERM/SIGKILLed mid-request with its upstream work still outstanding.
  // Cancelling first sends `notifications/cancelled` so the server can unwind.
  it("cancels in-flight MCP calls on the wire before tearing the client down", async () => {
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "slow_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    let observedSignal = null;
    let sawCall = null;
    const callStarted = new Promise((resolve) => { sawCall = resolve; });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockImplementation(async (_params, _schema, requestOptions) => {
        observedSignal = requestOptions?.signal ?? null;
        sawCall();
        // Mirror the SDK: reject only when the request's own signal aborts.
        return await new Promise((_resolve, reject) => {
          observedSignal?.addEventListener("abort", () => {
            reject(observedSignal.reason ?? new Error("aborted"));
          }, { once: true });
        });
      });
    const closeSpy = vi.spyOn(McpClient.prototype, "close").mockResolvedValue(undefined);
    try {
      const { tools, clients } = await initPiMcpTools(
        { linear: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        { limits: { mcpCallTimeoutMs: 120000 } },
      );
      const tool = tools.find((entry) => entry.name === "slow_thing");
      const pending = tool.execute("call-1", {}, undefined);
      // Keep the rejection observed from the first tick so teardown cannot
      // surface as an unhandled rejection.
      const settled = pending.then(() => ({ ok: true }), (error) => ({ ok: false, error }));
      await callStarted;
      expect(observedSignal?.aborted).toBe(false);

      await closePiMcpClients(clients);

      expect(observedSignal?.aborted).toBe(true);
      const outcome = await settled;
      expect(outcome.ok).toBe(false);
      // Explainable and immediate, naming the server and tool — not a 120s silence.
      expect(String(outcome.error?.message ?? outcome.error)).toContain("linear");
      expect(String(outcome.error?.message ?? outcome.error)).toContain("slow_thing");
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it("intersects both shipped MCP Apps revisions and retains one exact connection until the host evicts it", async () => {
    const resourceUri = "ui://widgets/chart";
    const mimeType = "text/html;profile=mcp-app";
    let hostVersions = ["2025-11-21"];
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{
        name: "show_chart",
        description: "Show a chart",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { resourceUri } },
      }],
    });
    const callSpy = vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const readSpy = vi.spyOn(McpClient.prototype, "readResource").mockImplementation(async ({ uri }) => ({
      contents: [{ uri, mimeType, text: "<!doctype html><p>chart</p>" }],
    }));
    const registrations = [];
    const mcpApps = {
      get protocolVersions() { return hostVersions; },
      mimeTypes: [mimeType],
      recordFailure: vi.fn(),
      register: vi.fn(async (registration) => {
        registrations.push(registration);
        return { retainConnection: true, part: { type: "mcp_app" } };
      }),
    };
    let clients = [];
    try {
      const initialized = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        { mcpApps, runId: "run-app" },
      );
      clients = initialized.clients;
      const clientClose = vi.spyOn(clients[0].client, "close").mockResolvedValue(undefined);
      const tool = initialized.tools.find((entry) => entry.name === "show_chart");

      expect(clients[0].client._capabilities.extensions["io.modelcontextprotocol/ui"]).toEqual({
        mimeTypes: [mimeType],
      });
      await tool.execute("call-legacy", { range: "week" });
      hostVersions = ["2026-01-26"];
      await tool.execute("call-current", { range: "month" });

      expect(readSpy).toHaveBeenNthCalledWith(1, { uri: resourceUri });
      expect(registrations.map((entry) => entry.protocolVersion)).toEqual(["2025-11-21", "2026-01-26"]);
      expect(new Set(registrations.map((entry) => entry.connection.connectionId)).size).toBe(1);
      await closePiMcpClients(clients);
      expect(clientClose).not.toHaveBeenCalled();

      await registrations[0].connection.close();
      expect(clientClose).toHaveBeenCalledOnce();
      expect(clients[0].closed).toBe(true);
      await registrations[1].connection.close();
      expect(clientClose).toHaveBeenCalledOnce();
      expect(mcpApps.recordFailure).not.toHaveBeenCalled();
    } finally {
      await Promise.all(clients.map(async (client) => {
        client.retainedByMcpApps = false;
      }));
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
      readSpy.mockRestore();
    }
  });

  it("preserves MCP protocol errors and bounded structured content for the Pi harness hook", async () => {
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "failing_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi.spyOn(McpClient.prototype, "callTool").mockResolvedValue({
      isError: true,
      content: [{ type: "text", text: "permission denied" }],
      structuredContent: { code: "denied", diagnostic: "x".repeat(20_000) },
    });
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
      );
      const result = await tools.find((entry) => entry.name === "failing_thing").execute("call-error", {}, undefined);

      expect(result.content).toEqual([{ type: "text", text: "permission denied" }]);
      expect(result.details.mcp_result_is_error).toBe(true);
      expect(result.details.raw).toMatchObject({ truncated: true });
      expect(JSON.stringify(result.details.raw).length).toBeLessThan(10_000);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  it("attaches onprogress so the SDK resets its inactivity timeout, and forwards progress to onToolProgress", async () => {
    // Without an onprogress callback the MCP SDK never attaches a progressToken,
    // so resetTimeoutOnProgress is dead code and every long tool call dies at the
    // inactivity cap. The bridge must attach one and surface progress events.
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "slow_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockImplementation(async (_params, _schema, requestOptions) => {
        requestOptions?.onprogress?.({ progress: 3, total: 8, message: "tick 3" });
        return { content: [{ type: "text", text: "ok" }] };
      });
    try {
      const progressEvents = [];
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        {
          limits: { mcpCallTimeoutMs: 90000, mcpCallMaxTotalTimeoutMs: 500000 },
          onToolProgress: (event) => progressEvents.push(event),
        },
      );
      const tool = tools.find((entry) => entry.name === "slow_thing");
      await tool.execute("call-1", {}, undefined);

      const [, , requestOptions] = callSpy.mock.calls[0];
      expect(typeof requestOptions.onprogress).toBe("function");
      expect(requestOptions).toMatchObject({ timeout: 90000, resetTimeoutOnProgress: true, maxTotalTimeout: 500000 });
      expect(progressEvents).toEqual([
        {
          type: "tool_progress",
          server: "srv",
          tool: "slow_thing",
          toolCallId: "call-1",
          progress: 3,
          total: 8,
          message: "tick 3",
        },
      ]);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  it("keeps a slow MCP call alive past the inactivity cap while it reports progress", async () => {
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "slow_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    // Resolves at 220ms — far past the 90ms inactivity cap — but reports progress
    // every 25ms, which must reset BOTH the SDK timeout and the bridge's outer
    // wall-clock race.
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockImplementation((_params, _schema, requestOptions) => new Promise((resolvePromise) => {
        const ticker = setInterval(() => requestOptions?.onprogress?.({ progress: 1 }), 25);
        setTimeout(() => {
          clearInterval(ticker);
          resolvePromise({ content: [{ type: "text", text: "slow ok" }] });
        }, 220);
      }));
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        { limits: { mcpCallTimeoutMs: 90, mcpCallMaxTotalTimeoutMs: 5000 } },
      );
      const tool = tools.find((entry) => entry.name === "slow_thing");
      const out = await tool.execute("call-1", {}, undefined);
      expect(out.content[0].text).toBe("slow ok");
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  it("still times out a stalled MCP call that reports no progress", async () => {
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const listSpy = vi.spyOn(McpClient.prototype, "listTools").mockResolvedValue({
      tools: [{ name: "stalled_thing", description: "d", inputSchema: { type: "object", properties: {} } }],
    });
    const callSpy = vi
      .spyOn(McpClient.prototype, "callTool")
      .mockImplementation(() => new Promise(() => {}));
    try {
      const { tools } = await initPiMcpTools(
        { srv: { type: "http", url: "http://127.0.0.1:9/mcp" } },
        new Set(),
        { limits: { mcpCallTimeoutMs: 60, mcpCallMaxTotalTimeoutMs: 5000 } },
      );
      const tool = tools.find((entry) => entry.name === "stalled_thing");
      await expect(tool.execute("call-1", {}, undefined)).rejects.toThrow(/timed out/);
    } finally {
      connectSpy.mockRestore();
      listSpy.mockRestore();
      callSpy.mockRestore();
    }
  });

  it("blocks non-read-only Bash commands when planning shell policy is enforced", async () => {
    const root = tempWorkspace();
    const bash = getPiBuiltinTools(["Bash"], {
      cwd: root,
      toolPolicy: { bashReadOnly: true },
    }).find((tool) => tool.name === "Bash");

    await expect(bash.execute("tool-write", { command: "touch should-not-exist" })).rejects.toThrow("Planning shell policy");
    const result = await bash.execute("tool-read", { command: "pwd" });
    expect(result.content[0].text.trim()).toContain("agent-runtime-pi-bridge-");
  });

  it("routes Playwright MCP relative artifact filenames into the QA output directory", () => {
    const root = tempWorkspace();
    const qaOutputDir = join(root, ".mono-agent", "artifacts", "run-1");

    const screenshot = normalizeMcpToolParams("playwright", "browser_take_screenshot", {
      filename: "screens/title.png",
      fullPage: true,
    }, { qaOutputDir });
    expect(screenshot.filename).toBe(join(qaOutputDir, "screens", "title.png"));
    expect(existsSync(join(qaOutputDir, "screens"))).toBe(true);

    const snapshot = normalizeMcpToolParams("playwright", "browser_snapshot", {
      filename: "../snapshot.md",
    }, { qaOutputDir });
    expect(snapshot.filename).toBe(join(qaOutputDir, "snapshot.md"));

    const absolute = normalizeMcpToolParams("playwright", "browser_console_messages", {
      filename: "/tmp/console.log",
    }, { qaOutputDir });
    expect(absolute.filename).toBe("/tmp/console.log");

    const code = normalizeMcpToolParams("playwright", "browser_run_code", {
      filename: "result.json",
    }, { qaOutputDir });
    expect(code.filename).toBe("result.json");
  });

  it("creates a reachable ReadSkill tool from an explicit skillsRoot", async () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "---\nname: research\n---\n# Research\n\nFull research skill body.\n");

    const tools = getPiBuiltinTools(["Read"], { skillsRoot, skillNames: ["research"] });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    expect(readSkill).toBeTruthy();
    expect(readSkill.description).toBe(
      "Load the complete instructions for a named skill. Use ReadSkill instead of Read for SKILL.md files. If a skill's instructions are already present in this conversation, apply those instead of loading it again.",
    );
    // The enum is restricted to the supplied skill names.
    expect(readSkill.parameters.properties.name.enum).toEqual(["research"]);

    const result = await readSkill.execute("ReadSkill:1", { name: "research" });
    expect(result.content[0].text).toContain("Full research skill body.");
    // Frontmatter is stripped from the returned body.
    expect(result.content[0].text).not.toContain("name: research");
  });

  it("creates ReadSkill for a subagent-shaped allowlist that never names it", () => {
    // Load-bearing for subagent skill inheritance: a profile enumerates its tools
    // explicitly (`["Bash","Read","Glob","Grep"]`) and would never think to list
    // ReadSkill, so the whole feature rests on this tool being deny-gated rather
    // than allow-gated. If that ever flips, children go silently tool-less and the
    // only symptom is wasted turns.
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nbody\n");

    const tools = getPiBuiltinTools(["Bash", "Read", "Glob", "Grep"], { skillsRoot, skillNames: ["research"] });
    expect(tools.find((tool) => tool.name === "ReadSkill")).toBeTruthy();
  });

  it("withholds ReadSkill when a profile denies it, under either spelling", () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nbody\n");

    // The deny gate honors a legacy alias; a policy that blocks only one spelling
    // is not a policy, so agent-app checks both when deciding what a child gets.
    for (const denied of ["ReadSkill", "read_skill"]) {
      const tools = getPiBuiltinTools(["Read"], { skillsRoot, skillNames: ["research"], disallowedTools: [denied] });
      expect(tools.find((tool) => tool.name === "ReadSkill"), denied).toBeFalsy();
    }
  });

  it("ReadSkill returns instructions beyond the legacy 12,000-character boundary", async () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    const sentinel = "full-body-sentinel-beyond-legacy-limit";
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "research", "SKILL.md"),
      `# Research\n\n${"x".repeat(12_500)}\n\n${sentinel}\n`,
    );

    const tools = getPiBuiltinTools([], { skillsRoot, skillNames: ["research"] });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    const result = await readSkill.execute("ReadSkill:full", { name: "research" });

    expect(result.content[0].text).toContain(sentinel);
    expect(result.content[0].text.length).toBeGreaterThan(12_000);
  });

  it("ReadSkill rejects path traversal and unknown skills", async () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nbody\n");
    // A sibling SKILL.md OUTSIDE the skills root must never be reachable.
    writeFileSync(join(root, "SKILL.md"), "# secret\n\nshould not be reachable\n");

    const tools = getPiBuiltinTools([], { skillsRoot, skillNames: ["research", "..", "../secret"] });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    // Traversal-shaped names are filtered out of the enum entirely.
    expect(readSkill.parameters.properties.name.enum).toEqual(["research"]);
    // Executing with a non-existent skill throws rather than reading anything.
    await expect(readSkill.execute("ReadSkill:miss", { name: "missing" })).rejects.toThrow("SKILL.md not found");
  });

  it("ReadSkill falls back to dataDir (skills under <dataDir>/skills) for back-compat", async () => {
    const dataDir = tempWorkspace();
    mkdirSync(join(dataDir, "skills", "writing"), { recursive: true });
    writeFileSync(join(dataDir, "skills", "writing", "SKILL.md"), "# Writing\n\nThe writing body.\n");

    const tools = getPiBuiltinTools([], { dataDir, skillNames: ["writing"] });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    expect(readSkill).toBeTruthy();
    const result = await readSkill.execute("ReadSkill:dd", { name: "writing" });
    expect(result.content[0].text).toContain("The writing body.");
  });

  it("does not create ReadSkill when neither skillsRoot nor dataDir is supplied", () => {
    const tools = getPiBuiltinTools([], { skillNames: ["research"] });
    expect(tools.find((tool) => tool.name === "ReadSkill")).toBeUndefined();
  });

  // Phase 5: ReadSkill accepts pi's neutral Skill shape ({name, description,
  // content, filePath, ...}) and derives each skill's root from its own filePath
  // when no shared skillsRoot/dataDir is threaded.
  it("ReadSkill accepts pi's Skill shape and derives root from a nested filePath", async () => {
    const root = tempWorkspace();
    const filePath = join(root, "skills", "research", "SKILL.md");
    const sentinel = "pi-file-path-sentinel-beyond-legacy-limit";
    mkdirSync(join(root, "skills", "research"), { recursive: true });
    writeFileSync(filePath, `---\nname: research\n---\n# Research\n\npi-shape body.\n${"x".repeat(12_500)}\n${sentinel}\n`);

    const tools = getPiBuiltinTools([], {
      skills: [{ name: "research", description: "when researching", content: "ignored — read lazily", filePath }],
    });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    expect(readSkill).toBeTruthy();
    expect(readSkill.parameters.properties.name.enum).toEqual(["research"]);

    const result = await readSkill.execute("ReadSkill:pi", { name: "research" });
    expect(result.content[0].text).toContain("pi-shape body.");
    expect(result.content[0].text).toContain(sentinel);
    expect(result.content[0].text).not.toContain("name: research");
    // The note points at the skill's own directory (the derived one-up root is
    // a prefix of this path, so asserting on it separately would be a weaker
    // duplicate of this check).
    expect(result.content[0].text).toContain(join(root, "skills", "research"));
  });

  it("ReadSkill accepts a flat <root>/<name>.md filePath (pi loadSkills flat form)", async () => {
    const root = tempWorkspace();
    const filePath = join(root, "writing.md");
    writeFileSync(filePath, "# Writing\n\nflat skill body.\n");

    const tools = getPiBuiltinTools([], {
      skills: [{ name: "writing", description: "d", content: "c", filePath }],
    });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    const result = await readSkill.execute("ReadSkill:flat", { name: "writing" });
    expect(result.content[0].text).toContain("flat skill body.");
  });

  it("prefers a shared skillsRoot over per-skill filePath (filePath used only when skillsRoot absent)", async () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nshared-root body.\n");
    // A DIFFERENT file the skill's filePath points at — must be ignored while a
    // shared root is present.
    const strayPath = join(root, "elsewhere", "research", "SKILL.md");
    mkdirSync(join(root, "elsewhere", "research"), { recursive: true });
    writeFileSync(strayPath, "# Research\n\nstray body — should not be read.\n");

    const tools = getPiBuiltinTools([], {
      skillsRoot,
      skillNames: ["research"],
      skills: [{ name: "research", description: "d", content: "c", filePath: strayPath }],
    });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    const result = await readSkill.execute("ReadSkill:shared", { name: "research" });
    expect(result.content[0].text).toContain("shared-root body.");
    expect(result.content[0].text).not.toContain("stray body");
  });

  it("ReadSkill supports the minimal {name}+skillsRoot form via the skills param", async () => {
    // agent-harness passes minimal {name} objects plus a shared skillsRoot; the
    // bridge maps them to skillNames AND forwards the objects. With a shared root
    // the objects lack filePath, so resolution stays on the shared-root path.
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nminimal-form body.\n");

    const tools = getPiBuiltinTools([], {
      skillsRoot,
      skillNames: ["research"],
      skills: [{ name: "research" }],
    });
    const readSkill = tools.find((tool) => tool.name === "ReadSkill");
    expect(readSkill.parameters.properties.name.enum).toEqual(["research"]);
    const result = await readSkill.execute("ReadSkill:min", { name: "research" });
    expect(result.content[0].text).toContain("minimal-form body.");
  });

  it("does not create ReadSkill for pi-shape skills whose name is unsafe or filePath is missing", () => {
    const tools = getPiBuiltinTools([], {
      skills: [
        { name: "../escape", description: "d", content: "c", filePath: "/tmp/escape/SKILL.md" },
        { name: "nofile", description: "d", content: "c" },
      ],
    });
    expect(tools.find((tool) => tool.name === "ReadSkill")).toBeUndefined();
  });

  it("passes abort signals to Bash tool execution", async () => {
    const root = tempWorkspace();
    const bash = getPiBuiltinTools(["Bash"], { cwd: root }).find((tool) => tool.name === "Bash");
    const ac = new AbortController();
    const promise = bash.execute("tool-1", {
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      timeout: 120000,
    }, ac.signal);

    setTimeout(() => ac.abort(), 50);

    await expect(promise).resolves.toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Error: Command aborted") }],
      details: {
        tool: "Bash",
        outcome: { status: "error", code: "aborted" },
      },
    });
  });
});

// The always-created built-ins getPiBuiltinTools owns. NodeRepl is run-owned and
// joins this set only when its controller is supplied. ReadSkill (legacy alias
// read_skill) is appended separately only when skills are supplied.
const BUILTIN_TOOL_NAMES = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Exec", "WebFetch", "WebSearch"];

function toolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}

describe("getPiBuiltinTools — allow-all wildcard + disallowedTools denylist", () => {
  it('treats the "*" sentinel as all built-in tools', () => {
    const tools = getPiBuiltinTools(["*"], {});
    expect(toolNames(tools)).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it('treats a wildcard mixed with named tools as all built-in tools', () => {
    const tools = getPiBuiltinTools(["*", "Read"], {});
    expect(toolNames(tools)).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("treats undefined as all built-in tools (unchanged)", () => {
    const tools = getPiBuiltinTools(undefined, {});
    expect(toolNames(tools)).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("treats [] as no built-in tools (unchanged)", () => {
    expect(getPiBuiltinTools([], {})).toEqual([]);
  });

  it("selects exactly the named subset (unchanged)", () => {
    const tools = getPiBuiltinTools(["Read", "Bash"], {});
    expect(toolNames(tools)).toEqual(["Bash", "Read"]);
  });

  it('applies disallowedTools to the "*" allow-all set (deny wins)', () => {
    const tools = getPiBuiltinTools(["*"], { disallowedTools: ["Bash"] });
    const names = tools.map((tool) => tool.name);
    expect(names).not.toContain("Bash");
    expect([...names].sort()).toEqual(BUILTIN_TOOL_NAMES.filter((name) => name !== "Bash").sort());
  });

  it("applies disallowedTools to an explicit allow list (deny wins)", () => {
    const tools = getPiBuiltinTools(["Read", "Bash"], { disallowedTools: ["Bash"] });
    expect(tools.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("exposes a sequential NodeRepl tool only when its run-owned controller is supplied", async () => {
    const execute = vi.fn(async () => "42");
    const controller = { execute };
    const tools = getPiBuiltinTools(["NodeRepl"], { nodeReplController: controller });
    const nodeRepl = tools.find((tool) => tool.name === "NodeRepl");
    const signal = new AbortController().signal;

    expect(nodeRepl).toMatchObject({
      label: "Node REPL",
      executionMode: "sequential",
      parameters: {
        type: "object",
        required: ["code"],
        additionalProperties: false,
        properties: { code: { type: "string", minLength: 1 } },
      },
    });
    await expect(nodeRepl.execute("NodeRepl:1", { code: "40 + 2" }, signal))
      .resolves.toMatchObject({ content: [{ type: "text", text: "42" }] });
    expect(execute).toHaveBeenCalledWith({ code: "40 + 2" }, { signal });
    expect(getPiBuiltinTools(["NodeRepl"], {})).toEqual([]);
  });

  it("applies wildcard and deny-wins policy to the run-owned NodeRepl tool", () => {
    const controller = { execute: vi.fn(async () => "ok") };
    expect(toolNames(getPiBuiltinTools(["*"], { nodeReplController: controller })))
      .toContain("NodeRepl");
    expect(toolNames(getPiBuiltinTools(["*"], {
      nodeReplController: controller,
      disallowedTools: ["NodeRepl"],
    }))).not.toContain("NodeRepl");
  });

  it("drops the ReadSkill tool when ReadSkill is disallowed, even with skills present", () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nbody\n");

    // Baseline: ReadSkill is present without the denylist.
    const withSkill = getPiBuiltinTools(["*"], { skillsRoot, skillNames: ["research"] });
    expect(withSkill.find((tool) => tool.name === "ReadSkill")).toBeTruthy();

    const denied = getPiBuiltinTools(["*"], {
      skillsRoot,
      skillNames: ["research"],
      disallowedTools: ["ReadSkill"],
    });
    expect(denied.find((tool) => tool.name === "ReadSkill")).toBeUndefined();
  });

  it("drops the ReadSkill tool when the legacy read_skill alias is disallowed", () => {
    const root = tempWorkspace();
    const skillsRoot = join(root, "skills");
    mkdirSync(join(skillsRoot, "research"), { recursive: true });
    writeFileSync(join(skillsRoot, "research", "SKILL.md"), "# Research\n\nbody\n");

    const denied = getPiBuiltinTools(["*"], {
      skillsRoot,
      skillNames: ["research"],
      disallowedTools: ["read_skill"], // legacy alias
    });
    expect(denied.find((tool) => tool.name === "ReadSkill")).toBeUndefined();
  });

describe("getPiBuiltinTools Agent registration", () => {
  const subagents = () => ({
    definitions: [{ name: "researcher", description: "d", systemPrompt: "s" }],
    run: async () => ({ text: "ok", events: [] }),
  });
  const names = (tools) => tools.map((tool) => tool.name);

  it("registers Agent only when subagents are wired for this run", () => {
    expect(names(getPiBuiltinTools(["Agent"], {}))).not.toContain("Agent");
    expect(names(getPiBuiltinTools(["Agent"], { subagents: subagents() }))).toContain("Agent");
  });

  it("suppresses Agent inside a subagent run", () => {
    expect(names(getPiBuiltinTools(["Agent"], { subagents: { ...subagents(), depth: 1 } })))
      .not.toContain("Agent");
  });

  it("honors the allow-all sentinel and deny-wins for Agent", () => {
    expect(names(getPiBuiltinTools(["*"], { subagents: subagents() }))).toContain("Agent");
    expect(names(getPiBuiltinTools(["*"], { subagents: subagents(), disallowedTools: ["Agent"] })))
      .not.toContain("Agent");
    expect(names(getPiBuiltinTools(["Read"], { subagents: subagents() }))).not.toContain("Agent");
  });

  it("keeps Agent parallel so it cannot serialize a mixed tool batch", () => {
    const agent = getPiBuiltinTools(["Agent"], { subagents: subagents() })
      .find((tool) => tool.name === "Agent");
    expect(agent.executionMode).toBeUndefined();
  });

  it("passes the run's skill context through to every child request", async () => {
    // Covers the turn-runner -> pi-bridge -> agent-tool seam: pi-bridge spreads
    // subagentContext into createAgentTool, so a skills-carrying run must produce
    // children whose requests carry them too.
    const run = vi.fn(async () => ({ text: "ok", events: [] }));
    const skills = [{ name: "research", description: "Reads the web." }];
    const agent = getPiBuiltinTools(["Agent"], {
      subagents: { ...subagents(), run },
      subagentContext: { skills, skillsRoot: "/repo/skills" },
    }).find((tool) => tool.name === "Agent");

    await agent.execute("c1", { name: "researcher", prompt: "x" });

    expect(run.mock.calls[0][0]).toMatchObject({ skills, skillsRoot: "/repo/skills" });
  });
});
});
