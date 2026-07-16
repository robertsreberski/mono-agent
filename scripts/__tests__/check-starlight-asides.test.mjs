import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  findEmptyStarlightAsides,
  runStarlightAsideCheck,
} from "../../website/scripts/check-starlight-asides.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-starlight-asides", () => {
  it("finds an opening fence immediately followed by its closing fence", () => {
    expect(findEmptyStarlightAsides([
      "# Page",
      "",
      ":::caution",
      ":::",
      "This paragraph was orphaned by the premature close.",
      "",
    ].join("\n"))).toEqual([{ line: 3, opening: ":::caution" }]);
  });

  it("fails a representative pre-fix document with an actionable location", () => {
    const docsRoot = temporaryDocs({
      "broken.md": ":::note\n:::\nOrphaned note text.\n",
    });
    const stderr = sink();

    const result = runStarlightAsideCheck({ docsRoot, stdout: sink(), stderr });

    expect(result.exitCode).toBe(1);
    expect(result.matches).toEqual([{
      file: "broken.md",
      line: 1,
      opening: ":::note",
    }]);
    expect(stderr.text).toContain("docs/broken.md:1");
  });

  it("passes after the paragraph is moved inside the aside", () => {
    const docsRoot = temporaryDocs({
      "fixed.md": ":::note\nThe note text is inside the fence.\n:::\n",
    });
    const stdout = sink();

    const result = runStarlightAsideCheck({ docsRoot, stdout, stderr: sink() });

    expect(result).toMatchObject({ exitCode: 0, filesChecked: 1, matches: [] });
    expect(stdout.text).toContain("0 empty asides");
  });
});

function temporaryDocs(files) {
  const root = mkdtempSync(join(tmpdir(), "mono-agent-asides-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents);
  }
  return root;
}

function sink() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
      return true;
    },
  };
}
