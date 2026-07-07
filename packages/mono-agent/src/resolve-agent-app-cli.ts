import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

interface AgentAppManifest {
  readonly bin?: string | Record<string, string>;
}

/**
 * Resolves the absolute path of `@mono-agent/agent-app`'s `mono-agent` CLI entry
 * from the installed dependency's own `package.json` `bin` field.
 *
 * Reading the `bin` path from the manifest (rather than hardcoding `dist/cli.js`)
 * means this survives any install layout — npm/npx global, pnpm-linked — and any
 * future change to agent-app's bin location. We resolve it through CJS
 * `require.resolve` of `@mono-agent/agent-app/package.json` (which agent-app
 * exports), so this works on every Node ≥20 without depending on the newer
 * synchronous `import.meta.resolve` (Node 20.6+).
 */
export function resolveAgentAppCliEntry(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  const manifestPath = require.resolve("@mono-agent/agent-app/package.json");
  const manifest = require("@mono-agent/agent-app/package.json") as AgentAppManifest;
  const bin = manifest.bin;
  const relative = typeof bin === "string" ? bin : bin?.["mono-agent"];
  if (typeof relative !== "string" || relative.length === 0) {
    throw new Error("@mono-agent/agent-app does not declare a `mono-agent` bin; cannot delegate.");
  }
  return resolve(dirname(manifestPath), relative);
}
