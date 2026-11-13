import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MemorySessionRepo } from "../../engine/session-store.js";
import { createRunDriver } from "../../engine/run-driver.js";
import { resolveRetainedSummaryAdmission, validRetainedSummaryReceipt } from "../../engine/retained-summary.js";
import type { RuntimeRetainedSummaryAccess, RuntimeRetainedSummaryCandidate } from "../../contracts/retained-summary.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const text = "## Historical events and corrections\n- Morgan chose cobalt; coral was rejected.\n\n## Pending items\n- Review the fictional diagram.";
const binding = { version: 1 as const, logicalConversationId: "fiction", conversationId: "fiction:bucket", generationId: "generation",
  recordId: "record", sha256: hash(text), retainedBytes: Buffer.byteLength(text), sourceEpoch: "source-epoch", sourceRevision: 2,
  publication: { journalId: "source-journal", operationId: "source-operation", sourceDigest: hash("coverage"), summaryDigest: hash(text) } };
const entry = `Generated summary evidence id="record" sha256="${hash(text)}": ${JSON.stringify(text)}\n`;
const pack = `Fictional pack\n${entry}Coverage: fictional.\n`;
const candidate: RuntimeRetainedSummaryCandidate = { binding, selection: { recordId: binding.recordId, generationId: binding.generationId,
  sha256: binding.sha256, retainedBytes: binding.retainedBytes, packSha256: hash(pack),
  entry: { startByte: Buffer.byteLength("Fictional pack\n"), endByte: Buffer.byteLength(`Fictional pack\n${entry}`), sha256: hash(entry) } } };
const model = { provider: "faux", id: "fixture", api: "faux", contextWindow: 65536, maxTokens: 8192 };
async function fixture(stringSeed = false) {
  const repo = new MemorySessionRepo(), raw = await repo.create({ id: "fiction-handle" });
  const seed = await raw.appendMessage({ role: "user", content: stringSeed ? pack : [{ type: "text", text: pack }], timestamp: 0 });
  const resolve = vi.fn(async () => ({ text } as { text: string } | undefined));
  const access: RuntimeRetainedSummaryAccess = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination-epoch", handleId: "fiction-handle" },
    assertCurrent: vi.fn(async () => {}), resolve };
  const driver = createRunDriver(raw, { model, retainedSummaryAccess: access });
  const descriptor = { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: "fiction-handle", turnId: "host-turn", baseRevision: 0 };
  return { repo, raw, driver, access, resolve, seed, descriptor };
}
it.each([false, true])("persists only inside the owned turn, binds the exact seed and resolves after reopen (string=%s)", async stringSeed => {
  const f = await fixture(stringSeed);
  await expect(f.driver.admitRetainedSummary(candidate, f.seed)).rejects.toThrow("owned host turn");
  await f.driver.beginTurn("host-turn", "host", f.descriptor);
  await f.driver.admitRetainedSummary(candidate, f.seed);
  const receipt = f.raw.validator.retainedSummaryAdmission;
  expect(validRetainedSummaryReceipt(receipt.payload)).toBe(true);
  expect(receipt.turnId).toBe("host-turn");
  expect(receipt.payload.destination.epoch).toBe("destination-epoch");
  expect(JSON.stringify(receipt.payload)).not.toContain("Morgan");
  expect(await resolveRetainedSummaryAdmission(f.raw, f.access)).toEqual({ admissionId: receipt.id, text });
  await f.driver.endTurn("completed"); await f.raw.close();
  const reopened = await f.repo.open(f.raw.metadata, { validateSession: async (raw: any) => { await resolveRetainedSummaryAdmission(raw, f.access); } });
  expect(await resolveRetainedSummaryAdmission(reopened, f.access)).toEqual({ admissionId: receipt.id, text });
  await reopened.close();
});
it.each(["digest", "selection", "seed", "scope"] as const)("rejects altered %s before admission", async damage => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const forged = structuredClone(candidate);
  if (damage === "digest") (forged.binding as any).sha256 = hash("forged");
  if (damage === "selection") (forged.selection.entry as any).endByte--;
  if (damage === "scope") (forged.binding as any).conversationId = "other-bucket";
  const seed = damage === "seed" ? await f.raw.appendMessage({ role: "user", content: [{ type: "text", text: "Copied fingerprint without quotation" }], timestamp: 0 }) : f.seed;
  await expect(f.driver.admitRetainedSummary(forged, seed)).rejects.toThrow();
  expect(f.raw.validator.retainedSummaryAdmission).toBeNull();
  await f.driver.endTurn("failed"); await f.raw.close();
});
it.each(["resolver", "epoch", "handle", "logical", "bucket", "purge"] as const)("fails closed for missing/wrong %s on active restart", async damage => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  let access: RuntimeRetainedSummaryAccess | undefined = f.access;
  if (damage === "resolver") access = undefined;
  if (damage === "epoch") (f.access.destination as any).epoch = "wrong";
  if (damage === "handle") (f.access.destination as any).handleId = "wrong";
  if (damage === "logical") (f.access.destination as any).logicalConversationId = "wrong";
  if (damage === "bucket") (f.access.destination as any).conversationId = "wrong";
  if (damage === "purge") f.resolve.mockResolvedValue(undefined);
  await expect(resolveRetainedSummaryAdmission(f.raw, access)).rejects.toThrow();
  await f.driver.endTurn("failed"); await f.raw.close();
});
it("does not promote an orphan seed and rejects duplicate/unknown receipt metadata", async () => {
  const f = await fixture();
  expect(await resolveRetainedSummaryAdmission(f.raw)).toBeUndefined();
  await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  const receipt = f.raw.validator.retainedSummaryAdmission.payload;
  expect(validRetainedSummaryReceipt({ ...receipt, text })).toBe(false);
  await expect(f.driver.admitRetainedSummary(candidate, f.seed)).rejects.toThrow();
  await f.driver.endTurn("completed"); await f.raw.close();
});
it("uses branch-local successor coverage, stops source resolution, and reactivates on rewind", async () => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  let predecessor: unknown;
  f.driver.hooks.on("before_compaction", (event: any) => { predecessor = event.retainedPredecessor; return { compaction: { summary: text, retainedTail: [], tokensBefore: 1000 } }; });
  const cut = await f.driver.compact();
  expect(predecessor).toEqual({ admissionId: f.raw.validator.retainedSummaryAdmission.id, text });
  expect(cut.checkpoint.retainedSummaryCoverage.admissionId).toBe(f.raw.validator.retainedSummaryAdmission.id);
  for (let index = 0; index < 5; index++) {
    const next = await f.driver.compact();
    expect(next.checkpoint.retainedSummaryCoverage).toEqual(cut.checkpoint.retainedSummaryCoverage);
  }
  expect(f.raw.records!.filter((record: any) => record.kind === "retained_summary_admitted")).toHaveLength(1);
  f.resolve.mockClear(); f.resolve.mockResolvedValue(undefined);
  expect(await resolveRetainedSummaryAdmission(f.raw, f.access)).toBeUndefined(); expect(f.resolve).not.toHaveBeenCalled();
  await f.driver.endTurn("completed"); await f.raw.close();
  const raw = await f.repo.open(f.raw.metadata, { validateSession: async (raw: any) => { await resolveRetainedSummaryAdmission(raw, f.access); } });
  expect(f.resolve).not.toHaveBeenCalled();
  await raw.moveTo(f.seed); f.resolve.mockResolvedValue({ text });
  expect(await resolveRetainedSummaryAdmission(raw, f.access)).toEqual({ admissionId: raw.validator.retainedSummaryAdmission.id, text });
  f.resolve.mockResolvedValue(undefined);
  expect(await resolveRetainedSummaryAdmission(raw, f.access)).toBeUndefined(); // Rewind + revoked source: legacy, not unavailable.
  await raw.close();
});

