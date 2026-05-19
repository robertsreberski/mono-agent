import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyDownloadsProposal,
  createDownloadsProposal,
  listDownloads,
} from "../downloads-tools.js";

async function tempWorkspace(): Promise<{
  downloadsRoot: string;
  stateDir: string;
  trashDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "downloads-curator-test-"));
  const workspace = {
    downloadsRoot: join(root, "Downloads"),
    stateDir: join(root, "state"),
    trashDir: join(root, "Trash"),
  };
  await Promise.all([
    mkdir(workspace.downloadsRoot, { recursive: true }),
    mkdir(workspace.stateDir, { recursive: true }),
    mkdir(workspace.trashDir, { recursive: true }),
  ]);
  return workspace;
}

describe("downloads curator tools", () => {
  it("lists top-level downloads with metadata and category hints", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace.downloadsRoot, "report.pdf"), "pdf", "utf8");
    await writeFile(join(workspace.downloadsRoot, "photo.jpg"), "image", "utf8");
    await writeFile(join(workspace.downloadsRoot, "unfinished.crdownload"), "partial", "utf8");

    const result = await listDownloads({ downloadsRoot: workspace.downloadsRoot });

    expect(result.entries.map((entry) => entry.relativePath).sort()).toEqual([
      "photo.jpg",
      "report.pdf",
      "unfinished.crdownload",
    ]);
    expect(result.entries.find((entry) => entry.relativePath === "report.pdf")).toMatchObject({
      kind: "file",
      extension: ".pdf",
      suggestedCategory: "Documents",
      activeDownload: false,
    });
    expect(result.entries.find((entry) => entry.relativePath === "unfinished.crdownload")).toMatchObject({
      activeDownload: true,
    });
  });

  it("rejects unsafe proposal sources before writing a pending proposal", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace.downloadsRoot, "safe.txt"), "safe", "utf8");
    await symlink("/tmp", join(workspace.downloadsRoot, "tmp-link"));

    await expect(createDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
      idGenerator: () => "proposal_unsafe",
    }, {
      rationale: "test unsafe paths",
      actions: [
        { kind: "move", source: "../outside.txt", targetCategory: "Documents", reason: "escape" },
      ],
    })).rejects.toThrow(/inside Downloads/u);

    await expect(createDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
      idGenerator: () => "proposal_symlink",
    }, {
      rationale: "test symlink",
      actions: [
        { kind: "trash", source: "tmp-link", reason: "symlink" },
      ],
    })).rejects.toThrow(/symlink/u);
  });

  it("requires the current user message to match the exact approval phrase", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace.downloadsRoot, "old.zip"), "archive", "utf8");
    const proposal = await createDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
      idGenerator: () => "proposal_needs_approval",
    }, {
      rationale: "remove junk",
      actions: [
        { kind: "trash", source: "old.zip", reason: "no longer needed" },
      ],
    });

    await expect(applyDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
    }, {
      proposalId: proposal.proposalId,
      approvalPhrase: proposal.approvalPhrase,
      actionIds: ["act_1"],
    })).rejects.toThrow(/current user message/u);

    expect(await readFile(join(workspace.downloadsRoot, "old.zip"), "utf8")).toBe("archive");
  });

  it("applies approved move and trash actions with collision-safe destinations and a manifest", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace.downloadsRoot, "report.pdf"), "new", "utf8");
    await writeFile(join(workspace.downloadsRoot, "old.dmg"), "installer", "utf8");
    await mkdir(join(workspace.downloadsRoot, "_Curated", "Documents"), { recursive: true });
    await writeFile(join(workspace.downloadsRoot, "_Curated", "Documents", "report.pdf"), "existing", "utf8");
    await writeFile(join(workspace.trashDir, "old.dmg"), "existing trash", "utf8");
    const proposal = await createDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
      idGenerator: () => "proposal_apply",
      now: () => new Date("2026-05-18T10:00:00.000Z"),
    }, {
      rationale: "curate files",
      actions: [
        { kind: "move", source: "report.pdf", targetCategory: "Documents", reason: "document" },
        { kind: "trash", source: "old.dmg", reason: "old installer" },
      ],
    });

    const result = await applyDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: proposal.approvalPhrase,
      now: () => new Date("2026-05-18T10:05:00.000Z"),
    }, {
      proposalId: proposal.proposalId,
      approvalPhrase: proposal.approvalPhrase,
      actionIds: ["act_1", "act_2"],
    });

    expect(result.applied.map((action) => action.destinationRelativePath)).toEqual([
      "_Curated/Documents/report-1.pdf",
      "../Trash/old-1.dmg",
    ]);
    expect(await readFile(join(workspace.downloadsRoot, "_Curated", "Documents", "report-1.pdf"), "utf8")).toBe("new");
    expect(await readFile(join(workspace.trashDir, "old-1.dmg"), "utf8")).toBe("installer");
    await expect(stat(join(workspace.downloadsRoot, "report.pdf"))).rejects.toMatchObject({ code: "ENOENT" });

    const manifest = await readFile(join(workspace.stateDir, "actions.jsonl"), "utf8");
    expect(manifest).toContain("proposal_apply");
    expect(manifest).toContain("act_1");
    expect(manifest).toContain("act_2");
  });

  it("refuses to apply a proposal when a source file changed after review", async () => {
    const workspace = await tempWorkspace();
    await writeFile(join(workspace.downloadsRoot, "draft.txt"), "old", "utf8");
    const proposal = await createDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: "clean downloads",
      idGenerator: () => "proposal_changed",
    }, {
      rationale: "move draft",
      actions: [
        { kind: "move", source: "draft.txt", targetCategory: "Documents", reason: "text" },
      ],
    });
    await writeFile(join(workspace.downloadsRoot, "draft.txt"), "changed", "utf8");

    await expect(applyDownloadsProposal({
      downloadsRoot: workspace.downloadsRoot,
      stateDir: workspace.stateDir,
      trashDir: workspace.trashDir,
      currentUserMessage: proposal.approvalPhrase,
    }, {
      proposalId: proposal.proposalId,
      approvalPhrase: proposal.approvalPhrase,
      actionIds: ["act_1"],
    })).rejects.toThrow(/changed since proposal/u);
  });
});
