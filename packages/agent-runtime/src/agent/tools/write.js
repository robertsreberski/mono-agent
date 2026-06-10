import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_WRITE_BYTES } from "./shared/constants.js";
import { isWritablePathAllowed, resolveToolPath } from "./shared/path-resolver.js";

export async function writeToolImpl({ file_path, content, workdir }, { sandboxPolicy } = {}) {
  const target = resolveToolPath(file_path, workdir);
  if (!isWritablePathAllowed(target, workdir, { sandboxPolicy })) return `Error: Path not allowed: ${file_path}`;
  const bytes = Buffer.byteLength(content || "", "utf8");
  if (bytes > MAX_WRITE_BYTES) return `Error: Content too large (${bytes} bytes)`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content || "", "utf8");
  return `Successfully wrote ${bytes} bytes to ${target}`;
}
