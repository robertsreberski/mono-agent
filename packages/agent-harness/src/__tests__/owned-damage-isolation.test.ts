// One stray, partial or damaged owned file never stops unrelated conversations.
// Damage refuses only its owner (typed), stays charged and is never deleted.
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeSessionTurnReconciliationResult } from "@mono-agent/runtime-adapter";
import { createDurableHistoryStore } from "../durable-history.js";
import { PendingTurnPayloadStore, pendingCoordinates } from "../durable-turn-payloads.js";
import { createPendingInitialInput, createPendingTurnPayload, pendingPayloadName } from "../durable-turn-contract.js";
import { MODEL_SWITCH_DIRECTORY } from "../durable-model-switch-contract.js";
import type { ConversationHistoryTurnInspection } from "../types.js";

const dirs: string[] = [], timestamp = "2026-01-01T00:00:00.000Z", modelKey = "openai:fictional-model";
const healthy = "fictional-healthy", damagedBucket = "fictional-damaged", older = "fictional-older";
const kinds = ["empty", "invalid JSON", "wrong mode", "hard link"] as const;
type Kind = typeof kinds[number];
const key = (bucket: string) => createHash("sha256").update("mono-agent-history-v1\0").update(bucket).digest("hex");
afterEach(async () => { await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporary(prefix: string) { const root = await mkdtemp(join(tmpdir(), prefix)); dirs.push(root); return root; }
function evidence(request: ConversationHistoryTurnInspection): RuntimeSessionTurnReconciliationResult {
  const { descriptor } = request, initial = request.expectedInputs.find((input) => input.placement === "initial");
  return { status: "matched", journalId: "fictional-journal", handleId: descriptor.handleId, turnId: descriptor.turnId,
    baselineTipId: null, tipId: "fictional-tip", currentTipId: "fictional-tip", outcome: "completed",
    seal: { version: 1, outcome: "completed", result: { text: "Fictional reply.", error: null, failureKind: null, cancelled: false, stopReason: "stop" } },
    binding: { ...descriptor, version: 1, model: { provider: "openai", id: "fictional-model", api: "openai-responses" } },
    inputs: initial ? [{ ...initial, messageId: "fictional-envelope", complete: true }] : [], admittedInputs: [],
    finalOperationId: "fictional-operation", consumedInputIds: initial ? [initial.id] : [],
    operations: [{ operationId: "fictional-operation", type: "prompt", cause: "initial", parentOperationId: null,
      baselineTipId: null, tipId: "fictional-tip", startSeq: 1, endSeq: 2, status: "completed", suspended: false }], interruptionEvidence: [] };
}
async function fixture() {
  const root = await temporary("owned-damage-"), outside = await temporary("owned-damage-alias-");
  const store = createDurableHistoryStore({ root, maxConversations: 2, reconcileProviderSessionTurn: vi.fn(async (request) => evidence(request)),
    retireProviderSession: vi.fn(async () => undefined), now: () => Date.parse(timestamp) });
  const begin = (bucket: string, turnId: string) => store.beginProviderSessionTurn(bucket, turnId, { modelKey,
    reconciliation: { purpose: "execution", ownerKey: bucket, initial: { persistText: "Fictional input.", timestamp } } });
  return { root, outside, store, begin };
}
/** Damage one owned file in place; `alias` lives outside the root for hard links. */
async function damage(path: string, kind: Kind, alias: string) {
  if (kind === "empty") await writeFile(path, "");
  else if (kind === "invalid JSON") await writeFile(path, "{not json");
  else if (kind === "wrong mode") await chmod(path, 0o644);
  else await link(path, alias);
}
async function snapshot(paths: readonly string[]) {
  return Promise.all(paths.map(async (path) => { const info = await lstat(path); return { path, mode: info.mode, nlink: info.nlink, bytes: info.isFile() ? (await readFile(path)).toString("base64") : "dir" }; }));
}
/** The unrelated conversation appends, admits, commits and recovers; retention may evict `older` only. */
async function unrelatedStillWorks(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.append(healthy, [{ role: "user", content: "Fictional plain append." }]);
  const first = await f.begin(healthy, "fictional-turn-1");
  await (await first.prepareCommit([], { providerSessionSynced: true })).commit();
  const second = await f.begin(healthy, "fictional-turn-2"); await second.abort();
  await expect(f.store.recoverProviderSessionTurn(healthy)).resolves.toMatchObject({ status: "recovered", outcome: "completed" });
  expect((await f.store.load(healthy)).filter((message) => message.role === "assistant")).toHaveLength(2);
}
/** Recent (not age-expired) history; a smaller `daysAgo` is more recently used. */
async function canonical(f: Awaited<ReturnType<typeof fixture>>, bucket: string, daysAgo: number) {
  await f.store.append(bucket, [{ role: "user", content: "Fictional earlier history." }]);
  const mtime = (Date.parse(timestamp) - daysAgo * 86_400_000) / 1_000;
  await utimes(join(f.root, `${key(bucket)}.history.json`), mtime, mtime);
}

it.each(kinds)("pending turns: a %s foreign generation is isolated to its owner and survives retention", async (kind) => {
  const f = await fixture(); await canonical(f, damagedBucket, 2); await canonical(f, older, 1);
  const payloads = new PendingTurnPayloadStore(f.root, await lstat(f.root));
  const value = createPendingTurnPayload({ purpose: "execution", ownerKey: damagedBucket, historyBucket: damagedBucket, turnId: "fictional-orphan",
    handleId: "a".repeat(64), modelKey, baseRevision: 0, fenceDigest: "b".repeat(64) },
  [createPendingInitialInput({ id: "initial:fictional", persistText: "Fictional orphan input.", timestamp }, "Fictional orphan input.")], "admitted");
  const pointer = await payloads.publish(value, { assertOwned: async () => undefined, reserve: async () => undefined });
  const directory = join(f.root, ".pending-turns"), coordinates = pendingCoordinates(value.identity);
  const path = join(directory, pendingPayloadName(coordinates.conversationKey, coordinates.runIdDigest, pointer.generation));
  await damage(path, kind, join(f.outside, "alias"));
  await writeFile(join(directory, ".DS_Store"), "Fictional stray", { mode: 0o644 }); await writeFile(join(directory, "notes.json.tmp"), "Fictional stray", { mode: 0o600 });
  await mkdir(join(directory, "scratch"), { mode: 0o700 });
  const preserved = await snapshot([path, join(directory, ".DS_Store"), join(directory, "notes.json.tmp"), join(directory, "scratch")]);

  await unrelatedStillWorks(f);
  // Retention ran (3 conversations, quota 2): only the healthy older history may be evicted.
  await expect(lstat(join(f.root, `${key(older)}.history.json`))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(f.root, `${key(damagedBucket)}.history.json`))).isFile()).toBe(true);
  await expect(f.store.recoverProviderSessionTurn(damagedBucket)).rejects.toMatchObject({ code: "ERR_OWNED_FILE_DAMAGED" });
  expect(await snapshot(preserved.map((entry) => entry.path))).toEqual(preserved);
});

