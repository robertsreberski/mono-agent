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

function normalizeClause(value: string): string {
  return value.replaceAll("`", "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isCodeLikeMultilineClause(value: string): boolean {
  return /(?:\/\/|[{}]|"[^"\n]+"\s*:|\b(?:const|let|return)\b)/u.test(value);
}

function guardSentences(value: string): readonly string[] {
  const source = value.replaceAll("`", "").toLowerCase();
  const lineSentences = source
    .split(/\r?\n/gu)
    .flatMap((line) => line.split(/[.!?;]+/u));
  const wrappedProseSentences = source
    .split(/[.!?;]+/u)
    .filter((sentence) => !isCodeLikeMultilineClause(sentence));
  return [...new Set([...lineSentences, ...wrappedProseSentences].map(normalizeClause))];
}

const PI_LOW_RELATION =
  /\b(?:map(?:s|ped|ping)?|use(?:s|d|ing)?|mak(?:e|es|ing)|made|get(?:s|ting)?|got|select(?:s|ed|ing)?|mean(?:s|t|ing)?|set(?:s|ting)?|yield(?:s|ed|ing)?|result(?:s|ed|ing)?|treat(?:s|ed|ing)?|translate(?:s|d|ing)?|convert(?:s|ed|ing)?|become(?:s|ing)?|became|apply|applies|applied|applying|run(?:s|ning)?|ran|turn(?:s|ed|ing)?|produce(?:s|d|ing)?|give(?:s|n|ing)?|gave|assign(?:s|ed|ing)?|choose(?:s|n|ing)?|chose|force(?:s|d|ing)?|default(?:s|ed|ing)?|fall(?:s|ing)?|fell|render(?:s|ed|ing)?)\b/gu;
const PI_LOW_COPULA = /\b(?:is|are|was|were)\b/gu;

function relationMatches(atom: string): readonly RegExpMatchArray[] {
  const matches = [...atom.matchAll(PI_LOW_RELATION)];
  matches.push(...atom.matchAll(PI_LOW_COPULA));
  return matches.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

function relationIsNegated(atom: string, relationIndex: number): boolean {
  const prefix = atom.slice(Math.max(0, relationIndex - 64), relationIndex);
  return /(?:\b(?:does|do|did|will|would|can|could|should|is|are|was|were)\s+(?:not|never)|\b(?:doesn't|don't|didn't|won't|wouldn't|can't|couldn't|shouldn't|isn't|aren't|wasn't|weren't)|\b(?:not|never))(?:\s+\w+ly){0,2}\s*$/u.test(
    prefix,
  );
}

function lowIsAffirmative(atom: string): boolean {
  return [...atom.matchAll(/\blow\b/gu)].some((match) => {
    const lowIndex = match.index ?? 0;
    const prefix = atom.slice(Math.max(0, lowIndex - 64), lowIndex);
    return !/\b(?:no|not|never)(?:\s+\w+){0,3}\s*$/u.test(prefix) &&
      !/\b(?:rather\s+than|instead\s+of)\s*$/u.test(prefix);
  });
}

function relationHasAffirmativeLow(atom: string, relation: RegExpMatchArray): boolean {
  if (!lowIsAffirmative(atom)) return false;
  if (!/^(?:is|are|was|were)$/u.test(relation[0] ?? "")) return true;
  const relationEnd = (relation.index ?? 0) + (relation[0]?.length ?? 0);
  return /^\s+(?:(?:currently|directly|effectively|always|now|still|simply|just)\s+){0,3}(?:the\s+)?low\b/u.test(
    atom.slice(relationEnd),
  );
}

function relationIsReasoningQualified(atom: string, relationIndex: number): boolean {
  const prefix = atom.slice(0, relationIndex);
  const qualifiers = [
    ...prefix.matchAll(
      /(?<!non-)\breasoning-capable\s+pi(?::\*)?(?=\s|$|[,])/gu,
    ),
  ];
  const qualifier = qualifiers.at(-1);
  if (qualifier === undefined) return false;
  const qualifierIndex = qualifier.index ?? 0;
  const lead = prefix.slice(Math.max(0, qualifierIndex - 48), qualifierIndex);
  return !/\b(?:no|not|never)\b[^.!?;]{0,40}$/u.test(lead);
}

function atomHasAffirmativeReasoningPi(atom: string): boolean {
  const match = /(?<!non-)\breasoning-capable\s+pi(?::\*)?(?=\s|$|[,])/u.exec(atom);
  if (match === null) return false;
  const lead = atom.slice(Math.max(0, match.index - 48), match.index);
  return !/\b(?:no|not|never)\b[^.!?;]{0,40}$/u.test(lead);
}

function unqualifiedPiLowClaims(value: string): readonly string[] {
  const claims: string[] = [];
  for (const sentence of guardSentences(value)) {
    const atoms = sentence.split(
      /(?:,\s*)?\b(?:and|but|while|whereas|although|though)\b/u,
    );
    let inheritedContext = false;
    let inheritedReasoningQualifier = false;
    for (const atom of atoms) {
      const hasPi = /\bpi\b/u.test(atom);
      const hasUltra = /\bultra\b/u.test(atom);
      const explicitContext = hasPi && hasUltra;
      const relations = relationMatches(atom);
      const elidedSubjectContinuation = !hasPi && inheritedContext && relations.some((relation) => {
        const lead = atom.slice(0, relation.index ?? 0).trim();
        return /^(?:(?:instead|then|also|still|directly|currently|simply)\s+)*$/u.test(lead);
      });
      const pronounContinuation = !hasPi && inheritedContext && /\bit\b/u.test(atom);
      const inheritedContextApplies = elidedSubjectContinuation || pronounContinuation;
      const hasRouteContext = explicitContext || inheritedContextApplies;
      const inheritedQualifierApplies = inheritedContextApplies && inheritedReasoningQualifier;
      const hasUnqualifiedRelation = relations.some((relation) => {
        const relationIndex = relation.index ?? 0;
        return hasRouteContext &&
          relationHasAffirmativeLow(atom, relation) &&
          !relationIsNegated(atom, relationIndex) &&
          !relationIsReasoningQualified(atom, relationIndex) &&
          !inheritedQualifierApplies;
      });
      if (hasUnqualifiedRelation) claims.push(normalizeClause(atom));
      if (explicitContext) {
        inheritedContext = true;
        inheritedReasoningQualifier = atomHasAffirmativeReasoningPi(atom);
      } else if (hasPi) {
        inheritedContext = false;
        inheritedReasoningQualifier = false;
      }
    }
  }
  return [...new Set(claims)];
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
    "claude sdk rejects ultra",
    "claude cli forwards ultra unchanged",
    "direct opencode rejects explicit effort",
  ]) {
    expect(prose, `${label} is missing: ${fact}`).toContain(fact);
  }
  expect(prose, `${label} must explain the escalation-only rank`).toMatch(
    /(?:effortrank places ultra above max only so keyword escalation cannot downgrade|ranking above max only prevents keyword downgrade)/u,
  );
  expect(
    unqualifiedPiLowClaims(value),
    `${label} must qualify every Pi/ultra/LOW claim as reasoning-capable`,
  ).toEqual([]);
}

