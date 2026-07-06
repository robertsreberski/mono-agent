# AGENTS.md

## Project

This repository is intended to become a small, single-purpose agent framework built from npm packages under the `@mono-agent` scope. The framework should provide reusable building blocks around `@mono-agent/agent-runtime`, including modular communication adapters, skills/MCP/harness integration, and an optional memory layer.

## Repository shape

- Treat this repository as a pnpm workspace monorepo.
- Future packages should live under `packages/<package-name>/`.
- Published package names should use the `@mono-agent/<package-name>` scope.
- Package categories live in `scripts/package-catalog.mjs` and README docs; keep the physical workspace layout flat unless a task explicitly asks for a mechanical migration.
- Root instructions apply to every package unless a package-local `AGENTS.md` narrows them.
- Keep root workspace/package-manager scaffolding limited to the checked-in pnpm workspace setup unless a task explicitly asks to broaden it.

## Engineering discipline

- Read this file, the relevant package-local `AGENTS.md` if present, and package docs before editing.
- Keep changes small, typed, and reviewable.
- Prefer explicit contracts, narrow interfaces, deterministic validation, and thin runtime wrappers.
- Keep package boundaries clear; avoid circular dependencies and hidden cross-package coupling.
- Do not hide model/runtime/provider failures behind broad fallbacks or fake success states.
- Do not commit secrets, provider API keys, OAuth tokens, generated credentials, or local `.env*` files.

## Goal-loop development protocol

- Work on this repo is organized as goal issues (label `goal`, milestone "v1 — deliver the premise") executed in iterative loops. The protocol lives in epic #119 and its "Protocol v1.1" amendment comment — read both before executing any goal.
- Checkpoint on the ISSUE, not the PR: post `goal_status: in_progress | complete | blocked` comments that cite exact evidence — commands run, their results, and the HEAD sha.
- The final checkpoint enumerates every "Done when" item as Done / Blocked / Cancelled; never silently substitute a different check for a stated one.
- Cite symbol + file, not bare line numbers, and re-verify every reference at orient time (line numbers drift).
- An unsatisfiable "Done when" makes the goal `blocked`, naming the exact discrepancy — never improvise a replacement.
- Give every external review finding an explicit disposition (fixed / follow-up issue / rejected-with-reason) before merge.
- All changes land through a PR; never commit directly to `main`.
- Start any task by checking whether a skill already covers it. `skills/` holds the repo workflow skills: verify-green, worktree-feature, fleet-deploy, live-smoke, release-lockstep, docs-sync, pi-upstream-recon, new-package.
- `agents/` holds the subagent templates; each `agents/*.md` has a `.toml` companion kept in sync by `pnpm run check:codex-discoverability`.
- The main checkout is a frozen deploy tree serving the live fleet — all work happens in worktrees (see `skills/worktree-feature`; fleet state tracked in #148).

## Package expectations

- Each package should have one clear responsibility and a focused public API.
- Use `@mono-agent/*` package names consistently.
- Add or update focused tests with behavior changes.
- Use package-local scripts once package manifests exist; route repo-wide commands through the root pnpm recursive scripts.
- Keep runtime-facing artifacts structured and machine-validated where practical.

## Framework boundaries

- Communication adapters, skills/MCP integration, harness/runtime orchestration, and memory should remain modular.
- Memory should be optional; a simple `memory.md`-style implementation is acceptable until a stronger persistence adapter is required.
- Prefer real execution paths in verification. Fixtures are acceptable for tests, not as product-runtime substitutes.

## Capability ladder

Choose the lowest rung that satisfies the capability; see [docs/reference/capability-ladder.md](./docs/reference/capability-ladder.md) for the canonical reader page.

1. Existing package / existing public surface. Cost: lowest; no new ownership surface. Gate: use the current package responsibility and API without adding a new config or runtime concept.
2. Config field or selected skill. Cost: new user-facing option or loaded instruction surface. Gate: typed config/validation/docs for config; selected skills stay under `context.selectedSkills` without host glue.
3. New adapter/package in the correct package category. Cost: new package ownership, README, tests, and catalog metadata. Gate: add `category`, `responsibility`, and `allowedDependencyCategories` to `scripts/package-catalog.mjs`; `scripts/check-package-architecture.mjs` must pass.
4. MCP server / auto-provisioned MCP tool. Cost: runtime-visible tool lifecycle, policy/security/docs, and tool-result behavior. Gate: use when the model needs an explicit callable tool boundary; canonical app-owned examples are `memory_recall` and `notify_conversation`.
5. Shared core contract change in `@mono-agent/agent-contracts`. Cost: highest blast radius and likely semver/release coordination. Gate: last resort for adapter-neutral shared structure; `scripts/check-package-architecture.mjs` enforces adapter-neutrality.
