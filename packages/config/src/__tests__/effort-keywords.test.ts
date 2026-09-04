import { describe, expect, it } from "vitest";

import { detectEffortKeyword, EFFORT_KEYWORD_TRIGGERS, effortRank, maxEffortLevel } from "../effort-keywords.js";

describe("detectEffortKeyword", () => {
  it("maps a bare 'think' anywhere in the message to high", () => {
    expect(detectEffortKeyword("think")).toEqual({ effort: "high", keyword: "think" });
    expect(detectEffortKeyword("Think hard about this bug")).toEqual({ effort: "high", keyword: "Think" });
    expect(detectEffortKeyword("what do you think?")).toEqual({ effort: "high", keyword: "think" });
  });

  it("maps 'extra think' and 'extrathink' to xhigh", () => {
    expect(detectEffortKeyword("extra think about the edge cases")).toEqual({ effort: "xhigh", keyword: "extra think" });
    expect(detectEffortKeyword("please extrathink this")).toEqual({ effort: "xhigh", keyword: "extrathink" });
  });

  it("maps 'ultra think' and 'ultrathink' to max, case-insensitively", () => {
    expect(detectEffortKeyword("ultra think about it")).toEqual({ effort: "max", keyword: "ultra think" });
    expect(detectEffortKeyword("ultrathink: what is 2+2")).toEqual({ effort: "max", keyword: "ultrathink" });
    expect(detectEffortKeyword("ULTRA THINK")).toEqual({ effort: "max", keyword: "ULTRA THINK" });
  });

  it("prefers the longest phrase when phrases overlap", () => {
    // "ultra think" also contains a standalone \bthink\b — the max trigger must win.
    expect(detectEffortKeyword("ultra think")?.effort).toBe("max");
    expect(detectEffortKeyword("extra think")?.effort).toBe("xhigh");
    expect(detectEffortKeyword("ultra think and think again")?.effort).toBe("max");
  });

  it("does not match inside larger words (word boundaries)", () => {
    expect(detectEffortKeyword("thinking")).toBeUndefined();
    expect(detectEffortKeyword("rethink")).toBeUndefined();
    expect(detectEffortKeyword("overthinking it")).toBeUndefined();
    expect(detectEffortKeyword("ultrathinking")).toBeUndefined();
  });

  it("does not match hyphenated or empty forms", () => {
    // "ultra-think" would match \bthink\b after the hyphen boundary, which is
    // exactly the spec: only "ultra think"/"ultrathink" earn max.
    expect(detectEffortKeyword("ultra-think")?.effort).toBe("high");
    expect(detectEffortKeyword("")).toBeUndefined();
    expect(detectEffortKeyword("no trigger words here")).toBeUndefined();
  });

  /**
   * A trigger is a PHRASE, so what it matches has to be that phrase -- its own words plus at
   * most one separator between them. `\s*` made the separator unbounded, so the "match" grew
   * with the message around it and `keyword` (which exists to be printed) became a copy of the
   * operator's whitespace.
   */
  it("matches a phrase, never an unbounded whitespace run between its words", () => {
    const longestPhrase = Math.max(...EFFORT_KEYWORD_TRIGGERS.map((trigger) => trigger.label.length));
    const flooded = `ultra${" ".repeat(1_000_000)}think`;
    const match = detectEffortKeyword(flooded);
    expect(match).toBeDefined();
    expect(match!.keyword.length).toBeLessThanOrEqual(longestPhrase);
  });

  it("bounds every trigger's match by its own canonical phrase", () => {
    for (const trigger of EFFORT_KEYWORD_TRIGGERS) {
      const flooded = trigger.label.replace(" ", "\t".repeat(50_000));
      const match = trigger.pattern.exec(flooded);
      expect(match?.[0].length ?? 0).toBeLessThanOrEqual(trigger.label.length);
    }
  });

  it("treats one line break as one separator, on every phrase trigger", () => {
    // A CRLF is one separator spelled with two characters. `\s?` bounded the
    // whitespace run but consumed only the `\r`, so `ultra\r\nthink` failed its own
    // phrase and fell through to the bare `think` trigger -- a Windows or
    // textarea-wrapped client silently got `high` where it asked for `max`.
    const phrases = EFFORT_KEYWORD_TRIGGERS.filter((trigger) => trigger.label.includes(" "));
    expect(phrases.length).toBeGreaterThan(0);
    for (const trigger of phrases) {
      for (const separator of ["", " ", "\t", "\n", "\r", "\r\n"]) {
        const message = trigger.label.replace(" ", separator);
        expect(detectEffortKeyword(message), `${trigger.label} joined by ${JSON.stringify(separator)}`).toEqual({
          effort: trigger.effort,
          keyword: message,
        });
      }
    }
  });

  it("exposes triggers in descending effort order for downstream consumers", () => {
    expect(EFFORT_KEYWORD_TRIGGERS.map((trigger) => trigger.effort)).toEqual(["max", "xhigh", "high"]);
  });
});

describe("effortRank", () => {
  it("orders the closed effort enum by index", () => {
    const ranks = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map(effortRank);
    expect(ranks).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("ranks unknown and missing values below every real level", () => {
    expect(effortRank("turbo")).toBe(-1);
    expect(effortRank(undefined)).toBe(-1);
    expect(effortRank("")).toBe(-1);
  });
});

describe("maxEffortLevel", () => {
  it("escalates only on a strict rank increase", () => {
    expect(maxEffortLevel(undefined, "high")).toBe("high");
    expect(maxEffortLevel("low", "xhigh")).toBe("xhigh");
    expect(maxEffortLevel("max", "high")).toBe("max");
    expect(maxEffortLevel("high", "high")).toBe("high");
  });

  it("treats an unknown current level as escalatable", () => {
    expect(maxEffortLevel("turbo", "high")).toBe("high");
  });

  it("never downgrades a configured 'ultra' (outranks max by enum position)", () => {
    expect(maxEffortLevel("ultra", "max")).toBe("ultra");
  });
});
