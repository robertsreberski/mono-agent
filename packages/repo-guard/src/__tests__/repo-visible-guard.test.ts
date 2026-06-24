import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRepoVisibleDenylist,
  guardRepoVisiblePayload,
  loadRepoVisibleDenylist,
  RepoVisibleGuardError,
  repoVisibleSlugVariant,
  sanitizeRepoVisibleString,
  scanGitHubRepoMetadata,
  scanLocalRepoFiles,
  scanRepoVisibleValue,
} from "../index.js";
import type { RepoVisibleCommandRunner } from "../index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "repo-visible-guard-"));
  tempDirs.push(dir);
  return dir;
}

describe("loadRepoVisibleDenylist", () => {
  it("loads JSON env entries and a default ignored file without exposing values in labels", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, ".mono-agent"), { recursive: true });
    await writeFile(
      join(cwd, ".mono-agent", "repo-visible-denylist.jsonl"),
      '{"label":"provider-account","value":"provider-account-alpha"}\n',
      "utf8",
    );

    const denylist = await loadRepoVisibleDenylist({
      cwd,
      env: {
        MONO_AGENT_REPO_VISIBLE_DENYLIST: JSON.stringify([
          { label: "operator-name", value: "Example Operator" },
          "/Users/example/local-agent-alpha",
        ]),
      },
    });

    expect(denylist.entries.map((entry) => entry.label)).toEqual([
      "operator-name",
      "entry-2",
      "provider-account",
    ]);
    expect(denylist.entries[1]?.variants).toContain("local-agent-alpha");
    expect(denylist.warnings).toEqual([]);
  });

  it("fails loudly when an explicitly configured file cannot be read", async () => {
    await expect(
      loadRepoVisibleDenylist({
        cwd: await tempDir(),
        env: { MONO_AGENT_REPO_VISIBLE_DENYLIST_FILE: "./missing.jsonl" },
      }),
    ).rejects.toMatchObject({ code: "denylist_read_failed" });
  });

  it("wraps invalid JSON env arrays in a typed parse error", async () => {
    await expect(
      loadRepoVisibleDenylist({
        env: { MONO_AGENT_REPO_VISIBLE_DENYLIST: "[not-json" },
      }),
    ).rejects.toMatchObject({ code: "denylist_parse_failed" });
  });
});

describe("scanRepoVisibleValue and guardRepoVisiblePayload", () => {
  it("finds issue, pull request, review, branch, and nested task metadata fields", () => {
    const denylist = createRepoVisibleDenylist([
      { label: "agent-name", value: "local-agent-alpha" },
      { label: "operator-path", value: "/Users/example/local-agent-alpha" },
      { label: "provider-account", value: "provider-account-alpha" },
    ]);

    const findings = scanRepoVisibleValue(
      {
        issue: { title: "Update local-agent-alpha metadata", body: "Safe body" },
        pullRequest: { review: { body: "Uses provider-account-alpha" } },
        branchName: "dogfood/100-local-agent-alpha",
        task: { metadata: { workspace: "/Users/example/local-agent-alpha" } },
      },
      denylist,
      { surface: "github_payload" },
    );

    expect(new Set(findings.map((finding) => finding.fieldPath))).toEqual(new Set([
      "$.issue.title",
      "$.pullRequest.review.body",
      "$.branchName",
      "$.task.metadata.workspace",
    ]));
    expect(findings.every((finding) => finding.label.includes("local-agent-alpha") === false)).toBe(true);
  });

  it("throws a typed error whose details omit raw sensitive values", () => {
    const denylist = createRepoVisibleDenylist([{ label: "username", value: "example-user" }]);

    expect(() =>
      guardRepoVisiblePayload({ comment: "hello example-user" }, { denylist, surface: "github_issue_comment" }),
    ).toThrow(RepoVisibleGuardError);

    try {
      guardRepoVisiblePayload({ comment: "hello example-user" }, { denylist, surface: "github_issue_comment" });
    } catch (error) {
      expect(error).toMatchObject({ code: "repo_visible_denylist_match" });
      expect(JSON.stringify((error as RepoVisibleGuardError).details)).not.toContain("example-user");
    }
  });

  it("supports generated slug variants and post-sanitize guard checks", () => {
    const denylist = createRepoVisibleDenylist([{ label: "operator-name", value: "Example Operator" }]);
    expect(repoVisibleSlugVariant("Example Operator")).toBe("example-operator");

    const unsafeBranch = "dogfood/100-example-operator-follow-up";
    expect(scanRepoVisibleValue(unsafeBranch, denylist, { fieldPath: "branch" })).toHaveLength(1);

    const safeBranch = sanitizeRepoVisibleString(unsafeBranch, { denylist, replacement: "redacted" });
    expect(safeBranch).toBe("dogfood/100-redacted-follow-up");
    expect(() => guardRepoVisiblePayload(safeBranch, { denylist, fieldPath: "branch" })).not.toThrow();
  });
});

