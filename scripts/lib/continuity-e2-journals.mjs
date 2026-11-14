// Bounded controller-owned native reads. Never use a child's discovered journal/hash.
import { readdir, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "./continuity-recorded-schema.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("e2_summary_receipt_invalid"), { code: "e2_summary_receipt_invalid" }); };
export const E2_JOURNAL_SCAN_BYTES = 128 * 1024 * 1024;
// Freeze directory membership and inode identities across the scoped read. A
// replacement/append/alias is not a second authority path, even with equal bytes.
export async function e2JournalScope(work) {
  const directory = join(work, "sessions", "journals");
  need(await realpath(directory) === directory);
  const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  const initial = await lstat(directory); need(initial.isDirectory() && !initial.isSymbolicLink());
  const names = async () => (await readdir(directory)).filter(n => /^[A-Za-z0-9_-]+\.jsonl$/u.test(n)).sort();
  const entries = await names(); need(entries.length <= 8192);
  const identities = [];
  for (const name of entries) {
    const stat = await lstat(join(directory, name)); need(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink());
    identities.push(identity(stat));
  }
  return { names: entries, async assertStable() {
    const final = await lstat(directory);
    need(final.isDirectory() && final.dev === initial.dev && final.ino === initial.ino && final.mtimeMs === initial.mtimeMs && final.ctimeMs === initial.ctimeMs && await realpath(directory) === directory
      && (await names()).join() === entries.join());
    for (const [i, name] of entries.entries()) {
      const stat = await lstat(join(directory, name)); need(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink() && identity(stat) === identities[i]);
    }
  } };
}
export async function readE2Journal(work, journalId, readArtifact, budget = { bytes: 0 }) {
  need(typeof journalId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(journalId));
  need(Number.isSafeInteger(budget.bytes) && budget.bytes >= 0 && budget.bytes < E2_JOURNAL_SCAN_BYTES);
  const remaining = E2_JOURNAL_SCAN_BYTES - budget.bytes;
  const bytes = await readArtifact(join(work, "sessions", "journals", `${journalId}.jsonl`), "e2_summary_receipt_invalid", remaining);
  need(bytes.length <= remaining); budget.bytes += bytes.length;
  const lines = bytes.toString("utf8").split("\n"); need(lines.pop() === "" && lines.length > 1 && lines.length <= 1000000);
  const header = JSON.parse(lines[0]);
  const { JournalValidator, validateJournalHeader } = await import(new URL("../../packages/turn/dist/engine/journal-schema.js", import.meta.url).href);
  validateJournalHeader(header); need(header.journalId === journalId && header.cwd === work);
  const validator = new JournalValidator(), records = [];
  for (const line of lines.slice(1)) {
    const record = JSON.parse(line), p = record.payload, retained = ["retained_summary_admitted", "reseed_predecessor_admitted"].includes(record.kind);
    if (retained) need(p.destination.handleId === header.id && p.destination.journalId === header.journalId);
    if (header.hostAuthority) {
      const a = header.hostAuthority, owner = record.kind === "owner_binding" ? p : p?.binding;
      if (retained) need(p.binding.logicalConversationId === a.ownerKey && p.binding.conversationId === a.historyBucket);
      else if (owner && owner.kind !== "unbound") need(owner.kind === "host" && owner.ownerKey === a.ownerKey && owner.historyBucket === a.historyBucket);
    } else need(p?.projectionBinding === undefined && p?.compaction?.checkpoint?.inheritedCoverage === undefined && p?.artifactRef === undefined);
    validator.apply(record); records.push(record);
  }
  return { header, validator, records, lines };
}
export function e2ActiveBranch(validator) {
  const chain = [];
  for (let id = validator.tip; id !== null;) {
    const info = validator.contextInfo.get(id); need(info && chain.length < 1000000);
    chain.push({ id, ...info }); id = info.parentId;
  }
  return chain;
}
export async function findE2ActiveCompaction(work, operationDigest, readArtifact) {
  need(/^[a-f0-9]{64}$/u.test(operationDigest ?? ""));
  const scope = await e2JournalScope(work), names = scope.names;
  need(names.length > 0);
  const budget = { bytes: 0 }; let match;
  for (const name of names) {
    const journal = await readE2Journal(work, name.slice(0, -6), readArtifact, budget);
    for (const operation of journal.validator.operations.values()) if (digest(operation.start.operationId) === operationDigest) {
      need(!match && !operation.end && operation.start.payload.type === "compaction" && journal.validator.openOperations.has(operation.start.operationId));
      match = { ...journal, operation };
    }
  }
  await scope.assertStable(); need(match); return match;
}
