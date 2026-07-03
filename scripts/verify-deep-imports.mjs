#!/usr/bin/env node
// Verifies that every subpath declared in @mono-agent/agent-runtime's `exports`
// map actually resolves and loads. Phase 6 replaced the package's `./ai/*` /
// `./agent/*` wildcard exports with an EXPLICIT map (root, ./ai, ./agent, plus a
// fixed set of deep `.js` subpaths). A wildcard silently resolved anything under
// src/; the explicit map does not, so a mistyped key or a moved/renamed module
// would break a documented deep import with no other signal. This script is that
// signal: it reads the exports keys straight from package.json (single source of
// truth) and `import()`s each mapped specifier via Node's real package
// resolution, failing loudly on the first specifier that does not load.
//
// Runs standalone (`node scripts/verify-deep-imports.mjs`, part of the phase
// gate) and under vitest (scripts/__tests__/verify-deep-imports.test.mjs), which
// injects a fake `importFn` to exercise the failure path deterministically.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "@mono-agent/agent-runtime";

function packageJsonUrl(repoRoot) {
  return pathToFileURL(join(repoRoot, "packages", "agent-runtime", "package.json")).href;
}

/**
 * Default import step: resolve each bare specifier through Node's exports
 * resolution (createRequire anchored at agent-runtime's OWN package.json, so the
 * package self-references its own name — this works whether or not the workspace
 * root has an `@mono-agent/agent-runtime` symlink, e.g. inside a git worktree),
 * then actually load the resolved module. Resolution exercises the exports map;
 * the import proves the target loads.
 */
function realImporter(repoRoot) {
  const require = createRequire(packageJsonUrl(repoRoot));
  return async (specifier) => {
    const resolved = require.resolve(specifier);
    return import(pathToFileURL(resolved).href);
  };
}

/**
 * Map an `exports` key to the bare specifier a consumer imports.
 *   "."      -> "@mono-agent/agent-runtime"
 *   "./ai"   -> "@mono-agent/agent-runtime/ai"
 *   "./x.js" -> "@mono-agent/agent-runtime/x.js"
 */
function specifierForExportKey(key) {
  if (key === ".") return PACKAGE_NAME;
  return `${PACKAGE_NAME}${key.slice(1)}`;
}

/**
 * Read the mapped subpath specifiers from agent-runtime's package.json exports.
 * Wildcard keys (should be none after Phase 6) are skipped defensively.
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function mappedSpecifiers(repoRoot) {
  const manifestPath = join(repoRoot, "packages", "agent-runtime", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exportsMap = manifest.exports || {};
  return Object.keys(exportsMap)
    .filter((key) => !key.includes("*"))
    .map(specifierForExportKey);
}

function sink() {
  const lines = [];
  return { write: (text) => lines.push(text), get text() { return lines.join(""); } };
}

/**
 * @param {Object} [options]
 * @param {string} [options.repoRoot] Repo root holding packages/agent-runtime.
 * @param {(specifier: string) => Promise<unknown>} [options.importFn] Injectable for tests.
 * @param {{write: (text: string) => void}} [options.stdout]
 * @param {{write: (text: string) => void}} [options.stderr]
 * @returns {Promise<{exitCode: number, results: Array<{specifier: string, ok: boolean, error?: string}>}>}
 */
export async function runVerifyDeepImports({
  repoRoot = defaultRepoRoot(),
  importFn = realImporter(repoRoot),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let specifiers;
  try {
    specifiers = mappedSpecifiers(repoRoot);
  } catch (err) {
    stderr.write(`FAIL could not read agent-runtime exports map: ${err?.message || String(err)}\n`);
    return { exitCode: 1, results: [] };
  }

  const results = [];
  for (const specifier of specifiers) {
    try {
      await importFn(specifier);
      results.push({ specifier, ok: true });
      stdout.write(`PASS ${specifier}\n`);
    } catch (err) {
      const message = err?.message || String(err);
      results.push({ specifier, ok: false, error: message });
      stdout.write(`FAIL ${specifier}: ${message}\n`);
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (failures.length > 0) {
    stdout.write(`deep-imports fail (${failures.length}/${results.length} unresolved)\n`);
    return { exitCode: 1, results };
  }
  stdout.write(`deep-imports ok (${results.length} mapped subpaths resolve)\n`);
  return { exitCode: 0, results };
}

function defaultRepoRoot() {
  // scripts/verify-deep-imports.mjs -> repo root is the parent of scripts/.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  runVerifyDeepImports()
    .then(({ exitCode }) => { process.exitCode = exitCode; })
    .catch((err) => {
      const out = sink();
      out.write(String(err?.stack || err));
      process.stderr.write(out.text + "\n");
      process.exitCode = 1;
    });
}
