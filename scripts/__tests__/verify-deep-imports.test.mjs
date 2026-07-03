import { describe, expect, it } from "vitest";

import { mappedSpecifiers, runVerifyDeepImports } from "../verify-deep-imports.mjs";

function sink() {
  const lines = [];
  return { write: (text) => lines.push(text), get text() { return lines.join(""); } };
}

// Root of THIS repo/worktree (scripts/__tests__ -> scripts -> root).
const repoRoot = new URL("../..", import.meta.url).pathname;

describe("verify-deep-imports", () => {
  it("derives specifiers from the exports map, without wildcards, including the core deep paths", () => {
    const specifiers = mappedSpecifiers(repoRoot);
    expect(specifiers).toContain("@mono-agent/agent-runtime");
    expect(specifiers).toContain("@mono-agent/agent-runtime/ai");
    expect(specifiers).toContain("@mono-agent/agent-runtime/agent");
    expect(specifiers).toContain("@mono-agent/agent-runtime/ai/failure.js");
    expect(specifiers).toContain("@mono-agent/agent-runtime/agent/compaction.js");
    expect(specifiers).toContain("@mono-agent/agent-runtime/ai/runtime/registry.js");
    // Phase 6 removed the wildcards + the pi-sdk shim; neither should be mapped.
    expect(specifiers.some((s) => s.includes("*"))).toBe(false);
    expect(specifiers).not.toContain("@mono-agent/agent-runtime/ai/providers/pi-sdk.js");
  });

  it("resolves every mapped subpath through real package resolution (exit 0)", async () => {
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
  });

  it("exits non-zero and reports the offending specifier when a mapped subpath fails to load", async () => {
    const stdout = sink();
    const { exitCode, results } = await runVerifyDeepImports({
      repoRoot,
      stdout,
      stderr: sink(),
      importFn: (specifier) => {
        if (specifier === "@mono-agent/agent-runtime/ai/cost.js") {
          return Promise.reject(new Error("boom"));
        }
        return Promise.resolve({});
      },
    });
    expect(exitCode).toBe(1);
    expect(stdout.text).toContain("FAIL @mono-agent/agent-runtime/ai/cost.js: boom");
    expect(stdout.text).toContain("deep-imports fail");
    expect(results.find((r) => r.specifier === "@mono-agent/agent-runtime/ai/cost.js")?.ok).toBe(false);
  });
});
