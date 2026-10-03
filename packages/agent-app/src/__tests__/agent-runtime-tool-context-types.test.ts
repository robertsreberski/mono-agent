import {
  bashToolImpl,
  bashToolRun,
  editToolImpl,
  execToolImpl,
  execToolRun,
  globToolImpl,
  grepToolImpl,
  isPathAllowed,
  isWorkdirAllowed,
  performWebFetch,
  performWebSearch,
  readToolImpl,
  webFetchToolImpl,
  webSearchToolImpl,
  writeToolImpl,
} from "@mono-agent/agent-runtime/agent/tools/index.js";
import { createToolContext } from "@mono-agent/agent-runtime/agent/tools/shared/tool-context.js";
import { describe, expect, it } from "vitest";

// This function is deliberately never executed. Its body is a downstream
// consumer compile contract for the declarations emitted by agent-runtime.
function publicToolContextTypeContract(): void {
  const ctx = createToolContext({ workspace: "/tmp" });

  void readToolImpl({ file_path: "README.md" }, { ctx });
  void writeToolImpl({ file_path: "/tmp/output", content: "ok" }, { ctx });
  void editToolImpl({ file_path: "/tmp/output", old_string: "o", new_string: "n" }, { ctx });
  void globToolImpl({ pattern: "**/*" }, { ctx });
  void grepToolImpl({ pattern: "context" }, { ctx });
  void bashToolImpl({ command: "true" }, { ctx });
  void bashToolRun({ command: "true" }, { ctx });
  void execToolImpl({ executable: "/usr/bin/true" }, { ctx });
  void execToolRun({ executable: "/usr/bin/true" }, { ctx });
  void webFetchToolImpl({ url: "https://example.com" }, { ctx });
  void performWebFetch({ url: "https://example.com" }, { ctx });
  void webSearchToolImpl({ query: "context contract" }, { ctx });
  void performWebSearch({ query: "context contract" }, { ctx });
  void isPathAllowed("README.md", undefined, { ctx });
  void isWorkdirAllowed("/tmp", { ctx });

  // @ts-expect-error Direct Read execution requires explicit ToolContext options.
  void readToolImpl({ file_path: "README.md" });
  // @ts-expect-error Direct Write execution requires explicit ToolContext options.
  void writeToolImpl({ file_path: "/tmp/output", content: "no" });
  // @ts-expect-error Direct Edit execution requires explicit ToolContext options.
  void editToolImpl({ file_path: "/tmp/output", old_string: "o", new_string: "n" });
  // @ts-expect-error Direct Glob execution requires explicit ToolContext options.
  void globToolImpl({ pattern: "**/*" });
  // @ts-expect-error Direct Grep execution requires explicit ToolContext options.
  void grepToolImpl({ pattern: "context" });
  // @ts-expect-error Direct Bash execution requires explicit ToolContext options.
  void bashToolImpl({ command: "true" });
  // @ts-expect-error Structured Bash execution requires explicit ToolContext options.
  void bashToolRun({ command: "true" });
  // @ts-expect-error Direct Exec execution requires explicit ToolContext options.
  void execToolImpl({ executable: "/usr/bin/true" });
  // @ts-expect-error Structured Exec execution requires explicit ToolContext options.
  void execToolRun({ executable: "/usr/bin/true" });
  // @ts-expect-error Direct WebFetch execution requires explicit ToolContext options.
  void webFetchToolImpl({ url: "https://example.com" });
  // @ts-expect-error Structured WebFetch execution requires explicit ToolContext options.
  void performWebFetch({ url: "https://example.com" });
  // @ts-expect-error Direct WebSearch execution requires explicit ToolContext options.
  void webSearchToolImpl({ query: "context contract" });
  // @ts-expect-error Structured WebSearch execution requires explicit ToolContext options.
  void performWebSearch({ query: "context contract" });
  // @ts-expect-error Public path guards require explicit ToolContext options.
  void isPathAllowed("README.md", undefined);
  // @ts-expect-error Public workdir guards require explicit ToolContext options.
  void isWorkdirAllowed("/tmp");

  // @ts-expect-error An options object without ctx cannot execute a direct tool.
  void bashToolImpl({ command: "true" }, {});
  // @ts-expect-error An options object without ctx cannot execute a filesystem tool.
  void readToolImpl({ file_path: "README.md" }, {});
  // @ts-expect-error An options object without ctx cannot execute a web tool.
  void performWebFetch({ url: "https://example.com" }, {});
  // @ts-expect-error An options object without ctx cannot run a public path guard.
  void isPathAllowed("README.md", undefined, {});
}

describe("agent-runtime public ToolContext declarations", () => {
  it("retain the compile-only contract without executing direct tools", () => {
    expect(publicToolContextTypeContract).toBeTypeOf("function");
  });
});
