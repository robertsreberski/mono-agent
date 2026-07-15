import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const mergeProofFields = "--json state,mergedAt,headRefName,headRefOid";
const exactBranchGate = 'test "$api_branch" = "$branch"';
const exactHeadGate = 'test "$api_head" = "$local_head"';

describe("repository hygiene skill contracts", () => {
  it("gates per-feature squash cleanup on the exact merged PR and clean worktree", async () => {
    const skill = await readFile("skills/worktree-feature/SKILL.md", "utf8");

    expect(skill).toContain(mergeProofFields);
    expect(skill).toContain(exactBranchGate);
    expect(skill).toContain(exactHeadGate);
    expect(skill).toContain('test -z "$(git -C "$worktree" status --porcelain)"');
    expect(skill).toContain('git branch -D -- "$branch"');
  });

  it("requires exact proof and a remote lease for historical cleanup", async () => {
    const skill = await readFile("skills/repo-hygiene-gc/SKILL.md", "utf8");

    expect(skill).toContain("#292 enabled the setting");
    expect(skill).toContain(".delete_branch_on_merge   # => true");
    expect(skill).toContain(mergeProofFields);
    expect(skill).toContain(exactBranchGate);
    expect(skill).toContain(exactHeadGate);
    expect(skill).toContain('headRefOid` exactly equals the current local or remote tip');
    expect(skill).toContain('--force-with-lease="refs/heads/$branch:$api_head"');
    expect(skill).not.toMatch(/gh pr list --state merged[\s\S]{0,200}git branch -D/u);
  });
});
