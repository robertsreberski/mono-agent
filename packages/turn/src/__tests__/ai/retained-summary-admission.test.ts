import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createHash } from "node:crypto";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { generateEngineTurnResponse } from "../../execution/pi/run.js";
import { nativeSessionRegistry } from "../../engine/session-lifecycle.js";
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
async function fixture(stringSeed = false, repo: MemorySessionRepo | JsonlSessionRepo = new MemorySessionRepo()) {
  const raw = await repo.create({ id: "fiction-handle" });
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
  await f.driver.admitRetainedSummary(candidate, f.seed);
  expect(f.raw.validator.retainedSummaryAdmission).toBeNull();
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
  await f.driver.admitRetainedSummary(forged, seed);
  expect(f.raw.validator.retainedSummaryAdmission).toBeNull();
  await f.driver.endTurn("failed"); await f.raw.close();
});
it.each(["epoch", "handle", "logical", "bucket"] as const)("refuses a wrong %s on active restart", async damage => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  const access = f.access;
  if (damage === "epoch") (f.access.destination as any).epoch = "wrong";
  if (damage === "handle") (f.access.destination as any).handleId = "wrong";
  if (damage === "logical") (f.access.destination as any).logicalConversationId = "wrong";
  if (damage === "bucket") (f.access.destination as any).conversationId = "wrong";
  await expect(resolveRetainedSummaryAdmission(f.raw, access)).rejects.toMatchObject({ code: "ERR_RETAINED_SUMMARY_AUTHORITY" });
  await f.driver.endTurn("failed"); await f.raw.close();
});
it("does not promote an orphan seed and rejects duplicate/unknown receipt metadata", async () => {
  const f = await fixture();
  expect(await resolveRetainedSummaryAdmission(f.raw)).toBeUndefined();
  await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  const receipt = f.raw.validator.retainedSummaryAdmission.payload;
  expect(validRetainedSummaryReceipt({ ...receipt, text })).toBe(false);
  await f.driver.admitRetainedSummary(candidate, f.seed);
  expect(f.raw.records!.filter((record: any) => record.kind === "retained_summary_admitted")).toHaveLength(1);
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
  expect(await resolveRetainedSummaryAdmission(f.raw, undefined)).toBeUndefined();
  expect(await resolveRetainedSummaryAdmission(f.raw, { ...f.access, resolve: undefined } as any)).toBeUndefined();
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

it.each(["resolver", "purge", "owner", "boundary"])("losing optional %s on an uncovered admission warns and falls back", async damage => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  const warn = vi.fn(); let access: RuntimeRetainedSummaryAccess | undefined = f.access;
  if (damage === "resolver") access = undefined;
  if (damage === "purge" || damage === "boundary") f.resolve.mockResolvedValue(undefined);
  if (damage === "owner") vi.mocked(f.access.assertCurrent).mockRejectedValue(new Error("Fictional owner unavailable"));
  expect(await resolveRetainedSummaryAdmission(f.raw, access, warn)).toBeUndefined(); expect(warn).toHaveBeenCalledOnce();
  await f.driver.endTurn("completed"); await f.raw.close();
});
it.each(["oversize", "purge"])("skips %s before writing any receipt and continues the owned turn", async damage => {
  const f = await fixture(); const warnings: any[] = []; f.driver.subscribe((event: any) => warnings.push(event));
  await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const value = structuredClone(candidate);
  if (damage === "oversize") (value.binding as any).sourceEpoch = "x".repeat(4097);
  else f.resolve.mockResolvedValue(undefined);
  await f.driver.admitRetainedSummary(value, f.seed);
  expect(f.raw.validator.retainedSummaryAdmission).toBeNull();
  expect(warnings).toContainEqual(expect.objectContaining({ type: "warning", code: "retained_summary_admission_skipped", message: expect.any(String) }));
  expect(JSON.stringify(warnings)).not.toContain(text);
  await f.driver.endTurn("completed"); await f.raw.close();
});
it("accepts source IDs through the shared 4096-byte identity limit", async () => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const value = structuredClone(candidate); (value.binding as any).sourceEpoch = "x".repeat(4096);
  await f.driver.admitRetainedSummary(value, f.seed);
  expect(f.raw.validator.retainedSummaryAdmission.payload.binding.sourceEpoch).toHaveLength(4096);
  await f.driver.endTurn("completed"); await f.raw.close();
});
it("awaits the receipt sync barrier before compaction or dispatch can proceed", async () => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const order: string[] = []; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sync = f.raw.sync.bind(f.raw);
  vi.spyOn(f.raw, "sync").mockImplementation(async () => { order.push("sync-start"); await blocked; await sync(); order.push("synced"); });
  f.driver.hooks.on("before_compaction", () => { order.push("compaction"); return undefined; });
  const admitted = f.driver.admitRetainedSummary(candidate, f.seed).then(async () => {
    await expect(f.driver.compact()).rejects.toThrow("compaction cancelled");
    order.push("dispatch-eligible");
  });
  await vi.waitFor(() => expect(order).toContain("sync-start"));
  expect(f.raw.validator.retainedSummaryAdmission).toBeTruthy(); expect(order).toEqual(["sync-start"]);
  release(); await admitted;
  expect(order).toEqual(["sync-start", "synced", "compaction", "dispatch-eligible"]);
  await f.driver.endTurn("completed"); await f.raw.close();
});

