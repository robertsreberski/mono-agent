import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_WRITE_BYTES } from "./shared/constants.js";
import {
  isWritablePathAllowed,
  isWritablePathLexicallyAllowed,
  resolveToolPath,
} from "./shared/path-resolver.js";
import {
  protectedCommandSucceeded,
  protectedFilesystemTargetPlan,
  runProtectedFilesystemCommand,
} from "./shared/protected-filesystem.js";

const PROTECTED_WRITE_SOURCE = String.raw`
"use strict";
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const target = process.argv[1];
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.concat(chunks));
});
`;

/**
 * @param {{file_path: string, content?: string, workdir?: string}} params
 * @param {{sandboxPolicy?: any, sandboxEngine?: any, ctx?: any}} [options]
 */
export async function writeToolImpl({ file_path, content, workdir }, { sandboxPolicy, sandboxEngine, ctx } = {}) {
  const target = resolveToolPath(file_path, workdir, ctx);
  const pathOptions = { sandboxPolicy, ctx };
  const protectedTarget = protectedFilesystemTargetPlan(target, { sandboxPolicy, ctx });
  const protectedExecution = protectedTarget !== null;
  if (protectedExecution) {
    if (!isWritablePathLexicallyAllowed(target, workdir, pathOptions)) {
      return "Error: Protected filesystem write was denied.";
    }
  } else if (!isWritablePathAllowed(target, workdir, pathOptions)) {
    return `Error: Path not allowed: ${file_path}`;
  }
  const bytes = Buffer.byteLength(content || "", "utf8");
  if (bytes > MAX_WRITE_BYTES) return `Error: Content too large (${bytes} bytes)`;
  try {
    if (protectedExecution) {
      const protectedResult = await runProtectedFilesystemCommand({
        command: process.execPath,
        args: ["--input-type=commonjs", "--eval", PROTECTED_WRITE_SOURCE, target],
        cwd: protectedTarget.cwd,
      }, { sandboxPolicy, sandboxEngine, ctx, input: content || "" });
      if (!protectedCommandSucceeded(protectedResult)) {
        return "Error: Protected filesystem write was denied.";
      }
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content || "", "utf8");
    }
  } catch {
    return "Error: Protected filesystem write was denied.";
  }
  return `Successfully wrote ${bytes} bytes to ${target}`;
}
