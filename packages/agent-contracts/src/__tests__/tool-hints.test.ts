import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatLiveInputActivityLine,
  formatProviderStatusLine,
  formatToolActivityLine,
  isSubagentLaunchToolName,
  setToolActivityPathRoots,
  splitSubagentToolName,
  toolHintFor,
} from "../tool-hints.js";

describe("subagent tool names", () => {
  it("splits a forwarded name into its profile and tool", () => {
    expect(splitSubagentToolName("researcher▸Read")).toEqual({ profile: "researcher", tool: "Read" });
  });

  it("leaves an ordinary tool name untouched", () => {
    expect(splitSubagentToolName("Read")).toEqual({ tool: "Read" });
    expect(splitSubagentToolName("mcp__gws__calendar_list_events"))
      .toEqual({ tool: "mcp__gws__calendar_list_events" });
  });

  it("keeps the raw name when a separator carries no tool", () => {
    expect(splitSubagentToolName("researcher▸")).toEqual({ tool: "researcher▸" });
    expect(splitSubagentToolName("▸Read")).toEqual({ tool: "Read" });
  });

  it("recognizes the launch tool regardless of case or namespace", () => {
    expect(isSubagentLaunchToolName("Agent")).toBe(true);
    expect(isSubagentLaunchToolName("agent")).toBe(true);
    expect(isSubagentLaunchToolName("mcp__helper__task")).toBe(true);
    expect(isSubagentLaunchToolName("Read")).toBe(false);
    expect(isSubagentLaunchToolName("")).toBe(false);
  });

  it("formats a launch as a header naming the profile", () => {
    expect(formatToolActivityLine("Agent", { name: "researcher", prompt: "find X" }))
      .toBe('🤖 Starting agent "researcher"');
    expect(formatToolActivityLine("Agent", { prompt: "find X" })).toBe("🤖 Starting a subagent");
  });

  it("formats a forwarded child call as the tool it actually ran", () => {
    // Without stripping the profile the whole string is one unknown token and
    // this degrades to a generic "🔧 Researcher read".
    expect(formatToolActivityLine("researcher▸Read", { file_path: "/repo/a.ts" }))
      .toBe("📖 Reading /repo/a.ts");
    expect(toolHintFor("researcher▸WebSearch")).toBe("Searching the web…");
  });
});

describe("toolHintFor", () => {
  it("maps built-in tools to friendly hints", () => {
    expect(toolHintFor("WebSearch")).toBe("Searching the web…");
    expect(toolHintFor("Bash")).toBe("Running a command…");
    expect(toolHintFor("Edit")).toBe("Editing a file…");
  });

  it("derives a hint from the tool segment of an MCP tool name", () => {
    expect(toolHintFor("mcp__gws__calendar_list_events")).toBe("Checking the calendar…");
    expect(toolHintFor("mcp__todoist__add_task")).toBe("Checking your tasks…");
  });

  it("falls back to a generic hint for unknown tools (never a raw name)", () => {
    expect(toolHintFor("SomethingWeird")).toBe("Working…");
    expect(toolHintFor("")).toBe("Working…");
  });
});

