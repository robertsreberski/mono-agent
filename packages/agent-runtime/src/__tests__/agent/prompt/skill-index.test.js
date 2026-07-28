import { describe, expect, it } from "vitest";
import { formatSkillBodyWithPathNote } from "../../../agent/prompt/skill-index.js";

describe("formatSkillBodyWithPathNote", () => {
  it("returns the complete rendered skill when maxChars is omitted", () => {
    const body = `# Research\n\n${"x".repeat(12_500)}\n\nfull-body-sentinel`;
    const result = formatSkillBodyWithPathNote({ body });

    expect(result).toContain("full-body-sentinel");
    expect(result.length).toBeGreaterThan(12_000);
  });

  it("applies a positive maxChars as an explicit truncation limit", () => {
    const full = formatSkillBodyWithPathNote({ body: "A complete skill body." });
    const capped = formatSkillBodyWithPathNote({
      body: "A complete skill body.",
      maxChars: 24,
    });

    expect(capped).toBe(full.slice(0, 24));
    expect(capped).toHaveLength(24);
  });
});