it.each(kinds)("model switches: a %s foreign switch file refuses only its owner and protects it from retention", async (kind) => {
  const f = await fixture(); await canonical(f, damagedBucket, 2); await canonical(f, older, 1);
  const directory = join(f.root, MODEL_SWITCH_DIRECTORY); await mkdir(directory, { mode: 0o700 });
  const path = join(directory, `${key(damagedBucket)}.${"e".repeat(64)}.fence.json`);
  await writeFile(path, JSON.stringify({ version: 6, kind: "model-switch" }), { mode: 0o600 }); await damage(path, kind, join(f.outside, "alias"));
  await writeFile(join(directory, ".DS_Store"), "Fictional stray", { mode: 0o644 }); await mkdir(join(directory, "scratch"), { mode: 0o700 });
  const preserved = await snapshot([path, join(directory, ".DS_Store"), join(directory, "scratch")]);

  await unrelatedStillWorks(f);
  await expect(lstat(join(f.root, `${key(older)}.history.json`))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(f.root, `${key(damagedBucket)}.history.json`))).isFile()).toBe(true);
  await expect(f.store.recoverProviderSessionTurn(damagedBucket)).rejects.toMatchObject({ code: "ERR_OWNED_FILE_DAMAGED" });
  await expect(f.store.modelSwitchStorageSource(damagedBucket)).rejects.toMatchObject({ code: "ERR_OWNED_FILE_DAMAGED" });
  expect(await snapshot(preserved.map((entry) => entry.path))).toEqual(preserved);
  expect((await readdir(directory)).sort()).toEqual([".DS_Store", `${key(damagedBucket)}.${"e".repeat(64)}.fence.json`, "scratch"]);
});
