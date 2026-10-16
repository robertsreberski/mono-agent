import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packages = ["contracts", "config", "turn", "conversation", "app"];
export const root = fileURLToPath(new URL("../../", import.meta.url));
export const outputDirectory = resolve(root, "node_modules/.cache/core-scans");

export function summarize(report, packageName) {
  const prefix = `packages/${packageName}/`;
  const issues = report.issues.filter((issue) => issue.file.startsWith(prefix));
  return {
    files: report.files.filter((file) => file.startsWith(prefix)).length,
    exports: issues.reduce((count, issue) => count + issue.exports.length, 0),
    types: issues.reduce((count, issue) => count + issue.types.length, 0),
    other: issues.reduce((count, issue) => count + Object.entries(issue)
      .filter(([key, value]) => !["file", "exports", "types"].includes(key) && Array.isArray(value))
      .reduce((sum, [, value]) => sum + value.length, 0), 0),
  };
}

export function scanArguments(kind) {
  if (kind === "dead-code") {
    return [
      ["default", []],
      ["production", ["--production"]],
      ["entry-exports", ["--include-entry-exports"]],
    ].map(([mode, flags]) => ({
      name: `knip-${mode}`,
      args: ["exec", "knip", "--directory", root,
        "--config", "scripts/core-scans/knip.ts",
        ...packages.flatMap((name) => ["--workspace", `packages/${name}`]),
        "--reporter", "json", ...flags],
    }));
  }
  if (kind === "cycles") {
    return packages.map((name) => ({
      name: `madge-${name}`,
      args: ["dlx", "madge@8.0.0", "--circular", "--json",
        "--extensions", "ts,js,mjs,mts", "--exclude", "__tests__",
        `packages/${name}/src`],
    }));
  }
  throw new Error("Usage: node scripts/core-scans/run.mjs <all|dead-code|cycles>");
}

// Findings are a non-zero result, not a launcher failure. Always finish every
// mode/package; never make a red baseline look green with --no-exit-code.
export function run(kind, { execute = spawnSync, directory = outputDirectory } = {}) {
  if (kind === "all") {
    return Math.max(run("dead-code", { execute, directory }), run("cycles", { execute, directory }));
  }
  const scans = scanArguments(kind);
  mkdirSync(directory, { recursive: true });
  let findings = false;
  let errors = false;
  for (const scan of scans) {
    console.log(`\n== ${scan.name}`);
    const result = execute("pnpm", scan.args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(resolve(directory, `${scan.name}.stderr.txt`), result.stderr ?? "");
    try {
      if (result.error || result.signal || ![0, 1].includes(result.status)) {
        throw result.error ?? new Error(`Tool exited ${result.status ?? result.signal}`);
      }
      const report = JSON.parse(result.stdout);
      if (kind === "dead-code") {
        if (!Array.isArray(report.files) || !Array.isArray(report.issues)) throw new Error("Invalid Knip report");
        // Workspace selectors retain other packages only as consumers. Assert
        // that neither their findings nor root tooling leak into this report.
        const isCore = (file) => packages.some((name) => file.startsWith(`packages/${name}/`));
        if (report.files.some((file) => !isCore(file)) || report.issues.some((issue) => !isCore(issue.file))) {
          throw new Error("Knip returned findings outside the five core packages");
        }
        for (const name of packages) console.log(`${name}: ${JSON.stringify(summarize(report, name))}`);
      } else {
        if (!Array.isArray(report) || report.some((cycle) => !Array.isArray(cycle))) throw new Error("Invalid Madge report");
        console.log(`${report.length} cycle(s)`);
        for (const cycle of report) console.log(`  ${cycle.join(" > ")}`);
      }
      writeFileSync(resolve(directory, `${scan.name}.json`), `${JSON.stringify(report, null, 2)}\n`);
      findings ||= result.status === 1;
    } catch (error) {
      errors = true;
      console.error(`${scan.name}: ${error.message}`);
      console.error(result.stderr || "No tool diagnostics; see the command above.");
      // Do not leave a previous successful report masquerading as this run.
      writeFileSync(resolve(directory, `${scan.name}.json`), `${JSON.stringify({ error: error.message })}\n`);
    }
  }
  console.log("\nReports: node_modules/.cache/core-scans/");
  return errors ? 2 : findings ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv[2]);
}
