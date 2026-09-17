import { describe, expect, it } from "vitest";

import {
  CHANGELOG_NONE_PATTERN,
  checkChangelogStructure,
  checkPublishedCoverage,
  compareSemver,
  evaluatePrGate,
  isRealCalendarDate,
  parsePrLabels,
  parseSemver,
  releasedVersionsFromTags,
  runCheckChangelog,
} from "../check-changelog.mjs";

const GOOD = `# Release notes

## Unreleased

- Add a user-visible thing.

## 0.2.0 — Second release (2026-09-01)

- Change something observable.

## 0.1.0 — First release (2026-08-01)

- Start the story.
`;

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}

function gitWith({ tags = [], baseText = null } = {}) {
  return async (args) => {
    if (args[0] === "tag") {
      return { status: 0, stdout: tags.join("\n") + (tags.length > 0 ? "\n" : "") };
    }
    if (args[0] === "show") {
      if (baseText === null) {
        return { status: 128, stdout: "" };
      }
      return { status: 0, stdout: baseText };
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
}

describe("check-changelog structure", () => {
  it("accepts a well-formed changelog", () => {
    expect(checkChangelogStructure(GOOD)).toEqual([]);
  });

  it("requires the exact H1 on line 1", () => {
    const errors = checkChangelogStructure(GOOD.replace("# Release notes", "# Changelog"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("CHANGELOG.md:1: first line must be exactly `# Release notes`");
  });

  it("requires Unreleased as the first section", () => {
    const moved = GOOD.replace("## Unreleased\n\n- Add", "## Unreleased\n\n- Add");
    const swapped = `# Release notes

## 0.2.0 — Second release (2026-09-01)

- Change something observable.

## Unreleased

- Add a user-visible thing.
`;
    expect(checkChangelogStructure(swapped).join("\n")).toContain(
      "## Unreleased` must be the first `##` section",
    );
    expect(moved).toBe(GOOD);
  });

  it("rejects a version heading that breaks the required shape", () => {
    const errors = checkChangelogStructure(GOOD.replace(
      "## 0.2.0 — Second release (2026-09-01)",
      "## 0.2.0 - Second release (2026-09-01)",
    ));
    expect(errors.join("\n")).toContain("must match `## X.Y.Z — <title> (YYYY-MM-DD)`");
  });

  it("rejects a non-semver version", () => {
    const errors = checkChangelogStructure(GOOD.replace("## 0.2.0 —", "## 0.2 —"));
    expect(errors.join("\n")).toContain("`0.2` is not a valid semver version");
  });

  it("rejects an impossible calendar date", () => {
    const errors = checkChangelogStructure(GOOD.replace("(2026-09-01)", "(2026-02-30)"));
    expect(errors.join("\n")).toContain("`2026-02-30` is not a real calendar date");
    expect(isRealCalendarDate(2024, 2, 29)).toBe(true);
    expect(isRealCalendarDate(2026, 2, 29)).toBe(false);
  });

  it("rejects versions that do not descend strictly", () => {
    const ascending = GOOD.replace("## 0.1.0 — First release (2026-08-01)", "## 0.3.0 — Later (2026-10-01)");
    expect(checkChangelogStructure(ascending).join("\n")).toContain("must descend strictly by semver");
  });

  it("rejects duplicate version sections", () => {
    const duplicated = `${GOOD}\n## 0.1.0 — First release again (2026-08-02)\n\n- Repeat.\n`;
    expect(checkChangelogStructure(duplicated).join("\n")).toContain("duplicate version section `0.1.0`");
  });

  it("rejects trailing whitespace with the offending line", () => {
    const errors = checkChangelogStructure(GOOD.replace("- Add a user-visible thing.", "- Add a user-visible thing. "));
    expect(errors).toContain("CHANGELOG.md:5: trailing whitespace");
  });

  it("rejects bullet markers that are not `- `", () => {
    const errors = checkChangelogStructure(GOOD.replace("- Add a user-visible thing.", "* Add a user-visible thing."));
    expect(errors).toHaveLength(0);
    const dash = checkChangelogStructure(GOOD.replace("- Add a user-visible thing.", "-Add a user-visible thing."));
    expect(dash.join("\n")).toContain("bullet markers must start with `- `");
  });
});

describe("check-changelog semver", () => {
  it("parses and orders releases including prereleases", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemver("1.2")).toBeNull();
    expect(compareSemver(parseSemver("0.2.0"), parseSemver("0.10.0"))).toBe(-1);
    expect(compareSemver(parseSemver("1.0.0"), parseSemver("1.0.0-beta.1"))).toBe(1);
    expect(compareSemver(parseSemver("1.0.0-beta.2"), parseSemver("1.0.0-beta.10"))).toBe(-1);
    expect(compareSemver(parseSemver("2.0.0"), parseSemver("2.0.0"))).toBe(0);
  });

  it("filters tag names to v-prefixed semver", () => {
    expect(releasedVersionsFromTags(["v1.2.3", "main", "v9.9", "v1.2.3-beta.1"])).toEqual(["1.2.3", "1.2.3-beta.1"]);
  });
});

describe("check-changelog published coverage", () => {
  it("passes when every in-scope tag has a section", () => {
    const result = checkPublishedCoverage({ changelogText: GOOD, tagNames: ["v0.2.0", "v0.1.0"] });
    expect(result).toEqual({ errors: [], note: null, grandfathered: [], grandfatheredOlderThan: "0.1.0" });
  });

  it("fails for a missing tag above the oldest section", () => {
    const result = checkPublishedCoverage({ changelogText: GOOD, tagNames: ["v0.1.5"] });
    expect(result.errors).toEqual(["CHANGELOG.md: published tag `v0.1.5` has no matching `## 0.1.5` section"]);
    expect(result.grandfathered).toEqual([]);
  });

  it("grandfathers tags older than the oldest section instead of failing", () => {
    const result = checkPublishedCoverage({ changelogText: GOOD, tagNames: ["v0.0.9", "v0.2.0"] });
    expect(result.errors).toEqual([]);
    expect(result.grandfathered).toEqual(["0.0.9"]);
    expect(result.grandfatheredOlderThan).toBe("0.1.0");
  });

  it("degrades honestly when no tags are visible", () => {
    expect(checkPublishedCoverage({ changelogText: GOOD, tagNames: [] }).note)
      .toBe("tags unavailable, coverage not checked");
  });
});

describe("check-changelog PR entry gate", () => {
  const base = GOOD;
  const withBullet = GOOD.replace(
    "- Add a user-visible thing.",
    "- Add a user-visible thing.\n\n- Add another one.",
  );

  it("passes when the diff adds an Unreleased bullet", () => {
    expect(evaluatePrGate({ baseText: base, headText: withBullet }).status).toBe("pass");
  });

  it("fails when the diff adds no Unreleased bullet", () => {
    const result = evaluatePrGate({ baseText: base, headText: base });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("adds no new bullet under `## Unreleased`");
  });

  it("does not count a reworded bullet as new", () => {
    const reworded = base.replace("- Add a user-visible thing.", "- Add a user-visible thing! ");
    const trimmed = reworded.replace("! ", ".");
    expect(evaluatePrGate({ baseText: base, headText: trimmed }).status).toBe("fail");
  });

  it("passes a release cut that moves Unreleased content into a version section", () => {
    const cut = `# Release notes

## Unreleased

## 0.3.0 — Cut release (2026-10-01)

- Add a user-visible thing.

## 0.2.0 — Second release (2026-09-01)

- Change something observable.

## 0.1.0 — First release (2026-08-01)

- Start the story.
`;
    const result = evaluatePrGate({ baseText: base, headText: cut });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("release cut");
  });

  it("honors the skip-changelog label", () => {
    expect(evaluatePrGate({ baseText: base, headText: base, labels: ["skip-changelog"] }).status).toBe("pass");
  });

  it("honors a Changelog: none line in the PR body", () => {
    const body = "Routine refactor.\n\nChangelog: none\n";
    expect(CHANGELOG_NONE_PATTERN.test(body)).toBe(true);
    expect(evaluatePrGate({ baseText: base, headText: base, prBody: body }).status).toBe("pass");
    expect(evaluatePrGate({ baseText: base, headText: base, prBody: "No changelog impact." }).status).toBe("fail");
  });

  it("parses labels from JSON or comma-separated text", () => {
    expect(parsePrLabels('["a", "skip-changelog"]')).toEqual(["a", "skip-changelog"]);
    expect(parsePrLabels("a, skip-changelog")).toEqual(["a", "skip-changelog"]);
    expect(parsePrLabels("")).toEqual([]);
    expect(parsePrLabels("null")).toEqual([]);
  });
});

describe("runCheckChangelog", () => {
  it("passes the current file shape and reports skipped gates honestly", async () => {
    const stdout = sink();
    const result = await runCheckChangelog({
      cwd: "/repo",
      env: {},
      stdout,
      stderr: sink(),
      git: gitWith({ tags: [] }),
      changelogText: GOOD,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("changelog structure: ok");
    expect(stdout.text).toContain("tags unavailable, coverage not checked");
    expect(stdout.text).toContain("not a PR context");
  });

  it("prints grandfathered tags with their boundary", async () => {
    const stdout = sink();
    const result = await runCheckChangelog({
      cwd: "/repo",
      env: {},
      stdout,
      stderr: sink(),
      git: gitWith({ tags: ["v0.0.9", "v0.2.0"] }),
      changelogText: GOOD,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("grandfathered 1 tag(s) older than the oldest sectioned version (0.1.0): v0.0.9");
  });

  it("fails closed when the base ref cannot be read", async () => {
    const stderr = sink();
    const result = await runCheckChangelog({
      cwd: "/repo",
      env: { CHANGELOG_BASE_REF: "deadbeef" },
      stdout: sink(),
      stderr,
      git: gitWith({ tags: ["v0.2.0"] }),
      changelogText: GOOD,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("cannot read base file at `deadbeef`");
  });

  it("runs the PR gate against the base file when armed", async () => {
    const stdout = sink();
    const withBullet = GOOD.replace(
      "- Add a user-visible thing.",
      "- Add a user-visible thing.\n\n- Add another one.",
    );
    const result = await runCheckChangelog({
      cwd: "/repo",
      env: { CHANGELOG_BASE_REF: "base-sha" },
      stdout,
      stderr: sink(),
      git: gitWith({ tags: ["v0.2.0"], baseText: GOOD }),
      changelogText: withBullet,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toContain("PR entry gate: pass");
  });
});
