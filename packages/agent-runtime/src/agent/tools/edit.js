import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isPathAllowed, isWritablePathAllowed, resolveToolPath } from "./shared/path-resolver.js";
import {
  protectedCommandSucceeded,
  runProtectedFilesystemCommand,
} from "./shared/protected-filesystem.js";

const PROTECTED_EDIT_SOURCE = String.raw`
"use strict";
const { readFileSync, writeFileSync } = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const content = readFileSync(process.argv[1], "utf8");
  const count = content.split(request.oldString).length - 1;
  if (count === 0) return process.stdout.write(JSON.stringify({ status: "missing", count }));
  if (!request.replaceAll && count > 1) return process.stdout.write(JSON.stringify({ status: "ambiguous", count }));
  writeFileSync(
    process.argv[1],
    request.replaceAll
      ? content.replaceAll(request.oldString, request.newString)
      : content.replace(request.oldString, request.newString),
    "utf8",
  );
  process.stdout.write(JSON.stringify({ status: "edited", count }));
});
`;

/**
 * @param {{file_path: string, old_string: string, new_string: string, replace_all?: boolean, workdir?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any}} [options]
 */
export async function editToolImpl({ file_path, old_string, new_string, replace_all = false, workdir }, { sandboxPolicy, ctx } = {}) {
  const target = resolveToolPath(file_path, workdir, ctx);
  const pathOptions = { sandboxPolicy, ctx };
  if (!isPathAllowed(target, workdir, pathOptions) || !isWritablePathAllowed(target, workdir, pathOptions)) return `Error: Path not allowed: ${file_path}`;
  if (!existsSync(target)) return `Error: File not found: ${file_path}`;
  try {
    const protectedResult = await runProtectedFilesystemCommand({
      command: process.execPath,
      args: ["--input-type=commonjs", "--eval", PROTECTED_EDIT_SOURCE, target],
      cwd: workdir,
    }, {
      sandboxPolicy,
      ctx,
      input: JSON.stringify({ oldString: old_string, newString: new_string, replaceAll: replace_all }),
    });
    if (protectedResult !== null) {
      if (!protectedCommandSucceeded(protectedResult)) {
        return "Error: Protected filesystem edit was denied.";
      }
      const result = JSON.parse(protectedResult.stdout);
      if (result.status === "missing") return `Error: old_string not found in ${target}`;
      if (result.status === "ambiguous") return `Error: old_string found ${result.count} times`;
      if (result.status !== "edited") return "Error: Protected filesystem edit was denied.";
      return `Successfully edited ${target}`;
    }
  } catch {
    return "Error: Protected filesystem edit was denied.";
  }
  const content = readFileSync(target, "utf8");
  const count = content.split(old_string).length - 1;
  if (count === 0) return `Error: old_string not found in ${target}`;
  if (!replace_all && count > 1) return `Error: old_string found ${count} times`;
  writeFileSync(target, replace_all ? content.replaceAll(old_string, new_string) : content.replace(old_string, new_string), "utf8");
  return `Successfully edited ${target}`;
}
