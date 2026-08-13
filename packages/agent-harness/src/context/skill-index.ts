import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ContextValidationError } from './errors.js';
import { fileReadError, resolveRequiredPath } from './fs-paths.js';
import { normalizeInlineText } from './text.js';
import type { SkillIndexEntry, SkillIndexSummary } from './types.js';

const SKILL_REFERENCE_GUIDANCE =
  "An exact `$skill-name` token is an explicit request to apply a skill only when `skill-name` matches `[A-Za-z0-9][A-Za-z0-9_-]*` and exactly matches a skill name below. Other `$`-prefixed text is ordinary user text. Apply only complete skill instructions already present in context; if they are unavailable, say so rather than improvising them.";

const READ_SKILL_GUIDANCE =
  "When a listed skill applies and its complete instructions are not already present, call `ReadSkill` with its exact name when that tool is available. Do not use `Read` to open a skill's `SKILL.md`; reserve ordinary file reads for files referenced by the loaded skill.";

const READ_SKILL_COMPATIBLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export interface LoadedSkillFile {
  readonly entry: SkillIndexEntry;
  readonly markdown: string;
}

export function buildSkillIndex(entries: readonly SkillIndexEntry[]): readonly SkillIndexEntry[] {
  const normalized = entries.map((entry, index) => normalizeSkillEntry(entry, index));
  const seen = new Map<string, SkillIndexEntry>();

  for (const entry of normalized) {
    const key = entry.name.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      throw new ContextValidationError('invalid_skill_index', 'Duplicate skill names are not allowed.', {
        name: entry.name,
        existing: existing.mainFile,
        duplicate: entry.mainFile,
      });
    }
    seen.set(key, entry);
  }

  return [...normalized].sort(compareSkillEntries);
}

export async function loadSkillIndexFromDirectory(root: string): Promise<readonly SkillIndexEntry[]> {
  const files = await loadSkillFilesFromDirectory(root);
  return files.map((file) => file.entry);
}

export async function loadSkillFilesFromDirectory(root: string): Promise<readonly LoadedSkillFile[]> {
  const rootPath = resolveRequiredPath(root, 'skillsRoot');
  let entries: Dirent[];
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (error) {
    throw fileReadError('Unable to read skills directory.', rootPath, error);
  }

  const discovered: SkillIndexEntry[] = [];
  const markdownByMainFile = new Map<string, string>();
  const childDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const childName of childDirectories) {
    const skillFile = join(rootPath, childName, 'SKILL.md');
    let markdown: string;
    try {
      markdown = await readFile(skillFile, 'utf8');
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) {
        continue;
      }
      throw fileReadError('Unable to read skill file.', skillFile, error);
    }

    const description = deriveSkillDescription(markdown);
    if (description.length === 0) {
      throw new ContextValidationError('invalid_skill_index', 'Skill file must contain a non-heading description paragraph.', {
        mainFile: skillFile,
        name: childName,
      });
    }

    discovered.push({
      name: childName,
      description,
      mainFile: skillFile,
    });
    markdownByMainFile.set(skillFile, markdown);
  }

  const index = buildSkillIndex(discovered);
  return index.map((entry) => ({
    entry,
    markdown: markdownByMainFile.get(entry.mainFile) ?? '',
  }));
}

/** Matches the conservative name grammar accepted by the runtime's shared-root ReadSkill tool. */
export function isReadSkillCompatibleName(name: unknown): name is string {
  return typeof name === 'string' && READ_SKILL_COMPATIBLE_NAME.test(name);
}

export function renderSkillIndex(
  entries: readonly SkillIndexEntry[],
  skillDisclosure?: 'index' | 'full',
): string {
  return renderSkillIndexEntries(buildSkillIndex(entries), skillDisclosure);
}

/**
 * Takes `SkillIndexSummary` rather than `SkillIndexEntry` because rendering only
 * ever reads `name` and `description`. Widening the parameter is what lets a
 * caller holding runtime-options entries (which carry no `mainFile`) render the
 * same index the context builder does. Existing callers passing full entries are
 * unaffected.
 */
