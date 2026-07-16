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
      "JSONL artifacts become the completed-run record after terminal persistence; events buffer in memory before then.",
      "JSONL artifacts are not a source of truth for in-flight runs.",
      "Replay shows only redacted, bounded events that reached terminal persistence.",
      "A separate tool-output artifact may retain a block when best-effort persistence succeeds.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.userDocsChecked).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("flags absolute JSONL durability claims across authoritative repo docs", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "README.md", [
      "# Framework",
      "",
      "The local JSONL artifacts remain the local fallback and source of truth.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/observability/phoenix-and-backfill.md", [
      "# Phoenix",
      "",
      "Read from the always-on run record.",
      "See the always-on JSONL run record for backfill.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/config/folder-layout.md", [
      "# Layout",
      "",
      "Artifacts are the always-on local traceability fallback.",
      "",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/observability/README.md", [
      "# Observability",
      "",
      "Raw `.events.jsonl` artifacts stay append-only.",
      "",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

    expect(result.checked).toBe(0);
    expect(result.userDocsChecked).toBe(4);
    expect(result.issues).toHaveLength(5);
    expect(result.issues.join("\n")).toContain("JSONL artifacts as a source of truth");
    expect(result.issues.join("\n")).toContain("always-on JSONL run record");
    expect(result.issues.join("\n")).toContain("always-on local traceability fallback");
    expect(result.issues.join("\n")).toContain("append-only JSONL run artifact");
  });

  it("flags full/no-drop TUI recovery claims across docs, package READMEs, and runtime source text", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/channels/tui.md", [
      "# TUI channel",
      "It streams every structured `AgentStreamEvent` verbatim.",
      "The full data stays in the run's [JSONL artifacts].",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/observability/tui.md", [
      "# TUI",
      "The full data is always in the run's JSONL artifacts and visible in replay.",
      "Replay opens a full coalesced event timeline.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/README.md", [
      "# TUI package",
      "Open any run for its full coalesced event timeline (nothing dropped).",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator-adapter/README.md", [
      "# Operator adapter",
      "The endpoint streams at full `AgentStreamEvent` fidelity.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/components/tool-panel.ts", [
      "const notice = '(payload truncated for streaming — full data in run artifacts)';",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator-adapter/src/tui/constants.ts", [
      "// The full data remains in the run's JSONL artifacts.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator-adapter/src/tui/server.ts", [
      "// The full payload stays available in run artifacts.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/views/replay.ts", [
      "// A full event timeline is richer than live since nothing is dropped.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/app.ts", [
      "const description = 'Browse recorded runs (full event timeline)';",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });
    const reported = result.issues.join("\n");

    expect(result.userDocsChecked).toBe(4);
    expect(result.artifactContractSourcesChecked).toBe(5);
    expect(reported).toContain("full payload guaranteed in run artifacts");
    expect(reported).toContain("full or no-drop replay timeline");
    expect(reported).toContain("full AgentStreamEvent fidelity");
    expect(reported).toContain("verbatim complete TUI event stream");
    for (const relativePath of [
      "docs/channels/tui.md",
      "docs/observability/tui.md",
      "packages/tui/README.md",
      "packages/operator-adapter/README.md",
      "packages/tui/src/ui/components/tool-panel.ts",
      "packages/operator-adapter/src/tui/constants.ts",
      "packages/operator-adapter/src/tui/server.ts",
      "packages/tui/src/ui/views/replay.ts",
      "packages/tui/src/ui/app.ts",
    ]) {
      expect(reported).toContain(relativePath);
    }
  });

  it("flags residual absolute observability claims in playbooks, composer references, and session-web source", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/reference/feature-registry.md", [
      "# Features",
      "live chat with full stream-event insight",
      "every structured `AgentStreamEvent` verbatim",
      "Rich traces are exported on every run.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/playbooks/phoenix-observed-agent.md", [
      "# Phoenix",
      "Every run lifecycle streams to a [Phoenix] dashboard.",
      "Redacted JSONL artifacts are always written locally as the fallback.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/config/blueprint.md", [
      "# Blueprint",
      "JSONL artifacts (always written; the local fallback)",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/runtime/tools-and-guards.md", [
      "# Tool guard",
      "When a tool result exceeds the budget it is persisted as an artifact, so nothing is silently lost.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/package-map.md", [
      "# Package map",
      "live chat with full stream-event insight",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/playbooks.md", [
      "# Playbooks",
      "stream every run to Phoenix as OpenInference spans",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md", [
      "# Blueprint",
      "JSONL artifacts are always written regardless of exporter state.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md", [
      "# Discovery",
      "Local JSONL artifacts are always written and are the fallback.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/session-web/src/history.ts", [
      "// a session's steps need the fuller (redacted) payload",
      "// Full timelines are loaded by readInstanceSession.",
      "// use {@link readInstanceSession} for full detail.",
      "// A single run read in full.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/session-web/src/aggregator.ts", [
      "// cached session contains full detail read from the disk artifact",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/operator-adapter/src/tui/constants.ts", [
      "// Upper bound for one serialized NDJSON frame.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/package.json", JSON.stringify({
      description: "live chat with full stream-event insight",
    }));
    await writeRepoDoc(repoRoot, "scripts/package-catalog.mjs", [
      "const responsibility = 'live chat with full stream-event insight';",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });
    const reported = result.issues.join("\n");

    expect(result.userDocsChecked).toBe(8);
    expect(result.artifactContractSourcesChecked).toBe(5);
    expect(reported).toContain("full stream-event insight");
    expect(reported).toContain("guaranteed every-run Phoenix stream");
    expect(reported).toContain("guaranteed every-run Phoenix export");
    expect(reported).toContain("always-written JSONL artifacts");
    expect(reported).toContain("unbounded session artifact detail");
    expect(reported).toContain("verbatim complete TUI event stream");
    expect(reported).toContain("strict 256 KiB TUI frame cap");
    expect(reported).toContain("guaranteed tool-output artifact persistence");
    for (const relativePath of [
      "docs/reference/feature-registry.md",
      "docs/playbooks/phoenix-observed-agent.md",
      "docs/config/blueprint.md",
      "docs/runtime/tools-and-guards.md",
      "packages/agent-app/skills/mono-agent-composer/references/package-map.md",
      "packages/agent-app/skills/mono-agent-composer/references/playbooks.md",
      "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
      "packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md",
      "packages/session-web/src/history.ts",
      "packages/session-web/src/aggregator.ts",
      "packages/operator-adapter/src/tui/constants.ts",
      "packages/tui/package.json",
      "scripts/package-catalog.mjs",
    ]) {
      expect(reported).toContain(relativePath);
    }
  });

  it("allows bounded replay wording and separate best-effort tool-output persistence", async () => {
    const repoRoot = await tempRepo();
    await writeRepoDoc(repoRoot, "docs/observability/tui.md", [
      "# TUI",
      "Replay shows redacted, capped events that reached terminal JSONL persistence.",
      "A crash can lose RAM-buffered events before that boundary.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/README.md", [
      "# TUI package",
      "Replay is bounded; a separate tool-output file exists only when persistence succeeds.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/src/ui/components/tool-panel.ts", [
      "const notice = '(payload truncated for streaming; replay may also be bounded)';",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/package-map.md", [
      "# Package map",
      "Oversized remote event frames trigger field reduction at the 256 KiB threshold; it is not a strict maximum.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/agent-app/skills/mono-agent-composer/references/discovery-questions.md", [
      "# Discovery",
      "Phoenix provides best-effort export of every run lifecycle at the terminal boundary.",
      "JSONL artifacts are not always written to a terminal state; a crash can lose buffered events.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "docs/runtime/tools-and-guards.md", [
      "# Tool guard",
      "The guard attempts best-effort persistence; missing or failed sinks leave omitted bytes unavailable.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/session-web/src/history.ts", [
      "// Loads only persisted, bounded session detail; omitted data cannot be restored.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/session-web/src/aggregator.ts", [
      "// Tracks sessions whose persisted, bounded detail has been loaded.",
    ].join("\n"));
    await writeRepoDoc(repoRoot, "packages/tui/package.json", JSON.stringify({
      description: "live chat with structured stream-event insight and bounded replay",
    }));
    await writeRepoDoc(repoRoot, "scripts/package-catalog.mjs", [
      "const responsibility = 'structured stream-event insight with bounded replay';",
    ].join("\n"));

    const result = await checkConsumerDocsConsistency([], { repoRoot });

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
