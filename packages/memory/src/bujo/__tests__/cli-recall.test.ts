import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../../../dist/bujo/cli.js", import.meta.url));

describe("memory-bujo bin removal deflector", () => {
  it.each([
    ["recall", "some-root", "needle"],
    ["reflect", "some-root"],
    ["rebuild", "some-root", "--tier", "lite"],
    [],
  ])("exits 1 with the redirect message for `%s`", (...argv) => {
    const result = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "the memory-bujo command was removed; use `mono-agent memory <subcommand>` from the agent folder",
    );
    // The deflector must not do any store work — nothing is written to stdout.
    expect(result.stdout).toBe("");
  });
});
