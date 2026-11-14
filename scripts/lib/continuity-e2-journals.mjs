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
  const identities = [], inodes = [], sizes = [];
  for (const name of entries) {
    const stat = await lstat(join(directory, name)); need(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink());
    identities.push(identity(stat)); sizes.push(stat.size); inodes.push({ directoryDev: initial.dev, directoryIno: initial.ino, fileDev: stat.dev, fileIno: stat.ino });
  }
  async function changedFiles() {
    const final = await lstat(directory);
    need(final.isDirectory() && final.dev === initial.dev && final.ino === initial.ino && final.mtimeMs === initial.mtimeMs && final.ctimeMs === initial.ctimeMs && await realpath(directory) === directory
      && (await names()).join() === entries.join());
    const changed = [];
    for (const [i, name] of entries.entries()) {
      const stat = await lstat(join(directory, name));
      need(stat.isFile() && stat.nlink === 1 && !stat.isSymbolicLink() && stat.dev === inodes[i].fileDev && stat.ino === inodes[i].fileIno);
      if (identity(stat) !== identities[i]) changed.push({ name, stamp: identity(stat), size: stat.size, previousSize: sizes[i] });
    }
    return changed;
  }
  return { names: entries, identity(name) { need(entries.includes(name)); return inodes[entries.indexOf(name)]; }, changedFiles,
    async assertStable(proof) {
      const changed = await changedFiles();
      // The only exception is an already observed append that a caller has
      // authenticated with a single reread. Any subsequent change refuses.
      need(proof ? changed.length === 1 && changed[0].name === proof.name && changed[0].stamp === proof.stamp : changed.length === 0);
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
  return { header, validator, records, lines, bytes };
}
export function e2ActiveBranch(validator) {
  const chain = [];
  for (let id = validator.tip; id !== null;) {
    const info = validator.contextInfo.get(id); need(info && chain.length < 1000000);
    chain.push({ id, ...info }); id = info.parentId;
  }
  return chain;
}
async function readScopedJournals(work, readArtifact) {
  const scope = await e2JournalScope(work), budget = { bytes: 0 }, journals = [];
  for (const name of scope.names) journals.push({ ...await readE2Journal(work, name.slice(0, -6), readArtifact, budget), identity: scope.identity(name) });
  return { scope, budget, journals };
}
export async function scanE2Journals(work, readArtifact) {
  const { scope, journals } = await readScopedJournals(work, readArtifact);
  await scope.assertStable(); return journals;
}
// Completed-checkpoint assembly alone can prove one append-only lifecycle tail.
// Hold/consume/discovery scans above remain strict. This is a consistency proof,
// not a retry: one additional bounded read shares the original aggregate budget.
export async function scanE2CheckpointJournals(work, readArtifact) {
  const { scope, budget, journals } = await readScopedJournals(work, readArtifact);
  need(journals.every(j => [...j.validator.operations.values()].every(op => op.end || op.start.payload.type !== "compaction")));
  const changes = await scope.changedFiles();
  if (!changes.length) return journals;
  need(changes.length === 1 && changes[0].size > changes[0].previousSize);
  const change = changes[0], index = journals.findIndex(j => j.header.journalId + ".jsonl" === change.name), prior = journals[index];
  const next = await readE2Journal(work, prior.header.journalId, readArtifact, budget);
  need(next.bytes.length === change.size && prior.bytes.length >= change.previousSize && next.bytes.length >= prior.bytes.length
    && next.bytes.subarray(0, prior.bytes.length).equals(prior.bytes) && next.bytes[change.previousSize - 1] === 10
    && Buffer.from(next.bytes.toString("utf8")).equals(next.bytes));
  // The append can precede the first read but follow directory discovery. In
  // that case the reread still authenticates every byte observed the first time.
  const suffixLines = next.bytes.subarray(change.previousSize).toString("utf8").split("\n");
  need(suffixLines.pop() === "");
  const suffix = suffixLines.map(line => JSON.parse(line));
  need(suffix.length > 0 && suffix.every(r => r.kind !== "compaction" && next.validator.operations.get(r.operationId)?.start.payload.type !== "compaction"));
  await scope.assertStable(change);
  journals[index] = { ...next, identity: prior.identity };
  return journals;
}
export async function findE2ActiveCompaction(work, operationDigest, readArtifact) {
  const journals = await scanE2Journals(work, readArtifact), live = [];
  for (const journal of journals) for (const operation of journal.validator.operations.values())
    if (!operation.end && operation.start.payload.type === "compaction" && journal.validator.openOperations.has(operation.start.operationId)) live.push({ ...journal, operation });
  need(live.length === 1);
  if (operationDigest !== undefined) need(/^[a-f0-9]{64}$/u.test(operationDigest ?? "") && digest(live[0].operation.start.operationId) === operationDigest);
  return live[0];
}
export function assertE2NativeBinding(binding, journal, externalOperationDigest, payloadDigest) {
  need(binding?.version === 1 && binding.externalOperationDigest === externalOperationDigest && binding.payloadDigest === payloadDigest
    && binding.journalId === journal.header.journalId && binding.nativeOperationDigest === digest(journal.operation.start.operationId)
    && ["directoryDev", "directoryIno", "fileDev", "fileIno"].every(k => binding.identity?.[k] === journal.identity[k])
    && Number.isSafeInteger(binding.lines) && binding.lines > 1 && journal.lines.length >= binding.lines
    && digest(journal.lines.slice(0, binding.lines).join("\n") + "\n") === binding.prefixSha256);
}
export async function bindE2NativeCompaction(work, externalOperationDigest, payloadDigest, readArtifact, previous) {
  need(/^[a-f0-9]{64}$/u.test(externalOperationDigest ?? "") && /^[a-f0-9]{64}$/u.test(payloadDigest ?? ""));
  const journal = await findE2ActiveCompaction(work, undefined, readArtifact);
  if (previous) {
    assertE2NativeBinding(previous, journal, externalOperationDigest, previous.payloadDigest);
    return { ...previous, payloadDigest };
  }
  return { version: 1, externalOperationDigest, payloadDigest, journalId: journal.header.journalId,
    nativeOperationDigest: digest(journal.operation.start.operationId), identity: journal.identity, lines: journal.lines.length,
    prefixSha256: digest(journal.lines.join("\n") + "\n") };
}
