// Explicit source inventory is a tripwire, not a JavaScript sandbox.
import { expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import ts from "typescript";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
async function scripts(dir = "scripts") {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? scripts(`${dir}/${e.name}`) : e.name.endsWith(".mjs") ? [`${dir}/${e.name}`] : []))).flat();
}
function parse(path, text) { return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS); }
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)); }
function calls(source, target) {
  const aliases = new Set([target]), found = [];
  visit(source, n => {
    if (ts.isImportSpecifier(n) && n.propertyName?.text === target) aliases.add(n.name.text);
    if (ts.isBindingElement(n) && n.propertyName?.text === target && ts.isIdentifier(n.name)) aliases.add(n.name.text);
  });
  visit(source, n => {
    if (!ts.isCallExpression(n)) return;
    const e = n.expression, name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text
      : ts.isElementAccessExpression(e) && ts.isStringLiteral(e.argumentExpression) ? e.argumentExpression.text : null;
    if (aliases.has(name)) found.push(n);
  }); return found;
}
const hasPilot = arg => arg && ts.isObjectLiteralExpression(arg) && arg.properties.some(p => p.name?.getText() === "pilot");
// Resolve only this scripts graph, never dependencies or default libraries. Symbols
// preserve renamed imports/re-exports; fixed-point aliases preserve value passing.
function inventory(sources, target) {
  const files = new Map([...sources].map(([path, text]) => [resolve(ROOT, path), parse(path, text)]));
  const program = ts.createProgram([...files.keys()], { allowJs: true, noLib: true, types: [], module: ts.ModuleKind.ESNext }, {
    getSourceFile: path => files.get(path), getDefaultLibFileName: () => "", writeFile() {}, getCurrentDirectory: () => ROOT,
    fileExists: path => files.has(path), readFile: path => files.get(path)?.text, getDirectories: () => [],
    getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
    resolveModuleNames: (names, file) => names.map(name => {
      const path = resolve(dirname(file), name);
      return files.has(path) ? { resolvedFileName: path, extension: ts.Extension.Mjs } : undefined;
    }),
  });
  const checker = program.getTypeChecker(), known = new Set();
  const symbol = node => {
    let value = checker.getSymbolAtLocation(node);
    if (value?.flags & ts.SymbolFlags.Alias) value = checker.getAliasedSymbol(value);
    return value?.declarations?.length ? value : undefined;
  };
  const named = node => ts.isIdentifier(node) && node.text === target
    || ts.isStringLiteral(node) && node.text === target && (ts.isElementAccessExpression(node.parent) || ts.isVariableDeclaration(node.parent));
  const ref = node => Boolean(node && (named(node) || known.has(symbol(node))));
  const value = node => node && (ref(node) || ts.isAwaitExpression(node) && value(node.expression)
    || ts.isPropertyAccessExpression(node) && (ref(node.name) || ["call", "apply", "bind"].includes(node.name.text) && value(node.expression))
    || ts.isElementAccessExpression(node) && ref(node.argumentExpression)
    || ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "bind" && value(node.expression.expression));
  for (const source of files.values()) visit(source, node => { if (named(node) && symbol(node)) known.add(symbol(node)); });
  let changed = true;
  while (changed) {
    const before = known.size;
    for (const source of files.values()) visit(source, node => {
      const name = ts.isVariableDeclaration(node) && value(node.initializer) ? node.name
        : ts.isPropertyAssignment(node) && value(node.initializer) ? node.name
        : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && value(node.right) ? node.left
        : ts.isBindingElement(node) && ref(node.propertyName) ? node.name : null;
      if (name && symbol(name)) known.add(symbol(name));
    });
    changed = known.size !== before;
  }
  const result = {};
  for (const [path] of sources) {
    const source = files.get(resolve(ROOT, path)); let count = 0;
    visit(source, node => {
      if ((ts.isIdentifier(node) || ts.isStringLiteral(node) && (ts.isElementAccessExpression(node.parent) || ts.isVariableDeclaration(node.parent))) && ref(node)) count++;
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && (!node.exportClause || ts.isNamespaceExport(node.exportClause))) {
        const module = checker.getSymbolAtLocation(node.moduleSpecifier);
        if (module && checker.getExportsOfModule(module).some(item => known.has(item.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(item) : item))) count++;
      }
      // A default import can conceal a fetch site without spelling its local name fetch.
      if (target === "fetch" && ts.isImportDeclaration(node) && /fetch|undici/u.test(node.moduleSpecifier.text)) count++;
    });
    if (count) result[path] = count;
  }
  return result;
}
// Whole-tree TypeScript parsing: CPU-bound and slow on a busy shared runner,
// so budget like the other heavy static suites; a hang still fails loudly.
it("inventories every authority reference and separate real/loopback native fetches, not just calls", async () => {
  const sources = new Map(await Promise.all((await scripts()).map(async path => [path, await readFile(join(ROOT, path), "utf8")])));
  const guard = inventory(sources, "guardedLookupModels"), real = inventory(sources, "createLookupRealSend");
  const fetches = inventory(sources, "fetch");
  const runtimeFetches = Object.fromEntries(Object.entries(fetches).filter(([path]) => !path.includes("/__tests__/")));
  expect({ guard, real, runtimeFetches }).toEqual(INVENTORY);
  const native = parse("native", sources.get("scripts/lib/continuity-lookup-real-capability.mjs"));
  expect(calls(native, "nativeFetch")).toHaveLength(1);
  expect(calls(parse("local", sources.get("scripts/lib/continuity-lookup-faux-capability.mjs")), "nativeFetch")).toHaveLength(1);
}, 120_000);
// Definition/import/alias references are intentional entries too. Test mocks are
// listed explicitly; no new production constructor may hide behind a callback.
const INVENTORY = {
  guard: {
    "scripts/__tests__/continuity-lookup-guard.test.mjs": 8,
    "scripts/__tests__/continuity-lookup-real-capability.test.mjs": 5,
    "scripts/__tests__/continuity-lookup-turn.test.mjs": 2,
    "scripts/__tests__/fixtures/continuity-lookup-guard-smoke.mjs": 2,
    "scripts/lib/continuity-lookup-guard.mjs": 2,
    "scripts/__tests__/fixtures/lookup-pilot-mechanics.mjs": 2,
    "scripts/lib/continuity-lookup-real-capability.mjs": 1,
  },
  real: {
    "scripts/__tests__/continuity-lookup-credentialed-models.test.mjs": 1,
    "scripts/__tests__/continuity-lookup-pilot-child.test.mjs": 1,
    "scripts/__tests__/fixtures/lookup-preparation-preload.mjs": 1,
    "scripts/__tests__/continuity-lookup-pilot-entry.test.mjs": 2,
    "scripts/__tests__/continuity-lookup-pilot-probe.test.mjs": 1,
    "scripts/__tests__/continuity-lookup-real-capability.test.mjs": 20,
    "scripts/lib/continuity-lookup-pilot-probe.mjs": 2,
    "scripts/lib/continuity-lookup-real-capability.mjs": 1,
  },
  runtimeFetches: {
    "scripts/check-dependency-vulnerabilities.mjs": 2,
    "scripts/memory-health-responsiveness.mjs": 1,
    "scripts/smoke-process-job-wake.mjs": 2,
    // Existing non-pilot embedding/generation transports are inventoried too.
    "scripts/lib/memory-e2e-private-providers.mjs": 2,
    // An SDK hook definition and its faux invocation are not native network sites.
    "scripts/lib/continuity-lookup-guard.mjs": 1,
    "scripts/lib/continuity-lookup-faux-capability.mjs": 3,
    // Capture, local alias declaration and exactly one native invocation.
    "scripts/lib/continuity-lookup-real-capability.mjs": 3,
  },
};
it("finds aliases, call/apply/bind, callbacks, renamed and star re-exports across files", () => {
  const sources = new Map([
    ["scripts/definition.mjs", "export function guardedLookupModels() {}"],
    ["scripts/exports.mjs", 'export { guardedLookupModels as renamed } from "./definition.mjs"; export * from "./definition.mjs";'],
    ["scripts/consumer.mjs", 'import { renamed as route } from "./exports.mjs"; const g = route; g.call(null); g.apply(null, []); const bound = g.bind(null); consume(bound);'],
  ]);
  expect(inventory(sources, "guardedLookupModels")).toEqual({ "scripts/definition.mjs": 1, "scripts/exports.mjs": 3, "scripts/consumer.mjs": 9 });
});
it("finds alternate fetch references, including captured aliases and computed access", () => {
  for (const text of ['fetch("fictional")', 'globalThis["fetch"]("fictional")', 'const key = "fetch"; globalThis[key]("fictional")', 'const f = globalThis.fetch.bind(globalThis); f.call(null, "fictional")', 'import other from "node-fetch"; other("fictional")']) {
    expect(inventory(new Map([["scripts/canary.mjs", text]]), "fetch")["scripts/canary.mjs"]).toBeGreaterThan(0);
  }
});
it("threads pilot through configured probe and all auxiliary helper boundaries", async () => {
  const runner = parse("runner", await readFile(join(ROOT, "scripts/lib/continuity-runner.mjs"), "utf8"));
  const functions = new Map(); visit(runner, n => { if (ts.isFunctionDeclaration(n)) functions.set(n.name?.text, n); });
  for (const name of ["buildCheckpoint", "prepareLedgerCheckpoint", "manualCompaction", "createJudge", "runProbe", "runLiveTurn"]) {
    expect(functions.has(name), name).toBe(true);
    expect(functions.get(name)?.parameters[0]?.name.elements.some(e => e.name.getText() === "pilot"), name).toBe(true);
  }
  const compaction = calls(runner, "manualCompaction"); expect(compaction).toHaveLength(1);
  for (const call of compaction) expect(hasPilot(call.arguments[0])).toBe(true);
  const preparation = calls(runner, "runBoundaryChild").filter(c => c.arguments[0]?.getText().includes('type: "preparation"'));
  expect(preparation).toHaveLength(1); expect(hasPilot(preparation[0].arguments[0])).toBe(true);
  const probe = parse("probe", await readFile(join(ROOT, "scripts/lib/continuity-lookup-pilot-probe.mjs"), "utf8"));
  expect(calls(probe, "buildCheckpoint")).toHaveLength(0);
  for (const name of ["runProbe", "createJudge"]) {
    const found = calls(probe, name); expect(found, name).toHaveLength(1); expect(hasPilot(found[0].arguments[0]), name).toBe(true);
  }
  const harnesses = calls(runner, "openHarness"); expect(harnesses.length).toBeGreaterThan(0);
  expect(harnesses.some(c => hasPilot(c.arguments[0]))).toBe(true);
  expect(functions.get("runProbe").getText()).toContain("owner: trace.owner.displayName, pilot");
});

