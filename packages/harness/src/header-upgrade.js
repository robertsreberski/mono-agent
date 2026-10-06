// @ts-check
// Replace only the header under the already-held native writer/catalogue locks.
// Native records (including their exact byte encoding) are copied, not rewritten.
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { JournalReader } from "./journal-reader.js";
import { JournalValidator, validateJournalHeader } from "./journal-schema.js";
import { canonicalHostJournalAuthority, sameHostJournalAuthority, validateHeaderUpgradeOptions } from "./header-authority.js";
const fail = () => { throw new Error("Native header upgrade evidence unavailable"); };
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const secure = (stat) => stat.isFile() && !(stat.mode & 0o077) && (!process.getuid || stat.uid === process.getuid());
async function writeAll(handle, bytes) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!result.bytesWritten) fail(); offset += result.bytesWritten;
  }
}
async function readAll(handle, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const result = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!result.bytesRead) fail(); offset += result.bytesRead;
  }
}

/** Exact copy proof used by guarded deletion as well as upgrade recovery.
 * The copy is removed first, so a killed deletion never loses its source witness.
 * @param {JournalReader|undefined} source @param {JournalReader} copy @param {any} authority */
export async function assertGuardedHeaderCopy(source, copy, authority) {
  if (!source) fail();
  const sourceIdentity = await source.assertIdentity(), copyIdentity = await copy.assertIdentity();
  const header = await source.readHeader(); validateJournalHeader(header);
  const hostAuthority = canonicalHostJournalAuthority(authority);
  if (header.ownershipSchemaVersion === 2 && !sameHostJournalAuthority(header.hostAuthority, hostAuthority)) fail();
  const upgraded = { ...header, ownershipSchemaVersion: 2, hostAuthority }; validateJournalHeader(upgraded);
  const headerBytes = Buffer.from(JSON.stringify(upgraded) + "\n");
  let bodyOffset = 0, found = false;
  while (bodyOffset < sourceIdentity.size) {
    const chunk = Buffer.alloc(Math.min(65536, sourceIdentity.size - bodyOffset));
    await readAll(source.handle, chunk, bodyOffset); const end = chunk.indexOf(10);
    if (end >= 0) { bodyOffset += end + 1; found = true; break; } bodyOffset += chunk.length;
  }
  if (!found || copyIdentity.nlink !== 1 || copyIdentity.size > headerBytes.length + sourceIdentity.size - bodyOffset) fail();
  for (let offset = 0; offset < copyIdentity.size;) {
    const length = Math.min(65536, copyIdentity.size - offset, offset < headerBytes.length ? headerBytes.length - offset : Infinity);
    const actual = Buffer.alloc(length), expected = Buffer.alloc(length); await readAll(copy.handle, actual, offset);
    if (offset < headerBytes.length) headerBytes.copy(expected, 0, offset, offset + length);
    else await readAll(source.handle, expected, bodyOffset + offset - headerBytes.length);
    if (!actual.equals(expected)) fail(); offset += length;
  }
  if (!unchanged(await source.assertIdentity(), sourceIdentity) || !unchanged(await copy.assertIdentity(), copyIdentity)) fail();
  return upgraded;
}

