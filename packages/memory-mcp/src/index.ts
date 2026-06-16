import { fileURLToPath } from "node:url";

export { createMemoryMcpServer, createMemoryMcpServerFromConfig } from "./server.js";
export type { MemoryMcpServerConfig, MemoryMcpEmbeddingsConfig } from "./server.js";
export { createMemoryTools } from "./tools.js";
export type { MemoryTools, MemoryToolDeps, ToolResult } from "./tools.js";

export function resolveMemoryMcpMainPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}
