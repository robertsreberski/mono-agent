import { fileURLToPath } from "node:url";

export function resolveMemoryMcpMainPath(): string {
  return fileURLToPath(new URL("./main.js", import.meta.url));
}
