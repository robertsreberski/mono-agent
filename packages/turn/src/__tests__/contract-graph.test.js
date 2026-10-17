import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "__tests__") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:js|mjs|ts)$/u.test(path) ? [path] : [];
  });
}

function sourceTarget(target) {
  const source = target.replace(/^\.\/(?:dist|types)\//u, "./src/").replace(/\.d\.ts$/u, ".js");
  const absolute = resolve(root, source);
  if (existsSync(absolute)) return absolute;
  const typed = absolute.replace(/\.js$/u, ".ts");
  if (existsSync(typed)) return typed;
  throw new Error(`Unresolved local contract target: ${source}`);
}

function dependency(file, specifier) {
  if (specifier.startsWith(".")) {
    const absolute = resolve(dirname(file), specifier);
    if (existsSync(absolute)) return absolute;
    const typed = absolute.replace(/\.js$/u, ".ts");
    if (existsSync(typed)) return typed;
    // Runtime asset URLs are not import edges; a literal import must resolve.
    throw new Error(`Unresolved local import ${relative(root, file)} -> ${specifier}`);
  }
  if (specifier.startsWith("#")) {
    const entry = manifest.imports[specifier];
    if (!entry) throw new Error(`Unmapped private import ${specifier}`);
    return sourceTarget(entry.default);
  }
  const prefix = "@mono-agent/turn";
  if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
    const key = specifier === prefix ? "." : `.${specifier.slice(prefix.length)}`;
    const entry = manifest.exports[key];
    if (!entry) throw new Error(`Unexported self import ${specifier}`);
    return sourceTarget(entry.default);
  }
  return undefined;
}

it("resolves turn-local runtime and erased contract edges without cycles or host facade back edges", () => {
  const graph = new Map();
  for (const file of sources(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    const imports = new Set([
      ...ts.preProcessFile(text).importedFiles.map((entry) => entry.fileName),
      // TypeScript's preprocessor omits JSDoc import types. Include those too.
      ...[...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1]),
    ]);
    const targets = [...imports].map((specifier) => dependency(file, specifier)).filter(Boolean);
    if (file.includes(`${join("src", "host")}/`) && !file.endsWith("/types.ts")) {
      expect(targets, relative(root, file)).not.toContain(join(root, "src/host/types.ts"));
    }
    graph.set(file, targets.filter((target) => [".js", ".ts", ".mjs"].includes(extname(target))));
  }
  const visited = new Set(), active = [];
  function visit(file) {
    if (active.includes(file)) throw new Error(`Turn dependency cycle: ${[...active.slice(active.indexOf(file)), file].map((path) => relative(root, path)).join(" -> ")}`);
    if (visited.has(file)) return;
    active.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.pop();
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
});
