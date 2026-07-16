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
  return value
    .replaceAll("`", "")
    .replace(/^\s*\/\/\s?/gmu, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
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
    .flatMap((line) => line.split(/[.!?]+/u));
  const wrappedProseSentences = source
    .split(/[.!?]+/u)
    .filter((sentence) => !isCodeLikeMultilineClause(sentence));
  return [...new Set([...lineSentences, ...wrappedProseSentences].map(normalizeClause))];
}

type PiLowRelationKind = "copula" | "targeted" | "outcome";

interface PiLowRelation {
  readonly index: number;
  readonly kind: PiLowRelationKind;
  readonly text: string;
}

const PI_LOW_RELATIONS: readonly [PiLowRelationKind, RegExp][] = [
  ["copula", /\b(?:is|are|was|were)\b/gu],
  [
    "targeted",
    /\b(?:map(?:s|ped|ping)?|interpret(?:s|ed|ing)?|equat(?:e|es|ed|ing)|set(?:s|ting)?|treat(?:s|ed|ing)?|translate(?:s|d|ing)?|convert(?:s|ed|ing)?|turn(?:s|ed|ing)?|render(?:s|ed|ing)?|assign(?:s|ed|ing)?)\b/gu,
  ],
  [
    "outcome",
    /\b(?:use(?:s|d|ing)?|mak(?:e|es|ing)|made|get(?:s|ting)?|got|select(?:s|ed|ing)?|mean(?:s|t|ing)?|yield(?:s|ed|ing)?|result(?:s|ed|ing)?|become(?:s|ing)?|became|apply|applies|applied|applying|run(?:s|ning)?|ran|produce(?:s|d|ing)?|give(?:s|n|ing)?|gave|choose(?:s|n|ing)?|chose|force(?:s|d|ing)?|default(?:s|ed|ing)?|fall(?:s|ing)?|fell)\b/gu,
  ],
];

// This is intentionally a small documentation grammar, not general-purpose NLP:
// relation kind decides where its target lives, clause sequencing carries only
// an explicit Pi/ultra subject, and qualification/negation are evaluated at the
// deciding relation. That keeps unrelated LOW clauses out of the mapping check.

function relationMatches(atom: string): readonly PiLowRelation[] {
  const matches = PI_LOW_RELATIONS.flatMap(([kind, pattern]) =>
    [...atom.matchAll(pattern)].map((match) => ({
      index: match.index ?? 0,
      kind,
      text: match[0] ?? "",
    })),
  );
  return matches.sort((left, right) => left.index - right.index);
}

