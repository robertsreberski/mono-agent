// Explicit source inventory is a tripwire, not a JavaScript sandbox.
import { expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
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
it("enumerates guard callers and real-send construction, including tests and aliases", async () => {
  const guard = [], real = [], native = [];
  for (const path of await scripts()) {
    const source = parse(path, await readFile(join(ROOT, path), "utf8"));
    if (calls(source, "guardedLookupModels").length) guard.push(path);
    if (calls(source, "createLookupRealSend").length) real.push(path);
    if (path.startsWith("scripts/lib/") && calls(source, "nativeFetch").length) native.push(path);
  }
  expect(guard.sort()).toEqual([
    "scripts/__tests__/continuity-lookup-guard.test.mjs", "scripts/__tests__/continuity-lookup-real-capability.test.mjs",
    "scripts/__tests__/continuity-lookup-turn.test.mjs", "scripts/__tests__/fixtures/continuity-lookup-guard-smoke.mjs",
    "scripts/lib/continuity-lookup-guard.mjs", "scripts/lib/continuity-lookup-pilot-child.mjs", "scripts/lib/continuity-lookup-real-capability.mjs",
  ].sort());
  expect(real.sort()).toEqual(["scripts/__tests__/continuity-lookup-real-capability.test.mjs", "scripts/lib/continuity-lookup-pilot-probe.mjs"].sort());
  expect(native).toEqual(["scripts/lib/continuity-lookup-real-capability.mjs"]);
});
it("threads pilot through configured probe and all auxiliary helper boundaries", async () => {
  const runner = parse("runner", await readFile(join(ROOT, "scripts/lib/continuity-runner.mjs"), "utf8"));
  const functions = new Map(); visit(runner, n => { if (ts.isFunctionDeclaration(n)) functions.set(n.name?.text, n); });
  for (const name of ["buildCheckpoint", "prepareLedgerCheckpoint", "manualCompaction", "createJudge", "runProbe", "runLiveTurn"]) {
    expect(functions.get(name)?.parameters[0]?.name.elements.some(e => e.name.getText() === "pilot"), name).toBe(true);
  }
  for (const call of calls(runner, "manualCompaction")) expect(hasPilot(call.arguments[0])).toBe(true);
  const preparation = calls(runner, "runBoundaryChild").filter(c => c.arguments[0]?.getText().includes('type: "preparation"'));
  expect(preparation).toHaveLength(1); expect(hasPilot(preparation[0].arguments[0])).toBe(true);
  const probe = parse("probe", await readFile(join(ROOT, "scripts/lib/continuity-lookup-pilot-probe.mjs"), "utf8"));
  for (const name of ["buildCheckpoint", "runProbe", "createJudge"]) {
    const found = calls(probe, name); expect(found, name).toHaveLength(1); expect(hasPilot(found[0].arguments[0]), name).toBe(true);
  }
  expect(calls(runner, "openHarness").some(c => hasPilot(c.arguments[0]))).toBe(true);
  expect(functions.get("runProbe").getText()).toContain("owner: trace.owner.displayName, pilot");
});
