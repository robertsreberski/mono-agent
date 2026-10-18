import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:ts|mts)$/u.test(path) && !/\.d\.(?:ts|mts)$/u.test(path) ? [path] : [];
  });
}

// Comment ranges come from the syntax tree, not a text search: embedded JS
// programs and declaration-comparator seeds are data, not authored JSDoc.
function comments(source: ts.SourceFile): ts.JSDoc[] {
  const ranges = new Map<number, number>();
  function visit(node: ts.Node) {
    for (const range of [...ts.getLeadingCommentRanges(source.text, node.pos) ?? [],
      ...ts.getTrailingCommentRanges(source.text, node.end) ?? []]) {
      if (source.text.startsWith("/**", range.pos)) ranges.set(range.pos, range.end);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...ranges].flatMap(([start, end]) => {
    const parsed = ts.createSourceFile("comment.ts", `${source.text.slice(start, end).replace(/@(?=[a-z][a-z0-9-]*\/)/gu, "\uE000")}\nconst owner = 0;`, ts.ScriptTarget.Latest, true);
    return (parsed.statements[0] as ts.VariableStatement & { jsDoc?: ts.JSDoc[] }).jsDoc ?? [];
  });
}

it("uses TS declarations instead of redundant JSDoc type syntax", () => {
  const findings: string[] = [];
  for (const file of sources(sourceRoot)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const doc of comments(source)) {
      function visit(node: ts.Node) {
        if (ts.isJSDocTypedefTag(node) || ts.isJSDocCallbackTag(node) || ts.isJSDocTypeTag(node)
          || ts.isJSDocTypeExpression(node) || ts.isJSDocOverloadTag(node)) {
          findings.push(`${file.slice(sourceRoot.length)}: ${node.getText(doc.getSourceFile())}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(doc);
    }
  }
  expect(findings).toEqual([]);
});

it("keeps SearchProvider's complete source-only description once on its declaration", () => {
  const file = join(sourceRoot, "tools/web/search-providers/registry.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const expected = [
    "Source-level provider contract. The chain owns relevance, fusion, deadlines,",
    "deferrals and refund settlement. Adapters own request shaping and parsing.",
    "configure returns a normalized config patch or a deterministic error; selected",
    "identifies an explicit selection (requirements must not silently skip it).",
    "networkTargets are sandbox-gated before admission; transports must also gate",
    "computed destinations and reject unsafe redirects. Admission keys and outcome",
    "metadata must never contain queries, bodies or credentials.",
    "search claims immediately before dispatch, via web-search-state; setup and",
    "failed responses are refunded by the chain. batchesQueries providers receive",
    "options.queries in primary-first order; others receive sequential queries.",
    "An optional preflight may refuse the attempt before admission is constructed",
    "or the coordinator is touched (no quota claimed, no dispatch); it returns a",
    "failure object or nullish to proceed.",
  ].join("\n");
  const declaration = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === "SearchProvider")!;
  const descriptions = ts.getJSDocCommentsAndTags(declaration).filter(ts.isJSDoc).map((doc) => doc.comment);
  expect(descriptions).toEqual([expected]);
  expect(comments(source).filter((doc) => doc.comment === expected)).toHaveLength(1);
  const member = (declaration.type as ts.TypeLiteralNode).members.find((node) => node.name?.getText(source) === "ownsRequests")!;
  const memberDescription = "Composite owns per-request URL policy and admission; never perform aggregate gating/admission.";
  expect(ts.getJSDocCommentsAndTags(member).filter(ts.isJSDoc).map((doc) => doc.comment)).toEqual([memberDescription]);
  expect(comments(source).filter((doc) => doc.comment === memberDescription)).toHaveLength(1);
});
