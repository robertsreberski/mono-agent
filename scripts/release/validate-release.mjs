#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEPENDENCY_SECTIONS,
  REPO_ROOT,
  discoverPackages,
  internalDependencies,
  publishablePackages,
  sortForPublish,
} from "./package-graph.mjs";

const TAG_RE = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

function argValue(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1] || null;
}

function rel(filePath) {
  return filePath ? path.relative(REPO_ROOT, filePath) || "." : "(unknown manifest)";
}

export function releaseVersionFromTag(tag) {
  const match = TAG_RE.exec(tag || "");
  if (!match) {
    throw new Error(`release tag must look like v1.2.3 or v1.2.3-beta.1; received ${tag || "(missing)"}`);
  }
  return match[1];
}

export function validateRelease({
  tag = process.env.GITHUB_REF_NAME,
  packages = discoverPackages(),
  silent = false,
} = {}) {
  const version = releaseVersionFromTag(tag);
  const publishable = publishablePackages(packages);
  const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const issues = [];

  if (!publishable.length) {
    issues.push("no publishable packages found");
  }

  for (const pkg of publishable) {
    // The `alias` tier is the intentionally unscoped `mono-agent` npm name; every
    // other publishable package must use the @mono-agent scope.
    if (pkg.catalogEntry.tier !== "alias" && !pkg.name?.startsWith("@mono-agent/")) {
      issues.push(`${pkg.name || rel(pkg.manifestPath)} must use the @mono-agent scope`);
    }
    if (pkg.private) {
      issues.push(`${pkg.name} must not be private`);
    }
    if (pkg.publishConfig?.access !== "public") {
      issues.push(`${pkg.name} publishConfig.access must be public`);
    }
  }

  for (const pkg of publishable) {
    if (pkg.version !== version) {
      issues.push(`${pkg.name} version must be ${version}; found ${pkg.version} in ${rel(pkg.manifestPath)}`);
    }
  }

  for (const pkg of publishable) {
    for (const dep of internalDependencies(pkg, packagesByName)) {
      if (dep.package.catalogEntry.publishable !== true) {
        issues.push(`${pkg.name} ${dep.section}.${dep.name} points at nonpublishable workspace package ${dep.name}`);
        continue;
      }

      const expectedRange = `workspace:${version}`;
      if (dep.range !== expectedRange) {
        issues.push(`${pkg.name} ${dep.section}.${dep.name} must be ${expectedRange}; found ${dep.range}`);
      }
    }
  }

  for (const pkg of packages) {
    if (pkg.catalogEntry.publishable !== true && pkg.publishConfig) {
      issues.push(`${pkg.name || rel(pkg.manifestPath)} has publishConfig but is not catalog-publishable`);
    }
  }

  const publishOrder = issues.length ? [] : sortForPublish(publishable);

  if (issues.length) {
    const error = new Error(`release validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    error.issues = issues;
    throw error;
  }

  if (!silent) {
    console.log(`Release ${tag} validates as version ${version}.`);
    console.log("Publish order:");
    for (const pkg of publishOrder) {
      console.log(`- ${pkg.name}@${pkg.version} (${pkg.relativeDir})`);
    }
    console.log(`Checked internal dependency sections: ${DEPENDENCY_SECTIONS.join(", ")}`);
  }

  return { tag, version, packages, publishablePackages: publishOrder };
}

async function main() {
  const tag = argValue("--tag") || process.env.GITHUB_REF_NAME;
  validateRelease({ tag });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
