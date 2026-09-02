import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});
