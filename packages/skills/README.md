# @worklab-ai/skills

Deterministic skill activation helpers for Mono Agent prompts.

The package builds on `@worklab-ai/context` skill indexes. Hosts provide configured skill names; the loader verifies they exist, reads only those `SKILL.md` files with byte caps, and returns Markdown context blocks for prompt assembly. It does not auto-enable every skill or silently ignore missing configured skills.