describe("formatToolActivityLine", () => {
  it("maps common tools to friendly actions with collapsed, bounded previews", () => {
    expect(formatToolActivityLine("WebSearch", { query: "  exact   product\nretailer  " }))
      .toBe("🌐 Searching the web for exact product retailer");
    expect(formatToolActivityLine("ReadSkill", {
      name: "review",
      path: "/repo/skills/review/SKILL.md",
    })).toBe('📚 Reading "review"');
    expect(formatToolActivityLine("ReadSkill", { path: "/repo/skills/private/SKILL.md" }))
      .toBe("📚 Reading");
    expect(formatToolActivityLine("apply_patch", { path: "/repo/src/really-long-file-name-that-keeps-going.ts" }))
      .toBe("✏️ Editing /repo/src/rea…e-name-that-keeps-going.ts");
    expect(formatToolActivityLine("mcp__browser__browser_console", {}))
      .toBe("🔧 Browser console");
  });

  it("relativizes workspace paths and collapses the home directory in previews", () => {
    const options = { workspaceRoot: "/Users/example/agents/assistant", homeDir: "/Users/example" };
    expect(formatToolActivityLine("Read", { file_path: "/Users/example/agents/assistant/backlog.md" }, options))
      .toBe("📖 Reading backlog.md");
    expect(formatToolActivityLine("Edit", { path: "/Users/example/agents/assistant/skills/x/SKILL.md" }, options))
      .toBe("✏️ Editing skills/x/SKILL.md");
    expect(formatToolActivityLine("Read", { file_path: "/Users/example/other-repo/notes.md" }, options))
      .toBe("📖 Reading ~/other-repo/notes.md");
    expect(formatToolActivityLine("bash", { command: "cat /Users/example/agents/assistant/daily/2026-07-20.md" }, options))
      .toBe("🖥️ Running cat daily/2026-07-20.md");
    expect(formatToolActivityLine("Exec", {
      executable: "cat",
      args: ["/Users/example/agents/assistant/daily/2026-07-20.md"],
    }, options)).toBe("🖥️ Running cat daily/2026-07-20.md");
    // Paths outside both roots stay untouched.
    expect(formatToolActivityLine("Read", { file_path: "/etc/hosts" }, options))
      .toBe("📖 Reading /etc/hosts");
  });

  describe("process-wide path roots", () => {
    afterEach(() => {
      setToolActivityPathRoots({});
    });

    it("relativizes against the configured roots when a caller passes no options", () => {
      // The streaming call site has no per-message workspace to hand down, so
      // without this the root falls back to process.cwd() — which for a
      // service-managed agent is not the agent directory.
      setToolActivityPathRoots({ workspaceRoot: "/srv/agents/assistant", homeDir: "/srv" });
      expect(formatToolActivityLine("Read", { file_path: "/srv/agents/assistant/backlog.md" }))
        .toBe("📖 Reading backlog.md");
      expect(formatToolActivityLine("Exec", {
        executable: "rg",
        args: ["needle", "/srv/agents/assistant/src"],
      })).toBe("🖥️ Running rg needle src");
      expect(formatToolActivityLine("Read", { file_path: "/srv/other/notes.md" }))
        .toBe("📖 Reading ~/other/notes.md");
    });

    it("lets explicit options override the configured roots", () => {
      setToolActivityPathRoots({ workspaceRoot: "/srv/agents/assistant", homeDir: "/srv" });
      expect(formatToolActivityLine(
        "Read",
        { file_path: "/Users/example/agent/backlog.md" },
        { workspaceRoot: "/Users/example/agent", homeDir: "/Users/example" },
      )).toBe("📖 Reading backlog.md");
    });
  });

  it.each([
    ["WebFetch", { url: "https://example.test" }, "🌐 Browsing https://example.test"],
    ["Read", { path: "/repo/file.ts" }, "📖 Reading /repo/file.ts"],
    ["Grep", { pattern: "needle" }, "🔎 Searching files for needle"],
    ["Write", { path: "/repo/new.ts" }, "📝 Writing /repo/new.ts"],
    ["Edit", { path: "/repo/existing.ts" }, "✏️ Editing /repo/existing.ts"],
    ["terminal", { command: "pnpm test" }, "🖥️ Running pnpm test"],
    ["python", { code: "print(42)" }, "🐍 Running code print(42)"],
    ["NodeRepl", { code: "1 + 1" }, "🐍 Running code 1 + 1"],
    ["vision", { question: "identify product" }, "👁️ Looking at the image identify product"],
    ["MemoryRecall", { query: "private preferences" }, "🧠 Recalling memory"],
    ["memory_recall", { query: "private preferences" }, "🧠 Recalling memory"],
    ["memory_write", { target: "preferences" }, "🧠 Updating memory preferences"],
  ])("maps %s to its stable activity family", (name, args, expected) => {
    expect(formatToolActivityLine(name, args)).toBe(expected);
  });

  it.each([
    [{ executable: "git", args: ["status", "--short"] }, "🖥️ Running git status --short"],
    [{ executable: "git" }, "🖥️ Running git"],
    [{ executable: "git", args: [] }, "🖥️ Running git"],
    // Non-argv fields never leak into the preview.
    [{ executable: "ls", args: ["-la"], workdir: "/repo", timeout_ms: 5_000 }, "🖥️ Running ls -la"],
    // A missing program leaves nothing safe to show; args alone are not a command.
    [{ args: ["status", "--short"] }, "🖥️ Running"],
  ])("renders an argv tool as one command line: %o", (args, expected) => {
    expect(formatToolActivityLine("Exec", args)).toBe(expected);
  });

  it("prefers an explicit command field over argv when a tool carries both", () => {
    expect(formatToolActivityLine("Exec", {
      command: "make build",
      executable: "git",
      args: ["status"],
    })).toBe("🖥️ Running make build");
  });

  it("truncates a long argv line on the same balanced 40-code-point bound as a command", () => {
    const line = formatToolActivityLine("Exec", {
      executable: "pnpm",
      args: ["--filter", "@mono-agent/agent-contracts", "test"],
    });

    expect(line).toBe("🖥️ Running pnpm --filter @mono-…gent-contracts test");
    expect(Array.from(line.slice("🖥️ Running ".length))).toHaveLength(40);
  });

  it("bounds the join for a pathological argv before truncation", () => {
    const line = formatToolActivityLine("Exec", {
      executable: "rg",
      args: Array.from({ length: 256 }, () => "x".repeat(64)),
    });

    expect(Array.from(line.slice("🖥️ Running ".length))).toHaveLength(40);
  });

  it("redacts argv credentials exactly as it redacts a shell command line", () => {
    const slackToken = ["xoxb", "1234567890-fixtureCredential"].join("-");
    const header = formatToolActivityLine("Exec", {
      executable: "curl",
      args: ["-H", `Authorization: Bearer ${slackToken}`],
    });

    expect(header).toContain("[redacted]");
    expect(header).not.toContain(slackToken);
    expect(formatToolActivityLine("Exec", {
      executable: "deploy",
      args: ["--api-key", "hunter2"],
    })).toBe("🖥️ Running deploy --api-key [redacted]");
  });

  it("keeps a truthful argv prefix without invoking array traps or accessors", () => {
    const elementGetter = vi.fn(() => { throw new Error("must not run"); });
    const accessorArgs: string[] = ["status"];
    Object.defineProperty(accessorArgs, "1", { get: elementGetter, configurable: true });
    const fieldGetter = vi.fn(() => { throw new Error("must not run"); });
    const accessorField = { executable: "git" };
    Object.defineProperty(accessorField, "args", { get: fieldGetter });
    const proxyGet = vi.fn(() => "secret");
    const proxiedArgs = new Proxy(["status"], { get: proxyGet });

    expect(formatToolActivityLine("Exec", { executable: "git", args: accessorArgs }))
      .toBe("🖥️ Running git status");
    expect(formatToolActivityLine("Exec", accessorField)).toBe("🖥️ Running git");
    expect(formatToolActivityLine("Exec", { executable: "git", args: proxiedArgs }))
      .toBe("🖥️ Running git");
    // A hole makes the rest of an argv positionally meaningless: stop, never splice.
    expect(formatToolActivityLine("Exec", { executable: "git", args: ["status", 3, "--short"] }))
      .toBe("🖥️ Running git status");
    expect(formatToolActivityLine("Exec", { executable: "git", args: "status" }))
      .toBe("🖥️ Running git");
    expect(elementGetter).not.toHaveBeenCalled();
    expect(fieldGetter).not.toHaveBeenCalled();
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("redacts credentials, auth headers, URL userinfo, and sensitive query parameters", () => {
    const openAiToken = ["sk", "fixtureCredential0123456789"].join("-");
    const slackToken = ["xoxb", "1234567890-fixtureCredential"].join("-");
    const command = `OPENAI_API_KEY=${openAiToken} Authorization: Bearer ${slackToken}`;
    const commandLine = formatToolActivityLine("Bash", { command });
    const urlLine = formatToolActivityLine("WebFetch", {
      url: "https://user:pass@x.test/?token=fixture",
    });

    expect(commandLine).toContain("[redacted]");
    expect(commandLine).not.toContain(openAiToken);
    expect(commandLine).not.toContain(slackToken);
    expect(urlLine).toBe("🌐 Browsing https://x.test/?token=[redacted]");
    expect(urlLine).not.toContain("user:pass");
    expect(urlLine).not.toContain("fixture");
  });

  it.each([
    ["mysql connect --password hunter2", "hunter2"],
    ["command with a deliberately long prefix --token abc", "abc"],
    ["curl to a deliberately long endpoint -u user:pass", "user:pass"],
    ["deploy with a deliberately long prefix --client-secret hunter2", "hunter2"],
    ["deploy with a deliberately long prefix --db-password hunter2", "hunter2"],
    ["mysql --host localhost with-a-long-option -p hunter2", "hunter2"],
    ["mysqldump --host localhost -phunter2", "hunter2"],
  ])("redacts command-line credentials before retaining the command ending: %s", (command, secret) => {
    const line = formatToolActivityLine("Bash", { command });

    expect(line).toContain("[redacted]");
    expect(line).not.toContain(secret);
    expect(Array.from(line.slice("🖥️ Running ".length)).length).toBeLessThanOrEqual(40);
  });

  it.each([
    ["postgresql://alice:hunter2@db.example/app", "hunter2", "db.example/app"],
    ["redis://:hunter2@cache.example:6379/0", "hunter2", "example:6379/0"],
    ["ftp://alice:hunter2@files.example/archive", "hunter2", "example/archive"],
  ])("redacts URI userinfo before retaining a command suffix: %s", (uri, secret, safeSuffix) => {
    const line = formatToolActivityLine("Bash", {
      command: `run a deliberately long synchronization command ${uri}`,
    });

    expect(line).not.toContain(secret);
    expect(line).not.toContain("alice");
    expect(line).not.toContain("@");
    expect(line).toContain(safeSuffix);
    expect(Array.from(line.slice("🖥️ Running ".length))).toHaveLength(40);
  });

  it("does not treat a generic short -p option as a password outside MySQL-family commands", () => {
    expect(formatToolActivityLine("Bash", { command: "mkdir -p /workspace/output" }))
      .toBe("🖥️ Running mkdir -p /workspace/output");
  });

  it("keeps filenames and command endings visible within the existing 40-code-point bound", () => {
    const path = formatToolActivityLine("Read", {
      path: "/workspace/demo/personal-agent/.mono-agent/outbound/spec-transcription-20260718.md",
    });
    const command = formatToolActivityLine("Bash", {
      command: "./bin/todoist-upsert --spec .mono-agent/outbound/spec-transcription-20260718.json",
    });

    expect(path).toBe("📖 Reading /workspace/de…-transcription-20260718.md");
    expect(command).toBe("🖥️ Running ./bin/todoist-upsert…ption-20260718.json");
    expect(Array.from(path.slice("📖 Reading ".length))).toHaveLength(40);
    expect(Array.from(command.slice("🖥️ Running ".length))).toHaveLength(40);
  });

  it("truncates previews by Unicode code point while retaining redaction", () => {
    const secret = ["sk", "fixtureCredential0123456789"].join("-");
    const line = formatToolActivityLine("Bash", {
      command: `echo 🧠🧠🧠 OPENAI_API_KEY=${secret} then-run-the-important-final-command`,
    });
    const preview = line.slice("🖥️ Running ".length);

    expect(Array.from(preview)).toHaveLength(40);
    expect(line).not.toContain(secret);
    expect(line).toContain("final-command");
  });

  it.each(["TOKEN", "PASSWORD", "COOKIE", "API_KEY"])(
    "redacts exact %s assignments without requiring a prefix",
    (name) => {
      const line = formatToolActivityLine("Bash", {
        command: `${name}=fixture echo ok`,
      });

      expect(line).toBe(`🖥️ Running ${name}=[redacted] echo ok`);
      expect(line).not.toContain("fixture");
    },
  );

  it("uses action-only copy for hostile arguments without invoking traps or getters", () => {
    const getter = vi.fn(() => { throw new Error("must not run"); });
    const args = {};
    Object.defineProperty(args, "command", { get: getter });
    const proxyGet = vi.fn(() => "secret");
    const proxy = new Proxy({}, { get: proxyGet });

    expect(formatToolActivityLine("Bash", args)).toBe("🖥️ Running");
    expect(formatToolActivityLine("Bash", proxy)).toBe("🖥️ Running");
    expect(getter).not.toHaveBeenCalled();
    expect(proxyGet).not.toHaveBeenCalled();
  });

  it("does not expose memory content fields", () => {
    expect(formatToolActivityLine("UpdateMemory", {
      action: "append preference",
      content: "private user profile",
    })).toBe("🧠 Updating memory append preference");
  });
});

describe("formatLiveInputActivityLine", () => {
  it("renders a one-line steering preview with the shared secret redaction", () => {
    expect(formatLiveInputActivityLine("  Use TOKEN=fixture\nthen continue  "))
      .toBe("↪️ Steered: “Use TOKEN=[redacted] then continue”");
  });

  it("collapses local paths and caps the preview at 40 Unicode code points", () => {
    const line = formatLiveInputActivityLine(
      `Review /Users/example/agent/${"🧠".repeat(50)}/result.md`,
      { workspaceRoot: "/Users/example/agent", homeDir: "/Users/example" },
    );
    const prefix = "↪️ Steered: “";
    const preview = line.slice(prefix.length, -1);

    expect(line).not.toContain("/Users/example");
    expect(Array.from(preview)).toHaveLength(40);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("uses a stable label when no safe preview remains", () => {
    expect(formatLiveInputActivityLine("\n\t")).toBe("↪️ Steered");
  });
});

describe("formatProviderStatusLine", () => {
  it("announces a route change with its cause", () => {
    expect(formatProviderStatusLine({
      type: "provider_status",
      kind: "failover_started",
      from: "pi:openai-codex:gpt-5.6-sol",
      to: "pi:opencode-go:kimi-k2.7-code",
      attemptIndex: 1,
      reason: "overloaded",
    })).toBe("⚠️ Failed over: pi:openai-codex:gpt-5.6-sol → pi:opencode-go:kimi-k2.7-code (overloaded)");
  });

  it("omits the cause when the router could not classify it", () => {
    expect(formatProviderStatusLine({
      type: "provider_status",
      kind: "failover_started",
      from: "a",
      to: "b",
    })).toBe("⚠️ Failed over: a → b");
  });

  it("words a same-model retry as a retry, not a failover", () => {
    expect(formatProviderStatusLine({
      type: "provider_status",
      kind: "retry_started",
      model: "pi:openai-codex:gpt-5.6-sol",
      attemptIndex: 0,
      retryIndex: 1,
      reason: "overloaded",
    })).toBe("⏳ Retrying pi:openai-codex:gpt-5.6-sol — attempt 2 (overloaded)");
  });

  it("stays silent for the kinds the final answer already accounts for", () => {
    for (const kind of ["request_started", "request_completed", "failover_completed"] as const) {
      expect(formatProviderStatusLine({ type: "provider_status", kind, model: "m" })).toBeUndefined();
    }
  });

  it("falls back to a stable placeholder when a route reference is missing", () => {
    expect(formatProviderStatusLine({ type: "provider_status", kind: "failover_started" }))
      .toBe("⚠️ Failed over: ? → ?");
    expect(formatProviderStatusLine({ type: "provider_status", kind: "retry_started" }))
      .toBe("⏳ Retrying ? — attempt 2");
  });
});