it.each(["seed", "turn_start", "receipt_write"] as const)("SIGKILL at admission boundary %s never promotes an orphan or partial receipt", async stage => {
  const root = await mkdtemp(join(tmpdir(), "retained-admission-crash-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  try {
    const script = `
      import { JsonlSessionRepo } from ${JSON.stringify(new URL("../../../dist/engine/session-store.js", import.meta.url).href)};
      import { createRunDriver } from ${JSON.stringify(new URL("../../../dist/engine/run-driver.js", import.meta.url).href)};
      globalThis.fetch = () => { throw Error("Network forbidden"); };
      const repo = new JsonlSessionRepo({ sessionsRoot: ${JSON.stringify(root)} });
      const raw = await repo.create({ id: "fiction-handle" });
      const seed = await raw.appendMessage({ role: "user", content: ${JSON.stringify(pack)}, timestamp: 1 });
      const stop = () => process.kill(process.pid, "SIGKILL");
      if (${JSON.stringify(stage)} === "seed") stop();
      const begin = raw.beginTurn.bind(raw), write = raw.write.bind(raw);
      raw.beginTurn = async (...args) => { const result = await begin(...args); if (${JSON.stringify(stage)} === "turn_start" && args[0] === "host-turn") stop(); return result; };
      raw.write = async (kind, ...args) => { const result = await write(kind, ...args); if (${JSON.stringify(stage)} === "receipt_write" && kind === "retained_summary_admitted") stop(); return result; };
      const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination-epoch", handleId: "fiction-handle" },
        assertCurrent: async () => {}, resolve: async () => ({ text: ${JSON.stringify(text)} }) };
      const driver = createRunDriver(raw, { model: ${JSON.stringify(model)}, retainedSummaryAccess: access });
      await driver.beginTurn("host-turn", "host", { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: "fiction-handle", turnId: "host-turn", baseRevision: 0 });
      await driver.admitRetainedSummary(${JSON.stringify(candidate)}, seed);
      throw Error("Crash boundary not reached");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)), encoding: "utf8", timeout: 15000 });
    expect(result.signal, result.stderr).toBe("SIGKILL");
    const metadata = await repo.find("fiction-handle");
    const access: RuntimeRetainedSummaryAccess = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination-epoch", handleId: "fiction-handle" },
      assertCurrent: async () => {}, resolve: async () => ({ text }) };
    const raw = await repo.open(metadata, { repair: false, validateSession: async (raw: any) => { await resolveRetainedSummaryAdmission(raw, access); } });
    const predecessor = await resolveRetainedSummaryAdmission(raw, access);
    if (stage === "receipt_write") { expect(predecessor?.text).toBe(text); expect(validRetainedSummaryReceipt(raw.validator.retainedSummaryAdmission.payload)).toBe(true); }
    else { expect(raw.validator.retainedSummaryAdmission).toBeNull(); expect(predecessor).toBeUndefined(); }
    await raw.close();
  } finally { await repo.close(); await rm(root, { recursive: true, force: true }); }
}, 20000);
