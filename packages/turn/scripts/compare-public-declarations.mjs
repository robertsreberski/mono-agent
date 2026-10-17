import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function copyGraph(source, target, label) {
  mkdirSync(target, { recursive: true });
  cpSync(join(source, "types"), join(target, "types"), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  // Distinct package IDs prevent TypeScript from redirecting one snapshot to the other.
  manifest.name = `@declaration-comparison/${label}`;
  writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
  symlinkSync(join(root, "packages/turn/node_modules"), join(target, "node_modules"), "dir");
  return manifest;
}

function readonly(symbol) {
  return Boolean(ts.getCheckFlags(symbol) & ts.CheckFlags.Readonly)
    || Boolean(symbol.declarations?.some((node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)));
}

/** Compare emitted declaration graphs, including guarantees structural assignment ignores. */
export function compareGraphs(baseline, candidate, entries) {
  const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true };
  const roots = entries.flatMap(({ types }) => [join(baseline, types), join(candidate, types)]);
  const program = ts.createProgram(roots, options), checker = program.getTypeChecker();
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (file) => file, getNewLine: () => "\n",
  }));
  const rows = [];
  for (const { key, types } of entries) {
    const errors = [], visited = new Set();
    const fail = (path, message) => errors.push(`${path}: ${message}`);
    const symbolType = (symbol) => checker.getTypeOfSymbolAtLocation(symbol,
      symbol.valueDeclaration ?? symbol.declarations?.[0] ?? program.getSourceFile(roots[0]));
    const unalias = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const documentation = (before, after, path) => {
      const normalize = (value) => value.replace(/\r\n?/gu, "\n").trim().split(/\n[ \t]*\n/gu)
        .map((paragraph) => paragraph.split("\n").map((line) => line.trim().replace(/[ \t]+/gu, " ")).reduce((text, line) =>
          `${text}${text ? /^(?:[-+*]|\d+[.)])\s/u.test(line) ? "\n" : " " : ""}${line}`, "")).join("\n\n");
      const previous = normalize(ts.displayPartsToString(before.getDocumentationComment(checker)));
      const current = normalize(ts.displayPartsToString(after.getDocumentationComment(checker)));
      if (previous && previous !== current) fail(path, current ? "changed documentation" : "lost documentation");
      const tags = (symbol) => symbol.getJsDocTags(checker).map(({ name, text }) => ({ name,
        text: normalize(typeof text === "string" ? text : ts.displayPartsToString(text)) }));
      const previousTags = tags(before), currentTags = tags(after);
      if (previousTags.length && JSON.stringify(previousTags) !== JSON.stringify(currentTags)) {
        fail(path, currentTags.length ? "changed documentation tags" : "lost documentation tags");
      }
    };
    const text = (type) => checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation)
      .replaceAll(baseline, "<snapshot>").replaceAll(candidate, "<snapshot>");
    function signatures(left, right, kind, path) {
      const before = checker.getSignaturesOfType(left, kind), after = checker.getSignaturesOfType(right, kind);
      if (after.length < before.length) fail(path, "removed overload");
      for (let index = 0; index < Math.min(before.length, after.length); index += 1) {
        const a = before[index], b = after[index], label = `${path}.signature[${index}]`;
        documentation(a, b, label);
        if (b.minArgumentCount > a.minArgumentCount) fail(label, "new required parameter");
        if (b.parameters.length < a.parameters.length) fail(label, "removed parameter");
        if ((a.typeParameters?.length ?? 0) !== (b.typeParameters?.length ?? 0)) fail(label, "changed generic arity");
        for (let n = 0; n < Math.min(a.typeParameters?.length ?? 0, b.typeParameters?.length ?? 0); n += 1) {
          walk(a.typeParameters[n], b.typeParameters[n], `${label}.generic[${n}]`, "input");
        }
        for (let n = 0; n < Math.min(a.parameters.length, b.parameters.length); n += 1) {
          walk(symbolType(a.parameters[n]), symbolType(b.parameters[n]), `${label}.parameter[${n}]`, "input");
        }
        walk(checker.getReturnTypeOfSignature(a), checker.getReturnTypeOfSignature(b), `${label}.return`, "output");
      }
    }
    function walk(left, right, path, mode = "output") {
      if (left === right) return; // Shared external declarations have identical ownership and guarantees.
      const kind = (type) => type.aliasSymbol?.flags & ts.SymbolFlags.TypeAlias ? "alias"
        : type.symbol?.flags & ts.SymbolFlags.Interface ? "interface" : undefined;
      if (kind(left) && kind(right) && kind(left) !== kind(right)) fail(path, "changed alias/interface declaration kind");
      // Shared generic declarations (Promise, Array, SDK containers) cannot have
      // changed here. Check every instantiation's arguments, not library methods
      // that recursively manufacture fresh instantiations of themselves.
      if (left.objectFlags & ts.ObjectFlags.Reference && right.objectFlags & ts.ObjectFlags.Reference
        && left.target && left.target === right.target) {
        const a = checker.getTypeArguments(left), b = checker.getTypeArguments(right);
        if (a.length !== b.length) fail(path, "changed reference type arity");
        else for (let index = 0; index < a.length; index += 1) walk(a[index], b[index], `${path}.argument[${index}]`, mode);
        return;
      }
      const aArgs = left.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(left) : [];
      const bArgs = right.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(right) : [];
      if (aArgs.length !== bArgs.length) fail(path, "changed reference type arity");
      else for (let n = 0; n < aArgs.length; n += 1) walk(aArgs[n], bArgs[n], `${path}.argument[${n}]`, mode);
      // Compare recursive declaration targets once, but each reference's actual
      // type arguments above remain checked even after another instantiation.
      const pair = `${left.objectFlags & ts.ObjectFlags.Reference ? left.target.id : left.id}:${right.objectFlags & ts.ObjectFlags.Reference ? right.target.id : right.id}:${mode}`;
      if (visited.has(pair)) return;
      visited.add(pair);
      const aAliases = left.aliasTypeArguments ?? [], bAliases = right.aliasTypeArguments ?? [];
      if (aAliases.length === bAliases.length) {
        for (let n = 0; n < aAliases.length; n += 1) walk(aAliases[n], bAliases[n], `${path}.aliasArgument[${n}]`, mode);
      }
      if (right.flags & ts.TypeFlags.Any) {
        if (!(left.flags & ts.TypeFlags.Any)) fail(path, "introduced any");
        return;
      }
      if (left.flags & ts.TypeFlags.Any) {
        fail(path, "changed baseline any");
        return;
      }
      if (left.flags & ts.TypeFlags.TypeParameter || right.flags & ts.TypeFlags.TypeParameter) {
        if (!(left.flags & ts.TypeFlags.TypeParameter) || !(right.flags & ts.TypeFlags.TypeParameter)) {
          fail(path, "changed generic parameter"); return;
        }
        const a = checker.getBaseConstraintOfType(left), b = checker.getBaseConstraintOfType(right);
        if (Boolean(a) !== Boolean(b)) fail(path, "changed generic constraint");
        else if (a && b) walk(a, b, `${path}.constraint`, mode);
        const ad = left.getDefault?.(), bd = right.getDefault?.();
        if (Boolean(ad) !== Boolean(bd)) fail(path, "changed generic default");
        else if (ad && bd) walk(ad, bd, `${path}.default`, mode);
        return;
      }
      if (left.isUnion() || right.isUnion()) {
        const before = left.isUnion() ? left.types : [left], after = right.isUnion() ? right.types : [right];
        for (const type of after) {
          const match = before.find((other) => text(other) === text(type))
            ?? before.find((other) => checker.isTypeAssignableTo(type, other));
          if (!match) fail(path, `widened union with ${text(type)}`);
          else walk(match, type, `${path}.union(${text(type)})`, mode);
        }
        if (mode === "input" && before.some((type) => !after.some((other) => checker.isTypeAssignableTo(type, other)))) {
          fail(path, "no longer accepts baseline input union");
        }
        return;
      }
      const structural = ts.TypeFlags.Object | ts.TypeFlags.Intersection;
      const leftObject = Boolean(left.flags & structural), rightObject = Boolean(right.flags & structural);
      if (!leftObject || !rightObject) {
        if (!checker.isTypeAssignableTo(right, left)) fail(path, `widened ${text(left)} to ${text(right)}`);
        if (mode === "input" && !checker.isTypeAssignableTo(left, right)) fail(path, "no longer accepts baseline input");
        return;
      }
      const ro = (type) => type.target?.readonly || type.symbol?.name === "ReadonlyArray";
      if (ro(left) && !ro(right)) fail(path, "lost readonly array/tuple");
      const before = checker.getPropertiesOfType(left), after = new Map(checker.getPropertiesOfType(right).map((symbol) => [symbol.name, symbol]));
      for (const a of before) {
        const b = after.get(a.name), label = `${path}.${a.name}`;
        if (!b) { fail(label, "removed member"); continue; }
        if (!(a.flags & ts.SymbolFlags.Optional) && b.flags & ts.SymbolFlags.Optional) fail(label, "required became optional");
        if (a.flags & ts.SymbolFlags.Optional && !(b.flags & ts.SymbolFlags.Optional)) fail(label, "optional became required");
        if (readonly(a) && !readonly(b)) fail(label, "lost readonly");
        documentation(a, b, label);
        walk(symbolType(a), symbolType(b), label, mode);
      }
      if (mode === "input") for (const b of after.values()) {
        if (!before.some((a) => a.name === b.name) && !(b.flags & ts.SymbolFlags.Optional)) fail(`${path}.${b.name}`, "new required input member");
      }
      const aIndexes = checker.getIndexInfosOfType(left), bIndexes = checker.getIndexInfosOfType(right);
      for (const a of aIndexes) {
        const b = bIndexes.find((index) => text(index.keyType) === text(a.keyType));
        if (!b) { fail(path, "removed index signature"); continue; }
        if (a.isReadonly && !b.isReadonly) fail(path, "lost readonly index signature");
        walk(a.type, b.type, `${path}.index`, mode);
      }
      signatures(left, right, ts.SignatureKind.Call, path);
      signatures(left, right, ts.SignatureKind.Construct, `${path}.constructor`);
    }
    const module = (directory) => checker.getSymbolAtLocation(program.getSourceFile(join(directory, types)));
    const before = checker.getExportsOfModule(module(baseline)), after = new Map(checker.getExportsOfModule(module(candidate)).map((symbol) => [symbol.name, symbol]));
    for (const symbol of before) {
      const candidateSymbol = after.get(symbol.name);
      if (!candidateSymbol) { fail(symbol.name, "removed export"); continue; }
      const a = unalias(symbol), b = unalias(candidateSymbol);
      documentation(a, b, symbol.name);
      if (Boolean(a.flags & ts.SymbolFlags.TypeAlias) !== Boolean(b.flags & ts.SymbolFlags.TypeAlias)
        && (a.flags | b.flags) & ts.SymbolFlags.Interface) fail(symbol.name, "changed alias/interface declaration kind");
      if (a.flags & ts.SymbolFlags.Type) {
        if (!(b.flags & ts.SymbolFlags.Type)) fail(symbol.name, "removed type export");
        else walk(checker.getDeclaredTypeOfSymbol(a), checker.getDeclaredTypeOfSymbol(b), symbol.name);
      }
      if (a.flags & ts.SymbolFlags.Value) {
        if (!(b.flags & ts.SymbolFlags.Value)) fail(symbol.name, "removed value export");
        else walk(symbolType(a), symbolType(b), symbol.name);
      }
    }
    rows.push({ entry: key, exports: before.length, errors });
  }
  return rows;
}

