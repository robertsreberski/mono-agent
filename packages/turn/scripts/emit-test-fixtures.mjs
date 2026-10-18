import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const isFixture = (path) => /(?:^|\/)__tests__\/(?:[^/]+\/)*fixtures\//u.test(path);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));

function visit(path, action) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child, action);
    else action(child);
  }
}

function resolveFixtureImports(path, bootstrap) {
  const text = readFileSync(path, "utf8"), source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function inspect(node) {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined;
    if (specifier && ts.isStringLiteralLike(specifier) && !isBuiltin(specifier.text)
      && !/^(?:\.|\/|[a-z]+:)/u.test(specifier.text)) {
      // All fixtures belong to turn. Resolve with its ESM conditions, not the
      // require condition or a synthetic node_modules link in the emitted tree.
      edits.push({ start: specifier.getStart(source), end: specifier.end, value: JSON.stringify(import.meta.resolve(specifier.text)) });
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  writeFileSync(path, `import ${JSON.stringify(bootstrap)};\n${result}`);
}

export function emitTestFixtures(directory = packageDirectory) {
  const output = resolve(directory, "../../.worklab-tmp/turn-test-fixtures");
  rmSync(output, { recursive: true, force: true });
  const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "--outDir", output, "-p", "tsconfig.fixtures.json"], { cwd: directory, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Test-only fixture emit failed");
  const bootstrap = pathToFileURL(join(output, "resolve-fixture-imports.mjs")).href;
  // Dependency closure is compiler input, never another executable production graph.
  visit(output, (path) => {
    if (!isFixture(relative(output, path))) rmSync(path);
    else if (/\.(?:js|mjs)$/u.test(path)) resolveFixtureImports(path, bootstrap);
  });
  visit(join(directory, "src"), (path) => {
    const name = relative(join(directory, "src"), path);
    if (!isFixture(name) || /\.(?:js|mjs|ts|mts)$/u.test(name)) return;
    const target = join(output, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(path, target);
  });
  // Static imports above must resolve during linking; the hook additionally
  // covers runtime template/expression imports without rewriting their values.
  writeFileSync(join(output, "resolve-fixture-imports.mjs"), `
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
const prefix = ${JSON.stringify(pathToFileURL(`${output}/`).href)};
const anchor = ${JSON.stringify(import.meta.url)};
const source = ${JSON.stringify(pathToFileURL(join(directory, "src/")).href)};
const production = ${JSON.stringify(pathToFileURL(join(directory, "dist/")).href)};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(prefix)) {
    if (!/^(?:\\.|\\/|[a-z]+:)/u.test(specifier)) context = { ...context, parentURL: anchor };
    else if (specifier.startsWith(".")) {
      const target = new URL(specifier, context.parentURL).href;
      if (target.startsWith(prefix) && !target.slice(prefix.length).includes("__tests__/")) {
        specifier = production + target.slice(prefix.length);
      }
    }
  }
  const resolved = nextResolve(specifier, context);
  if (resolved.url.startsWith(source) && !resolved.url.slice(source.length).includes("__tests__/")) {
    return nextResolve(fileURLToPath(production + resolved.url.slice(source.length)), context);
  }
  return resolved;
} });
`);
  if (!existsSync(join(output, "engine/__tests__/fixtures/projection-parity-worker.mjs"))) throw new Error("Missing emitted parity worker");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Emitted test fixtures: ${emitTestFixtures(process.argv[2] ? resolve(process.argv[2]) : packageDirectory)}`);
}
