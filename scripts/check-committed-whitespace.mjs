import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Select only the event bases covered by ci.yml, never an untrusted PR title/ref. */
export function whitespaceBase(env = process.env, readFile = readFileSync) {
  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_EVENT_NAME !== undefined) {
    const name = env.GITHUB_EVENT_NAME;
    if (!["pull_request", "push"].includes(name)) {
      throw new Error(`Unsupported committed-whitespace event: ${name ?? "missing"}; expected pull_request or push to main.`);
    }
    if (!env.GITHUB_EVENT_PATH) throw new Error("Committed-whitespace check requires GITHUB_EVENT_PATH.");
    let event;
    try { event = JSON.parse(readFile(env.GITHUB_EVENT_PATH, "utf8")); }
    catch { throw new Error("Cannot read committed-whitespace event JSON."); }
    if (name === "push" && event?.ref !== "refs/heads/main") {
      throw new Error("Committed-whitespace push check only supports refs/heads/main.");
    }
    // A force-pushed main with an unreachable before SHA fails by design.
    const base = name === "pull_request" ? event?.pull_request?.base?.sha : event?.before;
    if (typeof base !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(base) || /^0+$/u.test(base)) {
      throw new Error(`Committed-whitespace ${name} base must be a nonzero commit SHA.`);
    }
    return base;
  }
  const base = env.WHITESPACE_BASE_REF ?? "origin/main";
  if (typeof base !== "string" || !base.trim() || /^0+$/u.test(base)) {
    throw new Error("Committed-whitespace base must be a nonempty, nonzero revision.");
  }
  return base;
}

/** Check committed CI changes, or the complete local working tree, against the merge base. */
export function checkCommittedWhitespace({ cwd = process.cwd(), env = process.env, readFile = readFileSync, execute = spawnSync } = {}) {
  const base = whitespaceBase(env, readFile);
  const git = (args) => {
    const result = execute("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.signal) throw new Error(`Committed-whitespace git command failed: ${result.error?.message ?? result.signal}`);
    return result;
  };
  const resolved = git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (resolved.status !== 0) throw new Error(`Committed-whitespace base is unreachable: ${base}. Fetch its history or set WHITESPACE_BASE_REF locally.`);
  const merged = git(["merge-base", resolved.stdout.trim(), "HEAD"]);
  if (merged.status !== 0 || !merged.stdout.trim()) throw new Error(`No committed-whitespace merge-base with ${base}; complete history is required.`);
  const ci = env.GITHUB_ACTIONS === "true" || env.GITHUB_EVENT_NAME !== undefined;
  const range = `${merged.stdout.trim()}${ci ? "..HEAD" : ""}`;
  const result = git(["diff", "--check", range]);
  if (![0, 1, 2].includes(result.status)) throw new Error(`Committed-whitespace diff failed (${result.status}): ${result.stderr.trim()}`);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`Whitespace: ${range}${ci ? "" : " (working tree)"}`);
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = checkCommittedWhitespace(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