export function compareRevision(revision = "origin/main") {
  const oid = execFileSync("git", ["rev-parse", `${revision}^{commit}`], { cwd: root, encoding: "utf8" }).trim();
  const cache = join(root, ".worklab-tmp/turn-declaration-comparison");
  mkdirSync(cache, { recursive: true });
  const scratch = mkdtempSync(join(cache, "comparison-"));
  const archived = join(scratch, "archive");
  mkdirSync(archived);
  const archive = execFileSync("git", ["archive", oid, "packages/turn", "tsconfig.base.json"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", archived], { cwd: root, input: archive });
  const turn = join(archived, "packages/turn");
  // A baseline build must not share the candidate's staged-product ownership journal.
  mkdirSync(join(turn, "node_modules"));
  for (const entry of readdirSync(join(root, "packages/turn/node_modules"))) {
    if (entry !== ".cache") symlinkSync(join(root, "packages/turn/node_modules", entry), join(turn, "node_modules", entry), "dir");
  }
  const manifest = JSON.parse(readFileSync(join(turn, "package.json"), "utf8"));
  const result = spawnSync("pnpm", ["run", "build"], { cwd: turn, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Baseline build failed:\n${result.stdout}\n${result.stderr}`);
  copyGraph(turn, join(scratch, "baseline"), "baseline");
  copyGraph(join(root, "packages/turn"), join(scratch, "candidate"), "candidate");
  const entries = Object.entries(manifest.exports).map(([key, target]) => ({ key, types: target.types }));
  const rows = compareGraphs(join(scratch, "baseline"), join(scratch, "candidate"), entries);
  const report = { baseline: oid, candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), rows };
  writeFileSync(join(cache, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const row of rows) console.log(`${row.errors.length ? "FAIL" : "PASS"} ${row.entry}: ${row.exports} exports; ${row.errors.length} regressions`);
  console.log(`baseline ${oid}; candidate ${report.candidate} (working tree); report ${join(cache, "latest.json")}`);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = compareRevision(process.argv[2]);
  process.exitCode = report.rows.some((row) => row.errors.length) ? 1 : 0;
}
