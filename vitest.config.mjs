import { configDefaults, defineConfig } from "vitest/config";

// Root Vitest config. The repo runs several root-level Vitest invocations
// (`release:test`, `scripts:test`) that pass bare relative paths, which Vitest
// treats as substring filters against *every* discovered test file. Various
// tools keep full repo copies under gitignored worktree directories
// (`.claude/worktrees/`, `.quests-wt/`, `.ultrawork/`, `.worklab-tmp/`), so without scoping
// discovery those copies are matched too — `release:test` would run the
// canonical `scripts/release/__tests__/release.test.mjs` plus a divergent copy
// per worktree. Extend (do not replace) Vitest's default excludes so
// node_modules/dist/coverage stay excluded and worktree copies are never
// discovered by any root invocation.
export default defineConfig({
  test: {
    /**
     * The root invocations (`release:test`, `scripts:test`) drive real subprocesses —
     * npm installs into throwaway consumers, pnpm config probes, packed-tarball smoke tests. Those
     * take well over Vitest's 5s default whenever the machine is busy, which is exactly when CI
     * runs them: `packed-consumer` timed out immediately after a release pack while passing on its
     * own. Budget for the work these suites actually do; a genuine hang still fails well inside the
     * CI job timeout.
     */
    testTimeout: 30_000,
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.git/**",
      "**/.quests-wt/**",
      "**/.ultrawork/**",
      "**/.worklab-tmp/**",
    ],
  },
});
