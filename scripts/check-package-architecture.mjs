#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  PACKAGE_CATEGORIES,
  packageByName,
  packageCatalog,
} from "./package-catalog.mjs";

const root = process.cwd();
const packageScope = "@mono-agent/";
const requiredReadmeSections = [
  "## Category",
  "## Responsibility",
  "## Install / Usage",
  "## Public API",
  "## Dependency Boundary",
  "## What This Package Does Not Own",
  "## Verification",
];

const errors = [];
const catalogByName = packageByName();
const catalogDirs = new Set(packageCatalog.map((entry) => entry.dir));
const packageDirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((packageDir) => isPackageDirectory(join(root, "packages", packageDir)) || catalogDirs.has(packageDir))
  .sort();

for (const packageDir of packageDirs) {
  if (!catalogDirs.has(packageDir)) {
    errors.push(`packages/${packageDir} is missing from scripts/package-catalog.mjs.`);
  }
}

for (const catalogEntry of packageCatalog) {
  if (!PACKAGE_CATEGORIES.includes(catalogEntry.category)) {
    errors.push(`packages/${catalogEntry.dir} has unknown category ${catalogEntry.category}.`);
  }
  for (const allowed of catalogEntry.allowedDependencyCategories) {
    if (!PACKAGE_CATEGORIES.includes(allowed)) {
      errors.push(`packages/${catalogEntry.dir} allows unknown dependency category ${allowed}.`);
    }
  }
}

for (const catalogEntry of packageCatalog) {
  const packageDir = catalogEntry.dir;
  const dir = join(root, "packages", packageDir);
  const packageJsonPath = join(dir, "package.json");
  const readmePath = join(dir, "README.md");
  if (!existsSync(packageJsonPath)) {
    errors.push(`Missing package.json for packages/${packageDir}.`);
    continue;
  }
  if (!existsSync(readmePath)) {
    errors.push(`Missing README.md for packages/${packageDir}.`);
  } else {
    const readme = readFileSync(readmePath, "utf8");
    for (const section of requiredReadmeSections) {
      if (!readme.includes(section)) {
        errors.push(`packages/${packageDir}/README.md missing section ${section}.`);
      }
    }
    if (!readme.includes(`Category: \`${catalogEntry.category}\``)) {
      errors.push(`packages/${packageDir}/README.md missing catalog category line: Category: \`${catalogEntry.category}\`.`);
    }
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageName = manifest.name;
  if (packageName !== catalogEntry.name) {
    errors.push(`packages/${packageDir}/package.json has unexpected name ${packageName}.`);
  }
  if (!packageName.startsWith(packageScope)) {
    errors.push(`packages/${packageDir}/package.json name must use the ${packageScope} scope.`);
  }
  const deps = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const depNames = Object.keys(deps);
  for (const depName of depNames) {
    if (!depName.startsWith(packageScope)) {
      continue;
    }
    const depEntry = catalogByName.get(depName);
    if (depEntry === undefined) {
      if (String(deps[depName]).startsWith("workspace:")) {
        errors.push(`packages/${packageDir} depends on uncatalogued workspace package ${depName}.`);
      }
      continue;
    }
    if (!catalogEntry.allowedDependencyCategories.includes(depEntry.category)) {
      errors.push(
        `packages/${packageDir} (${catalogEntry.category}) may not depend on ${depName} (${depEntry.category}).`,
      );
    }
    if (depEntry.category === "communication" && catalogEntry.category !== "app") {
      errors.push(`packages/${packageDir} may not depend on communication adapter ${depName}; compose adapters only in app hosts/demos.`);
    }
  }
}

const oldReferences = [
  `@mono-agent/${"config"}-${"ui"}`,
  `@mono-agent/${"telegram"}-${"bridge"}`,
  `@mono-agent/${"whatsapp"}-${"bridge"}`,
];
for (const file of ["package.json", "README.md", "pnpm-lock.yaml"]) {
  const text = readFileSync(join(root, file), "utf8");
  for (const oldReference of oldReferences) {
    if (text.includes(oldReference)) {
      errors.push(`${file} still references ${oldReference}.`);
    }
  }
}

const staleReferences = [
  `@mono-agent/${"comm"}/`,
  `${packageScope}${"sandbox"}`,
  `packages/${"sandbox"}`,
  `${"config"}-${"ui"}`,
  `${"telegram"}-${"bridge"}`,
  `${"whatsapp"}-${"bridge"}`,
];
for (const staleReference of staleReferences) {
  for (const file of walkTextFiles(root)) {
    const text = readFileSync(file, "utf8");
    if (text.includes(staleReference)) {
      errors.push(`${relative(root, file)} still references ${staleReference}.`);
    }
  }
}

const sharedContractDir = join(root, "packages", "agent-contracts");
if (existsSync(sharedContractDir)) {
  for (const file of walkTextFiles(sharedContractDir)) {
    const text = readFileSync(file, "utf8").toLowerCase();
    if (text.includes("telegram") || text.includes("whatsapp")) {
      errors.push(`${relative(root, file)} must stay adapter-neutral.`);
    }
  }
}

if (errors.length > 0) {
  console.error("Package architecture check failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Package architecture check passed for ${packageCatalog.length} workspace packages.`);

function walkTextFiles(dir) {
  const ignoredDirs = new Set([".git", ".mono-agent", ".workflow", "node_modules", "dist"]);
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(path));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!isTextFile(path)) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function isTextFile(path) {
  if (statSync(path).size > 1_000_000) {
    return false;
  }
  return /\.(?:cjs|css|html|js|json|md|mjs|ts|tsx|yaml|yml)$/u.test(path);
}

function isPackageDirectory(dir) {
  if (existsSync(join(dir, "package.json"))) {
    return true;
  }
  const ignoredPackageArtifacts = new Set(["dist", "node_modules"]);
  return readdirSync(dir).some((entry) => !ignoredPackageArtifacts.has(entry));
}
