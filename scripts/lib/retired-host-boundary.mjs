import ts from "typescript";

// Only active import syntax is forbidden; migration tables, archived prose and
// assertions that the removed package cannot load are legitimate references.
export function retiredHostImports(file, text) {
  if (!/\.[cm]?[jt]sx?$/u.test(file)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const retired = ["runtime-adapter", "engine"].map((name) => `@mono-agent/${name}`);
  function record(node) {
    if (node && ts.isStringLiteralLike(node)
      && retired.some((name) => node.text === name || node.text.startsWith(`${name}/`))) imports.push(node.text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) record(node.argument.literal);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node.expression) && node.expression.text === "require")) record(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return imports;
}