describe("ultra effort documentation parity", () => {
  it.each([
    "Direct ultra currently maps to LOW thinking on Pi.",
    "When ultra is configured directly, Pi maps it to LOW thinking.",
    "Pi uses LOW thinking when ultra is configured directly.",
    "LOW thinking on Pi is the result of direct ultra configuration.",
    "Direct ultra means LOW thinking for Pi.",
    "Pi selects LOW thinking for directly configured ultra.",
    "Direct ultra makes Pi thinking LOW.",
    "Pi gets LOW thinking with direct ultra.",
    "For direct ultra, Pi thinking is LOW.",
    "On Pi, ultra is LOW.",
    "Pi accepts ultra and maps to LOW.",
    "On Pi, ultra becomes LOW.",
    "Even when Pi is not reasoning-capable, ultra maps to LOW.",
  ])("detects an unqualified Pi mapping regardless of word order: %s", (claim) => {
    const findings = unqualifiedPiLowClaims(claim);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("low");
  });

  it.each([
    ["A non-reasoning-capable Pi maps ultra to LOW.", "a non-reasoning-capable pi maps ultra to low"],
    [
      "Pi does not use OFF for ultra and instead maps it to LOW.",
      "instead maps it to low",
    ],
    [
      "Reasoning-capable Pi maps ultra to LOW, and all Pi routes map ultra to LOW.",
      "all pi routes map ultra to low",
    ],
  ])("keeps qualifier and negation scope local: %s", (claim, expected) => {
    expect(unqualifiedPiLowClaims(claim)).toEqual([expected]);
  });

  it.each([
    "Reasoning-capable pi:* maps ultra to LOW.",
    "Without reasoning, Pi maps ultra to OFF, not LOW.",
    "Pi does not map ultra to LOW.",
    "Pi thinking is not LOW for direct ultra.",
    "Pi's LOW mode differs from ultra.",
    "Reasoning-capable Pi uses ultra and maps it to LOW.",
    "Pi maps ultra not to LOW but to OFF.",
    "Pi maps ultra to OFF rather than LOW.",
    "Pi maps ultra to OFF, and LOW maps to medium in the ranking.",
    "On Pi, ultra is different from LOW.",
    "Pi maps ultra to OFF, although LOW remains available.",
  ])("allows an explicitly qualified or negated Pi mapping: %s", (claim) => {
    expect(unqualifiedPiLowClaims(claim)).toEqual([]);
  });

  it("does not mistake separate model and effort config lines for a mapping claim", () => {
    expect(
      unqualifiedPiLowClaims(`{
        "model": "pi:openai-codex:gpt-5.6-sol",
        "effort": "medium" // none|low|medium|high|max|ultra
      }`),
    ).toEqual([]);
  });

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