describe("scanLocalRepoFiles", () => {
  it("scans tracked text files and reports field paths without matched values", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "tracked.md"), "hello local-agent-alpha\n", "utf8");
    await writeFile(join(cwd, "pnpm-lock.yaml"), "local-agent-alpha\n", "utf8");
    const denylist = createRepoVisibleDenylist([{ label: "agent-name", value: "local-agent-alpha" }]);
    const runner: RepoVisibleCommandRunner = async (command, args) => {
      expect(command).toBe("git");
      expect(args).toEqual(["ls-files", "-z"]);
      return { stdout: "tracked.md\0pnpm-lock.yaml\0", stderr: "", status: 0 };
    };

    const result = await scanLocalRepoFiles({ cwd, denylist, runCommand: runner });

    expect(result.findings).toEqual([
      {
        surface: "local_file",
        identifier: "tracked.md",
        fieldPath: "content",
        label: "agent-name",
        matchKind: "literal",
        line: 1,
        column: 7,
      },
    ]);
    expect(result.sources[0]).toMatchObject({ scanned: 1, skipped: 1 });
  });
});

describe("scanGitHubRepoMetadata", () => {
  it("scans issue, PR, comment, review, and inline review comment metadata through gh", async () => {
    const denylist = createRepoVisibleDenylist([{ label: "agent-name", value: "local-agent-alpha" }]);
    const runner: RepoVisibleCommandRunner = async (_command, args) => {
      const endpoint = args.at(-1);
      if (endpoint === "repos/example/repo/issues?state=all&per_page=100") {
        return { stdout: JSON.stringify([[{ number: 1, title: "local-agent-alpha", body: "" }]]), stderr: "", status: 0 };
      }
      if (endpoint === "repos/example/repo/issues/comments?per_page=100") {
        return { stdout: JSON.stringify([[{ id: 2, body: "local-agent-alpha" }]]), stderr: "", status: 0 };
      }
      if (endpoint === "repos/example/repo/pulls?state=all&per_page=100") {
        return {
          stdout: JSON.stringify([[
            {
              number: 3,
              title: "safe",
              body: "safe",
              head: { ref: "dogfood/local-agent-alpha" },
              base: { ref: "main" },
            },
          ]]),
          stderr: "",
          status: 0,
        };
      }
      if (endpoint === "repos/example/repo/pulls/comments?per_page=100") {
        return { stdout: JSON.stringify([[{ id: 4, body: "local-agent-alpha" }]]), stderr: "", status: 0 };
      }
      if (endpoint === "repos/example/repo/pulls/3/reviews?per_page=100") {
        return { stdout: JSON.stringify([[{ id: 5, body: "local-agent-alpha" }]]), stderr: "", status: 0 };
      }
      throw new Error(`unexpected endpoint ${String(endpoint)}`);
    };

    const result = await scanGitHubRepoMetadata({ repo: "example/repo", denylist, runCommand: runner });

    expect(result.findings.map((finding) => `${finding.surface}:${finding.identifier}:${finding.fieldPath}`)).toEqual([
      "github_issue:github_issue#1:title",
      "github_issue_comment:github_issue_comment#2:body",
      "github_pr:github_pr#3:head.ref",
      "github_review_comment:github_review_comment#4:body",
      "github_pr_review:github_pr_review#5:body",
    ]);
  });
});
