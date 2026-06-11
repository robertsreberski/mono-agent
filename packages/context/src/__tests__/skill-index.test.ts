import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ContextValidationError } from '../errors.js';
import { buildSkillIndex, loadSkillIndexFromDirectory } from '../skill-index.js';

const fixturesRoot = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const validSkillsRoot = join(fixturesRoot, 'skills-valid');
const invalidSkillsRoot = join(fixturesRoot, 'skills-invalid');

describe('buildSkillIndex', () => {
  it('normalizes, validates, and sorts skill entries deterministically', () => {
    const skills = buildSkillIndex([
      { name: 'Writing ', description: ' Create plans\nfor agents ', mainFile: ' /skills/writing/SKILL.md ' },
      { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
    ]);

    expect(skills).toEqual([
      { name: 'research', description: 'Find sources', mainFile: '/skills/research/SKILL.md' },
      { name: 'Writing', description: 'Create plans for agents', mainFile: '/skills/writing/SKILL.md' },
    ]);
  });

  it('rejects duplicate skill names', () => {
    expect(() =>
      buildSkillIndex([
        { name: 'research', description: 'One', mainFile: '/one/SKILL.md' },
        { name: 'Research', description: 'Two', mainFile: '/two/SKILL.md' },
      ]),
    ).toThrow(ContextValidationError);
  });
});

describe('loadSkillIndexFromDirectory', () => {
  it('loads immediate child SKILL.md files and derives descriptions', async () => {
    const skills = await loadSkillIndexFromDirectory(validSkillsRoot);

    expect(skills).toEqual([
      {
        name: 'research',
        description: 'Find source-grounded evidence before making claims.',
        mainFile: join(validSkillsRoot, 'research', 'SKILL.md'),
      },
    ]);
  });

  it('skips YAML frontmatter when deriving the description', async () => {
    const frontmatterSkillsRoot = join(fixturesRoot, 'skills-frontmatter');
    const skills = await loadSkillIndexFromDirectory(frontmatterSkillsRoot);

    expect(skills).toEqual([
      {
        name: 'frontmatter',
        description: 'Works in harnesses that read YAML frontmatter and in mono-agent.',
        mainFile: join(frontmatterSkillsRoot, 'frontmatter', 'SKILL.md'),
      },
    ]);
  });

  it('rejects skill files without a description paragraph', async () => {
    await expect(loadSkillIndexFromDirectory(invalidSkillsRoot)).rejects.toThrow(ContextValidationError);
  });
});
