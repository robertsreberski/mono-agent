import { describe, expect, it } from "vitest";

import { mappedEntries, runVerifyDeepImports } from "../verify-deep-imports.mjs";

function sink() {
  const lines = [];
  return { write: (text) => lines.push(text), get text() { return lines.join(""); } };
}

// Root of THIS repo/worktree (scripts/__tests__ -> scripts -> root).
const repoRoot = new URL("../..", import.meta.url).pathname;

describe("verify-deep-imports", () => {
  it("derives exactly the eleven curated turn specifiers without wildcards", () => {
    const specifiers = mappedEntries(repoRoot).map((entry) => entry.specifier);
    expect(specifiers.sort()).toEqual([
      "@mono-agent/turn", "@mono-agent/turn/ai", "@mono-agent/turn/agent", "@mono-agent/turn/tools",
      "@mono-agent/turn/host", "@mono-agent/turn/host/config", "@mono-agent/turn/host/types", "@mono-agent/turn/host/sandbox",
      "@mono-agent/turn/engine", "@mono-agent/turn/engine/sessions.js", "@mono-agent/turn/engine/owned-fs.js",
    ].sort());
  });

  it("maps each non-wildcard export key to its types condition target", () => {
    const entries = mappedEntries(repoRoot);
    // Every mapped key in the Phase-6 explicit map is a conditions object with a
    // `types` target, so none should be null.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => typeof entry.typesTarget === "string")).toBe(true);
    const root = entries.find((entry) => entry.specifier === "@mono-agent/turn");
    expect(root?.typesTarget?.endsWith("packages/turn/types/index.d.ts")).toBe(true);
  });

  it("resolves every mapped subpath (default + types conditions) through real resolution (exit 0)", async () => {
    // Real `default` import resolution + real on-disk `types` (.d.ts) existence.
    // The types/ outDir is a build artifact (gitignored); this runs after the
    // package is built (worktree has types/ present, phase gate builds first).
    const stdout = sink();
    const { exitCode, results } = await runVerifyDeepImports({ repoRoot, stdout, stderr: sink() });
    if (exitCode !== 0) {
      // Surface which subpath failed to make a regression actionable.
      throw new Error(`deep-import verification failed:\n${stdout.text}`);
    }
    expect(exitCode).toBe(0);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(stdout.text).toContain("deep-imports ok");
    expect(stdout.text).toContain("(types)");
  });

  it("exits non-zero when a mapped types condition target is missing on disk", async () => {
    // Default imports all succeed; a single types target is forced missing via
    // the injectable fileExists, so the run fails on the broken `types` condition.
    const stdout = sink();
    const missing = "@mono-agent/turn/ai";
    const { exitCode, results } = await runVerifyDeepImports({
      repoRoot,
      stdout,
      stderr: sink(),
      importFn: () => Promise.resolve({}),
      fileExists: (path) => !path.includes(`${"types"}/ai/index.d.ts`),
    });
    expect(exitCode).toBe(1);
    expect(stdout.text).toContain(`FAIL ${missing} (types): types condition target missing on disk`);
    expect(stdout.text).toContain("deep-imports fail");
    expect(results.find((r) => r.specifier === missing)?.ok).toBe(false);
  });

  it("exits non-zero and reports the offending specifier when a mapped subpath fails to load", async () => {
    const stdout = sink();
    const { exitCode, results } = await runVerifyDeepImports({
      repoRoot,
      stdout,
      stderr: sink(),
      importFn: (specifier) => {
        if (specifier === "@mono-agent/turn/ai") {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve({});
      },
    });
    expect(exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL @mono-agent/turn/ai: boom");
    expect(stdout.text).toContain("deep-imports fail");
    expect(results.find((r) => r.specifier === "@mono-agent/turn/ai")?.ok).toBe(false);
  });
});
