import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parsePackedSmokeArgs,
  publicExportSpecifiers,
} from "./public-exports.mjs";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const { target } = parsePackedSmokeArgs(process.argv.slice(2));
const dependencyNames = Object.keys(manifest.dependencies ?? {}).sort();
if (target !== null && !dependencyNames.includes(target)) {
  throw new Error(`Packed smoke target ${target} is not installed as a direct consumer dependency.`);
}
const packageNames = target === null ? dependencyNames : [target];
const packageManifests = new Map();
for (const name of packageNames) {
  packageManifests.set(name, await readInstalledManifest(name));
}
const importSpecifiers = packageNames.flatMap((name) =>
  publicExportSpecifiers(name, packageManifests.get(name)));

for (const specifier of importSpecifiers) {
  if (specifier.endsWith("/package.json")) {
    await import(specifier, { with: { type: "json" } });
  } else {
    await import(specifier);
  }
}

const cliSmokes = [
  { packageName: "@mono-agent/agent-app", binName: "mono-agent", args: ["--help"], statuses: [0] },
  { packageName: "@mono-agent/tui", binName: "mono-agent-tui", args: ["--help"], statuses: [0] },
  { packageName: "create-mono-agent", binName: "create-mono-agent", args: ["--help"], statuses: [0] },
];
const selectedCliSmokes = cliSmokes.filter((entry) => packageNames.includes(entry.packageName));
for (const entry of selectedCliSmokes) {
  const packageJson = packageManifests.get(entry.packageName);
  const relativeCli = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.[entry.binName];
  if (typeof relativeCli !== "string") {
    throw new Error(`Packed ${entry.packageName} is missing bin ${entry.binName}.`);
  }
  const cli = join(installedPackageDirectory(entry.packageName), relativeCli);
  const { status, stderr } = await runNodeCli(cli, entry.args);
  if (!entry.statuses.includes(status)) {
    throw new Error(`${cli} ${entry.args.join(" ")} exited ${status}: ${stderr}`);
  }
  if (entry.stderrIncludes !== undefined && !stderr.includes(entry.stderrIncludes)) {
    throw new Error(
      `${cli} ${entry.args.join(" ")} stderr must contain ${JSON.stringify(entry.stderrIncludes)}: ${stderr}`,
    );
  }
}

const ranCreateInfoForms = packageNames.includes("create-mono-agent");
if (ranCreateInfoForms) {
  const createManifest = packageManifests.get("create-mono-agent");
  if (typeof createManifest?.version !== "string") {
    throw new Error("Packed create-mono-agent is missing its version.");
  }
  await verifyCreateMonoAgentInfoForms(createManifest.version);
}

const scope = target === null ? "consumer" : `isolated ${target} consumer`;
const createInfoSummary = ranCreateInfoForms ? " and all 4 create-mono-agent info forms" : "";
console.log(
  `Packed ${scope} imported ${importSpecifiers.length} public export(s); `
  + `ran ${selectedCliSmokes.length} dist CLI smoke(s)${createInfoSummary}.`,
);

async function readInstalledManifest(name) {
  return JSON.parse(await readFile(join(installedPackageDirectory(name), "package.json"), "utf8"));
}

function installedPackageDirectory(name) {
  return join(process.cwd(), "node_modules", ...name.split("/"));
}

async function runNodeCli(cli, args) {
  return await runCapturedCli(process.execPath, [cli, ...args], process.cwd());
}

async function verifyCreateMonoAgentInfoForms(version) {
  const createBin = join(process.cwd(), "node_modules", ".bin", "create-mono-agent");
  const cases = [
    { label: "help-long", args: ["--help"], kind: "help" },
    { label: "help-short", args: ["-h"], kind: "help" },
    { label: "version-long", args: ["--version"], kind: "version" },
    { label: "version-short", args: ["-v"], kind: "version" },
  ];

  for (const entry of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `create-mono-agent-${entry.label}-`));
    try {
      const beforeEntries = (await readdir(cwd)).sort();
      if (beforeEntries.length !== 0) {
        throw new Error(`Fresh create-mono-agent ${entry.label} cwd was not empty.`);
      }
      const result = await runCapturedCli(createBin, entry.args, cwd);
      const afterEntries = (await readdir(cwd)).sort();
      if (JSON.stringify(afterEntries) !== JSON.stringify(beforeEntries)) {
        throw new Error(
          `create-mono-agent ${entry.args.join(" ")} changed its cwd entries: `
          + `${JSON.stringify(beforeEntries)} -> ${JSON.stringify(afterEntries)}.`,
        );
      }
      if (result.status !== 0) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} exited ${result.status}: ${result.stderr || result.stdout}`,
        );
      }
      if (entry.kind === "help" && !result.stdout.includes("mono-agent init [--preset <id>]")) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} did not render the init help topic: ${result.stdout}`,
        );
      }
      if (entry.kind === "version" && result.stdout !== `mono-agent ${version}\n`) {
        throw new Error(
          `${createBin} ${entry.args.join(" ")} version output must be exactly `
          + `${JSON.stringify(`mono-agent ${version}\n`)}; found ${JSON.stringify(result.stdout)}.`,
        );
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

async function runCapturedCli(command, args, cwd) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}
