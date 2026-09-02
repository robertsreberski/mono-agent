import { existsSync, renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { cleanBuildOutputs } from "../clean-dist.mjs";

const tempDirs = [];

async function fixtureRepo(directories) {
  const repoRoot = await mkdtemp(join(tmpdir(), "mono-agent-clean-dist-"));
  tempDirs.push(repoRoot);
  for (const directory of directories) {
    await mkdir(join(repoRoot, directory), { recursive: true });
  }
  return repoRoot;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("clean-dist", () => {
  it("removes build output across every workspace parent, including nested webapp bundles", async () => {
    const repoRoot = await fixtureRepo([
      "packages/telegram-adapter/dist",
      "packages/telegram-adapter/src",
      "packages/web/webapp/dist",
      "extras/whatsapp-adapter/dist",
      "demos/final-agent/dist",
      "demos/generic-fixture/dist",
    ]);
    await writeFile(join(repoRoot, "packages/telegram-adapter/dist/ask.js"), "");
    await writeFile(join(repoRoot, "packages/telegram-adapter/src/index.ts"), "");
    await writeFile(join(repoRoot, "demos/final-agent/dist/cli.js"), "runnable legacy demo");
    await writeFile(join(repoRoot, "demos/generic-fixture/dist/index.js"), "fixture");

    const removed = cleanBuildOutputs({ repoRoot, log: () => {} });

    expect(removed.sort()).toEqual([
      "demos/final-agent/dist",
      "extras/whatsapp-adapter/dist",
      "packages/telegram-adapter/dist",
      "packages/web/webapp/dist",
    ]);
    expect(existsSync(join(repoRoot, "packages/telegram-adapter/dist"))).toBe(false);
    expect(existsSync(join(repoRoot, "demos/final-agent/dist/cli.js"))).toBe(false);
    // Sources are never touched — only generated output is removed.
    expect(existsSync(join(repoRoot, "packages/telegram-adapter/src/index.ts"))).toBe(true);
    // Generic demo-named fixtures are outside the exact retired output contract.
    expect(existsSync(join(repoRoot, "demos/generic-fixture/dist/index.js"))).toBe(true);
  });

  it("is idempotent and tolerates absent workspace parents", async () => {
    const repoRoot = await fixtureRepo(["packages/config/dist"]);

    expect(cleanBuildOutputs({ repoRoot, log: () => {} })).toEqual(["packages/config/dist"]);
    expect(cleanBuildOutputs({ repoRoot, log: () => {} })).toEqual([]);
  });

  it("does not follow a symlinked retired-demo parent outside the repository", async () => {
    const repoRoot = await fixtureRepo(["demos"]);
    const externalRoot = await mkdtemp(join(tmpdir(), "mono-agent-external-demo-"));
    tempDirs.push(externalRoot);
    await mkdir(join(externalRoot, "dist"));
    await writeFile(join(externalRoot, "dist/cli.js"), "external data");
    await symlink(externalRoot, join(repoRoot, "demos/final-agent"), "dir");
    const logs = [];

    expect(cleanBuildOutputs({ repoRoot, log: (line) => logs.push(line) })).toEqual([]);

    expect(existsSync(join(externalRoot, "dist/cli.js"))).toBe(true);
    expect(logs).toContain(
      "skipped demos/final-agent/dist: a parent path is a symbolic link",
    );
  });

  it("fails closed when a validated retired-demo parent is swapped to an external symlink", async () => {
    const repoRoot = await fixtureRepo(["demos/final-agent/dist"]);
    const externalRoot = await mkdtemp(join(tmpdir(), "mono-agent-external-demo-race-"));
    tempDirs.push(externalRoot);
    await mkdir(join(externalRoot, "dist"));
    await writeFile(join(externalRoot, "dist/cli.js"), "external data");
    const originalParent = join(repoRoot, "demos/final-agent");
    const movedParent = join(repoRoot, "demos/final-agent-original");
    const logs = [];

    const removed = cleanBuildOutputs({
      repoRoot,
      log: (line) => logs.push(line),
      beforeRetiredOutputRemoval: () => {
        renameSync(originalParent, movedParent);
        symlinkSync(externalRoot, originalParent, "dir");
      },
    });

    expect(removed).toEqual([]);
    expect(existsSync(join(externalRoot, "dist/cli.js"))).toBe(true);
    expect(existsSync(join(movedParent, "dist"))).toBe(true);
    expect(logs).toContain(
      "skipped demos/final-agent/dist: path identity changed during deletion",
    );
  });

  it("fails closed when the validated parent inode is moved outside and linked back", async () => {
    const repoRoot = await fixtureRepo(["demos/final-agent/dist"]);
    const outsideRoot = await mkdtemp(join(tmpdir(), "mono-agent-moved-demo-parent-"));
    tempDirs.push(outsideRoot);
    const originalParent = join(repoRoot, "demos/final-agent");
    const movedParent = join(outsideRoot, "moved-final-agent");
    await writeFile(join(originalParent, "dist/cli.js"), "moved outside data");
    const logs = [];

    const removed = cleanBuildOutputs({
      repoRoot,
      log: (line) => logs.push(line),
      beforeRetiredOutputRemoval: () => {
        renameSync(originalParent, movedParent);
        symlinkSync(movedParent, originalParent, "dir");
      },
    });

    expect(removed).toEqual([]);
    expect(existsSync(join(movedParent, "dist/cli.js"))).toBe(true);
    expect(logs).toContain(
      "skipped demos/final-agent/dist: path identity changed during deletion",
    );
  });
});