it("refuses a persisted selection slice that matches its pack commitment but not the rendered source entry", async () => {
  const f = await fixture();
  await f.driver.beginTurn("host-turn", "host", f.descriptor);
  await f.driver.admitRetainedSummary(candidate, f.seed); await f.driver.endTurn("completed");
  const persisted = f.raw.records!.find((record: any) => record.kind === "retained_summary_admitted")!;
  const selected = persisted.payload.selection.entry;
  selected.startByte++;
  selected.sha256 = hash(Buffer.from(pack).subarray(selected.startByte, selected.endByte).toString());
  expect(persisted.payload.selection.packSha256).toBe(hash(pack));
  expect(validRetainedSummaryReceipt(persisted.payload)).toBe(true);
  await f.raw.close();
  f.resolve.mockClear(); const warn = vi.fn();
  await expect(f.repo.open(f.raw.metadata, { validateSession: async (raw: any) => {
    await resolveRetainedSummaryAdmission(raw, f.access, warn);
  } })).rejects.toMatchObject({ code: "ERR_RETAINED_SUMMARY_AUTHORITY" });
  expect(f.resolve).toHaveBeenCalledOnce(); expect(warn).not.toHaveBeenCalled();
  await f.repo.close();
});

it.each(["hash", "bytes"])("source-side %s mismatch still warns and uses legacy context", async damage => {
  const f = await fixture();
  await f.driver.beginTurn("host-turn", "host", f.descriptor); await f.driver.admitRetainedSummary(candidate, f.seed);
  if (damage === "hash") f.resolve.mockResolvedValue({ text: text.replace("cobalt", "violet") }); // Equal byte length, wrong hash.
  else {
    // Keep the source hash correct while corrupting its source-side byte claim.
    // Selection/binding metadata remains internally consistent, so the byte check is reached.
    const p = f.raw.validator.retainedSummaryAdmission.payload;
    p.binding.retainedBytes++; p.selection.retainedBytes++;
  }
  const warn = vi.fn();
  expect(await resolveRetainedSummaryAdmission(f.raw, f.access, warn)).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce();
  await f.driver.endTurn("completed"); await f.raw.close();
});

it("preflights actual store authority without writing or advancing validator state", async () => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const originalJournal = f.raw.metadata.journalId, before = f.raw.snapshot(), warnings: any[] = [];
  f.driver.subscribe((event: any) => warnings.push(event));
  const validate = vi.spyOn(f.raw, "validateRecord"), write = vi.spyOn(f.raw, "write");
  f.resolve.mockImplementation(async () => { f.raw.metadata.journalId = "other-journal"; return { text }; });
  try { await f.driver.admitRetainedSummary(candidate, f.seed); }
  finally { f.raw.metadata.journalId = originalJournal; }
  expect(validate).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
  expect(f.raw.snapshot()).toEqual(before); expect(f.raw.failure).toBeNull();
  expect(warnings.filter(event => event.code === "retained_summary_admission_skipped")).toHaveLength(1);
  await f.driver.endTurn("completed"); await f.raw.close();
});

