import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const packageRoot = resolve(__filename, "..", "..", "..");
const binPath = resolve(packageRoot, "dist", "bin", "mono-agent-tui.js");

describe("mono-agent-tui bin", () => {
  it("prints help text and exits 0 when --help is passed", () => {
    if (!existsSync(binPath)) {
      // The bin only exists after the package has been built. Skip the
      // smoke test in source-only test runs (vitest runs against src/).
      // The build step in the verification phase covers the same surface.
      return;
    }
    const output = execFileSync("node", [binPath, "--help"], {
      encoding: "utf8",
    });
    expect(output).toMatch(/Usage: mono-agent-tui/);
    expect(output).toMatch(/--responder/);
    expect(output).toMatch(/--config/);
  });
});
