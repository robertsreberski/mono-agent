import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderHelp } from "../cli.js";
import { readinessProbeTimeoutDescription } from "../readiness-probe.js";

const PACKAGE_README = readFileSync(
  fileURLToPath(new URL("../../README.md", import.meta.url)),
  "utf8",
);
const ROOT_README = readFileSync(
  fileURLToPath(new URL("../../../../README.md", import.meta.url)),
  "utf8",
);

function occurrences(source: string, needle: string): number {
  return source.replace(/\s+/gu, " ").split(needle).length - 1;
}

describe("init wall-clock disclosure", () => {
  it("front-loads the scaffold versus live-readiness distinction in init help", () => {
    const help = renderHelp();
    const initStart = help.indexOf("mono-agent init [--preset");
    const setupStart = help.indexOf("mono-agent setup", initStart);
    const initEntry = help.slice(initStart, setupStart);

    expect(initStart).toBeGreaterThanOrEqual(0);
    expect(setupStart).toBeGreaterThan(initStart);
    expect(initEntry).toContain("Fast scaffold-only path: flags or non-TTY input");
    expect(initEntry).toContain("without explicit --auth");
    expect(initEntry).toContain("real no-tool model call per selected route");
    expect(initEntry).toContain("before committing the scaffold");
    expect(initEntry).toContain(readinessProbeTimeoutDescription());
    expect(initEntry.indexOf("Fast scaffold-only path")).toBeLessThan(
      initEntry.indexOf("--preset seeds a blueprint"),
    );
  });

  it("keeps both README openings and detailed timeout facts aligned with source", () => {
    const timeoutDescription = readinessProbeTimeoutDescription();
    const packageOpening = PACKAGE_README.slice(0, PACKAGE_README.indexOf("## Category"));
    const quickstartStart = ROOT_README.indexOf("## Quickstart:");
    const rootOpening = ROOT_README.slice(
      quickstartStart,
      ROOT_README.indexOf("```", quickstartStart),
    );

    for (const opening of [packageOpening, rootOpening]) {
      expect(opening).toContain("fast scaffold-only path");
      expect(opening).toContain("flags or non-TTY input");
      expect(opening).toContain("real no-tool model call per selected route");
      expect(opening).toContain("before committing the scaffold");
      expect(opening).toContain(timeoutDescription);
    }

    expect(occurrences(PACKAGE_README, timeoutDescription)).toBe(2);
    expect(occurrences(ROOT_README, timeoutDescription)).toBe(2);
  });
});
