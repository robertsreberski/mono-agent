#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const requiredReadmeSections = [
  "## Responsibility",
  "## Install / Usage",
  "## Public API",
  "## Dependency Boundary",
  "## What This Package Does Not Own",
  "## Verification",
];

const packages = [
  "agent-harness",
  "config",
  "context",
  "memory-md",
  "observability",
  "operator-console",
  "runtime-adapter",
  "settings",
  "skills",
  "telegram-adapter",
  "tool-policy",
  "tui",
  "whatsapp-adapter",
];

const errors = [];

for (const packageDir of packages) {
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
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageName = manifest.name;
  if (packageName !== `@worklab-ai/${packageDir}`) {
    errors.push(`packages/${packageDir}/package.json has unexpected name ${packageName}.`);
  }
  const deps = {
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const depNames = Object.keys(deps);
  if (packageDir.endsWith("-adapter")) {
    const forbidden = depNames.filter((dep) =>
      dep === "@worklab-ai/agent-harness" ||
      dep === "@worklab-ai/operator-console" ||
      (dep.startsWith("@worklab-ai/") && dep.endsWith("-adapter") && dep !== "@worklab-ai/runtime-adapter"),
    );
    if (forbidden.length > 0) {
      errors.push(`packages/${packageDir} has forbidden adapter dependency: ${forbidden.join(", ")}.`);
    }
  }
  if (packageDir === "operator-console") {
    const forbidden = depNames.filter((dep) =>
      dep === "@worklab-ai/config" ||
      dep === "@worklab-ai/agent-harness" ||
      (dep.endsWith("-adapter") && dep !== "@worklab-ai/runtime-adapter"),
    );
    if (forbidden.length > 0) {
      errors.push(`packages/operator-console has forbidden dependency: ${forbidden.join(", ")}.`);
    }
  }
  if (packageDir === "config") {
    const forbidden = depNames.filter((dep) =>
      dep === "@worklab-ai/operator-console" ||
      (dep.endsWith("-adapter") && dep !== "@worklab-ai/runtime-adapter"),
    );
    if (forbidden.length > 0) {
      errors.push(`packages/config has forbidden dependency: ${forbidden.join(", ")}.`);
    }
  }
}

const oldReferences = [
  `@worklab-ai/${"config"}-${"ui"}`,
  `@worklab-ai/${"telegram"}-${"bridge"}`,
  `@worklab-ai/${"whatsapp"}-${"bridge"}`,
];
for (const file of ["package.json", "README.md", "pnpm-lock.yaml"]) {
  const text = readFileSync(join(root, file), "utf8");
  for (const oldReference of oldReferences) {
    if (text.includes(oldReference)) {
      errors.push(`${file} still references ${oldReference}.`);
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

console.log(`Package architecture check passed for ${packages.length} workspace packages.`);