export function renderSkillIndexEntries(
  entries: readonly SkillIndexSummary[],
  skillDisclosure?: 'index' | 'full',
): string {
  const index = entries.map((entry) => `- **${entry.name}** — ${entry.description}`).join('\n');
  const guidance = skillDisclosure === 'index'
    ? `${SKILL_REFERENCE_GUIDANCE}\n\n${READ_SKILL_GUIDANCE}`
    : SKILL_REFERENCE_GUIDANCE;
  return `${guidance}\n\n${index}`;
}

/**
 * The whole `## Skill Index` section, heading included.
 *
 * Exists so a caller outside the context builder — the subagent path in
 * agent-app, which composes a child prompt without going through the harness —
 * cannot drift from the section heading `buildAgentContext` emits. Disclosure is
 * fixed to `index`: inlining bodies into a child is the cost this exists to
 * avoid, so `ReadSkill` guidance always belongs with it.
 */
export function renderSkillIndexSection(entries: readonly SkillIndexSummary[]): string {
  return `## Skill Index\n\n${renderSkillIndexEntries(entries, 'index')}`;
}

function normalizeSkillEntry(entry: SkillIndexEntry, index: number): SkillIndexEntry {
  const raw = entry as unknown as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    throw new ContextValidationError('invalid_skill_index', 'Skill entries must be objects.', {
      index,
    });
  }

  return {
    name: normalizeRequiredInlineString(raw.name, 'name', index),
    description: normalizeRequiredInlineString(raw.description, 'description', index),
    mainFile: normalizeRequiredInlineString(raw.mainFile, 'mainFile', index),
  };
}

function normalizeRequiredInlineString(value: unknown, field: string, index: number): string {
  if (typeof value !== 'string') {
    throw new ContextValidationError('invalid_skill_index', `Skill ${field} must be a string.`, {
      field,
      index,
    });
  }

  const normalized = normalizeInlineText(value);
  if (normalized.length === 0) {
    throw new ContextValidationError('invalid_skill_index', `Skill ${field} must not be empty.`, {
      field,
      index,
    });
  }

  return normalized;
}

function compareSkillEntries(left: SkillIndexEntry, right: SkillIndexEntry): number {
  const leftKey = left.name.toLowerCase();
  const rightKey = right.name.toLowerCase();
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  if (left.name < right.name) {
    return -1;
  }
  if (left.name > right.name) {
    return 1;
  }
  return 0;
}

function deriveSkillDescription(markdown: string): string {
  const fromFrontmatter = readFrontmatterField(markdown, 'description');
  if (fromFrontmatter.length > 0) {
    return fromFrontmatter;
  }

  return deriveDescriptionFromBody(markdown);
}

function deriveDescriptionFromBody(markdown: string): string {
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  const flush = (): void => {
    if (currentParagraph.length > 0) {
      paragraphs.push(normalizeInlineText(currentParagraph.join(' ')));
      currentParagraph = [];
    }
  };

  for (const rawLine of stripFrontmatter(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      continue;
    }
    currentParagraph.push(line);
  }
  flush();

  return paragraphs.find((paragraph) => paragraph.length > 0) ?? '';
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/u;

/**
 * Skill files shared with other harnesses (e.g. Claude Code, Codex) open with a
 * YAML frontmatter block whose `description` is the canonical, harness-facing
 * summary (often the "use when…" trigger text). Prefer it for the index; the
 * first body paragraph is only a fallback for skills authored without
 * frontmatter. Flat single-line scalars only, mirroring the cron/webhook job
 * parsers, so the context builder stays dependency-free.
 */
function readFrontmatterField(markdown: string, field: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (match === null) {
    return '';
  }

  for (const rawLine of (match[1] ?? '').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1 || line.slice(0, separator).trim() !== field) {
      continue;
    }
    return normalizeInlineText(stripFrontmatterQuotes(line.slice(separator + 1).trim()));
  }

  return '';
}

function stripFrontmatterQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function stripFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const match = FRONTMATTER_PATTERN.exec(normalized);
  return match === null ? normalized : normalized.slice(match[0].length);
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === code;
}
