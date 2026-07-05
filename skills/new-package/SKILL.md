---
name: new-package
description: Add a new @mono-agent package/adapter that passes the architecture gate on the first try (catalog entry, README sections, dependency categories, lockstep version). Use when creating any new package, or when check:architecture fails on catalog/README/boundary errors.
---

# New package

## First: climb the capability ladder (AGENTS.md)

A new package is rung 3 of 5. Confirm the lower rungs don't satisfy the need:

1. Existing package / existing public surface
2. Config field or selected skill (typed config + validation + docs)
3. **New adapter/package in the correct category** ← this skill
4. MCP server / auto-provisioned MCP tool (canonical examples: `memory_recall`, `notify_conversation`)
5. Shared contract change in `@mono-agent/agent-contracts` — last resort;
   adapter-neutrality is enforced by the arch checker

## Checklist

1. **Manifest** — `packages/<name>/package.json`: name `@mono-agent/<name>`,
   version = current lockstep version (match `packages/agent-app/package.json`),
   internal deps as `workspace:<version>`, `types`/`exports` pointing at `dist/`
   (NodeNext, no src aliases), and `build`/`test`/`typecheck` scripts matching a
   sibling package in the same category.
2. **Catalog** — register in `scripts/package-catalog.mjs`:

```js
{
  dir: "<name>",
  name: "@mono-agent/<name>",
  category: "communication",   // one of: runtime, core, context, execution,
                               // observability, evaluation, communication,
                               // operator-surface, app
  responsibility: "<one sentence>",
  allowedDependencyCategories: ["core"],
  publishable: true,
}
```

3. **README** — must contain these byte-exact section headings:
   `## Category`, `## Responsibility`, `## Install / Usage`, `## Public API`,
   `## Dependency Boundary`, `## What This Package Does Not Own`, `## Verification`.
4. **Tests** — focused tests under `src/__tests__/`; behavior lives with tests
   from the first commit.
5. **Root wiring** — add to root `package.json` devDependencies as
   `workspace:<version>` (release:validate checks the root too), then `pnpm install`.

## Gate

```bash
pnpm run check:architecture
pnpm run release:validate -- --tag v<version>
pnpm --filter @mono-agent/<name> run build && pnpm --filter @mono-agent/<name> test
```

Then the full `verify-green` gate. Common arch-check failures: package dir
missing from the catalog, unknown/disallowed dependency category, missing README
section, adapter-neutrality violation in agent-contracts.

## Boundaries to respect

- One clear responsibility, focused public API, no hidden cross-package coupling.
- Dependencies only on categories in `allowedDependencyCategories`; if you need
  more, that's a design smell — re-read the ladder before widening.
- User-facing packages need docs: `PACKAGES.md`, feature-registry entry, maybe a
  playbook (hand off to the `docs-sync` skill).
