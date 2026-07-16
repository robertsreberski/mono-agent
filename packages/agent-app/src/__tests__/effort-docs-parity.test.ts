import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { allConfigReferenceFields } from "../config-reference.js";
import { renderHelp } from "../cli.js";

const here = dirname(fileURLToPath(import.meta.url));

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

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot(), path), "utf8");
}

function normalizeProse(value: string): string {
  return value.replaceAll("`", "").replace(/\s+/gu, " ").toLowerCase();
}

interface ContractSurface {
  readonly label: string;
  readonly path: string;
  readonly tableRow?: string;
}

const STATIC_CONTRACT_SURFACES: readonly ContractSurface[] = [
  { path: "packages/config/README.md", label: "config package README" },
  { path: "docs/channels/cron.md", label: "canonical cron guide" },
  { path: "docs/channels/webhook.md", label: "canonical webhook guide" },
  { path: "docs/config/blueprint.md", label: "canonical config blueprint" },
  { path: "docs/config/env-vars.md", label: "canonical environment reference" },
  { path: "docs/config/reference.md", label: "generated config reference" },
  { path: "docs/observability/cli-reference.md", label: "canonical CLI reference" },
  {
    path: "docs/reference/feature-registry.md",
    label: "feature registry runtime.effort row",
    tableRow: "runtime.effort",
  },
  {
    path: "docs/reference/feature-registry.md",
    label: "feature registry runtime.per-trigger-model row",
    tableRow: "runtime.per-trigger-model",
  },
  {
    path: "docs/runtime/execution-effort-permissions.md",
    label: "canonical runtime effort guide",
  },
  { path: "docs/runtime/index.md", label: "canonical runtime index" },
  {
    path: "packages/agent-app/schema/mono-agent.config.schema.json",
    label: "generated config schema",
  },
  {
    path: "packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md",
    label: "composer feature coverage",
  },
  {
    path: "packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md",
    label: "composer config blueprint",
  },
];

function readContractSurface(surface: ContractSurface): readonly [string, string] {
  const contents = readRepoFile(surface.path);
  if (surface.tableRow === undefined) {
    return [contents, surface.label];
  }

  const prefix = `| \`${surface.tableRow}\` |`;
  const rows = contents.split(/\r?\n/gu).filter((line) => line.startsWith(prefix));
  expect(rows, `${surface.label} must resolve to exactly one table row`).toHaveLength(1);
  return [rows[0] ?? "", surface.label];
}

function expectUltraRouteContract(value: string, label: string): void {
  const prose = normalizeProse(value);
  for (const fact of [
    "reasoning-capable pi:* maps ultra to low",
    "pi without reasoning uses off",
    "direct codex:* forwards ultra unchanged",
    "direct claude rejects ultra",
    "direct opencode rejects explicit effort",
  ]) {
    expect(prose, `${label} is missing: ${fact}`).toContain(fact);
  }
  expect(prose, `${label} must explain the escalation-only rank`).toMatch(
    /(?:effortrank places ultra above max only so keyword escalation cannot downgrade|ranking above max only prevents keyword downgrade)/u,
  );
  expect(prose, `${label} must not claim a global Pi mapping`).not.toMatch(
    /direct(?:ly configured)? ultra\b[^.!?]{0,160}\b(?:currently )?maps to low thinking(?: on pi)?/u,
  );
}

describe("ultra effort documentation parity", () => {
  it("keeps canonical docs, generated reference, CLI help, and composer references route-specific", () => {
    const runtimeEffort = allConfigReferenceFields().find(
      (field) => field.jsonPath === "runtime.effort",
    );
    expect(runtimeEffort).toBeDefined();

    const surfaces = [
      ...STATIC_CONTRACT_SURFACES.map(readContractSurface),
      [runtimeEffort?.description ?? "", "config reference source"],
      [renderHelp(), "built CLI help source"],
    ] as const;

    for (const [surface, label] of surfaces) {
      expectUltraRouteContract(surface, label);
    }
  });
});
