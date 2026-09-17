import { describe, expect, it } from "vitest";

import { cutChangelog, runCutChangelog, todayUtc } from "../cut-changelog.mjs";
import { extractChangelogSection, runChangelogSection } from "../changelog-section.mjs";
import { validateRelease } from "../validate-release.mjs";

const CHANGELOG = `# Release notes

## Unreleased

- Add a user-visible thing.

## 0.2.0 — Second release (2026-09-01)

- Change something observable.
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

describe("cut-changelog", () => {
  it("moves Unreleased entries below a fresh empty Unreleased section", () => {
    const cut = cutChangelog({ text: CHANGELOG, version: "0.3.0", title: "Cut release", date: "2026-10-01" });
    expect(cut.heading).toBe("## 0.3.0 — Cut release (2026-10-01)");
    expect(cut.movedBullets).toBe(1);
    expect(cut.text).toBe(`# Release notes

## Unreleased

## 0.3.0 — Cut release (2026-10-01)

- Add a user-visible thing.

## 0.2.0 — Second release (2026-09-01)

- Change something observable.
`);
  });

  it("defaults the date to today in UTC", () => {
    expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const cut = cutChangelog({ text: CHANGELOG, version: "0.3.0", title: "Cut release" });
    expect(cut.heading).toBe(`## 0.3.0 — Cut release (${todayUtc()})`);
  });

  it("refuses an empty Unreleased section", () => {
    const empty = CHANGELOG.replace("- Add a user-visible thing.\n", "");
    expect(() => cutChangelog({ text: empty, version: "0.3.0", title: "Cut release", date: "2026-10-01" }))
      .toThrow("`## Unreleased` has no entries to cut");
  });

  it("refuses a version that already has a section", () => {
    expect(() => cutChangelog({ text: CHANGELOG, version: "0.2.0", title: "Repeat", date: "2026-10-01" }))
      .toThrow("already has a `## 0.2.0` section");
  });

  it("refuses a version that is not greater than the newest section", () => {
    expect(() => cutChangelog({ text: CHANGELOG, version: "0.1.9", title: "Old", date: "2026-10-01" }))
      .toThrow("is not greater than the current newest section `## 0.2.0`");
    expect(() => cutChangelog({ text: CHANGELOG, version: "0.2.0", title: "Same", date: "2026-10-01" }))
      .toThrow("already has a `## 0.2.0` section");
  });

  it("refuses bad versions, empty titles, and impossible dates", () => {
    expect(() => cutChangelog({ text: CHANGELOG, version: "1.2", title: "T", date: "2026-10-01" }))
      .toThrow("Version must be semver");
    expect(() => cutChangelog({ text: CHANGELOG, version: "0.3.0", title: "  ", date: "2026-10-01" }))
      .toThrow("non-empty --title");
    expect(() => cutChangelog({ text: CHANGELOG, version: "0.3.0", title: "T", date: "2026-02-30" }))
      .toThrow("real calendar date");
  });

  it("refuses a file that fails the structure check", () => {
    const broken = CHANGELOG.replace("## Unreleased", "## Pending");
    expect(() => cutChangelog({ text: broken, version: "0.3.0", title: "T", date: "2026-10-01" }))
      .toThrow("fails the structure check");
  });

  it("dry-runs without writing", async () => {
    let written = null;
    const stdout = sink();
    const result = await runCutChangelog({
      argv: ["--version", "0.3.0", "--title", "Cut release", "--date", "2026-10-01", "--check"],
      stdout,
      stderr: sink(),
      root: "/repo",
      readFile: async () => CHANGELOG,
      writeFile: async (_path, text) => {
        written = text;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(written).toBeNull();
    expect(stdout.text).toContain("Would cut 1 Unreleased bullet(s)");
  });

  it("writes the cut file on a real run", async () => {
    let written = null;
    const result = await runCutChangelog({
      argv: ["--version", "0.3.0", "--title", "Cut release", "--date", "2026-10-01"],
      stdout: sink(),
      stderr: sink(),
      root: "/repo",
      readFile: async () => CHANGELOG,
      writeFile: async (_path, text) => {
        written = text;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(written).toContain("## 0.3.0 — Cut release (2026-10-01)");
  });
});

describe("changelog-section", () => {
  it("prints the section body without the heading", () => {
    expect(extractChangelogSection(CHANGELOG, "0.2.0")).toBe("- Change something observable.\n");
  });

  it("accepts a v-prefixed version through the CLI", async () => {
    const stdout = sink();
    const result = await runChangelogSection({
      argv: ["--version", "v0.2.0"],
      stdout,
      stderr: sink(),
      root: "/repo",
      readFile: async () => CHANGELOG,
    });
    expect(result.exitCode).toBe(0);
    expect(stdout.text).toBe("- Change something observable.\n");
  });

  it("fails naming the missing section", async () => {
    const stderr = sink();
    const result = await runChangelogSection({
      argv: ["--version", "9.9.9"],
      stdout: sink(),
      stderr,
      root: "/repo",
      readFile: async () => CHANGELOG,
    });
    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain("has no `## 9.9.9` section");
  });
});

describe("validate-release changelog section", () => {
  function issuesFor(tag, changelogText) {
    try {
      validateRelease({
        tag,
        packages: [],
        rootPackageJson: {},
        nodeVersionFile: "none",
        silent: true,
        ...(changelogText === undefined ? {} : { changelogText }),
      });
      expect.unreachable();
    } catch (error) {
      return error.issues ?? [];
    }
    return [];
  }

  it("does not complain when the tag version has a changelog section", () => {
    expect(issuesFor("v0.2.0", CHANGELOG)).not.toContain(
      "CHANGELOG.md must contain a `## 0.2.0` section for release v0.2.0",
    );
  });

  it("fails naming the missing changelog section", () => {
    expect(issuesFor("v9.9.9", CHANGELOG)).toContain(
      "CHANGELOG.md must contain a `## 9.9.9` section for release v9.9.9",
    );
  });

  it("skips the changelog rule when no changelog text is provided", () => {
    expect(issuesFor("v9.9.9", undefined)).not.toContain(
      "CHANGELOG.md must contain a `## 9.9.9` section for release v9.9.9",
    );
  });
});
