import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const authorizationSeam = vi.hoisted(() => ({
  remainingChecks: 0,
  swap: undefined,
}));

vi.mock("../../agent/tools/shared/path-resolver.js", async (importOriginal) => {
  const actual = await importOriginal();
  const afterAllowedCheck = (allowed) => {
    if (!allowed || authorizationSeam.remainingChecks <= 0) return allowed;
    authorizationSeam.remainingChecks -= 1;
    if (authorizationSeam.remainingChecks === 0) {
      const swap = authorizationSeam.swap;
      authorizationSeam.swap = undefined;
      swap?.();
    }
    return allowed;
  };
  return {
    ...actual,
    isPathAllowed(...args) {
      return afterAllowedCheck(actual.isPathAllowed(...args));
    },
    isWritablePathAllowed(...args) {
      return afterAllowedCheck(actual.isWritablePathAllowed(...args));
    },
  };
});

import {
  editToolImpl,
  globToolImpl,
  grepToolImpl,
  readToolImpl,
  resolveRgPath,
} from "../../agent/tools/index.js";
import { createFakeSandbox, testSandboxPolicy } from "../helpers/fake-sandbox.js";
import {
  configureToolRuntime,
  resetToolRuntime,
} from "../../agent/tools/shared/runtime-context.js";

const tempDirs = [];
const PROTECTED_SENTINEL = "PROTECTED_SENTINEL_UNCHANGED";

