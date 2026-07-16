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
    /direct(?:ly configured)? ultra (?:currently )?maps to low thinking on pi/u,
  );
}

describe("ultra effort documentation parity", () => {
  it("keeps canonical docs, generated reference, CLI help, and composer references route-specific", () => {
    const runtimeEffort = allConfigReferenceFields().find(
      (field) => field.jsonPath === "runtime.effort",
    );
    expect(runtimeEffort).toBeDefined();

    const surfaces = [
      [readRepoFile("packages/config/README.md"), "config package README"],
      [readRepoFile("docs/runtime/execution-effort-permissions.md"), "canonical runtime guide"],
      [readRepoFile("docs/config/blueprint.md"), "canonical config blueprint"],
      [readRepoFile("docs/config/reference.md"), "generated config reference"],
      [runtimeEffort?.description ?? "", "config reference source"],
      [renderHelp(), "built CLI help source"],
      [
        readRepoFile("packages/agent-app/skills/mono-agent-composer/references/feature-coverage.md"),
        "composer feature coverage",
      ],
      [
        readRepoFile("packages/agent-app/skills/mono-agent-composer/references/config-blueprint.md"),
        "composer config blueprint",
      ],
    ] as const;

    for (const [surface, label] of surfaces) {
      expectUltraRouteContract(surface, label);
    }
  });
});
