# AGENTS.md

## Project

Mono Agent is intended to become a small, single-purpose agent framework built from npm packages under the `@worklab-ai` scope. The framework should provide reusable building blocks around `@worklab-ai/agent-runtime`, including modular communication adapters, skills/MCP/harness integration, and an optional memory layer.

## Repository shape

- Treat this repository as an npm monorepo.
- Future packages should live under `packages/<package-name>/`.
- Published package names should use the `@worklab-ai/<package-name>` scope.
- Root instructions apply to every package unless a package-local `AGENTS.md` narrows them.
- Do not add root workspace/package-manager scaffolding until a task explicitly asks for the first package or build setup.

## Engineering discipline

- Read this file, the relevant package-local `AGENTS.md` if present, and package docs before editing.
- Keep changes small, typed, and reviewable.
- Prefer explicit contracts, narrow interfaces, deterministic validation, and thin runtime wrappers.
- Keep package boundaries clear; avoid circular dependencies and hidden cross-package coupling.
- Do not hide model/runtime/provider failures behind broad fallbacks or fake success states.
- Do not commit secrets, provider API keys, OAuth tokens, generated credentials, or local `.env*` files.

## Package expectations

- Each package should have one clear responsibility and a focused public API.
- Use `@worklab-ai/*` package names consistently.
- Add or update focused tests with behavior changes.
- Use package-local scripts once package manifests exist; do not invent global scripts without root workspace configuration.
- Keep runtime-facing artifacts structured and machine-validated where practical.

## Framework boundaries

- Communication adapters, skills/MCP integration, harness/runtime orchestration, and memory should remain modular.
- Memory should be optional; a simple `memory.md`-style implementation is acceptable until a stronger persistence adapter is required.
- Prefer real execution paths in verification. Fixtures are acceptable for tests, not as product-runtime substitutes.
