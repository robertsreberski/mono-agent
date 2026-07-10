import { readFile } from "node:fs/promises";
import { join } from "node:path";

const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const packageNames = Object.keys(manifest.dependencies ?? {}).sort();
const importSpecifiers = packageNames.flatMap((name) => {
  if (name === "create-mono-agent") return [];
  if (name === "@mono-agent/memory") {
    return [
      "@mono-agent/memory/store",
      "@mono-agent/memory/search",
      "@mono-agent/memory/bujo",
    ];
  }
  return [name];
});

for (const specifier of importSpecifiers) {
  await import(specifier);
}

const cliPaths = [
  { parts: ["@mono-agent", "agent-app", "dist", "cli.js"], args: ["--help"], statuses: [0] },
  { parts: ["@mono-agent", "tui", "dist", "bin", "mono-agent-tui.js"], args: ["--help"], statuses: [0] },
  { parts: ["@mono-agent", "memory", "dist", "bujo", "cli.js"], args: [], statuses: [2] },
  { parts: ["create-mono-agent", "dist", "bin", "mono-agent.js"], args: ["--help"], statuses: [0] },
];
for (const entry of cliPaths) {
  const cli = join(process.cwd(), "node_modules", ...entry.parts);
  const { status, stderr } = await runNodeCli(cli, entry.args);
  if (!entry.statuses.includes(status)) {
    throw new Error(`${cli} ${entry.args.join(" ")} exited ${status}: ${stderr}`);
  }
}

console.log(`Packed consumer imported ${importSpecifiers.length} public entry points and ran ${cliPaths.length} CLIs.`);

async function runNodeCli(cli, args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ status: 1, stderr: error.message }));
    child.on("close", (status) => resolve({ status: status ?? 1, stderr }));
  });
}