function relationIsNegated(atom: string, relationIndex: number): boolean {
  const prefix = atom.slice(Math.max(0, relationIndex - 96), relationIndex);
  return /(?:\b(?:does|do|did|will|would|can|could|should|is|are|was|were)\s+(?:not|never)|\b(?:cannot|doesn't|don't|didn't|won't|wouldn't|can't|couldn't|shouldn't|isn't|aren't|wasn't|weren't)|\b(?:not|never))(?:\s+\w+ly){0,2}\s*$/u.test(prefix) ||
    /\bno(?:\s+[\w*:'-]+){0,5}\s*$/u.test(prefix);
}

function lowIsAffirmativeAt(atom: string, lowIndex: number): boolean {
  const prefix = atom.slice(Math.max(0, lowIndex - 72), lowIndex);
  return !/\b(?:no|not|never)(?:\s+\w+){0,4}\s*$/u.test(prefix) &&
    !/\b(?:rather\s+than|instead\s+of|different\s+from|distinct\s+from|unrelated\s+to|separate\s+from)\s*$/u.test(prefix);
}

function relationHasAffirmativeLow(atom: string, relation: PiLowRelation): boolean {
  const relationEnd = relation.index + relation.text.length;
  if (relation.kind === "copula") {
    const lows = [...atom.matchAll(/\blow\b/gu)];
    return lows.some((low) => {
      const lowIndex = low.index ?? 0;
      if (!lowIsAffirmativeAt(atom, lowIndex)) return false;
      if (lowIndex > relation.index) {
        const predicatePrefix = atom.slice(relationEnd, lowIndex);
        return /^\s+(?:(?:currently|directly|effectively|always|now|still|simply|just)\s+){0,3}(?:the\s+)?$/u.test(
          predicatePrefix,
        ) && /\bultra\b/u.test(atom);
      }
      const inversePredicate = atom.slice(relationEnd);
      return /^\s+(?:(?:currently|directly|effectively|always|now|still|simply|just)\s+){0,3}(?:(?:the\s+)?result\s+of\s+(?:direct(?:ly\s+configured)?\s+)?|(?:the\s+)?same(?:\s+effort)?\s+as\s+)?ultra\b/u.test(
        inversePredicate,
      );
    });
  }

  const tail = atom.slice(relationEnd);
  if (relation.kind === "targeted") {
    const target = /\b(?:to|as|with|into)\s+(?:(?:the|a|an|its|directly|configured)\s+){0,3}(low|off|none|minimal|medium|high|xhigh|max|ultra)\b/gu.exec(tail);
    if (target === null || target[1] !== "low") return false;
    const lowOffset = target[0].lastIndexOf("low");
    return lowIsAffirmativeAt(atom, relationEnd + target.index + lowOffset);
  }

  const effort = /\b(low|off|none|minimal|medium|high|xhigh|max|ultra)\b/gu.exec(tail);
  if (effort === null || effort[1] !== "low") return false;
  return lowIsAffirmativeAt(atom, relationEnd + effort.index);
}

function relationIsReasoningQualified(atom: string, relationIndex: number): boolean {
  const qualifiers = [...atom.matchAll(/(?<!non-)\breasoning-capable\b/gu)];
  return qualifiers.some((qualifier) => {
    const qualifierIndex = qualifier.index ?? 0;
    const qualifierEnd = qualifierIndex + (qualifier[0]?.length ?? 0);
    const lead = atom.slice(Math.max(0, qualifierIndex - 56), qualifierIndex);
    if (/\b(?:no|not|never|without)\b[^.!?;]{0,48}$/u.test(lead)) return false;
    if (qualifierIndex < relationIndex) {
      return /^\s+pi(?::\*)?(?=\s|[,]|$)/u.test(
        atom.slice(qualifierEnd, relationIndex),
      );
    }
    if (!/\b(?:(?:only\s+)?(?:when|if)|for)\s+(?:a\s+)?$/u.test(lead)) return false;
    return /^\s*(?:pi(?::\*)?)?\s*$/u.test(atom.slice(qualifierEnd));
  });
}

function atomHasAffirmativeReasoningPi(atom: string): boolean {
  const match = /(?<!non-)\breasoning-capable\s+pi(?::\*)?(?=\s|$|[,])/u.exec(atom);
  if (match === null) return false;
  const lead = atom.slice(Math.max(0, match.index - 48), match.index);
  return !/\b(?:no|not|never|without)\b[^.!?;]{0,40}$/u.test(lead);
}

function unqualifiedPiLowClaims(value: string): readonly string[] {
  const claims: string[] = [];
  for (const sentence of guardSentences(value)) {
    const atoms = sentence.split(
      /\s*;\s*|(?:,\s*)?\b(?:and|but|while|whereas|although|though)\b/u,
    );
    let inheritedContext = false;
    let inheritedReasoningQualifier = false;
    for (const atom of atoms) {
      const hasPi = /\bpi\b/u.test(atom);
      const hasUltra = /\bultra\b/u.test(atom);
      const explicitContext = hasPi && hasUltra;
      const relations = relationMatches(atom);
      const elidedSubjectContinuation = !hasPi && inheritedContext && relations.some((relation) => {
        const lead = atom.slice(0, relation.index).trim();
        return /^(?:(?:instead|then|also|still|directly|currently|simply)\s+)*$/u.test(lead);
      });
      const pronounContinuation = !hasPi && inheritedContext && /\bit\b/u.test(atom);
      const repeatedPiContinuation = hasPi && !hasUltra && inheritedContext && relations.length > 0;
      const inheritedContextApplies = elidedSubjectContinuation || pronounContinuation || repeatedPiContinuation;
      const hasRouteContext = explicitContext || inheritedContextApplies;
      const inheritedQualifierApplies = inheritedContextApplies && !hasPi && inheritedReasoningQualifier;
      const hasUnqualifiedRelation = relations.some((relation) => {
        const relationIndex = relation.index;
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
      } else if (hasPi && !repeatedPiContinuation) {
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
    "mono-agent rejects ultra on its claude sdk route because the pinned sdk public contract ends at max",
    "the sdk javascript itself forwards the value",
    "the claude cli route passes --effort ultra",
    "sdk-bundled 2.1.206 and local 2.1.210",
    "warn that it is unknown, ignore it, and use default effort",
    "direct opencode rejects explicit effort",
  ]) {
    expect(prose, `${label} is missing: ${fact}`).toContain(fact);
  }
  expect(prose, `${label} must explain the escalation-only rank`).toMatch(
    /(?:effortrank places ultra above max only so keyword escalation cannot downgrade|ranking above max only prevents keyword downgrade)/u,
  );
  expect(
    unqualifiedPiLowClaims(value),
    `${label} contains a recognized unqualified Pi ultra-to-LOW mapping`,
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
    "On Pi, LOW is ultra.",
    "Pi accepts ultra and maps to LOW.",
    "On Pi, ultra becomes LOW.",
    "Pi interprets directly configured ultra as LOW thinking.",
    "Pi equates ultra with LOW thinking.",
    "Pi does not use OFF for ultra; instead, it maps it to LOW.",
    "Compared with reasoning-capable Codex, Pi maps ultra to LOW.",
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
    "For reasoning-capable Pi, ultra maps to LOW.",
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
    "Pi maps ultra to LOW only when reasoning-capable.",
    "Pi cannot map ultra to LOW.",
    "No Pi route maps ultra to LOW.",
    "Pi maps ultra to OFF, with LOW available as a separate effort level.",
    "On Pi, ultra is unsupported, with LOW available as a separate effort level.",
    "On Pi, LOW is not ultra.",
    "On Pi, LOW isn't ultra.",
  ])("allows an explicitly qualified or negated Pi mapping: %s", (claim) => {
    expect(unqualifiedPiLowClaims(claim)).toEqual([]);
  });

  it("accepts the exact documented Pi route split without leaking qualification across clauses", () => {
    expect(
      unqualifiedPiLowClaims(
        "Reasoning-capable pi:* maps ultra to LOW; Pi without reasoning uses OFF.",
      ),
    ).toEqual([]);
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