it.each(["write", "barrier"] as const)("propagates a real journal %s failure instead of skipping admission", async stage => {
  const root = await mkdtemp(join(tmpdir(), "retained-admission-io-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const f = await fixture(false, repo);
  try {
    await f.driver.beginTurn("host-turn", "host", f.descriptor);
    const warnings: any[] = []; f.driver.subscribe((event: any) => warnings.push(event));
    const fault = Object.assign(new Error("Fictional journal I/O failure"), { code: "EIO" });
    vi.spyOn(f.raw.io, stage === "write" ? "append" : "sync").mockRejectedValueOnce(fault);
    await expect(f.driver.admitRetainedSummary(candidate, f.seed)).rejects.toMatchObject({ name: "JournalStorageError", code: "EIO", cause: fault });
    expect(f.raw.failure).toMatchObject({ cause: fault });
    expect(Boolean(f.raw.validator.retainedSummaryAdmission)).toBe(stage === "barrier");
    expect(warnings.filter(event => event.code === "retained_summary_admission_skipped")).toHaveLength(0);
  } finally {
    await f.raw.close().catch(() => {}); await repo.close(); await rm(root, { recursive: true, force: true });
  }
});

it.each(["journalId", "malformed"])("refuses on-disk receipt %s damage before source resolution and preserves the public refusal", async damage => {
  const root = await mkdtemp(join(tmpdir(), "retained-admission-journal-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const f = await fixture(false, repo);
  try {
    await f.driver.beginTurn("host-turn", "host", f.descriptor);
    await f.driver.admitRetainedSummary(candidate, f.seed); await f.driver.endTurn("completed"); await f.raw.close();
    const records = (await readFile(f.raw.metadata.path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const receipt = records.find(record => record.kind === "retained_summary_admitted");
    if (damage === "journalId") receipt.payload.destination.journalId = "mismatched-journal";
    else receipt.payload.extra = "unknown-field";
    expect(validRetainedSummaryReceipt(receipt.payload)).toBe(damage === "journalId");
    const damaged = records.map(record => JSON.stringify(record)).join("\n") + "\n";
    await writeFile(f.raw.metadata.path, damaged);
    f.resolve.mockClear();
    await expect(repo.open(f.raw.metadata, { validateSession: async (raw: any) => {
      await resolveRetainedSummaryAdmission(raw, f.access);
    } })).rejects.toMatchObject({ code: "ERR_HARNESS_JOURNAL_CORRUPT" });
    expect(f.resolve).not.toHaveBeenCalled();
    const faux = fauxProvider({ models: [{ id: "fixture" }] }), models = createModels(); models.setProvider(faux.provider);
    const result = await generateEngineTurnResponse("Fictional rules", {
      model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, piResolvedModel: faux.getModel(), piResolvedModels: models,
      effort: "none", allowedTools: [], sessionId: f.raw.metadata.id, sessionsRoot: root, sessionKeepAlive: true,
      messages: [{ role: "user", content: "Fictional resume input." }], retainedSummaryAccess: f.access,
    });
    expect(result).toMatchObject({ text: null, failureKind: "native_journal_unreadable", diagnostics: { pi_error_code: "pi_session_unreadable" } });
    expect(faux.state.callCount).toBe(0); expect(f.resolve).not.toHaveBeenCalled();
    expect(await readFile(f.raw.metadata.path, "utf8")).toBe(damaged);
  } finally {
    nativeSessionRegistry.delete(f.raw.metadata.id);
    await repo.close(); await rm(root, { recursive: true, force: true });
  }
});

it("warns when an uncovered seed is excluded by the active branch, without consulting optional access", async () => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  await f.driver.admitRetainedSummary(candidate, f.seed); await f.raw.moveTo(null);
  const warn = vi.fn(); f.resolve.mockClear(); vi.mocked(f.access.assertCurrent).mockClear();
  expect(await resolveRetainedSummaryAdmission(f.raw, f.access, warn)).toBeUndefined();
  expect(warn).toHaveBeenCalledOnce(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.access.assertCurrent).not.toHaveBeenCalled();
  expect(await resolveRetainedSummaryAdmission(f.raw, undefined, () => { throw new Error("Fictional diagnostic failure"); })).toBeUndefined();
  await f.driver.endTurn("completed"); await f.raw.close();
});
