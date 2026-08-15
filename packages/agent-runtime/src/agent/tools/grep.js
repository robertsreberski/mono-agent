import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_MAX_SEARCH_CHARS,
  DEFAULT_MAX_SEARCH_LINES,
  SEARCH_MAX_BUFFER,
} from "./shared/constants.js";
import { boundedInt, safeStat } from "./shared/dedup.js";
import {
  isPathAllowed,
  protectedRelativePaths,
  resolveToolPath,
  workspaceRoot,
} from "./shared/path-resolver.js";
import {
  normalizeProtectedSearchLine,
  protectedFilesystemTargetPlan,
  runProtectedFilesystemCommand,
  scopeProtectedSearchGlob,
} from "./shared/protected-filesystem.js";
import {
  capLines,
  excludedGlobArgs,
  excludedPathSummary,
  resolveRgPath,
  ripgrepMissingMessage,
} from "./shared/ripgrep.js";

const execFileAsync = promisify(execFile);

/**
 * @param {{pattern: string, path?: string, glob?: string, type?: string, output_mode?: string, context?: number, case_insensitive?: boolean, multiline?: boolean, head_limit?: number, offset?: number, max_matches?: number, max_output_chars?: number, workdir?: string}} params
 * @param {{sandboxPolicy?: any, ctx?: any}} [options]
 */
export async function grepToolImpl({
  pattern,
  path,
  glob,
  type,
  output_mode = "files_with_matches",
  context,
  case_insensitive,
  multiline,
  head_limit,
  offset = 0,
  max_matches,
  max_output_chars,
  workdir,
}, { sandboxPolicy, ctx } = {}) {
  const target = resolveToolPath(path || workspaceRoot(workdir, ctx), workdir, ctx);
  if (!isPathAllowed(target, workdir, { sandboxPolicy, ctx })) return `Error: Path not allowed: ${target}`;
  const protectedSearch = protectedFilesystemTargetPlan(target, { sandboxPolicy, ctx });
  const protectedExecution = protectedSearch !== null;
  let cwd;
  let searchTarget;
  if (protectedExecution) {
    ({ cwd, searchTarget } = protectedSearch);
  } else {
    const stat = safeStat(target);
    if (!stat) return `Error: Path not found: ${target}`;
    cwd = stat.isDirectory() ? target : dirname(target);
    searchTarget = stat.isDirectory() ? "." : basename(target);
  }
  const mode = ["content", "count", "files_with_matches"].includes(output_mode) ? output_mode : "files_with_matches";
  const args = ["--no-config", "--hidden", "--color=never"];
  if (mode === "files_with_matches") args.push("--files-with-matches");
  else if (mode === "count") args.push("--count-matches");
  else args.push("--line-number");
  if (case_insensitive) args.push("-i");
  if (mode === "content" && context) args.push(`-C${boundedInt(context, 0, { min: 0, max: 20 })}`);
  if (multiline) args.push("-U", "--multiline-dotall");
  if (glob) args.push(
    "--glob",
    protectedExecution ? scopeProtectedSearchGlob(glob, searchTarget) : glob,
  );
  if (type) args.push("--type", type);
  args.push(...excludedGlobArgs());
  const protectedPaths = protectedRelativePaths(cwd, { sandboxPolicy, ctx });
  for (const protectedPath of protectedPaths) {
    args.push("--glob", `!${protectedPath}`, "--glob", `!${protectedPath}/**`);
  }
  args.push("--", pattern, searchTarget);
  const resultLimit = boundedInt(head_limit ?? max_matches, DEFAULT_MAX_SEARCH_LINES, { min: 1, max: 1000 });
  const rgPath = resolveRgPath({ ctx });
  if (!rgPath) return ripgrepMissingMessage(ctx);
  try {
    let stdout;
    if (!protectedExecution) {
      ({ stdout } = await execFileAsync(rgPath, args, { cwd, timeout: 15000, maxBuffer: SEARCH_MAX_BUFFER }));
    } else {
      const protectedResult = await runProtectedFilesystemCommand({
        command: rgPath,
        args,
        cwd,
      }, { sandboxPolicy, ctx, maxBufferBytes: SEARCH_MAX_BUFFER });
      if (protectedResult?.code === 1) return "No matches found.";
      if (protectedResult === null
        || protectedResult.code !== 0
        || protectedResult.bufferExceeded
        || protectedResult.timedOut) {
        return "Error: Protected filesystem search was denied.";
      }
      stdout = protectedResult.stdout;
    }
    const normalized = stdout.trim().split("\n")
      .filter(Boolean)
      .filter((line) => !protectedPaths.some((path) => (
        line === path || line.startsWith(`${path}/`) || line.startsWith(`${path}:`)
      )))
      .map((line) => protectedExecution
        ? normalizeProtectedSearchLine(line, searchTarget)
        : line.replace(/^\.\//, ""));
    const formatted = capLines(normalized.join("\n"), {
      label: "Grep",
      noMatches: "No matches found.",
      maxLines: resultLimit,
      maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
      offset,
      ctx,
    });
    return formatted === "No matches found." ? formatted : `${formatted}\n\n${excludedPathSummary()}`;
  } catch (err) {
    if (protectedExecution) return "Error: Protected filesystem search was denied.";
    if (err.code === 1) return "No matches found.";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/i.test(err.message || "")) {
      return `${capLines(err.stdout || "", {
        label: "Grep",
        noMatches: "Grep result exceeded the output limit before any preview could be captured.",
        maxLines: resultLimit,
        maxChars: Number(max_output_chars) || DEFAULT_MAX_SEARCH_CHARS,
        offset,
        ctx,
      })}\n\n${excludedPathSummary()}`;
    }
    return `Error: ${err.message}`;
  }
}
