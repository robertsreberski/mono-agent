// Controller-owned committed-summary lineage. Never trust a child-supplied text hash.
import { fail } from "./continuity-observation-input.mjs";
import { assertE2BaselineContext } from "./continuity-e2-protocol.mjs";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { digest } from "./continuity-recorded-schema.mjs";
import { digest as canonicalDigest } from "./continuity-dataset.mjs";
import { verifyE2SummaryResult, e2SummaryResultPath } from "./continuity-e2-summary-receipts.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_summary_receipt_invalid"), { code: "e2_summary_receipt_invalid" }); };
const token = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(s);
const ARCHIVE_SCHEMA = "continuity-e2-committed-checkpoint-v1", ARCHIVE_BYTES = 8 * 1024 * 1024;
const hash = s => typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const split = "\n\n---\n\n**Turn Context (split turn):**\n\n";
export const E2_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const E2_SUMMARY_SUFFIX = "\n</summary>";
export const E2_BRANCH_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export function e2PhaseBase(root, slot) {
  need(slot && ["proof", "replay"].includes(slot.kind));
  if (slot.kind === "replay") return join(root, "work", "replay");
  need(["switch", "cancel", "idle", "pressure"].includes(slot.arm) && ["ceiling", "restart"].includes(slot.variant));
  return join(root, "work", `${slot.arm}-${slot.variant}`);
}
export function e2PhaseWork(root, slot, branch) {
  if (slot.kind === "replay") { need([0, 1].includes(branch)); return join(e2PhaseBase(root, slot), `branch-${branch}`, "work"); }
  return join(e2PhaseBase(root, slot), "work");
}
export async function e2LineageScope(state, planned, checkpoint, readArtifact) {
  if (planned.kind === "proof") return "proof";
  const binding = state.pilot.registration.protocol;
  const bytes = await readArtifact(binding.path, "e2_summary_receipt_invalid"); need(digest(bytes) === binding.sha256);
  const protocol = JSON.parse(bytes); need(Number.isSafeInteger(checkpoint) && checkpoint >= 0);
  const first = protocol.branches[0].checkpoints.length, total = first + protocol.branches[1].checkpoints.length;
  need(checkpoint < total); return checkpoint < first ? 0 : 1;
}
const responseText = message => message.content.filter(p => p.type === "text").map(p => p.text).join("\n");
function fileSuffix(details) {
  need(details && ["readFiles", "modifiedFiles"].every(k => Array.isArray(details[k]) && details[k].length <= 4096
    && details[k].every(s => typeof s === "string" && s.length <= 16384)));
  return [["read-files", details.readFiles], ["modified-files", details.modifiedFiles]]
    .map(([tag, paths]) => paths.length ? `\n\n<${tag}>\n${paths.join("\n")}\n</${tag}>` : "").join("");
}
export async function readE2Checkpoint(root, planned, reference, readArtifact) {
  try { return await readCheckpoint(root, planned, reference, readArtifact); }
  catch { need(false); }
}
async function readCheckpoint(root, planned, reference, readArtifact) {
  need(reference && token(reference.journalId) && token(reference.checkpointId));
  const work = e2PhaseWork(root, planned, reference.branch);
  const bytes = await readArtifact(join(work, "sessions", "journals", `${reference.journalId}.jsonl`), "e2_summary_receipt_invalid", 128 * 1024 * 1024);
  const lines = bytes.toString("utf8").split("\n"); need(lines.pop() === "" && lines.length > 1 && lines.length <= 1000000);
  const header = JSON.parse(lines.shift());
  const { JournalValidator, validateJournalHeader } = await import(new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href);
  validateJournalHeader(header); need(header.journalId === reference.journalId && header.cwd === work);
  const validator = new JournalValidator(), records = lines.map(line => JSON.parse(line));
  for (const record of records) validator.apply(record);
  const record = records.find(r => r.id === reference.checkpointId), value = record?.payload?.compaction;
  need(record?.kind === "compaction" && (records.filter(r => r.kind === "compaction").at(-1)?.id === record.id) && value?.checkpoint?.summaryMessage?.summary === value.summary && typeof value.summary === "string"
    && value.summary.isWellFormed() && Buffer.byteLength(value.summary) <= 4 * 1024 * 1024 && value.summary.trim()
    && records.some(r => r.kind === "operation_end" && r.operationId === record.operationId && r.payload.status === "completed"));
  return { summary: value.summary, details: value.details, model: value.checkpoint.model, seq: record.seq, operationId: record.operationId };
}
// The child may discover a candidate, but only the controller calls bind/write.
export async function validateE2Checkpoint({ root, state, planned, slot, summaries, reference, readPrivate, readArtifact }) {
  const scope = await e2LineageScope(state, planned, reference.checkpoint, readArtifact);
  reference = { ...reference, ...(planned.kind === "replay" ? { branch: scope } : {}) };
  const checkpoint = await readE2Checkpoint(root, planned, reference, readArtifact), texts = [];
  const prior = slot.lineages?.[scope];
  if (prior) await verifyE2NativeLineage(Buffer.from('{"input":[]}'), { lineageScope: scope, lineage: prior }, state, { outputRoot: root, index: planned.index }, readArtifact);
  need(summaries.length > 0 && summaries.length <= 2 && !(state.slots ?? []).some(s => s.checkpoints?.some(c => c.journalId === reference.journalId && c.checkpointId === reference.checkpointId)));
  for (const hold of summaries) {
    await verifyE2SummaryResult(root, slot.slotId, hold, { schema: hold.summaryReceipt.schema, sha256: hold.summaryReceipt.sha256 }, readPrivate);
    const result = await readPrivate(e2SummaryResultPath(root, slot.slotId, hold.round));
    need(`${checkpoint.model?.provider}:${checkpoint.model?.id}` === hold.model); texts.push(responseText(result.message));
  }
  const suffix = fileSuffix(checkpoint.details);
  let matches = (texts.length === 2 ? texts.join(split) : texts[0]) + suffix === checkpoint.summary;
  if (texts.length === 1) {
    // Restored snapshot probes can restart from an older registered checkpoint;
    // a cold epoch can have no native prior history at all. Neither permits an
    // unverified prefix: all alternatives come from the validated archive chain.
    matches ||= "No prior history." + split + texts[0] + suffix === checkpoint.summary;
    let predecessor = prior;
    while (predecessor && !matches) {
      const previous = await readE2Archive(root, state, planned.index, scope, predecessor, readArtifact);
      const history = previous.summary.replace(/(?:\n\n<(read-files|modified-files)>\n[\s\S]*?\n<\/\1>)+$/u, "");
      matches = history + split + texts[0] + suffix === checkpoint.summary; predecessor = previous.previous;
    }
  }
  need(matches);
  const lineage = { version: 2, scope, ...(planned.kind === "replay" ? { branch: scope } : {}), phase: planned.index, journalId: reference.journalId, checkpointId: reference.checkpointId,
    textSha256: digest(checkpoint.summary), generated: summaries.map(h => ({ round: h.round, sha256: h.summaryReceipt.sha256 })) };
  return { schema: ARCHIVE_SCHEMA, lineage, slotId: slot.slotId, ...checkpoint, previous: slot.lineages?.[scope] ?? null };
}
export function e2ArchivePath(root, sha256) {
  need(hash(sha256)); return join(root, "e2-committed-checkpoints", `${sha256}.json`);
}
export async function bindE2Checkpoint(options) {
  try {
    const { durable, directoryOnly } = await import("./continuity-holdout-workflow.mjs");
    const artifact = await validateE2Checkpoint(options), bytes = Buffer.from(JSON.stringify(artifact) + "\n");
    need(bytes.length <= ARCHIVE_BYTES);
    const archiveSha256 = digest(bytes), path = e2ArchivePath(options.root, archiveSha256), directory = join(options.root, "e2-committed-checkpoints");
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    await directoryOnly(directory);
    await durable(path, bytes, true); // exclusive creation + file and directory fsync, before ACK
    return { ...artifact.lineage, archiveSha256 };
  } catch { need(false); }
}
// Scope and the one registered seed -> resume edge are the only authority paths.
function assertReference(state, index, scope, reference) {
  const planned = state.schedule[index], owner = state.schedule[reference?.phase];
  need(reference?.version === 2 && reference.scope === scope && hash(reference.archiveSha256) && hash(reference.textSha256)
    && token(reference.journalId) && token(reference.checkpointId) && Number.isSafeInteger(reference.phase) && reference.phase >= 0 && reference.phase <= index
    && Array.isArray(reference.generated) && reference.generated.length > 0 && reference.generated.length <= 2
    && reference.generated.every(g => Number.isSafeInteger(g.round) && g.round > 0 && hash(g.sha256)));
  need(planned && owner && (planned.kind === "replay" ? [0, 1].includes(scope) && reference.branch === scope && owner.kind === "replay"
    : scope === "proof" && reference.branch === undefined && owner.kind === "proof" && owner.arm === planned.arm && owner.variant === planned.variant));
  if (reference.phase !== index) need(planned.kind === "proof" && planned.phase === "resume" && reference.phase === index - 1 && owner.phase === "seed"
    && ["completed", "own_abort_after_send"].includes(state.slots[reference.phase]?.terminal));
}
function assertRegisteredPredecessor(state, index, reference) {
  if (reference && reference.phase < index) need(canonicalDigest(reference) === canonicalDigest(state.slots[reference.phase]?.lineages?.[reference.scope] ?? null));
}
export async function readE2Archive(root, state, index, scope, reference, readArtifact) {
  try {
    assertReference(state, index, scope, reference);
    const bytes = await readArtifact(e2ArchivePath(root, reference.archiveSha256), "e2_summary_receipt_invalid", ARCHIVE_BYTES);
    need(bytes.length <= ARCHIVE_BYTES && digest(bytes) === reference.archiveSha256);
    const artifact = JSON.parse(bytes), { archiveSha256: _, ...lineage } = reference;
    need(artifact.schema === ARCHIVE_SCHEMA && canonicalDigest(artifact.lineage) === canonicalDigest(lineage)
      && artifact.slotId === state.slots[reference.phase]?.slotId && typeof artifact.summary === "string" && artifact.summary.isWellFormed()
      && Buffer.byteLength(artifact.summary) <= 4 * 1024 * 1024 && digest(artifact.summary) === reference.textSha256
      && token(artifact.operationId) && Number.isSafeInteger(artifact.seq) && artifact.seq >= 0 && artifact.model?.provider && artifact.model?.id);
    fileSuffix(artifact.details);
    need(artifact.previous === null || artifact.previous?.scope === scope);
    return artifact;
  } catch { need(false); }
}
// Parse complete shipping representations. A malformed *claim* refuses instead
// of silently turning into an apparent absence. Ordinary quoted conversation is
// not promoted to authority. The recorded pack sha must authenticate its text.
export function e2BodySummaryRepresentations(body) {
  const found = [];
  for (const item of [...(body.input ?? []), ...(typeof body.instructions === "string" ? [{ role: "instructions", content: body.instructions }] : [])]) {
    const parts = typeof item.content === "string" ? [item.content] : (item.content ?? [])
      .filter(p => ["input_text", "output_text", "reasoning_text", "refusal"].includes(p.type)).map(p => p.type === "refusal" ? p.refusal : p.text);
    // These fields can be supplied by a child/SDK transcript, not solely by a
    // durable ConversationHistory read. Apply the same complete-claim checks.
    if (item.type === "function_call_output" && typeof item.output === "string") parts.push(item.output);
    if (item.type === "reasoning") parts.push(...(item.summary ?? []).filter(p => p.type === "summary_text").map(p => p.text));
    for (const text of parts) {
      if (typeof text !== "string") continue;
      for (const [kind, prefix, suffix] of [["native", E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX], ["branch", E2_BRANCH_PREFIX, "</summary>"]]) {
        if (!text.startsWith(prefix)) continue;
        need(item.role === "user" && text.isWellFormed() && text.endsWith(suffix));
        found.push({ kind, text: text.slice(prefix.length, -suffix.length) });
      }
      // Compaction serializes role messages into one user prompt. Authenticate
      // embedded framework claims too; verified spans remain opaque (nested tags
      // inside an exact archived value are not additional authority claims).
      if (![E2_SUMMARY_PREFIX, E2_BRANCH_PREFIX, "### Conversation continuity pack (historical evidence)\n"].some(p => text.startsWith(p))) {
        if (text.startsWith("<conversation>\n")) for (const role of ["Assistant", "Assistant thinking", "Tool result"]) {
          for (const [kind, prefix] of [["native", E2_SUMMARY_PREFIX], ["branch", E2_BRANCH_PREFIX], ["pack", "### Conversation continuity pack (historical evidence)\n"]]) {
            let offset = text.indexOf(`[${role}]: ${prefix}`);
            while (offset >= 0) { found.push({ kind, text: "", source: text, offset, forbidden: true }); offset = text.indexOf(`[${role}]: ${prefix}`, offset + 1); }
          }
        }
        const frames = [["native", "<previous-summary", "<previous-summary>\n", "\n</previous-summary>"],
          ...text.startsWith("<conversation>\n") ? [["native", `[User]: ${E2_SUMMARY_PREFIX}`, `[User]: ${E2_SUMMARY_PREFIX}`, E2_SUMMARY_SUFFIX],
            ["branch", `[User]: ${E2_BRANCH_PREFIX}`, `[User]: ${E2_BRANCH_PREFIX}`, "</summary>"]] : []];
        for (const [kind, marker, prefix, suffix] of frames) {
          let offset = text.indexOf(marker);
          while (offset >= 0) {
            if (marker === "<previous-summary" && !text.startsWith(prefix, offset) && offset > 0 && text[offset - 1] !== "\n") {
              offset = text.indexOf(marker, offset + marker.length); continue; // shipping instruction prose mentions the tag
            }
            need(item.role === "user" && text.isWellFormed());
            const end = text.indexOf(suffix, offset + prefix.length);
            found.push({ kind, text: end < 0 ? "" : text.slice(offset + prefix.length, end), source: text, offset, prefix, suffix });
            offset = text.indexOf(marker, offset + marker.length);
          }
        }
        const pack = "[User]: ### Conversation continuity pack (historical evidence)\n";
        if (text.startsWith("<conversation>\n")) {
          let start = text.indexOf(pack);
          while (start >= 0) {
            need(item.role === "user");
            const after = start + "[User]: ".length, rest = text.slice(after), boundary = /\n(?:<\/conversation>\n\n|\n\[(?:User|Assistant|Assistant thinking|Assistant tool calls|Tool result)\]: )/u.exec(rest);
            const packet = boundary ? rest.slice(0, boundary.index) : rest;
            if (packet.split("\n").some(line => line.startsWith("Generated summary evidence ")))
              found.push({ kind: "pack", text: packet, source: text, offset: start, serialized: true });
            start = text.indexOf(pack, start + pack.length);
          }
        }
      }
      if (text.startsWith("### Conversation continuity pack (historical evidence)\n")) for (const line of text.split("\n")) {
        if (!line.startsWith("Generated summary evidence ")) continue;
        need(item.role === "user" && line.isWellFormed());
        const match = /^Generated summary evidence id="chr1_[A-Za-z0-9_-]{43}" sha256="([a-f0-9]{64})": (".*")$/su.exec(line);
        need(match);
        let value; try { value = JSON.parse(match[2]); } catch { need(false); }
        need(typeof value === "string" && value.isWellFormed() && digest(value) === match[1]);
        found.push({ kind: "pack", text: value, sha256: match[1] });
      }
    }
  }
  return found;
}
export function assertE2BaselineRequest(context, options) {
  assertE2BaselineContext(context, options);
  // Compaction flattens injected messages into role-framed conversation text.
  // Reuse the native lineage detector rather than searching serialized history.
  const serialized = (context.messages ?? context.input ?? []).map(m => ({ role: m.role,
    content: typeof m.content === "string" ? m.content : (m.content ?? [])
      .filter(p => ["text", "input_text", "output_text"].includes(p.type)).map(p => p.text).join("\n") }))
    .filter(m => m.content.startsWith("<conversation>\n"));
  if (e2BodySummaryRepresentations({ input: serialized }).some(r => r.kind === "pack")) fail("e2_payload_forbidden");
}
export function e2BodySummaryDigests(body) { return e2BodySummaryRepresentations(body).map(r => digest(r.text)); }
export async function verifyE2NativeLineage(bytes, hold, state, assignment, readArtifact) {
  try {
    const scope = hold.lineageScope;
    need(["proof", 0, 1].includes(scope) && canonicalDigest(hold.lineage ?? null) === canonicalDigest(state.slots[assignment.index].lineages?.[scope] ?? null));
    const found = e2BodySummaryRepresentations(JSON.parse(bytes)), verified = new Set(), seen = new Set(), spans = [], packs = [];
    let reference = hold.lineage;
    assertRegisteredPredecessor(state, assignment.index, reference);
    while (reference) {
      need(!seen.has(reference.archiveSha256) && seen.size < 4096); seen.add(reference.archiveSha256);
      const artifact = await readE2Archive(assignment.outputRoot, state, assignment.index, scope, reference, readArtifact);
      // This is the shipping retention/redaction function, not an approximation
      // or an allowlist of hashes supplied by the child/continuity sidecar.
      const { retainContinuityText } = await import(new URL("../../packages/conversation/dist/tool-history/continuity-payload.js", import.meta.url).href);
      const retained = retainContinuityText(artifact.summary); packs.push(retained);
      for (const [i, representation] of found.entries()) if (!representation.serialized && !representation.forbidden && (representation.kind === "pack"
        ? !retained.truncated && representation.text === retained.text && representation.sha256 === retained.sha256
        : representation.source ? representation.source.startsWith(representation.prefix + artifact.summary + representation.suffix, representation.offset)
          : representation.text === artifact.summary)) {
          verified.add(i);
          if (representation.source && representation.prefix) spans.push({ source: representation.source, start: representation.offset,
            end: representation.offset + representation.prefix.length + artifact.summary.length + representation.suffix.length });
        }
      const previous = artifact.previous;
      need(previous === null || previous.phase <= reference.phase);
      if (previous && previous.phase !== reference.phase) assertRegisteredPredecessor(state, assignment.index, previous);
      reference = previous;
    }
    const opaque = new Set();
    for (const [i, r] of found.entries()) if (r.source && spans.some(s => s.source === r.source && s.start < r.offset && r.offset < s.end)) { verified.add(i); opaque.add(i); }
    const expanded = new Map();
    for (const [i, r] of found.entries()) if (r.serialized && !opaque.has(i)) {
      const decoded = e2BodySummaryRepresentations({ input: [{ role: "user", content: r.text }] });
      need(decoded.length > 0 && decoded.every(d => d.kind === "pack" && packs.some(p => !p.truncated && d.text === p.text && d.sha256 === p.sha256)));
      verified.add(i); expanded.set(i, decoded);
    }
    need(verified.size === found.length); // no-lineage baseline cannot smuggle a summary
    const claims = found.flatMap((r, i) => opaque.has(i) ? [] : expanded.get(i) ?? [r]);
    return { native: claims.filter(r => r.kind === "native").length, branch: claims.filter(r => r.kind === "branch").length,
      pack: claims.filter(r => r.kind === "pack").length, none: claims.length === 0 };
  } catch { need(false); }
}
