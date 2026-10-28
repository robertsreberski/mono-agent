import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, realpath, mkdir, lstat, writeFile } from "node:fs/promises";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./continuity-dataset.mjs";

export const CHECKOUT = fileURLToPath(new URL("../../", import.meta.url));
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = value => canonicalJson(value) + "\n";
export const readJson = async path => JSON.parse(await readFile(path, "utf8"));
export function toolingRevision() { return execFileSync("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
const within = (root, path) => { const rel = relative(root, path); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); };

/** Resolve every existing ancestor before creating anything, including symlinked parents. */
export async function externalDirectory(path, create = false) {
  const checkout = await realpath(CHECKOUT);
  let ancestor = resolve(path), suffix = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; suffix.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
  }
  const target = resolve(ancestor, ...suffix);
  if (within(checkout, target) || within(target, checkout)) throw new Error("output_must_be_outside_checkout");
  if (create) await mkdir(target, { recursive: true, mode: 0o700 });
  return target;
}
export async function writeExclusive(path, bytes) { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
export async function regularFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error("regular_file_required");
  return readFile(path);
}
export function parseFlags(argv, allowed) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.includes(key) || Object.hasOwn(flags, key)) throw new Error("invalid_arguments");
    if (key === "--schema-only") flags[key] = true;
    else { if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("missing_argument"); flags[key] = argv[++i]; }
  }
  for (const key of allowed.filter(k => k !== "--schema-only")) if (!flags[key]) throw new Error("missing_argument");
  return flags;
}
export async function runCli(url, main) {
  if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(url)) {
    try { await main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
