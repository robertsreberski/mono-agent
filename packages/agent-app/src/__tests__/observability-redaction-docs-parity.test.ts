import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SHARED_REDACTION_CONTRACT = [
  "non-numeric values under sensitive-looking object keys are redacted;",
  "numeric values under matched keys are retained;",
  "free text is not content-scanned",
].join(" ");
const RUN_HISTORY_SECOND_PASS_CONTRACT = [
  "`runhistory` then applies an additional projection sanitizer.",
  "in that second pass, numeric values under `credential`, `private_key`, and `bearer` can remain visible;",
  "numeric values under `apikey`, `token`, `client_secret`, `password`, `authorization`, and `cookie` are redacted.",
  "assignment-shaped password or secret prose is content-scanned and replaced with the diagnostic or tool-result omission sentinel.",
].join(" ");

function repoRoot(): string {
  let dir = here;
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate pnpm-workspace.yaml above the test file");
}

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot(), relativePath), "utf8");
}

function normalized(source: string): string {
  return source.replace(/\s+/gu, " ").toLowerCase();
}

function lineContaining(relativePath: string, anchor: string): string {
  const line = readRepoFile(relativePath).split("\n").find((candidate) => candidate.includes(anchor));
  if (line === undefined) {
    throw new Error(`${relativePath} is missing anchor ${JSON.stringify(anchor)}`);
  }
  return normalized(line);
}

function paragraphContaining(relativePath: string, anchor: string): string {
  const paragraph = readRepoFile(relativePath)
    .split(/\n\s*\n/gu)
    .find((candidate) => candidate.includes(anchor));
  if (paragraph === undefined) {
    throw new Error(`${relativePath} is missing paragraph anchor ${JSON.stringify(anchor)}`);
  }
  return normalized(paragraph);
}

function markdownSection(relativePath: string, heading: string): string {
  const page = readRepoFile(relativePath);
  const marker = `## ${heading}`;
  const start = page.indexOf(marker);
  if (start === -1) {
    throw new Error(`${relativePath} is missing section ${JSON.stringify(heading)}`);
  }
  const rest = page.slice(start + marker.length);
  const next = rest.search(/^## /mu);
  return normalized(next === -1 ? rest : rest.slice(0, next));
}

describe("observability redaction docs parity", () => {
  it("keeps canonical and composer summary surfaces explicit about numeric retention", () => {
    const surfaces = [
      ["docs/runtime/tools-and-guards.md", "Each run records per-turn usage"],
      ["docs/observability/index.md", "| JSONL run artifacts |"],
      ["docs/observability/phoenix-and-backfill.md", "| `includeSensitiveData` |"],
      ["docs/playbooks/phoenix-observed-agent.md", "- [`observability.jsonl-artifacts`]"],
      ["docs/playbooks/phoenix-observed-agent.md", "With `includeSensitiveData: false`"],
      ["docs/reference/feature-registry.md", "| `observability.jsonl-artifacts` |"],
      ["docs/reference/feature-registry.md", "| `observability.phoenix-exporter` |"],
      ["packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md", "| JSONL run artifacts"],
      ["packages/agent-app/skills/mono-agent-composer/references/playbooks.md", "**Smoke:** complete a TUI prompt"],
      ["packages/agent-app/skills/mono-agent-composer/references/validation.md", "| Observability |"],
    ] as const;

    for (const [relativePath, anchor] of surfaces) {
      expect(lineContaining(relativePath, anchor), `${relativePath}: ${anchor}`).toContain(SHARED_REDACTION_CONTRACT);
    }
  });

  it("distinguishes RunHistory's second sanitizer from shared observability redaction", () => {
    const surfaces = [
      markdownSection("docs/tools/mcp.md", "`RunHistory`: prior-run evidence"),
      markdownSection(
        "docs/observability/artifacts-and-traces.md",
        "Agent-facing prior-run evidence (`RunHistory`)",
      ),
      lineContaining("docs/reference/feature-registry.md", "| `agent-app.run-history-tool` |"),
      paragraphContaining("packages/agent-app/README.md", "`RunHistory` requires no config key."),
    ];

    for (const surface of surfaces) {
      expect(surface).toContain(SHARED_REDACTION_CONTRACT);
      expect(surface).toContain(RUN_HISTORY_SECOND_PASS_CONTRACT);
    }
  });

  it("documents the current separator misses and substring false positives as follow-up", () => {
    for (const relativePath of [
      "docs/observability/artifacts-and-traces.md",
      "packages/observability/README.md",
    ]) {
      const page = normalized(readRepoFile(relativePath));
      expect(page).toContain("follow-up");
      for (const term of ["space", "dot", "slash", "colon", "credentialtype", "bearerstatus", "privatekeyboard"]) {
        expect(page, `${relativePath} is missing ${term}`).toContain(term);
      }
    }
  });
});
