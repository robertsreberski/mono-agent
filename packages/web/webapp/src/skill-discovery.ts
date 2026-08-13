import type { SkillInfo } from "./types";

export const MAX_SKILL_AUTOCOMPLETE_RESULTS = 8;

export interface SkillQuery {
  readonly offset: number;
  readonly query: string;
  readonly cursor: number;
}

export interface TextInsertion {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

interface SkillMatch {
  readonly skill: SkillInfo;
  readonly originalIndex: number;
  readonly tier: number;
  readonly quality: number;
}

const SKILL_QUERY = /^[A-Za-z0-9_-]*$/u;
const SKILL_REFERENCE = /^\$[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** Mirrors assistant-ui trigger boundaries while enforcing the canonical skill-name grammar. */
export function detectSkillQuery(
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): SkillQuery | null {
  if (selectionStart !== selectionEnd) return null;
  const cursor = Math.max(0, Math.min(selectionStart, text.length));
  const beforeCursor = text.slice(0, cursor);
  for (let index = beforeCursor.length - 1; index >= 0; index -= 1) {
    const character = beforeCursor[index] ?? "";
    if (/\s/u.test(character)) return null;
    if (character !== "$") continue;
    if (index > 0 && !/\s/u.test(beforeCursor[index - 1] ?? "")) continue;
    const query = beforeCursor.slice(index + 1);
    return SKILL_QUERY.test(query) ? { offset: index, query, cursor } : null;
  }
  return null;
}

export function isUsableSkill(skill: SkillInfo): skill is SkillInfo & { readonly reference: string } {
  return skill.availability !== "unavailable"
    && typeof skill.reference === "string"
    && skill.reference === `$${skill.name}`
    && SKILL_REFERENCE.test(skill.reference);
}

export function rankSkills(
  skills: readonly SkillInfo[],
  query: string,
  options: { readonly includeUnavailable?: boolean; readonly limit?: number } = {},
): readonly SkillInfo[] {
  const normalizedQuery = normalizeSearchText(query.trim());
  const matches = skills.flatMap((skill, originalIndex): SkillMatch[] => {
    if (skill.availability === "unavailable" && options.includeUnavailable !== true) return [];
    if (skill.availability !== "unavailable" && !isUsableSkill(skill)) return [];
    const score = matchSkill(skill, normalizedQuery);
    return score === undefined
      ? []
      : [{ skill, originalIndex, tier: score.tier, quality: score.quality }];
  });
  matches.sort(compareMatches);
  return matches.slice(0, options.limit ?? MAX_SKILL_AUTOCOMPLETE_RESULTS).map(({ skill }) => skill);
}

export function insertSkillReference(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  reference: string,
): TextInsertion {
  if (!SKILL_REFERENCE.test(reference)) {
    return { text, selectionStart, selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before.length > 0 && !/\s$/u.test(before) ? " " : "";
  const suffix = after.length === 0 || !/^\s/u.test(after) ? " " : "";
  const nextText = `${before}${prefix}${reference}${suffix}${after}`;
  const referenceEnd = before.length + prefix.length + reference.length;
  const caret = referenceEnd + (suffix.length > 0 ? suffix.length : after.length > 0 ? 1 : 0);
  return { text: nextText, selectionStart: caret, selectionEnd: caret };
}

function matchSkill(
  skill: SkillInfo,
  query: string,
): { readonly tier: number; readonly quality: number } | undefined {
  if (query.length === 0) return { tier: 7, quality: 0 };
  const name = normalizeSearchText(skill.name);
  if (name === query) return { tier: 0, quality: 0 };
  if (name.startsWith(query)) return { tier: 1, quality: name.length - query.length };

  const nameTokens = name.split(/[-_]+/u).filter(Boolean);
  const tokenIndex = nameTokens.findIndex((token) => token.startsWith(query));
  if (tokenIndex >= 0) return { tier: 2, quality: tokenIndex };

  const substringIndex = name.indexOf(query);
  if (substringIndex >= 0) return { tier: 3, quality: substringIndex };

  const subsequenceQuality = orderedSubsequenceQuality(name, query);
  if (subsequenceQuality !== undefined) return { tier: 4, quality: subsequenceQuality };

  const description = normalizeSearchText(skill.description);
  const phraseIndex = description.indexOf(query);
  if (phraseIndex >= 0) return { tier: 5, quality: phraseIndex };

  const queryTokens = query.split(/[^a-z0-9]+/u).filter(Boolean);
  const descriptionTokens = description.split(/[^a-z0-9]+/u).filter(Boolean);
  if (
    queryTokens.length > 0
    && queryTokens.every((needle) => descriptionTokens.some((token) => token.startsWith(needle)))
  ) {
    return { tier: 6, quality: queryTokens.length };
  }
  return undefined;
}

function orderedSubsequenceQuality(value: string, query: string): number | undefined {
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return undefined;
    if (first < 0) first = index;
    last = index;
    cursor = index + 1;
  }
  return first < 0 ? undefined : (last - first + 1) - query.length + first;
}

function compareMatches(left: SkillMatch, right: SkillMatch): number {
  if (left.tier !== right.tier) return left.tier - right.tier;
  if (left.quality !== right.quality) return left.quality - right.quality;
  const availability = availabilityRank(left.skill) - availabilityRank(right.skill);
  if (availability !== 0) return availability;
  if (left.tier !== 7 && left.skill.name.length !== right.skill.name.length) {
    return left.skill.name.length - right.skill.name.length;
  }
  const leftName = left.skill.name.toLowerCase();
  const rightName = right.skill.name.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  return left.originalIndex - right.originalIndex;
}

function availabilityRank(skill: SkillInfo): number {
  if (skill.availability === "inlined") return 0;
  if (skill.availability === "on-demand") return 1;
  return 2;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}