it("cannot hide an authority alias in a user variable named unknown", () => {
  const sources = new Map([["scripts/alias.mjs", "function guardedLookupModels() {} const unknown = guardedLookupModels; const x = unknown; x();"]]);
  expect(inventory(sources, "guardedLookupModels")["scripts/alias.mjs"]).toBe(6);
});

it("keeps preparation entries and helpers free of authority and fetch references", async () => {
  const paths = ["scripts/lib/continuity-lookup-preparation-child.mjs", "scripts/lib/continuity-lookup-preparation.mjs", "scripts/lib/continuity-lookup-preflight.mjs", "scripts/lib/continuity-lookup-child-environment.mjs"];
  const sources = new Map(await Promise.all(paths.map(async path => [path, await readFile(join(ROOT, path), "utf8")])));
  for (const target of ["fetch", "guardedLookupModels", "createLookupRealSend", "verifyLookupRealAssignment", "createLookupPilotIPC", "validateLookupAuthorization", "consumeLookupAuthorization", "verifyLookupConsumption", "verifyLookupPilotParent", "assertRealLookupPermitSource", "createFauxLookupDecorator", "isRealLookupSend", "realLookupSendForGuard", "isRealLookupDecorator", "realLookupSendBinds"]) expect(inventory(sources, target), target).toEqual({});
  for (const text of sources.values()) expect(text).not.toMatch(/from ["'][^"']*(?:real-capability|lookup-ipc)[^"']*["']/u);
});
it("includes a new top-level runtime fetch in the exact inventory", () => {
  const sources = new Map([["scripts/new-runtime.mjs", 'const hidden = globalThis.fetch; hidden("fictional");']]);
  const runtimeFetches = Object.fromEntries(Object.entries(inventory(sources, "fetch")).filter(([path]) => !path.includes("/__tests__/")));
  expect(runtimeFetches).toEqual({ "scripts/new-runtime.mjs": 3 });
});
