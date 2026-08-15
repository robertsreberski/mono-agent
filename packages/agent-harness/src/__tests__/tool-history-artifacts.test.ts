import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalToolArtifactRoot } from "../tool-history-artifacts.js";

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
    expect(() => canonicalToolArtifactRoot(dangling)).toThrow();
    expect(() => canonicalToolArtifactRoot(loopA)).toThrow();
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects an existing artifact directory without read/search permission",
    async () => {
      const root = await tempRoot();
      const inaccessible = join(root, "inaccessible");
      await mkdir(inaccessible, { mode: 0o700 });
      await chmod(inaccessible, 0o000);
      try {
        expect(() => canonicalToolArtifactRoot(inaccessible)).toThrow();
      } finally {
        await chmod(inaccessible, 0o700);
      }
    },
  );
});
