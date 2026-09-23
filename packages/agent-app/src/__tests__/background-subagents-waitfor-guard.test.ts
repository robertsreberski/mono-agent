import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for background-subagents.test.ts only (not a general
// style rule): that file's durable cases are the slowest in the package —
// durable publication plus wake settlement has measured 7-9s under CI load —
// while Vitest's implicit vi.waitFor default is 1 000 ms. Every vi.waitFor in
// that file must therefore carry an explicit timeout. This test parses the
// file's source with a small balanced-paren scanner so multi-line calls are
// checked, not just single-line ones.
const TARGET = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "background-subagents.test.ts",
);

interface Violation {
  line: number;
  snippet: string;
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source[i] === "\n") line++;
  return line;
}

function findWaitForViolations(source: string): Violation[] {
  const violations: Violation[] = [];
  const needle = "vi.waitFor(";
  let from = 0;
  while (true) {
    const start = source.indexOf(needle, from);
    if (start < 0) break;
    // Balanced scan of the call starting at the opening paren, skipping
    // string literals, template literals and comments so nested parens and
    // commas inside them do not confuse the top-level argument split.
    let i = start + needle.length - 1; // at '('
    let depth = 0;
    let topLevelComma = -1;
    let state: "code" | "single" | "double" | "template" | "lineComment" | "blockComment" = "code";
    let templateExprDepth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const ch = source[i]!;
      const next = source[i + 1] ?? "";
      if (state === "lineComment") {
        if (ch === "\n") state = "code";
        continue;
      }
      if (state === "blockComment") {
        if (ch === "*" && next === "/") {
          state = "code";
          i++;
        }
        continue;
      }
      if (state === "single") {
        if (ch === "\\") i++;
        else if (ch === "'") state = "code";
        continue;
      }
      if (state === "double") {
        if (ch === "\\") i++;
        else if (ch === '"') state = "code";
        continue;
      }
      if (state === "template") {
        if (ch === "\\") i++;
        else if (ch === "`") state = "code";
        else if (ch === "$" && next === "{") {
          templateExprDepth++;
          i++;
        } else if (ch === "}" && templateExprDepth > 0) templateExprDepth--;
        continue;
      }
      // state === "code"
      if (ch === "/" && next === "/") {
        state = "lineComment";
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "blockComment";
        i++;
        continue;
      }
      if (ch === "'") {
        state = "single";
        continue;
      }
      if (ch === '"') {
        state = "double";
        continue;
      }
      if (ch === "`") {
        state = "template";
        templateExprDepth = 0;
        continue;
      }
      if (ch === "(") {
        depth++;
        continue;
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
        continue;
      }
      if (ch === "," && depth === 1 && topLevelComma < 0) topLevelComma = i;
    }
    if (end < 0) {
      violations.push({ line: lineOf(source, start), snippet: source.slice(start, start + 80) });
      from = start + needle.length;
      continue;
    }
    const optionsText = topLevelComma < 0 ? "" : source.slice(topLevelComma + 1, end);
    if (!/\btimeout\s*:/.test(optionsText)) {
      const line = lineOf(source, start);
      const snippet = source.slice(start, Math.min(end + 1, start + 160)).replace(/\s+/g, " ");
      violations.push({ line, snippet });
    }
    from = end + 1;
  }
  return violations;
}

describe("background-subagents explicit waitFor budgets", () => {
  it("fails if any vi.waitFor in background-subagents.test.ts omits an explicit timeout", () => {
    const source = readFileSync(TARGET, "utf8");
    const violations = findWaitForViolations(source);
    expect(
      violations,
      violations.length
        ? `background-subagents.test.ts has ${violations.length} vi.waitFor call(s) without an explicit timeout:\n` +
            violations.map((v) => `  line ~${v.line}: ${v.snippet}`).join("\n")
        : "all vi.waitFor calls carry an explicit timeout",
    ).toEqual([]);
  });
});
