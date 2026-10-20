import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Exact, directed exceptions. Declarations can collaborate without creating a
// JavaScript initialization cycle; neither new cycles nor stale entries pass.
export const cycleExceptions = [{
  scan: "madge-app",
  cycle: ["packages/web/dist/console-tools.d.ts", "packages/web/dist/store.d.ts"],
  classification: "erased",
  edges: [
    { from: "packages/web/src/console-tools.ts", to: "packages/web/src/store.ts", kind: "type-only" },
    { from: "packages/web/src/store.ts", to: "packages/web/src/console-tools.ts", kind: "runtime" },
  ],
  reason: "Console operations use the WebStore type; the store invokes the operations. The reverse import is erased from JavaScript, so there is no runtime initialization cycle. Keep the concrete store contract rather than introducing a broad forwarding port solely for declaration traversal.",
}];

const cycleKey = (cycle) => cycle.map((_, index) => JSON.stringify([...cycle.slice(index), ...cycle.slice(0, index)])).sort()[0];

// Traverse emitted relative JS edges, including export-from and literal dynamic
// imports (preProcessFile also recognizes require). Source import kinds alone
// cannot prove erasure: a new indirect runtime path must invalidate the waiver.
function assertErasedRuntimePath(entry, directory) {
  if (entry.classification !== "erased") return;
  const [from, to] = entry.cycle.map((file) => resolve(directory, file.replace(/\.d\.([cm]?)ts$/u, ".$1js")));
  const seen = new Set();
  function visit(file, trail) {
    if (file === to) throw new Error(`Erased cycle has an emitted runtime path: ${[...trail, file].join(" > ")}`);
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8"); // Missing emit is not proof of erasure.
    for (const { fileName } of ts.preProcessFile(source, true, true).importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), fileName);
      if (/\.[cm]?js$/u.test(target)) visit(target, [...trail, file]);
    }
  }
  readFileSync(to, "utf8");
  visit(from, []);
}

export function classifyCycles(scan, cycles, exceptions = cycleExceptions, directory = fileURLToPath(new URL("../../", import.meta.url))) {
  const packageName = /^madge-(contracts|config|turn|conversation|app)$/u.exec(scan)?.[1];
  if (!packageName) throw new Error(`Unknown cycle scan: ${scan}`);
  const expected = exceptions.filter((entry) => entry.scan === scan);
  const keys = expected.map((entry) => cycleKey(entry.cycle));
  if (new Set(keys).size !== keys.length) throw new Error(`Duplicate cycle policy entry: ${scan}`);
  const seen = new Set(), matched = [], unexpected = [];
  for (const cycle of cycles) {
    if (!Array.isArray(cycle) || cycle.length === 0 || cycle.some((file) => typeof file !== "string" || !file)) {
      throw new Error("Invalid Madge cycle");
    }
    const normalized = cycle.map((file) => {
      const path = posix.normalize(`packages/${packageName}/src/${file.replaceAll("\\", "/")}`);
      if (!path.startsWith("packages/")) throw new Error(`Cycle path outside packages: ${file}`);
      return path;
    });
    const key = cycleKey(normalized), index = keys.indexOf(key);
    if (index === -1) unexpected.push(normalized);
    else { seen.add(key); matched.push({ ...expected[index], reported: cycle }); }
  }
  for (const entry of matched) assertErasedRuntimePath(entry, directory);
  const stale = expected.filter((_, index) => !seen.has(keys[index]));
  return { matched, unexpected, stale };
}
