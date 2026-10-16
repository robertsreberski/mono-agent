import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as root from "../index.js";
import { AgentResponseCancelledError, ChannelUserCancelReason } from "../cancellation.js";
import { MCP_APP_RESOURCE_MIME_TYPE, MCP_APP_SUPPORTED_VERSIONS } from "../mcp-apps.js";

const source = new URL("../", import.meta.url);

describe("contracts leaf ownership", () => {
  it("keeps the root exports-only and production imports off the root", () => {
    for (const file of readdirSync(source).filter((name) => name.endsWith(".ts"))) {
      const ast = ts.createSourceFile(file, readFileSync(new URL(file, source), "utf8"), ts.ScriptTarget.Latest, true);
      if (file === "index.ts") {
        expect(ast.statements.every((statement) => ts.isExportDeclaration(statement))).toBe(true);
      } else {
        for (const statement of ast.statements) {
          if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
            expect(["./index.js", "@mono-agent/contracts"], file).not.toContain(statement.moduleSpecifier.text);
          }
        }
      }
    }
  });

  it("re-exports the same runtime identities rather than wrappers", () => {
    expect(root.AgentResponseCancelledError).toBe(AgentResponseCancelledError);
    expect(root.ChannelUserCancelReason).toBe(ChannelUserCancelReason);
    expect(root.MCP_APP_RESOURCE_MIME_TYPE).toBe(MCP_APP_RESOURCE_MIME_TYPE);
    expect(root.MCP_APP_SUPPORTED_VERSIONS).toBe(MCP_APP_SUPPORTED_VERSIONS);
  });
});
