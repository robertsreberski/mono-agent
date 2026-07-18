import { describe, expect, it, vi } from "vitest";

import { formatToolActivityLine, toolHintFor } from "../tool-hints.js";

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
    expect(formatToolActivityLine("ReadSkill", { path: "/repo/skills/review/SKILL.md" }))
      .toBe("📖 Reading /repo/skills/review/SKILL.md");
    expect(formatToolActivityLine("apply_patch", { path: "/repo/src/really-long-file-name-that-keeps-going.ts" }))
      .toBe("✏️ Editing /repo/src/really-long-file-name-that-ke…");
    expect(formatToolActivityLine("mcp__browser__browser_console", {}))
      .toBe("🔧 Browser console");
  });

  it.each([
    ["WebFetch", { url: "https://example.test" }, "🌐 Browsing https://example.test"],
    ["Read", { path: "/repo/file.ts" }, "📖 Reading /repo/file.ts"],
    ["Grep", { pattern: "needle" }, "🔎 Searching files for needle"],
    ["Write", { path: "/repo/new.ts" }, "📝 Writing /repo/new.ts"],
    ["Edit", { path: "/repo/existing.ts" }, "✏️ Editing /repo/existing.ts"],
    ["terminal", { command: "pnpm test" }, "🖥️ Running pnpm test"],
    ["python", { code: "print(42)" }, "🐍 Running code print(42)"],
    ["vision", { question: "identify product" }, "👁️ Looking at the image identify product"],
    ["MemoryRecall", { query: "private preferences" }, "📚 Reading memory"],
    ["memory_recall", { query: "private preferences" }, "📚 Reading memory"],
    ["memory_write", { target: "preferences" }, "🧠 Updating memory preferences"],
  ])("maps %s to its stable activity family", (name, args, expected) => {
    expect(formatToolActivityLine(name, args)).toBe(expected);
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