/** @param {any} repo @param {any} metadata @param {any} options */
export async function publishGuardedHeader(repo, metadata, options) {
  validateHeaderUpgradeOptions(options);
  const onPhase = options.onPhase ?? repo.onHeaderUpgradePhase;
  const authority = canonicalHostJournalAuthority(options.hostAuthority);
  await options.assertOwned(); await repo.assertDirectory();
  const reader = await JournalReader.open(metadata.path, repo.root);
  let stage, createdIdentity;
  let publicationComplete = false;
  const temporary = `${metadata.path}.upgrading`;
  try {
    /** @type {any} */ let header;
    let bodyOffset = 0;
    const validator = new JournalValidator();
    const evidence = await reader.scan((record, address) => {
      if (!header) {
        validateJournalHeader(record); header = record; bodyOffset = address.length + 1;
        if (header.id !== metadata.id || header.journalId !== metadata.journalId) fail();
        if (header.ownershipSchemaVersion === 2 && !sameHostJournalAuthority(header.hostAuthority, authority)) fail();
      } else {
        validator.apply(record);
        const owner = record.kind === "owner_binding" ? record.payload : record.payload.binding;
        if (owner && owner.kind !== "unbound" && (owner.kind !== "host" || owner.ownerKey !== authority.ownerKey || owner.historyBucket !== authority.historyBucket)) fail();
        if (record.kind === "turn_start" && record.payload.binding?.handleId !== undefined && record.payload.binding.handleId !== header.id) fail();
      }
    });
    if (!header || evidence.torn || validator.openTurns.size || validator.openOperations.size) fail();
    const assertSource = async () => {
      await options.assertOwned(); await repo.assertDirectory();
      if (!unchanged(await reader.assertIdentity(), evidence.identity)) fail();
    };
    await assertSource();
    const upgraded = { ...header, ownershipSchemaVersion: 2, hostAuthority: authority };
    validateJournalHeader(upgraded);
    if (header.ownershipSchemaVersion === 2) {
      // A restart after rename but before directory fsync must re-establish the
      // barrier; there is no downgrade or second rename.
      const handle = await open(metadata.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!unchanged(await handle.stat(), evidence.identity)) fail(); await handle.sync(); }
      finally { await handle.close(); }
      await repo.syncDirectories(); await assertSource();
      return { ...upgraded, path: metadata.path };
    }
    const headerBytes = Buffer.from(`${JSON.stringify(upgraded)}\n`);
    const expectedSize = headerBytes.length + evidence.identity.size - bodyOffset;
    // An abandoned stage may be removed only when ALL of its bytes are an exact
    // prefix of this guarded header + this pinned source body. Unknown evidence
    // pins the upgrade/deletion instead of being silently discarded.
    let abandoned;
    try { abandoned = await lstat(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (abandoned) {
      const before = abandoned;
      if (!secure(before) || before.size > expectedSize) fail();
      const copy = await JournalReader.open(temporary, repo.root);
      try { await assertGuardedHeaderCopy(reader, copy, authority); await assertSource(); }
      finally { await copy.close(); }
      if (!unchanged(await lstat(temporary), before)) fail();
      await unlink(temporary); await repo.syncDirectories();
    }
    stage = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stageIdentity = await stage.stat();
    createdIdentity = stageIdentity;
    await onPhase("stage_created");
    await writeAll(stage, headerBytes); await onPhase("header_written");
    for (let offset = bodyOffset; offset < evidence.identity.size;) {
      const chunk = Buffer.alloc(Math.min(65536, evidence.identity.size - offset));
      await readAll(reader.handle, chunk, offset); await writeAll(stage, chunk); offset += chunk.length;
      await onPhase("body_copied");
    }
    await assertSource();
    const copied = await stage.stat();
    if (copied.size !== expectedSize || !secure(copied) || !unchanged(await lstat(temporary), copied)) fail();
    await stage.sync(); await onPhase("stage_synced");
    await assertSource();
    if (!unchanged(await stage.stat(), copied) || !unchanged(await lstat(temporary), copied)
      || stageIdentity.dev !== copied.dev || stageIdentity.ino !== copied.ino) fail();
    await rename(temporary, metadata.path); publicationComplete = true;
    await onPhase("published");
    await repo.syncDirectories(); await onPhase("publication_synced");
    await options.assertOwned(); await repo.assertDirectory();
    const published = await lstat(metadata.path);
    if (published.dev !== copied.dev || published.ino !== copied.ino || published.size !== copied.size || published.mtimeMs !== copied.mtimeMs || !secure(published)) fail();
    return { ...upgraded, path: metadata.path };
  } catch (error) {
    // Still under native writer/catalogue ownership: remove only the stage this
    // invocation created. A lost host claim cannot authorize publication, but
    // does not require preserving our unpublished duplicate copy. Replaced or
    // pre-existing unknown evidence remains pinned. SIGKILL recovery is separate.
    if (createdIdentity && !publicationComplete) {
      try {
        await repo.assertDirectory();
        let current;
        try { current = await lstat(temporary); } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
        if (current?.dev === createdIdentity.dev && current?.ino === createdIdentity.ino) {
          await unlink(temporary); await repo.syncDirectories();
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Native header upgrade failed and stage cleanup is incomplete", { cause: error });
      }
    }
    throw error;
  } finally { await stage?.close(); await reader.close(); }
}
