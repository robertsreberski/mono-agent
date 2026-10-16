import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MonoAgentConfigError as LeafError } from "../errors.js";
import { MonoAgentConfigError, resolveJsonMonoAgentConfig } from "../index.js";
import { readMonoAgentConfigJson } from "../json-source.js";

const source = new URL("../", import.meta.url);

function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith(".ts") ? [file] : [];
  });
}

describe("config leaf ownership", () => {
  it("keeps policy, types and parser leaves independent of resolver composition", () => {
    for (const file of sourceFiles(source)) {
      const ast = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      if (["index.ts", "load.ts", "layered-loader.ts"].some((name) => file.pathname.endsWith(`/${name}`))) continue;
      for (const statement of ast.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          expect(statement.moduleSpecifier.text, file.pathname).not.toMatch(/(?:^|\/)(?:config|index|json-source)\.js$/u);
          expect(statement.moduleSpecifier.text).not.toBe("@mono-agent/config");
        }
      }
    }
  });

  it("uses one public error identity through JSON and resolver failures", async () => {
    expect(MonoAgentConfigError).toBe(LeafError);
    expect(() => resolveJsonMonoAgentConfig({ cwd: "/fictional/repo", json: {} })).toThrow(LeafError);
    await expect(readMonoAgentConfigJson(new URL("../errors.ts", import.meta.url).pathname)).rejects.toBeInstanceOf(LeafError);
  });
});
