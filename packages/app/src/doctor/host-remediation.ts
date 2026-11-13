import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostRemediation } from "./host-preflight-types.js";

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export function nativeRemediations(): readonly HostRemediation[] {
  const appRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const version = (JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { version: string }).version;
  const root = dirname(dirname(appRoot));
  const prerequisite = "First select supported Node, then stop affected agents. Reinstall with that Node and rerun mono-agent preflight. No repair runs automatically.";
  // Identify the executing installation, never the consumer's working directory.
  if (existsSync(join(root, "pnpm-workspace.yaml")) && existsSync(join(root, "scripts/node-version.mjs"))) {
    return [{ command: `cd ${shellQuote(root)} && pnpm install --frozen-lockfile --force && pnpm run build`, explanation: "Source-checkout rebuild (including native dependencies).", prerequisite }];
  }
  // Ownership cannot be proven from a transitive app path in arbitrary npm layouts.
  return [
    { command: `npm uninstall --global create-mono-agent && npm install --global create-mono-agent@${version}`, explanation: "Alternative: global create-mono-agent installation only.", prerequisite },
    { command: `npm uninstall --global @mono-agent/app && npm install --global @mono-agent/app@${version}`, explanation: "Alternative: direct global @mono-agent/app installation only.", prerequisite },
  ];
}
