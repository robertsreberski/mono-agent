import fs from "node:fs";
import path from "node:path";

import { DEPENDENCY_SECTIONS } from "./package-graph.mjs";

export const PINNED_RUNTIME_DEPENDENCIES = Object.freeze({
  "@earendil-works/pi-agent-core": "1.2.0",
  "@earendil-works/pi-ai": "1.2.0",
});

export function releaseDependencyPinIssues(packages) {
  const issues = [];
  for (const pkg of packages) {
    for (const { section, name, range } of pinnedDependencyReferences(pkg.packageJson)) {
      if (section !== "devDependencies" && pkg.name !== "@mono-agent/turn") {
        issues.push(`${pkg.name} ${section}.${name} must be owned by @mono-agent/turn; test-only Pi dependencies belong in devDependencies`);
      }
      const expected = PINNED_RUNTIME_DEPENDENCIES[name];
      if (range !== expected) {
        issues.push(
          `${pkg.name} ${section}.${name} must pin known-compatible version ${expected} exactly; found ${range}`,
        );
      }
    }
  }
  return issues;
}

export function assertPackedDependencyResolution(consumerDir, packages, options = {}) {
  const readJson = options.readJson ?? readJsonFile;
  const resolveManifestFrom = options.resolveManifestFrom
    ?? ((name, fromManifestPath, reader) =>
      findInstalledPackageManifest(name, fromManifestPath, consumerDir, reader));
  const checked = new Set();

  for (const pkg of packages) {
    const installedManifestPath = installedPackageManifestPath(consumerDir, pkg.name);
    const installedManifest = readJson(installedManifestPath);
    const expectedReferences = pinnedDependencyReferences(pkg.packageJson ?? installedManifest);
    for (const { section, name } of expectedReferences) {
      const expected = PINNED_RUNTIME_DEPENDENCIES[name];
      const range = installedManifest[section]?.[name];
      if (range !== expected) {
        throw new Error(
          `Packed ${pkg.name} ${section}.${name} must remain ${expected}; found ${range ?? "(missing)"}`,
        );
      }
      // Packed development-only fixtures keep their exact pin, but are not
      // installed or resolved as part of the consumer runtime closure.
      if (section === "devDependencies") continue;
      assertResolvedVersion({
        checked,
        expected,
        fromManifestPath: installedManifestPath,
        name,
        owner: pkg.name,
        readJson,
        resolveManifestFrom,
      });
    }
  }
}

function assertResolvedVersion({
  checked,
  expected,
  fromManifestPath,
  name,
  owner,
  readJson,
  resolveManifestFrom,
}) {
  const checkKey = `${fromManifestPath}\0${name}`;
  if (checked.has(checkKey)) return;
  checked.add(checkKey);

  const resolvedManifestPath = resolveManifestFrom(name, fromManifestPath, readJson);
  const resolvedManifest = readJson(resolvedManifestPath);
  if (resolvedManifest.version !== expected) {
    throw new Error(
      `Packed consumer resolved ${name}@${resolvedManifest.version ?? "(missing)"} from ${owner}; expected ${expected}`,
    );
  }

  // pi-agent-core declares pi-ai with a floating compatible-minor range while
  // turn owns Core and an exact known-compatible Pi AI copy. Verify resolution
  // from Core too so a host package or later Pi patch cannot silently rewire it.
  if (name === "@earendil-works/pi-agent-core") {
    const piAi = "@earendil-works/pi-ai";
    assertResolvedVersion({
      checked,
      expected: PINNED_RUNTIME_DEPENDENCIES[name],
      fromManifestPath: resolvedManifestPath,
      name: piAi,
      owner: `${name}@${resolvedManifest.version}`,
      readJson,
      resolveManifestFrom,
    });
  }
}

function pinnedDependencyReferences(packageJson) {
  const references = [];
  for (const section of [...DEPENDENCY_SECTIONS, "devDependencies"]) {
    for (const [name, range] of Object.entries(packageJson[section] ?? {})) {
      if (Object.hasOwn(PINNED_RUNTIME_DEPENDENCIES, name)) {
        references.push({ section, name, range });
      }
    }
  }
  return references;
}

function installedPackageManifestPath(consumerDir, name) {
  return path.join(consumerDir, "node_modules", ...name.split("/"), "package.json");
}

function findInstalledPackageManifest(name, fromManifestPath, consumerDir, readJson) {
  const consumerRoot = path.resolve(consumerDir);
  let directory = path.dirname(fromManifestPath);
  if (directory !== consumerRoot && !directory.startsWith(`${consumerRoot}${path.sep}`)) {
    throw new Error(`Refusing to resolve ${name} outside packed consumer ${consumerRoot}`);
  }
  for (;;) {
    const candidate = path.join(directory, "node_modules", ...name.split("/"), "package.json");
    try {
      if (readJson(candidate).name === name) return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    if (directory === consumerRoot) break;
    directory = path.dirname(directory);
  }
  throw new Error(`Could not resolve installed ${name} from ${fromManifestPath}`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
