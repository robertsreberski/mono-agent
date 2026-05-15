import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildAgentContext } from './context-builder.js';
import { ContextValidationError } from './errors.js';
import { buildSkillIndex, loadSkillIndexFromDirectory } from './skill-index.js';
import type { BuildContextInput, BuiltAgentContext, FileContextInput, MarkdownContextBlock, SkillIndexEntry } from './types.js';

export async function loadContextFromFiles(input: FileContextInput): Promise<BuiltAgentContext> {
  const rawInput = input as unknown;
  if (rawInput === null || typeof rawInput !== 'object') {
    throw new ContextValidationError('file_read_failed', 'File context input must be an object.');
  }

  const identity = await readMarkdownFile(input.identityPath, 'identityPath');
  const core = input.soulPath === undefined ? undefined : await readMarkdownFile(input.soulPath, 'soulPath');
  const skills = await loadMergedSkillIndex(input);

  const buildInput: BuildContextInput = {
    identity,
    userMessage: input.userMessage,
    ...(core === undefined ? {} : { core }),
    ...(input.memory === undefined ? {} : { memory: input.memory }),
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(input.skillInstructions === undefined ? {} : { skillInstructions: input.skillInstructions }),
  };

  return buildAgentContext(buildInput);
}

async function loadMergedSkillIndex(input: FileContextInput): Promise<readonly SkillIndexEntry[]> {
  const discovered = input.skillsRoot === undefined ? [] : await loadSkillIndexFromDirectory(input.skillsRoot);
  const explicit = input.skills ?? [];
  if (explicit.length === 0 && discovered.length === 0) {
    return [];
  }

  return buildSkillIndex([...explicit, ...discovered]);
}

async function readMarkdownFile(filePath: string, field: string): Promise<MarkdownContextBlock> {
  const resolvedPath = resolveRequiredPath(filePath, field);
  try {
    return {
      kind: 'markdown',
      content: await readFile(resolvedPath, 'utf8'),
      source: resolvedPath,
    };
  } catch (error) {
    throw new ContextValidationError('file_read_failed', `Unable to read ${field}.`, {
      path: resolvedPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveRequiredPath(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContextValidationError('file_read_failed', `${field} must be a non-empty path.`, {
      field,
    });
  }
  return resolve(value);
}