function createFixture({ denyProtectedCommands = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agent-runtime-metadata-oracle-"));
  tempDirs.push(root);
  const protectedRoot = join(root, ".mono-agent", "protected-state");
  const protectedFile = join(protectedRoot, "guess-file.txt");
  const protectedDirectory = join(protectedRoot, "guess-directory");
  const protectedMissing = join(protectedRoot, "guess-missing");
  const siblingFile = join(root, "sibling.txt");
  const siblingDirectory = join(root, "!sibling[directory]");
  const racePath = join(root, "model-race-target");
  mkdirSync(protectedDirectory, { recursive: true });
  mkdirSync(siblingDirectory, { recursive: true });
  writeFileSync(protectedFile, PROTECTED_SENTINEL, "utf8");
  writeFileSync(join(protectedDirectory, "sentinel.txt"), PROTECTED_SENTINEL, "utf8");
  writeFileSync(siblingFile, "sibling original", "utf8");
  writeFileSync(join(siblingDirectory, "allowed.txt"), "sibling needle", "utf8");
  const sandboxEngine = {
    async isAvailable() {
      return true;
    },
    async prepareCommand(command) {
      if (!denyProtectedCommands) {
        return {
          ...command,
          args: command.args ?? [],
          cwd: command.cwd ?? root,
          sandboxed: true,
        };
      }
      return {
        command: process.execPath,
        args: ["--input-type=commonjs", "--eval", "process.exit(73)"],
        cwd: root,
        sandboxed: true,
      };
    },
  };
  configureToolRuntime({
    workspace: root,
    sandbox: createFakeSandbox(),
    sandboxEngine,
  });
  return {
    root,
    protectedFile,
    protectedDirectory,
    protectedMissing,
    siblingFile,
    siblingDirectory,
    racePath,
    policy: testSandboxPolicy({ root, protectedRoots: [protectedRoot] }),
  };
}

function pointSymlink(linkPath, targetPath) {
  rmSync(linkPath, { force: true });
  symlinkSync(targetPath, linkPath);
}

function swapAfterAuthorization(checkCount, swap) {
  authorizationSeam.remainingChecks = checkCount;
  authorizationSeam.swap = swap;
}

afterEach(() => {
  authorizationSeam.remainingChecks = 0;
  authorizationSeam.swap = undefined;
  resetToolRuntime();
  resolveRgPath({ refresh: true });
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

const protectedToolCases = [
  {
    name: "Read",
    authorizationChecks: 1,
    initialTarget: "file",
    expected: "Error: Protected filesystem read was denied.",
    variants: [undefined],
    async run(path, policy) {
      return await readToolImpl({ file_path: path }, { sandboxPolicy: policy });
    },
  },
  {
    name: "Edit",
    authorizationChecks: 2,
    initialTarget: "file",
    expected: "Error: Protected filesystem edit was denied.",
    variants: [undefined],
    async run(path, policy) {
      return await editToolImpl({
        file_path: path,
        old_string: PROTECTED_SENTINEL,
        new_string: "CORRUPTED",
      }, { sandboxPolicy: policy });
    },
  },
  {
    name: "Glob",
    authorizationChecks: 1,
    initialTarget: "directory",
    expected: "Error: Protected filesystem search was denied.",
    variants: [undefined],
    async run(path, policy) {
      return await globToolImpl({ path, pattern: "**/*" }, { sandboxPolicy: policy });
    },
  },
  {
    name: "Grep",
    authorizationChecks: 1,
    initialTarget: "directory",
    expected: "Error: Protected filesystem search was denied.",
    variants: ["content", "count", "files_with_matches", undefined],
    async run(path, policy, output_mode) {
      return await grepToolImpl({
        path,
        pattern: PROTECTED_SENTINEL,
        ...(output_mode === undefined ? {} : { output_mode }),
      }, { sandboxPolicy: policy });
    },
  },
];

describe("protected filesystem target metadata", () => {
  it.each(protectedToolCases)(
    "$name normalizes post-authorization protected missing/file/directory swaps",
    async ({ authorizationChecks, expected, initialTarget, run, variants }) => {
      const fixture = createFixture();
      const initial = initialTarget === "file" ? fixture.siblingFile : fixture.siblingDirectory;
      const guesses = [fixture.protectedMissing, fixture.protectedFile, fixture.protectedDirectory];
      const results = [];

      for (const guess of guesses) {
        for (const variant of variants) {
          pointSymlink(fixture.racePath, initial);
          swapAfterAuthorization(authorizationChecks, () => pointSymlink(fixture.racePath, guess));
          results.push(await run(fixture.racePath, fixture.policy, variant));
          expect(authorizationSeam.remainingChecks).toBe(0);
        }
      }

      expect(new Set(results)).toEqual(new Set([expected]));
      expect(results.join("\n")).not.toContain(fixture.root);
      expect(readFileSync(fixture.protectedFile, "utf8")).toBe(PROTECTED_SENTINEL);
      expect(readFileSync(join(fixture.protectedDirectory, "sentinel.txt"), "utf8"))
        .toBe(PROTECTED_SENTINEL);
    },
  );

  it("keeps allowed sibling Read/Edit/Glob/all-Grep-mode behavior with protected roots active", async () => {
    const fixture = createFixture({ denyProtectedCommands: false });

    const readResult = await readToolImpl(
      { file_path: fixture.siblingFile },
      { sandboxPolicy: fixture.policy },
    );
    const editResult = await editToolImpl({
      file_path: fixture.siblingFile,
      old_string: "original",
      new_string: "edited",
    }, { sandboxPolicy: fixture.policy });
    const globResult = await globToolImpl(
      { path: fixture.siblingDirectory, pattern: "*.txt" },
      { sandboxPolicy: fixture.policy },
    );
    const grepResults = await Promise.all([
      "content",
      "count",
      "files_with_matches",
      undefined,
    ].map(async (output_mode) => await grepToolImpl({
      path: fixture.siblingDirectory,
      pattern: "sibling needle",
      glob: "*.txt",
      ...(output_mode === undefined ? {} : { output_mode }),
    }, { sandboxPolicy: fixture.policy })));
    const fileGrepResult = await grepToolImpl({
      path: fixture.siblingFile,
      pattern: "sibling edited",
      output_mode: "content",
    }, { sandboxPolicy: fixture.policy });
    const compatiblePolicy = testSandboxPolicy({ root: fixture.root });
    const compatibleGlobResult = await globToolImpl(
      { path: fixture.siblingDirectory, pattern: "*.txt" },
      { sandboxPolicy: compatiblePolicy },
    );
    const compatibleGrepResults = await Promise.all([
      "content",
      "count",
      "files_with_matches",
      undefined,
    ].map(async (output_mode) => await grepToolImpl({
      path: fixture.siblingDirectory,
      pattern: "sibling needle",
      glob: "*.txt",
      ...(output_mode === undefined ? {} : { output_mode }),
    }, { sandboxPolicy: compatiblePolicy })));
    const compatibleFileGrepResult = await grepToolImpl({
      path: fixture.siblingFile,
      pattern: "sibling edited",
      output_mode: "content",
    }, { sandboxPolicy: compatiblePolicy });

    expect(readResult).toContain("sibling original");
    expect(editResult).toContain("Successfully edited");
    expect(readFileSync(fixture.siblingFile, "utf8")).toBe("sibling edited");
    expect(globResult).toContain("allowed.txt");
    for (const grepResult of grepResults) expect(grepResult).toContain("allowed.txt");
    expect(fileGrepResult).toContain("sibling edited");
    expect(globResult).toBe(compatibleGlobResult);
    expect(grepResults).toEqual(compatibleGrepResults);
    expect(fileGrepResult).toBe(compatibleFileGrepResult);
    expect(readFileSync(fixture.protectedFile, "utf8")).toBe(PROTECTED_SENTINEL);
  });

  it("preserves host metadata errors and file search behavior without protected roots", async () => {
    const fixture = createFixture({ denyProtectedCommands: false });
    const policy = testSandboxPolicy({ root: fixture.root });
    const missing = join(fixture.root, "missing.txt");

    expect(await readToolImpl({ file_path: "missing.txt" }, { sandboxPolicy: policy }))
      .toBe("Error: File not found: missing.txt");
    expect(await editToolImpl({
      file_path: "missing.txt",
      old_string: "old",
      new_string: "new",
    }, { sandboxPolicy: policy })).toBe("Error: File not found: missing.txt");
    expect(await globToolImpl({ path: fixture.siblingFile, pattern: "**/*" }, { sandboxPolicy: policy }))
      .toBe(`Error: Glob path is not a directory: ${fixture.siblingFile}`);
    expect(await globToolImpl({ path: missing, pattern: "**/*" }, { sandboxPolicy: policy }))
      .toBe(`Error: Glob path is not a directory: ${missing}`);
    expect(await grepToolImpl({ path: missing, pattern: "sibling" }, { sandboxPolicy: policy }))
      .toBe(`Error: Path not found: ${missing}`);
    expect(await grepToolImpl({ path: fixture.siblingFile, pattern: "sibling" }, { sandboxPolicy: policy }))
      .toContain("sibling.txt");
  });
});
