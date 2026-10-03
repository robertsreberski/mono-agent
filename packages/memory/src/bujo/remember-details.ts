import { relative } from "node:path";

import type { MemoryDb, MemoryRecord } from "../store/index.js";
import { findCanonicalMemoryBullet, REMEMBER_ID_PREFIX } from "./canonical-lookup.js";
import { replayCaptureIntent, writeCaptureIntent, type CaptureIntentAction } from "./capture-outbox.js";
import { dailyFilePath, normalizeMemoryText, normalizedContentHash, readUniqueBullet } from "./daily.js";
import { assertNoShadowedLegacyDailyFile } from "./remember-layout.js";
import { serializeBullet } from "./grammar.js";
import { canonicalMemoryLabel, labelsOf, withMemoryLabels } from "./labels.js";
import { withSerializedBujoMutation } from "./mutation-lock.js";
import { assertCanonicalGraphRepairBaseParity } from "./rebuild.js";
import { assertBoundedMemoryText } from "./text-safety.js";
import type { Bullet, MemoryRememberResult } from "./types.js";

class RememberDetailsPartialWriteError extends Error {
  readonly rememberIntentWritten = true as const;
  constructor(override readonly cause: unknown) {
    super(`memory-bujo: Remember write intent is durable but replay did not finish: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "RememberDetailsPartialWriteError";
  }
}

const SALIENCE = 0.8;
const MAX_TEXT_BYTES = 2048;
const DETAILS_MARKER = "remember-details:v1";
const CAPTURE_ID = /^C-[a-f0-9]{64}-\d{2,}$/u;

/** The explicit subject and replacement are never inferred from the sentence. */
export interface RememberDetails {
  readonly about?: string;
  readonly supersedes?: string;
  readonly abortSignal?: AbortSignal;
}

function matchesDetails(root: string, db: MemoryDb, id: string, about: string | undefined): boolean {
  const canonical = findCanonicalMemoryBullet(root, id, "remembered memory");
  if (canonical?.bullet.status !== "open" || !canonical.bullet.refs.includes(DETAILS_MARKER)) return false;
  const associations = db.allMemoryAssociations().filter((association) => association.memoryId === id
    && association.provenance === "capture");
  const expectedLabels = about === undefined ? [] : [{ v: 1 as const, kind: "fact" as const,
    entityId: about, attribution: "assistant-inferred" as const }];
  return JSON.stringify(labelsOf(canonical.bullet).map(canonicalMemoryLabel))
      === JSON.stringify(expectedLabels.map(canonicalMemoryLabel))
    && (about === undefined ? associations.length === 0
      : associations.length === 1 && associations[0]?.entityId === about);
}

/** One serialized, recoverable BuJo write; no classifier or model calls. */
export async function rememberWithDetails(
  root: string,
  db: MemoryDb,
  clock: () => Date,
  conversationId: string,
  text: string,
  details: RememberDetails,
): Promise<MemoryRememberResult> {
  const stored = normalizeMemoryText(text);
  assertBoundedMemoryText(stored, "remembered", "text", MAX_TEXT_BYTES, false, true);
  const hash = normalizedContentHash(stored);
  const id = `${REMEMBER_ID_PREFIX}${hash}`;
  return await withSerializedBujoMutation({ root, db,
    ...(details.abortSignal === undefined ? {} : { abortSignal: details.abortSignal }),
    canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity }, async () => {
    details.abortSignal?.throwIfAborted();
    const about = details.about;
    if (about !== undefined) {
      const person = db.getEntity(about);
      if (!about.startsWith("person:") || person === undefined
        || (person.type !== undefined && person.type !== "person")) {
        throw new Error("memory-bujo: about must identify an existing person entity.");
      }
    }
    const targetId = details.supersedes;
    if (targetId !== undefined && targetId === id) {
      throw new Error("memory-bujo: a memory cannot supersede itself.");
    }
    const existing = db.get(id);
    if (existing?.supersededBy !== undefined) {
      throw new Error("memory-bujo: this exact text was superseded; record the new state with its date and source.");
    }
    const target = targetId === undefined ? undefined : db.get(targetId);
    if (targetId !== undefined && target === undefined) throw new Error("memory-bujo: supersedes target is unavailable.");
    if (target !== undefined && target.supersededBy === id && existing !== undefined) {
      // A completed replacement is idempotent only with its original subject and
      // attribution; a content hash alone cannot certify those details.
      if (existing.text !== stored || existing.status !== "open" || !matchesDetails(root, db, id, about)) {
        throw new Error("memory-bujo: remembered text already has conflicting details.");
      }
      return { id, conversationId, source: existing.source.file ?? "", text: stored,
        bytesWritten: 0, duplicate: true, recovered: false, supersededId: target.id };
    }
    if (existing !== undefined && targetId === undefined && existing.status === "open"
      && existing.text === stored && existing.supersededBy === undefined) {
      if (matchesDetails(root, db, id, about)) {
        return { id, conversationId, source: existing.source.file ?? "", text: stored,
          bytesWritten: 0, duplicate: true, recovered: false };
      }
    }
    const located = existing === undefined ? findCanonicalMemoryBullet(root, id, "remembered memory") : undefined;
    if (existing !== undefined || located !== undefined) {
      if (existing?.status === "invalidated" || existing?.status === "dropped"
        || located?.bullet.status === "invalidated" || located?.bullet.status === "dropped") {
        throw new Error("memory-bujo: this exact text was forgotten and cannot be restored through Remember.");
      }
      throw new Error("memory-bujo: remembered text already exists with different details; retry the original write.");
    }
    let oldBullet: Bullet | undefined;
    if (target !== undefined) {
      if ((target.type !== "note" && target.type !== "event") || target.status !== "open" || target.supersededBy !== undefined
        || target.validTo !== undefined || target.supersededAt !== undefined || target.source.file === undefined) {
        throw new Error("memory-bujo: supersedes target is not a current ordinary note.");
      }
      oldBullet = readUniqueBullet(root, target.source.file, target.id);
      if (oldBullet === undefined || oldBullet.status !== "open") {
        throw new Error("memory-bujo: supersedes target has no matching current canonical note.");
      }
      if (labelsOf(oldBullet).some((label) => label.kind === "preference" || label.kind === "lesson"
        || (label.kind === "fact" && label.attribution === "user-stated"))) {
        throw new Error("memory-bujo: user-stated facts and standing guidance cannot be superseded by Remember.");
      }
      if (!CAPTURE_ID.test(target.id) && !oldBullet.refs.includes(DETAILS_MARKER)) {
        throw new Error("memory-bujo: supersedes accepts only captured notes/events or enhanced Remember writes.");
      }
    }
    const now = clock();
    const at = new Date(Math.max(now.getTime(), target === undefined ? 0 : Date.parse(target.createdAt))).toISOString();
    const file = relative(root, dailyFilePath(root, new Date(at)));
    assertNoShadowedLegacyDailyFile(root, new Date(at));
    const bullet: Bullet = withMemoryLabels({ id, type: "note", status: "open", text: stored,
      salience: SALIENCE, isInsight: false, createdAt: at, refs: [`sha256:${hash}`, DETAILS_MARKER] },
    about === undefined ? [] : [{ v: 1, kind: "fact", entityId: about, attribution: "assistant-inferred" }]);
    const record: MemoryRecord = { id, type: bullet.type, status: bullet.status, text: stored,
      salience: bullet.salience, isInsight: false, createdAt: at, accessCount: 0, tags: [],
      source: { session: conversationId, file } };
    // Prepare embeddings before publishing the intent or changing canonical source.
    const [vector] = await db.prepareUpsertVectors([record]);
    details.abortSignal?.throwIfAborted();
    const afterNew = { file, bullet };
    let action: CaptureIntentAction;
    if (target !== undefined) {
      const oldFile = target.source.file!;
      action = { candidateIndex: 0, kind: "supersede", oldId: target.id, newId: id,
        beforeOld: { file: oldFile, bullet: oldBullet! },
        afterOld: { file: oldFile, bullet: { ...oldBullet!, status: "invalidated" } },
        afterNew, record, ...(vector === undefined ? {} : { vector }), at };
    } else {
      action = { candidateIndex: 0, kind: "add", id, after: afterNew, record,
        ...(vector === undefined ? {} : { vector }), threads: [] };
    }
    const handle = writeCaptureIntent(root, [action], {
      entities: about === undefined ? [] : [db.getEntity(about)!], relations: [],
      associations: about === undefined ? [] : [{
        memoryId: id, entityId: about, provenance: "capture", createdAt: at,
      }],
    }, at);
    // Once published, any failure is recoverable on the next mutation or restart.
    try {
      replayCaptureIntent(root, handle, db, { canonicalGraphRepairGuard: assertCanonicalGraphRepairBaseParity });
    } catch (error) {
      throw new RememberDetailsPartialWriteError(error);
    }
    return { id, conversationId, source: file, text: stored,
      bytesWritten: Buffer.byteLength(`${serializeBullet(bullet)}\n`, "utf8"),
      duplicate: false, recovered: false, ...(targetId === undefined ? {} : { supersededId: targetId }) };
  });
}
