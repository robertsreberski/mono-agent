import { fileURLToPath } from "node:url";

export {
  createMemoryMcpServer,
  createMemoryMcpServerFromConfig,
  createMemoryTools,
} from "./server.js";
export type {
  EntityUpsertArgs,
  MemoryMcpConfig,
  MemoryMcpDependencies,
  MemoryTools,
  ToolResult,
} from "./server.js";
export { grepMemory, isValidDay, listDailyNotes, readDailyNote } from "./file-store.js";
export type { GrepHit } from "./file-store.js";

export function resolveMemoryMcpMainPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}
