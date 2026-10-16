// Skill-rendering helpers used to inject skill bodies and metadata into
// agent system prompts. Lives in agent/prompt/ because the rendering shape
// is a kernel concern; data loading (loadSkills, parseSkillFrontmatter)
// stays in the host.

import { resolve } from "node:path";

const SKILL_PATH_RULE = "Path rule: Files referenced by SKILL.md are bundled with the skill. Resolve `scripts/...`, `references/...`, and `assets/...` relative to that skill's directory; resolve `<skill-directory-name>/...` relative to the configured skills root.";

/**
 * @param {{assetsPath?: string, skillsRoot?: any}} [options]
 */
function buildSkillPathNote({ assetsPath, skillsRoot } = {}) {
  const lines = [];
  if (skillsRoot) lines.push(`Configured skills root: ${resolve(skillsRoot)}`);
  if (assetsPath) lines.push(`Skill directory: ${resolve(assetsPath)}`);
  lines.push(SKILL_PATH_RULE);
  return lines.join("\n");
}

/**
 * Render a complete skill body plus its path note. Omitting `maxChars` returns
 * the full text; pass a positive `maxChars` only when explicit truncation is
 * required by the caller.
 * @param {{body?: string, assetsPath?: string, skillsRoot?: any, maxChars?: number}} [options]
 */
export function formatSkillBodyWithPathNote({ body, assetsPath, skillsRoot, maxChars } = {}) {
  const text = [
    buildSkillPathNote({ assetsPath, skillsRoot }),
    String(body || "").trim(),
  ].filter(Boolean).join("\n\n");
  const limit = Number(maxChars);
  return Number.isFinite(limit) && limit > 0 ? text.slice(0, Math.floor(limit)) : text;
}
