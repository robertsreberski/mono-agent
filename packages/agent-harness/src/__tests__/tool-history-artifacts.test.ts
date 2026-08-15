import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalToolArtifactRoot,
  toolHistoryArtifactAvailable,
} from "../tool-history-artifacts.js";

const tempDirs: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tool-history-artifact-root-"));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true })));
});

describe("canonicalToolArtifactRoot", () => {
  it.skipIf(process.platform === "win32")("allows a safe directory symlink and canonicalizes a future child through it", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    const alias = join(root, "alias");
    await mkdir(target);
    await symlink(target, alias, "dir");

    expect(canonicalToolArtifactRoot(alias)).toBe(await realpath(target));
    expect(canonicalToolArtifactRoot(join(alias, "future", "tool-output")))
      .toBe(join(await realpath(target), "future", "tool-output"));
  });

  it.skipIf(process.platform === "win32")("rejects a missing root below a dangling symlink ancestor", async () => {
    const root = await tempRoot();
    const safeFuture = join(root, "ordinary-missing", "future", "tool-output");
    const dangling = join(root, "dangling");
    await symlink(join(root, "missing-target"), dangling, "dir");

    expect(canonicalToolArtifactRoot(safeFuture))
      .toBe(join(await realpath(root), "ordinary-missing", "future", "tool-output"));
    expect(capturedError(() => canonicalToolArtifactRoot(join(dangling, "future", "tool-output"))))
      .toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform === "win32")("rejects regular-file, file-symlink, dangling, and cyclic roots", async () => {
    const root = await tempRoot();
    const file = join(root, "artifact-file");
    const fileAlias = join(root, "file-alias");
    const dangling = join(root, "dangling");
    const loopA = join(root, "loop-a");
    const loopB = join(root, "loop-b");
    await writeFile(file, "not a directory");
    await symlink(file, fileAlias);
    await symlink(join(root, "missing-target"), dangling, "dir");
    await symlink(loopB, loopA, "dir");
    await symlink(loopA, loopB, "dir");

    expect(() => canonicalToolArtifactRoot(file)).toThrow(/must be a directory/iu);
    expect(() => canonicalToolArtifactRoot(fileAlias)).toThrow(/must be a directory/iu);
    expect(capturedError(() => canonicalToolArtifactRoot(dangling))).toMatchObject({ code: "ENOENT" });
    expect(capturedError(() => canonicalToolArtifactRoot(loopA))).toMatchObject({ code: "ELOOP" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects an existing artifact directory without read/search permission",
    async () => {
      const root = await tempRoot();
      const inaccessible = join(root, "inaccessible");
      await mkdir(inaccessible, { mode: 0o700 });
      await chmod(inaccessible, 0o000);
      try {
        expect(capturedError(() => canonicalToolArtifactRoot(inaccessible))).toMatchObject({ code: "EACCES" });
      } finally {
        await chmod(inaccessible, 0o700);
      }
    },
  );
});

describe("toolHistoryArtifactAvailable", () => {
  it.skipIf(process.platform === "win32")("resolves a safe directory alias without weakening containment", async () => {
    const root = await tempRoot();
    const target = join(root, "target");
    const alias = join(root, "alias");
    const runId = "safe-alias-run";
    const artifact = join(alias, runId, "result.txt");
    await mkdir(join(target, runId), { recursive: true });
    await writeFile(join(target, runId, "result.txt"), "artifact body");
    await symlink(target, alias, "dir");

    expect(toolHistoryArtifactAvailable(artifact, alias, runId)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("returns false after the root is replaced by a dangling symlink", async () => {
    const root = await tempRoot();
    const artifactRoot = join(root, "artifacts");
    const retainedRoot = join(root, "retained-artifacts");
    const runId = "dangling-root-run";
    const artifact = join(artifactRoot, runId, "result.txt");
    await mkdir(join(artifactRoot, runId), { recursive: true });
    await writeFile(artifact, "artifact body");
    expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(true);

    await rename(artifactRoot, retainedRoot);
    await symlink(join(root, "missing-artifacts"), artifactRoot, "dir");

    expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(false);
  });

  it("returns false after the root is replaced by a regular file", async () => {
    const root = await tempRoot();
    const artifactRoot = join(root, "artifacts");
    const retainedRoot = join(root, "retained-artifacts");
    const runId = "file-root-run";
    const artifact = join(artifactRoot, runId, "result.txt");
    await mkdir(join(artifactRoot, runId), { recursive: true });
    await writeFile(artifact, "artifact body");
    expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(true);

    await rename(artifactRoot, retainedRoot);
    await writeFile(artifactRoot, "not a directory");

    expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "returns false when the root loses read/search permission",
    async () => {
      const root = await tempRoot();
      const artifactRoot = join(root, "artifacts");
      const runId = "inaccessible-root-run";
      const artifact = join(artifactRoot, runId, "result.txt");
      await mkdir(join(artifactRoot, runId), { recursive: true, mode: 0o700 });
      await writeFile(artifact, "artifact body");
      expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(true);

      await chmod(artifactRoot, 0o000);
      try {
        expect(toolHistoryArtifactAvailable(artifact, artifactRoot, runId)).toBe(false);
      } finally {
        await chmod(artifactRoot, 0o700);
      }
    },
  );
});

function capturedError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
