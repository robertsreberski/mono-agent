// Private inputs are never reachable from the fictional benchmark entry path.
import { constants } from "node:fs";
import { lstat, realpath, readdir, mkdir, open } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BenchmarkError } from "./memory-e2e-providers.mjs";

export const PRIVATE_CODES = Object.freeze([
  "private_ci_refused", "private_absolute_roots_required", "private_repository_path",
  "private_permissions", "private_unsafe_entry", "private_roots_overlap",
  "private_input_invalid", "private_preregistration_invalid", "private_preregistration_changed", "private_cleanup_failed", "private_output_exists",
  "private_arguments_invalid", "private_provider_route_refused", "private_isolation_required",
  "private_provider_failed", "private_budget_exceeded", "private_budget_exhausted", "private_invocation_missing",
  "private_review_tty_required", "private_annotations_invalid", "private_operation_failed",
]);
export class PrivateError extends Error {
  constructor(code) { super(PRIVATE_CODES.includes(code) ? code : "private_operation_failed"); this.code = this.message; }
}
export function privateCode(error) {
  if (error instanceof PrivateError) return error.code;
  if (error instanceof BenchmarkError && ["runtime_budget_exhausted", "budget_exhausted"].includes(error.code)) return "private_budget_exhausted";
  return "private_operation_failed";
}
export function inside(root, path) { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); }
function requireOwned(info) {
  if (typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
    || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw new PrivateError("private_permissions");
}

/** Root/current-user ancestry only. Sticky is safe solely for root-owned
 * system directories; another directory owner could replace private children. */
export function requirePrivateAncestor(info, uid = process.getuid?.()) {
  if (uid === undefined || !info.isDirectory() || (info.uid !== uid && info.uid !== 0)
    || ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))) throw new PrivateError("private_permissions");
}

/** Resolve existing ancestors even for an output directory that does not exist yet. */
export async function privatePath(path, repositories) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new PrivateError("private_absolute_roots_required");
  const lexical = resolve(path);
  if (repositories.some((root) => inside(root, lexical))) throw new PrivateError("private_repository_path");
  let ancestor = lexical;
  const tail = [];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error?.code !== "ENOENT" || dirname(ancestor) === ancestor) throw new PrivateError("private_unsafe_entry");
      tail.unshift(ancestor.slice(dirname(ancestor).length + 1)); ancestor = dirname(ancestor);
    }
  }
  let canonical;
  try { canonical = resolve(await realpath(ancestor), ...tail); }
  catch { throw new PrivateError("private_unsafe_entry"); }
  if (repositories.some((root) => inside(root, canonical))) throw new PrivateError("private_repository_path");
  // The nearest existing ancestor must itself be private. System ancestors need
  // not be 0700, but a writable untrusted ancestor can replace a private root.
  requireOwned(await lstat(await realpath(ancestor))); requireNoAcl(await realpath(ancestor));
  let parent = dirname(await realpath(ancestor));
  for (;;) {
    requirePrivateAncestor(await lstat(parent)); requireNoAcl(parent, true);
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  return canonical;
}

// Darwin ACL names/permissions are fixed tokens, not translated prose. Reject
// unknown rows, flags and permissions, including truncated/nonsequential output.
const denyAclTokens = new Set([
  "read", "write", "execute", "delete", "append", "readattr", "writeattr",
  "readextattr", "writeextattr", "readsecurity", "writesecurity", "chown", "synchronize",
  "list", "search", "add_file", "add_subdirectory", "delete_child",
  "file_inherit", "directory_inherit", "limit_inherit", "only_inherit", "inherited",
]);
/** Pure metadata parser: only higher ancestors may carry verified deny-only
 * ACLs. Private roots/tree entries remain strict, including harmless denials. */
