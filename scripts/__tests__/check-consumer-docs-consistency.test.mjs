import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkConsumerDocsConsistency } from "../check-consumer-docs-consistency.mjs";

const tempDirs = [];
const monoPackage = (...nameParts) => `@mono-agent/${nameParts.join("-")}`;

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("check-consumer-docs-consistency", () => {
  it("flags retired pre-v1 package references in repo user docs", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/getting-started/quickstart.md", [
      "# Quickstart",
      "",
      "Install @mono-agent/agent-evals for the old evaluation path.",
      "The memory-bujo package owns durable memory.",
      "WhatsApp and A2A are bundled core channels.",
      "Built-in WhatsApp/A2A channels are available.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.checked).toBe(0);
    expect(result.userDocsChecked).toBe(1);
    expect(result.issues).toHaveLength(4);
    expect(result.issues.join("\n")).toContain("@mono-agent/agent-evals");
    expect(result.issues.join("\n")).toContain("memory-bujo package");
    expect(result.issues.join("\n")).toContain("WhatsApp/A2A in core");
  });

  it("allows current generic and external-plugin references", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/config/blueprint.md", [
      "# Config",
      "",
      "Settings can be adjusted in mono-agent.config.json.",
      "WhatsApp and A2A are external channel plugins/extras.",
      "Use memory.llm.provider: \"agent-host\" for SDK memory capture.",
      "Run memory-bujo recall ./memory \"question\" for manual maintenance.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.userDocsChecked).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("flags retired pre-v1 names in supplied consumer README files", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/index.md", "# Docs\n");
    const consumerDir = await tempDir("consumer-docs-");
    await writeFile(join(consumerDir, "README.md"), [
      "# Downstream Agent",
      "",
      `This folder still depends on ${monoPackage("tui", "adapter")}.`,
      "",
    ].join("\n"), "utf8");
    await writeFile(join(consumerDir, "mono-agent.config.json"), JSON.stringify({ runtime: { model: "test" } }), "utf8");

    const result = await checkConsumerDocsConsistency([consumerDir], { repoRoot });

    expect(result.checked).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(monoPackage("tui", "adapter"));
  });
});

async function tempRepo() {
  const dir = await tempDir("consumer-docs-repo-");
  await mkdir(join(dir, "docs"), { recursive: true });
  return dir;
}

async function writeRepoDoc(repoRoot, relativePath, contents) {
  const path = join(repoRoot, relativePath);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
