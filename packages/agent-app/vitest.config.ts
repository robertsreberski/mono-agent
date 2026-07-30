import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * This package runs ~2160 tests across ~110 files, and its heaviest cases start a whole app,
     * spawn `tsc`, or drive a real HTTP bridge. Against Vitest's 5s default those lose the
     * scheduling race on a loaded runner: every full CI run timed out *some* test at exactly
     * 5000ms, a different one each time, while each passed in isolation.
     *
     * Raise the default rather than patching cases one at a time — the tests are not individually
     * wrong, the budget was. 30s is far below the CI job timeout, so a genuine hang still fails
     * the run rather than stalling it.
     */
    testTimeout: 30_000,
  },
});
