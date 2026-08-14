import { createRequire } from "node:module";

export function advisorMcpPackageVersion(): string {
  const value = createRequire(import.meta.url)("../package.json") as { readonly version?: unknown };
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    throw new Error("@mono-agent/advisor-mcp package version is unavailable.");
  }
  return value.version.trim();
}
