import { describe, expect, it } from "vitest";

import type { SkillInfo } from "./types";
import {
  detectSkillQuery,
  insertSkillReference,
  rankSkills,
} from "./skill-discovery";

const skill = (
  name: string,
  description: string,
  availability: SkillInfo["availability"] = "on-demand",
): SkillInfo => availability === "unavailable"
  ? { name, description, availability, unavailableReason: "not-selected" }
  : { name, description, availability, reference: `$${name}` };

describe("detectSkillQuery", () => {
  it("detects a canonical token at the caret and rejects shell-like or selected text", () => {
    expect(detectSkillQuery("Please $rese", 12)).toEqual({ offset: 7, query: "rese", cursor: 12 });
    expect(detectSkillQuery("$", 1)).toEqual({ offset: 0, query: "", cursor: 1 });
    expect(detectSkillQuery("cost$rese", 9)).toBeNull();
    expect(detectSkillQuery("$(date)", 7)).toBeNull();
    expect(detectSkillQuery("$research", 2, 5)).toBeNull();
  });
});

describe("rankSkills", () => {
  const skills = [
    skill("research", "Find primary sources", "on-demand"),
    skill("research-notes", "Write sourced notes", "inlined"),
    skill("market-research", "Compare competitors", "on-demand"),
    skill("release-check", "Verify the package registry", "on-demand"),
    skill("retrospective", "Summarize completed work", "on-demand"),
    skill("private-research", "Unavailable helper", "unavailable"),
  ];

  it("prioritizes exact, prefix, token-prefix, substring, fuzzy, then description matches", () => {
    expect(rankSkills(skills, "research", { limit: 20 }).map(({ name }) => name)).toEqual([
      "research",
      "research-notes",
      "market-research",
    ]);
    expect(rankSkills(skills, "rrch", { limit: 20 }).map(({ name }) => name)).toContain("research");
    expect(rankSkills(skills, "package registry", { limit: 20 }).map(({ name }) => name))
      .toEqual(["release-check"]);
  });

  it("orders an empty browse query by availability and then alphabetically", () => {
    const tied = [
      skill("zebra", "Same", "on-demand"),
      skill("qa", "Same", "inlined"),
      skill("architecture", "Same", "inlined"),
    ];
    expect(rankSkills(tied, "", { limit: 20 }).map(({ name }) => name))
      .toEqual(["architecture", "qa", "zebra"]);
  });

  it("normalizes diacritics in description search", () => {
    expect(rankSkills([
      skill("career-writer", "Polish a résumé and cover letter"),
    ], "resume")).toEqual([
      expect.objectContaining({ name: "career-writer" }),
    ]);
  });

  it("excludes unavailable skills from autocomplete but includes disabled entries for browse", () => {
    expect(rankSkills(skills, "private", { limit: 20 })).toEqual([]);
    expect(rankSkills(skills, "private", { includeUnavailable: true, limit: 20 }))
      .toEqual([expect.objectContaining({ name: "private-research", availability: "unavailable" })]);
  });
});

describe("insertSkillReference", () => {
  it("replaces only the selected range, adds token boundaries, and returns the restored caret", () => {
    expect(insertSkillReference("Use rese now", 4, 8, "$research")).toEqual({
      text: "Use $research now",
      selectionStart: 14,
      selectionEnd: 14,
    });
    expect(insertSkillReference("prefixsuffix", 6, 6, "$research")).toEqual({
      text: "prefix $research suffix",
      selectionStart: 17,
      selectionEnd: 17,
    });
  });
});