export function validatePrivateAclMetadata(metadata, allowDenyOnly = false) {
  if (typeof metadata !== "string") throw new PrivateError("private_permissions");
  const [header, ...tail] = metadata.split(/\r?\n/u);
  const mode = header.split(/\s/u, 1)[0];
  if (!/^[bcdlps-][rwxStTs-]{9}[+@]?$/u.test(mode)) throw new PrivateError("private_permissions");
  const rows = tail.filter((line) => line.trim() !== "");
  if (!rows.length) {
    if (mode.includes("+")) throw new PrivateError("private_permissions");
    return;
  }
  if (!allowDenyOnly) throw new PrivateError("private_permissions");
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i].match(/^\s*(\d+):\s+(?:user|group):\S+\s+(?:inherited\s+)?deny\s+([a-z_,]+)\s*$/u);
    if (!row || row[1] !== String(i) || row[2].split(",").some((token) => !denyAclTokens.has(token))) throw new PrivateError("private_permissions");
  }
}
/** Metadata-only preflight; never expose command output or exception text. */
function requireNoAcl(path, allowDenyOnly = false) {
  if (process.platform === "darwin") {
    let metadata;
    try { metadata = execFileSync("/bin/ls", ["-lde", path], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
      env: { ...process.env, LC_ALL: "C" },
    }); }
    catch { throw new PrivateError("private_permissions"); }
    // An xattr '@' may hide '+', so validate all additional rows too.
    validatePrivateAclMetadata(metadata, allowDenyOnly);
  }
}
export async function validateTree(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new PrivateError("private_unsafe_entry");
  requireOwned(info);
  requireNoAcl(path);
  if (info.isDirectory()) for (const name of await readdir(path)) await validateTree(join(path, name));
}
export async function validatePrivateRoots({ inputRoot, outputRoot, storeRoot, repositories, env = process.env }) {
  if (Object.hasOwn(env, "CI")) throw new PrivateError("private_ci_refused");
  try {
    const roots = await Promise.all([inputRoot, outputRoot, storeRoot].map((path) => privatePath(path, repositories)));
    for (let i = 0; i < roots.length; i += 1) for (let j = i + 1; j < roots.length; j += 1) {
      if (inside(roots[i], roots[j]) || inside(roots[j], roots[i])) throw new PrivateError("private_roots_overlap");
    }
    await validateTree(roots[0]); await validateTree(roots[2]);
    if (!(await lstat(roots[0])).isDirectory() || !(await lstat(roots[2])).isDirectory()) throw new PrivateError("private_unsafe_entry");
    try { await validateTree(roots[1]); if (!(await lstat(roots[1])).isDirectory()) throw new PrivateError("private_unsafe_entry"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    return { inputRoot: roots[0], outputRoot: roots[1], storeRoot: roots[2], repositories };
  } catch (error) { throw new PrivateError(privateCode(error)); }
}
/** Re-check canonical containment immediately at each logical write boundary.
 * A changed ancestor alias is a refusal, never a newly trusted destination. */
export async function assertPrivateLocation(path, repositories) {
  const canonical = await privatePath(path, repositories);
  if (canonical !== resolve(path)) throw new PrivateError("private_unsafe_entry");
}
export async function createPrivateOutput(root, repositories) {
  await assertPrivateLocation(root, repositories);
  try { await lstat(root); throw new PrivateError("private_output_exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw new PrivateError(privateCode(error)); }
  await mkdir(root, { mode: 0o700, recursive: true });
  await assertPrivateLocation(root, repositories);
  await validateTree(root);
}
export async function readPrivateJson(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat(); requireOwned(info);
    if (info.size > 32 * 1024 * 1024) throw new PrivateError("private_input_invalid");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) { throw new PrivateError(privateCode(error) === "private_operation_failed" ? "private_input_invalid" : privateCode(error)); }
  finally { await handle?.close(); }
}
export const opaqueId = (value) => typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
export const LABELS = Object.freeze(["useful", "partial", "noise", "stale"]);
const isoInstant = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function validateTurns(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10000) throw new PrivateError("private_input_invalid");
  let previous = -Infinity; const ids = new Set();
  return value.map((turn) => {
    if (!opaqueId(turn?.id) || !opaqueId(turn.conversationId) || ids.has(turn.id) || !isoInstant(turn.timestamp)
      || Date.parse(turn.timestamp) < previous || typeof turn.ownerText !== "string" || turn.ownerText.length === 0
      || Buffer.byteLength(turn.ownerText) > 64000 || typeof turn.followUp !== "boolean" || typeof turn.directQuestion !== "boolean"
      || (turn.assistantText !== undefined && (typeof turn.assistantText !== "string" || Buffer.byteLength(turn.assistantText) > 64000))
      || (turn.baselineLines !== undefined && (turn.baselineSource !== "provider_session_transcript" || !Array.isArray(turn.baselineLines) || turn.baselineLines.length > 100
        || turn.baselineLines.some((line) => !["profile", "guidance", "similarity"].includes(line?.kind) || typeof line.text !== "string" || Buffer.byteLength(line.text) > 16000)))) {
      throw new PrivateError("private_input_invalid");
    }
    ids.add(turn.id); previous = Date.parse(turn.timestamp);
    // Never forward unknown fields to a provider, harness, or artifact writer.
    return { id: turn.id, conversationId: turn.conversationId, timestamp: turn.timestamp, ownerText: turn.ownerText,
      assistantText: turn.assistantText ?? "", followUp: turn.followUp, directQuestion: turn.directQuestion,
      baselineLines: turn.baselineLines?.map(({ kind, text }) => ({ kind, text })) };
  });
}
export function validateRegistration(value) {
  const definitions = value?.definitions;
  if (value?.version !== 1 || value.caseSelection !== "all_ordered_owner_turns"
    || value.denominators !== "all_selected_turns_and_all_invoked_lines"
    || !LABELS.every((label) => typeof definitions?.[label] === "string" && definitions[label].trim().length > 0)
    || !Number.isSafeInteger(value.minimumTurns) || value.minimumTurns < 400
    || !Number.isSafeInteger(value.minimumFollowUps) || value.minimumFollowUps < 50
    || !Number.isSafeInteger(value.minimumJudgedFollowUpLines) || value.minimumJudgedFollowUpLines < 100
    || !Number.isSafeInteger(value.lengthAbstentionMaxCodePoints) || value.lengthAbstentionMaxCodePoints < 1 || value.lengthAbstentionMaxCodePoints > 1536
    || !["approximate_as_of", "present_diagnostic"].includes(value.snapshot)
    || value.isolation?.noContentLogs !== true || value.isolation?.noTelemetry !== true || value.isolation?.localServiceNoOutbound !== true
    || !Array.isArray(value.productionRoutes) || value.productionRoutes.some((route) => typeof route !== "string" || !/^[a-z0-9-]+:[A-Za-z0-9:._/-]+$/u.test(route))) {
    throw new PrivateError("private_preregistration_invalid");
  }
  return { version: 1, definitions: Object.fromEntries(LABELS.map((label) => [label, definitions[label]])),
    caseSelection: value.caseSelection, denominators: value.denominators, minimumTurns: value.minimumTurns,
    minimumFollowUps: value.minimumFollowUps, minimumJudgedFollowUpLines: value.minimumJudgedFollowUpLines,
    lengthAbstentionMaxCodePoints: value.lengthAbstentionMaxCodePoints, snapshot: value.snapshot,
    isolation: { noContentLogs: true, noTelemetry: true, localServiceNoOutbound: true }, productionRoutes: [...value.productionRoutes] };
}
export function validateAnnotations(value) {
  if (!Array.isArray(value)) throw new PrivateError("private_annotations_invalid");
  const ids = new Set();
  return value.map((row) => {
    if (!opaqueId(row?.id) || ids.has(row.id) || !(row.label === null || LABELS.includes(row.label))
      || Object.keys(row).some((key) => !["id", "label"].includes(key))) throw new PrivateError("private_annotations_invalid");
    ids.add(row.id); return { id: row.id, label: row.label };
  });
}
export async function loadPrivateInputs(root) {
  return { turns: validateTurns(await readPrivateJson(join(root, "turns.json"))),
    registration: validateRegistration(await readPrivateJson(join(root, "preregistration.json"))) };
}

/** Reconstruct canonical daily source only, never copy indexes, audit, intake,
 * transcripts, or projections containing information from the future. */
export async function reconstructClone({ source, destination, asOf, grammar, graph, present = false, repositories }) {
  await assertPrivateLocation(destination, repositories);
  await mkdir(join(destination, "daily"), { recursive: true, mode: 0o700 });
  await assertPrivateLocation(destination, repositories);
  const flags = new Set(present ? ["diagnostic_present_store"] : ["approximate_as_of"]);
  let count = 0; const keptIds = new Set();
  let names;
  try { names = await readdir(join(source, "daily")); } catch (error) { if (error?.code !== "ENOENT") throw error; names = []; }
  for (const name of names.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/u.test(name)) throw new PrivateError("private_unsafe_entry");
    const path = join(source, "daily", name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text, info;
    try { info = await handle.stat(); requireOwned(info); if (info.size > 32 * 1024 * 1024) throw new PrivateError("private_input_invalid"); text = await handle.readFile("utf8"); } finally { await handle.close(); }
    const parsed = grammar.parseDailyFile(text);
    if (parsed.lines.some((line) => !line.bullet && line.raw.includes("<!--mem"))) flags.add("timestamp_unknown");
    const kept = parsed.bullets.filter((bullet) => {
      const created = Date.parse(bullet.createdAt);
      if (!Number.isFinite(created)) { flags.add("timestamp_unknown"); return false; }
      return present || created < Date.parse(asOf);
    });
    if (!present && kept.length > 0) {
      if (info.mtimeMs > Date.parse(asOf)) flags.add("later_file_edit_possible");
      if (kept.some((bullet) => bullet.status !== "open" || bullet.refs.some((ref) => ref.startsWith("supersed")))) flags.add("later_status_or_supersession_possible");
      // created= cannot establish the historical text/labels of a rewritten line.
      flags.add("rewrite_history_unknown");
    }
    for (const bullet of kept) keptIds.add(bullet.id);
    if (kept.length > 0) {
      await assertPrivateLocation(destination, repositories);
      const output = await open(join(destination, "daily", name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await output.writeFile(kept.map(grammar.serializeBullet).join("\n") + "\n"); } finally { await output.close(); }
      count += kept.length;
    }
  }
  let graphHandle;
  try {
    graphHandle = await open(join(source, "graph.jsonl"), constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await graphHandle.stat(); requireOwned(info);
    if (info.size > 32 * 1024 * 1024 || !graph) throw new PrivateError("private_input_invalid");
    const records = graph.parseCanonicalGraphStrict(await graphHandle.readFile("utf8"));
    const before = (record) => present || (Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) < Date.parse(asOf));
    const entities = records.entities.filter(before); const entityIds = new Set(entities.map((entity) => entity.id));
    if (!present && entities.some((entity) => entity.updatedAt !== undefined && Date.parse(entity.updatedAt) >= Date.parse(asOf))) flags.add("later_graph_edit_possible");
    const lines = [
      ...entities.map((entity) => ({ ...entity, kind: "entity" })),
      ...records.relations.filter((relation) => before(relation) && entityIds.has(relation.src) && entityIds.has(relation.dst)).map((relation) => ({ ...relation, kind: "relation" })),
      ...records.associations.filter((association) => before(association) && keptIds.has(association.memoryId) && entityIds.has(association.entityId)).map((association) => ({ ...association, kind: "association" })),
    ];
    if (lines.length > 0) {
      await assertPrivateLocation(destination, repositories);
      const output = await open(join(destination, "graph.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await output.writeFile(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"); } finally { await output.close(); }
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  finally { await graphHandle?.close(); }
  return { count, flags: [...flags].sort(), contaminated: [...flags].some((flag) => !["approximate_as_of"].includes(flag)) };
}
