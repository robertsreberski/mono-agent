#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runDependencyVulnerabilityCheck } from "./check-dependency-vulnerabilities.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The browser app deliberately owns an isolated lockfile, while its compiled
// assets ship inside @mono-agent/web. Audit that production graph with the same
// fail-closed evaluator as the publishable workspace graph.
const result = await runDependencyVulnerabilityCheck({
  cwd: resolve(repoRoot, "packages/web/webapp"),
  rootPackageNames: ["mono-agent-web-console"],
  dispositionsPath: resolve(
    repoRoot,
    "scripts/webapp-dependency-vulnerability-dispositions.json",
  ),
});

process.exitCode = result.exitCode;
