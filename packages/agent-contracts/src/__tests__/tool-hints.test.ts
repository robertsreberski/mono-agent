import { describe, expect, it } from "vitest";

import { toolHintFor } from "../tool-hints.js";

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
