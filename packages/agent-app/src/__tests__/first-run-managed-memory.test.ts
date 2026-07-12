import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateMonoAgentFolder } from "../doctor.js";
import {
  FIRST_RUN_MEMORY_INITIALIZING_MARKER,
  initializeFirstRunManagedMemory,
} from "../first-run-managed-memory.js";
import { composeWizardPlan } from "../wizard/answers.js";
import { findPreset, presetAnswers } from "../wizard/presets.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-app-first-memory-"));
  await mkdir(join(dir, ".mono-agent"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function localPrivatePlan() {
  return composeWizardPlan(presetAnswers(findPreset("local-private")!), {
    dirBasename: "first-memory",
    skillsRootExists: false,
  });
}

describe("initializeFirstRunManagedMemory", () => {
  it.each([
    { label: "escaping", path: "../outside-memory" },
    { label: "absolute", path: "/tmp/outside-memory" },
    { label: "root", path: "." },
  ])("rejects a $label configured path before claiming anything", async ({ path }) => {
    const base = localPrivatePlan();
    const plan = {
      ...base,
      configJson: {
        ...base.configJson,
        memory: { ...base.configJson.memory!, path },
      },
    };

    await expect(initializeFirstRunManagedMemory({ agentRoot: dir, plan }))
      .rejects.toThrow(/Refusing first-run managed memory/u);
    await expect(access(join(dir, ".mono-agent", "memory"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a root and its contents untouched when another creator wins the claim race", async () => {
    const root = join(await realpath(dir), ".mono-agent", "memory");
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRootClaim: async (candidate) => {
          expect(candidate).toBe(root);
          await mkdir(candidate);
          await writeFile(join(candidate, "sentinel"), "external-winner\n");
        },
      },
    })).rejects.toThrow(/another creator won/u);

    expect(await readFile(join(root, "sentinel"), "utf8")).toBe("external-winner\n");
  });

  it("cleans only its claimed root when initialization fails", async () => {
    const root = join(dir, ".mono-agent", "memory");
    const sibling = join(dir, ".mono-agent", "keep.txt");
    await writeFile(sibling, "keep\n");

    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRebuild: async () => { throw new Error("injected rebuild failure"); },
      },
    })).rejects.toThrow("injected rebuild failure");

    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sibling, "utf8")).toBe("keep\n");
  });

  it("preserves raced external content when a claimed staging root fails", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforeRebuild: async (candidate) => {
          stagingRoot = candidate;
          await writeFile(join(candidate, "external-sentinel"), "external\n");
          throw new Error("external race");
        },
      },
    })).rejects.toThrow("external race");

    await expect(access(finalRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(stagingRoot, "external-sentinel"), "utf8")).toBe("external\n");
  });

  it("publishes only a complete managed generation at the final root", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    let stagingRoot = "";
    const plan = localPrivatePlan();
    const configPath = join(dir, "mono-agent.config.json");
    await writeFile(configPath, JSON.stringify(plan.configJson));
    await writeFile(join(dir, "IDENTITY.md"), "# Identity\n");
    const result = await initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan,
      hooks: {
        beforePromotion: async (candidate, destination) => {
          stagingRoot = candidate;
          expect(destination).toBe(finalRoot);
          await access(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER));
          await expect(access(join(finalRoot, ".index"))).rejects.toMatchObject({ code: "ENOENT" });
          const report = await validateMonoAgentFolder({
            cwd: dir,
            configPath,
            env: {},
            allowFilesystemWrites: true,
            liveness: false,
          });
          expect(report.sections.find((section) => section.id === "memory")).toMatchObject({
            status: "error",
            details: expect.arrayContaining([expect.stringMatching(/initialization is incomplete/u)]),
          });
          const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
          expect(readManagedIndexManifest(candidate)).toMatchObject({
            active: {
              tier: "journal",
              embeddingModel: "ollama:nomic-embed-text:v1.5",
              dimension: 768,
            },
          });
        },
      },
    });

    expect(result).toEqual({ initialized: true, root: finalRoot });
    await expect(access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(finalRoot)?.rollback).toBeUndefined();
  });

  it("does not replace an external final root created at promotion time", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforePromotion: async (candidate) => {
          stagingRoot = candidate;
          await rm(finalRoot, { recursive: true });
          await mkdir(finalRoot);
          await writeFile(join(finalRoot, "external-sentinel"), "winner\n");
        },
      },
    })).rejects.toThrow(/claimed root changed/u);

    expect(await readFile(join(finalRoot, "external-sentinel"), "utf8")).toBe("winner\n");
    const { readManagedIndexManifest } = await import("@mono-agent/memory/bujo");
    expect(readManagedIndexManifest(stagingRoot)?.active.tier).toBe("journal");
  });

  it("never overwrites an empty .index raced immediately before publication", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    let racedIndexIdentity: { readonly dev: number; readonly ino: number } | undefined;
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        beforePromotion: async () => {
          const racedIndex = join(finalRoot, ".index");
          await mkdir(racedIndex);
          const pathStat = await lstat(racedIndex);
          racedIndexIdentity = { dev: pathStat.dev, ino: pathStat.ino };
        },
      },
    })).rejects.toThrow(/claimed root changed before publication/u);

    const after = await lstat(join(finalRoot, ".index"));
    expect({ dev: after.dev, ino: after.ino }).toEqual(racedIndexIdentity);
    await expect(access(join(finalRoot, ".index", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the fail-closed marker when failure follows the manifest authority link", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterManifestLinked: async (publishedRoot) => {
          expect(publishedRoot).toBe(finalRoot);
          await access(join(finalRoot, ".index", "manifest.json"));
          throw new Error("injected manifest source-cleanup failure");
        },
      },
    })).rejects.toThrow("injected manifest source-cleanup failure");

    await access(join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER));
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("fails instead of reporting success when its exact marker is replaced after publication", async () => {
    const finalRoot = join(await realpath(dir), ".mono-agent", "memory");
    const markerPath = join(finalRoot, FIRST_RUN_MEMORY_INITIALIZING_MARKER);
    await expect(initializeFirstRunManagedMemory({
      agentRoot: dir,
      plan: localPrivatePlan(),
      hooks: {
        afterManifestLinked: async () => {
          await rm(markerPath);
          await writeFile(markerPath, "external replacement\n");
        },
      },
    })).rejects.toThrow(/exact initialization marker/u);

    expect(await readFile(markerPath, "utf8")).toBe("external replacement\n");
    await access(join(finalRoot, ".index", "manifest.json"));
  });

  it("rejects a pinned parent replaced by a symlink before publication", async () => {
    const originalParent = join(dir, ".mono-agent");
    const holder = await mkdtemp(join(tmpdir(), "agent-app-first-memory-moved-parent-"));
    const movedParent = join(holder, "moved-mono-agent");
    try {
      await expect(initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan: localPrivatePlan(),
        hooks: {
          beforePromotion: async () => {
            await rename(originalParent, movedParent);
            await symlink(movedParent, originalParent);
          },
        },
      })).rejects.toThrow(/pinned parent directory changed identity/u);

      await expect(access(join(movedParent, "memory", ".index", "manifest.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(originalParent, { recursive: true, force: true });
      await rm(holder, { recursive: true, force: true });
    }
  });

  it("detects a claimed-root symlink replacement without touching its target", async () => {
    const finalRoot = join(dir, ".mono-agent", "memory");
    let stagingRoot = "";
    const outside = await mkdtemp(join(tmpdir(), "agent-app-first-memory-outside-"));
    try {
      await writeFile(join(outside, "sentinel"), "outside\n");
      await expect(initializeFirstRunManagedMemory({
        agentRoot: dir,
        plan: localPrivatePlan(),
        hooks: {
          afterRootClaim: async (candidate) => {
            stagingRoot = candidate;
            await rm(candidate, { recursive: true });
            await symlink(outside, candidate);
          },
        },
      })).rejects.toThrow(/claimed root changed identity/u);

      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("outside\n");
      expect((await lstat(stagingRoot)).isSymbolicLink()).toBe(true);
      expect((await lstat(finalRoot)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
