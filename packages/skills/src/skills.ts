import { readFile } from "node:fs/promises";

import { buildSkillIndex, loadSkillIndexFromDirectory } from "@worklab-ai/context";
import type { MarkdownContextBlock, SkillIndexEntry } from "@worklab-ai/context";

export interface LoadedSkill {
  readonly name: string;
  readonly description: string;
  readonly mainFile: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface LoadSelectedSkillsInput {
  readonly skillsRoot: string;
  readonly names: readonly string[];
  readonly maxBytes?: number;
}

export interface LoadedSkillContext {
  readonly index: readonly SkillIndexEntry[];
  readonly instructions: readonly MarkdownContextBlock[];
  readonly loaded: readonly LoadedSkill[];
}

export class SkillActivationError extends Error {
  readonly code: "invalid_skill_selection" | "skill_not_found" | "skill_read_failed";
  readonly details: Record<string, unknown>;

  constructor(code: SkillActivationError["code"], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SkillActivationError";
    this.code = code;
    this.details = { ...details, code };
  }
}

const DEFAULT_MAX_SKILL_BYTES = 48_000;

export async function loadSelectedSkills(input: LoadSelectedSkillsInput): Promise<LoadedSkillContext> {
  const names = normalizeSkillNames(input.names);
  if (names.length === 0) {
    return { index: [], instructions: [], loaded: [] };
  }
  if (typeof input.skillsRoot !== "string" || input.skillsRoot.trim().length === 0) {
    throw new SkillActivationError("invalid_skill_selection", "skillsRoot must be a non-empty path.");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new SkillActivationError("invalid_skill_selection", "maxBytes must be an integer of at least 256.");
  }

  const index = await loadSkillIndexFromDirectory(input.skillsRoot);
  const byName = new Map(index.map((entry) => [entry.name.toLowerCase(), entry]));
  const loaded: LoadedSkill[] = [];
  for (const name of names) {
    const entry = byName.get(name.toLowerCase());
    if (entry === undefined) {
      throw new SkillActivationError("skill_not_found", "Configured skill was not found in skillsRoot.", {
        name,
        available: index.map((candidate) => candidate.name),
      });
    }
    loaded.push(await loadSkillBody(entry, maxBytes));
  }

  return {
    index: buildSkillIndex(loaded.map(({ name, description, mainFile }) => ({ name, description, mainFile }))),
    instructions: skillInstructionsToContextBlocks(loaded),
    loaded,
  };
}

export function skillInstructionsToContextBlocks(skills: readonly LoadedSkill[]): readonly MarkdownContextBlock[] {
  return skills.map((skill) => ({
    kind: "markdown",
    source: skill.mainFile,
    content: `# Skill: ${skill.name}\n\n${skill.content}${skill.truncated ? "\n\n<!-- skill truncated by maxBytes -->" : ""}`,
  }));
}

function normalizeSkillNames(names: readonly string[]): readonly string[] {
  if (!Array.isArray(names)) {
    throw new SkillActivationError("invalid_skill_selection", "names must be an array.");
  }
  const normalized = names.map((name, index) => normalizeInlineString(name, `names[${index}]`));
  const seen = new Set<string>();
  for (const name of normalized) {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new SkillActivationError("invalid_skill_selection", "Skill names must not be duplicated.", { name });
    }
    seen.add(key);
  }
  return normalized;
}

async function loadSkillBody(entry: SkillIndexEntry, maxBytes: number): Promise<LoadedSkill> {
  try {
    const buffer = await readFile(entry.mainFile);
    const truncated = buffer.byteLength > maxBytes;
    const content = truncated
      ? `${buffer.subarray(0, maxBytes).toString("utf8")}\n<!-- truncated to first ${maxBytes} bytes -->`
      : buffer.toString("utf8");
    return {
      name: entry.name,
      description: entry.description,
      mainFile: entry.mainFile,
      content: content.trim(),
      truncated,
    };
  } catch (error) {
    throw new SkillActivationError("skill_read_failed", "Unable to read selected skill body.", {
      name: entry.name,
      mainFile: entry.mainFile,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeInlineString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new SkillActivationError("invalid_skill_selection", `${field} must be a string.`, { field });
  }
  const normalized = value.replace(/\r\n?/gu, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  if (normalized.length === 0) {
    throw new SkillActivationError("invalid_skill_selection", `${field} must not be empty.`, { field });
  }
  return normalized;
}
