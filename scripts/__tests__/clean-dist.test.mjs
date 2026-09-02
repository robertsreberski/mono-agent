import { existsSync, renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function childPreload(source) {
  const preloadRoot = await mkdtemp(join(tmpdir(), "mono-agent-clean-dist-preload-"));
  tempDirs.push(preloadRoot);
  const preloadPath = join(preloadRoot, "preload.cjs");
  await writeFile(preloadPath, source);
  return preloadPath;
}

function childEnvironment(preloadPath) {
  return {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preloadPath}`.trim(),
  };
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
    expect((await readdir(join(repoRoot, "demos/final-agent"))).some(
      (entry) => entry.startsWith(".dist.cleaning-"),
    )).toBe(false);
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

  it("does not report success when the named entry is replaced after inspection", async () => {
    const repoRoot = await fixtureRepo([
      "demos/final-agent/dist",
      "demos/final-agent/replacement",
    ]);
    const parent = join(repoRoot, "demos/final-agent");
    await writeFile(join(parent, "dist/cli.js"), "original runnable demo");
    await writeFile(join(parent, "replacement/keep.txt"), "replacement data");
    const logs = [];

    const removed = cleanBuildOutputs({
      repoRoot,
      log: (line) => logs.push(line),
      beforeRetiredOutputRemoval: () => {
        renameSync(join(parent, "dist"), join(parent, "dist.original"));
        renameSync(join(parent, "replacement"), join(parent, "dist"));
      },
    });

    expect(removed).toEqual([]);
    expect(await readFile(join(parent, "dist/keep.txt"), "utf8")).toBe("replacement data");
    expect(await readFile(join(parent, "dist.original/cli.js"), "utf8")).toBe(
      "original runnable demo",
    );
    expect(logs).toContain(
      "skipped demos/final-agent/dist: path identity changed during deletion",
    );
    expect(logs).not.toContain("removed demos/final-agent/dist");
  });

  it("quarantines but does not delete an entry replaced immediately after the child inspection", async () => {
    const repoRoot = await fixtureRepo([
      "demos/final-agent/dist",
      "demos/final-agent/replacement",
    ]);
    const parent = join(repoRoot, "demos/final-agent");
    await writeFile(join(parent, "dist/cli.js"), "original runnable demo");
    await writeFile(join(parent, "replacement/keep.txt"), "replacement data");
    const preloadPath = await childPreload(`
const fs = require("node:fs");
const nativeLstatSync = fs.lstatSync;
let swapped = false;
fs.lstatSync = function patchedLstatSync(candidate, ...args) {
  const details = nativeLstatSync.call(this, candidate, ...args);
  if (!swapped && candidate === "dist") {
    swapped = true;
    fs.renameSync("dist", "dist.original");
    fs.renameSync("replacement", "dist");
  }
  return details;
};
`);
    const logs = [];

    const removed = cleanBuildOutputs({
      repoRoot,
      log: (line) => logs.push(line),
      retiredOutputChildEnv: childEnvironment(preloadPath),
    });

    expect(removed).toEqual([]);
    const pending = (await readdir(parent)).filter((entry) => entry.startsWith(".dist.cleaning-"));
    expect(pending).toHaveLength(1);
    expect(await readFile(join(parent, pending[0], "keep.txt"), "utf8")).toBe("replacement data");
    expect(await readFile(join(parent, "dist.original/cli.js"), "utf8")).toBe(
      "original runnable demo",
    );
    expect(logs.some((line) => line.includes("quarantine identity mismatch")
      && line.includes(`inspect`)
      && line.includes(pending[0]))).toBe(true);
    expect(logs).not.toContain("removed demos/final-agent/dist");
  });

  it("reports a quarantine cleanup failure and preserves the inspected entry", async () => {
    const repoRoot = await fixtureRepo(["demos/final-agent/dist"]);
    const parent = join(repoRoot, "demos/final-agent");
    await writeFile(join(parent, "dist/cli.js"), "original runnable demo");
    const preloadPath = await childPreload(`
const fs = require("node:fs");
const nativeRmSync = fs.rmSync;
fs.rmSync = function patchedRmSync(candidate, options) {
  if (typeof candidate === "string" && candidate.startsWith(".dist.cleaning-")) {
    const error = new Error("injected quarantine cleanup failure");
    error.code = "EIO";
    throw error;
  }
  return nativeRmSync.call(this, candidate, options);
};
`);

    let cleanupError;
    try {
      cleanBuildOutputs({
        repoRoot,
        log: () => {},
        retiredOutputChildEnv: childEnvironment(preloadPath),
      });
    } catch (error) {
      cleanupError = error;
    }

    expect(cleanupError).toMatchObject({
      code: "RETIRED_OUTPUT_QUARANTINE_CLEANUP_FAILED",
      quarantineState: "retained",
    });
    expect(cleanupError.message).toContain("quarantine cleanup failed (EIO)");
    expect(cleanupError.quarantinePath).toMatch(/\.dist\.cleaning-/u);
    expect(await readFile(join(cleanupError.quarantinePath, "cli.js"), "utf8")).toBe(
      "original runnable demo",
    );
    expect(existsSync(join(parent, "dist"))).toBe(false);
  });

  it("reports no successful removal when quarantine cleanup returns without deleting", async () => {
    const repoRoot = await fixtureRepo(["demos/final-agent/dist"]);
    const parent = join(repoRoot, "demos/final-agent");
    await writeFile(join(parent, "dist/cli.js"), "original runnable demo");
    const preloadPath = await childPreload(`
const fs = require("node:fs");
const nativeRmSync = fs.rmSync;
fs.rmSync = function patchedRmSync(candidate, options) {
  if (typeof candidate === "string" && candidate.startsWith(".dist.cleaning-")) return;
  return nativeRmSync.call(this, candidate, options);
};
`);
    const logs = [];

    const removed = cleanBuildOutputs({
      repoRoot,
      log: (line) => logs.push(line),
      retiredOutputChildEnv: childEnvironment(preloadPath),
    });

    expect(removed).toEqual([]);
    const pending = (await readdir(parent)).filter((entry) => entry.startsWith(".dist.cleaning-"));
    expect(pending).toHaveLength(1);
    expect(await readFile(join(parent, pending[0], "cli.js"), "utf8")).toBe(
      "original runnable demo",
    );
    expect(logs.some((line) => line.includes("quarantine cleanup incomplete")
      && line.includes("remains at")
      && line.includes(pending[0]))).toBe(true);
    expect(logs).not.toContain("removed demos/final-agent/dist");
  });
});
