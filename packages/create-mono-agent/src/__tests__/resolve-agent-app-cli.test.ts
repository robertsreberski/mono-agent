import { existsSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentAppCliEntry } from "../resolve-agent-app-cli.js";

describe("resolveAgentAppCliEntry", () => {
  it("resolves @mono-agent/app's mono-agent CLI bin to an existing file", () => {
    const entry = resolveAgentAppCliEntry();
    // Points into the app package and at its shipped CLI entry.
    expect(entry).toMatch(/[\\/]app[\\/]/u);
    expect(basename(entry)).toBe("cli.js");
    // The dependency must actually ship the file the bin promises.
    expect(existsSync(entry)).toBe(true);
  });
});
