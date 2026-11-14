import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlSessionRepo } from "../../engine/session-store.js";
import { createHash } from "node:crypto";
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { generateEngineTurnResponse, preparePiNativeDispatch } from "../../execution/pi/run.js";
import { refreshProviderSession } from "../../runtime/session-fanout.js";
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

it.each(["seed", "turn_start", "receipt_write"].flatMap(stage => [false, true].map(carry => ({ stage, carry }))))("SIGKILL at admission boundary $stage carry=$carry never promotes an orphan or partial receipt", async ({ stage, carry }) => {
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
      raw.write = async (kind, ...args) => { const result = await write(kind, ...args); if (${JSON.stringify(stage)} === "receipt_write" && ["retained_summary_admitted", "reseed_predecessor_admitted"].includes(kind)) stop(); return result; };
      const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination-epoch", handleId: "fiction-handle" },
        assertCurrent: async () => {}, resolve: async () => ({ text: ${JSON.stringify(text)} }) };
      const driver = createRunDriver(raw, { model: ${JSON.stringify(model)}, retainedSummaryAccess: access });
      await driver.beginTurn("host-turn", "host", { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: "fiction-handle", turnId: "host-turn", baseRevision: 0 });
      await driver.admitRetainedSummary(${JSON.stringify(carry ? { binding } : candidate)}, seed);
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
    if (stage === "receipt_write") { expect(predecessor?.text).toBe(text); expect(validRetainedSummaryReceipt(raw.validator.retainedSummaryAdmission.payload, carry)).toBe(true); }
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
it.each([false, true])("awaits the receipt sync barrier before compaction or dispatch can proceed (carry=%s)", async carry => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  const order: string[] = []; let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sync = f.raw.sync.bind(f.raw);
  vi.spyOn(f.raw, "sync").mockImplementation(async () => { order.push("sync-start"); await blocked; await sync(); order.push("synced"); });
  f.driver.hooks.on("before_compaction", () => { order.push("compaction"); return undefined; });
  const admitted = f.driver.admitRetainedSummary(carry ? { binding } : candidate, f.seed).then(async () => {
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

it.each(["write", "barrier"].flatMap(stage => [false, true].map(carry => ({ stage, carry }))))("propagates a real journal $stage failure instead of skipping admission (carry=$carry)", async ({ stage, carry }) => {
  const root = await mkdtemp(join(tmpdir(), "retained-admission-io-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const f = await fixture(false, repo);
  try {
    await f.driver.beginTurn("host-turn", "host", f.descriptor);
    const warnings: any[] = []; f.driver.subscribe((event: any) => warnings.push(event));
    const fault = Object.assign(new Error("Fictional journal I/O failure"), { code: "EIO" });
    vi.spyOn(f.raw.io, stage === "write" ? "append" : "sync").mockRejectedValueOnce(fault);
    await expect(f.driver.admitRetainedSummary(carry ? { binding } : candidate, f.seed)).rejects.toMatchObject({ name: "JournalStorageError", code: "EIO", cause: fault });
    expect(f.raw.failure).toMatchObject({ cause: fault });
    expect(Boolean(f.raw.validator.retainedSummaryAdmission)).toBe(stage === "barrier");
    expect(warnings.filter(event => event.code === "retained_summary_admission_skipped")).toHaveLength(0);
  } finally {
    await f.raw.close().catch(() => {}); await repo.close(); await rm(root, { recursive: true, force: true });
  }
});

it.each(["journalId", "malformed"].flatMap(damage => [false, true].map(carry => ({ damage, carry }))))("refuses on-disk receipt $damage damage before source resolution (carry=$carry)", async ({ damage, carry }) => {
  const root = await mkdtemp(join(tmpdir(), "retained-admission-journal-"));
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const f = await fixture(false, repo);
  try {
    await f.driver.beginTurn("host-turn", "host", f.descriptor);
    await f.driver.admitRetainedSummary(carry ? { binding } : candidate, f.seed); await f.driver.endTurn("completed"); await f.raw.close();
    const records = (await readFile(f.raw.metadata.path, "utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    const receipt = records.find(record => record.kind === (carry ? "reseed_predecessor_admitted" : "retained_summary_admitted"));
    if (damage === "journalId") receipt.payload.destination.journalId = "mismatched-journal";
    else receipt.payload.extra = "unknown-field";
    expect(validRetainedSummaryReceipt(receipt.payload, carry)).toBe(damage === "journalId");
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

it("keeps one admission authority across both closed kinds, with no fabricated quotation", async () => {
  for (const carryFirst of [false, true]) {
    const f = await fixture();
    await f.driver.beginTurn("host-turn", "host", f.descriptor);
    await f.driver.admitRetainedSummary(carryFirst ? { binding } : candidate, f.seed);
    await f.driver.admitRetainedSummary(carryFirst ? candidate : { binding }, f.seed);
    const receipts = f.raw.records!.filter((r: any) => ["retained_summary_admitted", "reseed_predecessor_admitted"].includes(r.kind));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.kind).toBe(carryFirst ? "reseed_predecessor_admitted" : "retained_summary_admitted");
    if (carryFirst) expect(receipts[0]!.payload).not.toHaveProperty("selection");
    expect(await resolveRetainedSummaryAdmission(f.raw, f.access)).toEqual({ admissionId: receipts[0]!.id, text });
    await f.driver.endTurn("completed"); await f.raw.close();
  }
});
it.each(["access", "purge", "owner", "digest"])("keeps active carry available on optional %s loss, but rejects persisted seed damage", async loss => {
  const f = await fixture(); await f.driver.beginTurn("host-turn", "host", f.descriptor);
  await f.driver.admitRetainedSummary({ binding }, f.seed);
  const warning = vi.fn();
  if (loss === "purge") f.resolve.mockResolvedValue(undefined);
  if (loss === "digest") f.resolve.mockResolvedValue({ text: "Changed retained bytes" });
  if (loss === "owner") f.access.assertCurrent = async () => { throw Error("Fictional revoked owner"); };
  expect(await resolveRetainedSummaryAdmission(f.raw, loss === "access" ? undefined : f.access, warning)).toBeUndefined();
  expect(warning).toHaveBeenCalledOnce();
  f.raw.validator.retainedSummaryAdmission.payload.seed.messageDigest = hash("tampered");
  await expect(resolveRetainedSummaryAdmission(f.raw, f.access)).rejects.toMatchObject({ code: "ERR_RETAINED_SUMMARY_AUTHORITY" });
  await f.driver.endTurn("completed"); await f.raw.close();
});

it.each([true, false])("looks up carry only after cold resolution, never warm resume, with seed=%s", async hasSeed => {
  const root = await mkdtemp(join(tmpdir(), "retained-cold-trigger-"));
  const handle = `fictional-trigger-${hasSeed}`;
  const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional first answer.")]), fauxAssistantMessage([fauxText("Fictional second answer.")])]);
  const eligibleForReseed = vi.fn(async () => binding);
  const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination", handleId: handle },
    assertCurrent: async () => {}, resolve: async () => ({ text }), eligibleForReseed };
  const options = { model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, piResolvedModel: faux.getModel(), piResolvedModels: models,
    effort: "none", allowedTools: [], sessionId: handle, sessionsRoot: root, sessionKeepAlive: true, compaction: { enabled: false }, retainedSummaryAccess: access };
  try {
    const first = await generateEngineTurnResponse("Fictional rules", { ...options,
      sessionTurn: { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: handle, turnId: "first", baseRevision: 0 },
      messages: [...(hasSeed ? [{ role: "user", content: "Fictional canonical seed." }, { role: "assistant", content: "Ready." }] : []), { role: "user", content: "Continue." }] });
    expect(first.error).toBeNull(); expect(eligibleForReseed).toHaveBeenCalledOnce();
    const second = await generateEngineTurnResponse("Fictional rules", { ...options,
      sessionTurn: { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: handle, turnId: "second", baseRevision: 1 },
      messages: [{ role: "user", content: "Continue again." }] });
    expect(second.error).toBeNull(); expect(eligibleForReseed).toHaveBeenCalledOnce();
    const repo = new JsonlSessionRepo({ sessionsRoot: root });
    const raw = await repo.open(await repo.find(handle));
    expect(Boolean(raw.validator.retainedSummaryAdmission)).toBe(hasSeed);
    if (hasSeed) expect(raw.validator.retainedSummaryAdmission.kind).toBe("reseed_predecessor_admitted");
    await raw.close(); await repo.close();
  } finally { nativeSessionRegistry.delete(handle); await rm(root, { recursive: true, force: true }); }
});

it.each([false, true].flatMap(quotation => [false, true].map(rewound => ({ quotation, rewound }))))("prepared admission requires initialized epoch, not an empty rewound branch: quotation=$quotation rewound=$rewound", async ({ quotation, rewound }) => {
  const root = await mkdtemp(join(tmpdir(), "retained-initialized-epoch-"));
  const handle = "d".repeat(64);
  const hostAuthority = { version: 1 as const, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fiction", historyBucket: "fiction:bucket" };
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const raw = await repo.create({ id: handle, hostAuthority, assertOwned: async () => {} });
  const eligibleForReseed = vi.fn(async () => binding);
  const coldContext = vi.fn(async () => ({ messages: [{ role: "user", content: pack }], retainedSummary: candidate }));
  const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination", handleId: handle },
    assertCurrent: async () => {}, resolve: async () => ({ text }), eligibleForReseed };
  const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional continued answer.")]), fauxAssistantMessage([fauxText("Fictional resumed answer.")])]);
  const descriptor = { kind: "host" as const, ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: handle, turnId: "prepared-turn", baseRevision: rewound ? 1 : 0,
    reconciliation: { version: 1 as const, purpose: "execution" as const, fenceDigest: "c".repeat(64), initialInputId: "fictional-input" } };
  try {
    if (rewound) {
      const driver = createRunDriver(raw, { model: faux.getModel(), models, tools: [] });
      await driver.beginTurn("previous-turn", "host", { ...descriptor, turnId: "previous-turn", baseRevision: 0 });
      expect((await driver.prompt("Fictional completed request.")).status).toBe("completed");
      await driver.endTurn("completed", { text: "Fictional continued answer.", error: null, failureKind: null, cancelled: false, stopReason: "stop" });
      await raw.moveTo(null);
      expect(raw.seq).toBeGreaterThan(4);
      expect([...raw.validator.turns.values()].some((turn: any) => turn.start.payload.binding?.baseRevision === 0 && turn.end?.payload.status === "completed")).toBe(true);
    } else expect(raw.seq).toBe(4);
    expect((await raw.getEntries())).toHaveLength(0);
    expect(raw.validator.retainedSummaryAdmission).toBeFalsy();
    await raw.close();
    const lease = await preparePiNativeDispatch("Fictional rules", {
      model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, piResolvedModel: faux.getModel(), piResolvedModels: models,
      effort: "none", allowedTools: [], sessionsRoot: root, compaction: { enabled: false },
      retainedSummaryAccess: access, ...(quotation ? { coldContext } : {}),
      messages: [{ role: "user", content: "Fictional canonical replay." }, { role: "assistant", content: "Fictional prior answer." }, { role: "user", content: "Continue." }],
    });
    let result;
    try { result = await lease.run({ sessionId: handle, providerSessionId: handle, sessionKeepAlive: true, sessionTurn: descriptor,
      nativeSessionAuthority: { version: 1, currentHandleId: handle, sessionsRoot: root, hostAuthority, assertCurrent: async () => {} } }); }
    finally { await lease.close(); }
    expect(result.error).toBeNull();
    expect(result.runtimeWarnings).not.toContainEqual(expect.objectContaining({ warning_kind: "retained_summary_admission_skipped" }));
    const reopened = await repo.open(await repo.find(handle));
    try {
      if (rewound) {
        expect(reopened.validator.retainedSummaryAdmission).toBeFalsy();
        expect(JSON.stringify(await reopened.getEntries())).not.toContain("Fictional canonical replay.");
      } else expect(reopened.validator.retainedSummaryAdmission.kind).toBe(quotation ? "retained_summary_admitted" : "reseed_predecessor_admitted");
      expect(eligibleForReseed).toHaveBeenCalledTimes(rewound ? 0 : 1);
      expect(coldContext).toHaveBeenCalledTimes(!rewound && quotation ? 1 : 0);
    } finally { await reopened.close(); }
  } finally { nativeSessionRegistry.delete(handle); await repo.close(); await rm(root, { recursive: true, force: true }); }
});

it.each([false, true].flatMap(carry => ["logicalConversationId", "conversationId"].map(scope => ({ carry, scope }))))("guarded receipt binds retained-source owner/bucket before schema validation: carry=$carry scope=$scope", async ({ carry, scope }) => {
  const repo = new MemorySessionRepo();
  const raw = await repo.create({ id: "fiction-handle", hostAuthority: { version: 1, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fiction", historyBucket: "fiction:bucket" }, assertOwned: async () => {} });
  const seed = await raw.appendMessage({ role: "user", content: pack, timestamp: 0 });
  const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination-epoch", handleId: raw.metadata.id }, assertCurrent: async () => {}, resolve: async () => ({ text }) };
  const driver = createRunDriver(raw, { model, retainedSummaryAccess: access });
  try {
    await driver.beginTurn("guarded-turn", "host", { kind: "host", ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: raw.metadata.id, turnId: "guarded-turn", baseRevision: 0 });
    await driver.admitRetainedSummary(carry ? { binding } : candidate, seed);
    const admission = raw.validator.retainedSummaryAdmission;
    expect(admission.kind).toBe(carry ? "reseed_predecessor_admitted" : "retained_summary_admitted");
    const forged = structuredClone(admission);
    forged.payload.binding[scope] = forged.payload.destination[scope] = "fictional-other-scope";
    expect(validRetainedSummaryReceipt(forged.payload, carry)).toBe(true);
    const validate = vi.spyOn(raw.validator, "validate");
    expect(() => raw.validateRecord(forged)).toThrow("Invalid mono-agent harness session binding");
    expect(validate).not.toHaveBeenCalled();
    validate.mockRestore();
    await driver.endTurn("completed");
  } finally { await raw.close(); }
});

it.each([false, true].flatMap(prepared => [false, true].map(quotation => ({ prepared, quotation }))))("used journal cannot acquire admission on real durable reopen: prepared=$prepared quotation=$quotation", async ({ prepared, quotation }) => {
  const root = await mkdtemp(join(tmpdir(), "retained-used-reopen-")), handle = "e".repeat(64);
  const repo = new JsonlSessionRepo({ sessionsRoot: root });
  const hostAuthority = { version: 1 as const, rootId: "1".repeat(64), authorityId: "2".repeat(64), ownerKey: "fiction", historyBucket: "fiction:bucket" };
  const authority = { version: 1 as const, currentHandleId: handle, sessionsRoot: root, hostAuthority, assertCurrent: async () => {} };
  const faux = fauxProvider({ models: [{ id: "fixture" }], tokensPerSecond: 1000000 });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Fictional first reply.")]), fauxAssistantMessage([fauxText("Fictional resumed reply.")])]);
  const eligibleForReseed = vi.fn(async () => binding);
  const coldContext = vi.fn(async () => ({ messages: [{ role: "user", content: pack }], retainedSummary: candidate }));
  const access = { destination: { logicalConversationId: "fiction", conversationId: "fiction:bucket", epoch: "destination", handleId: handle },
    assertCurrent: async () => {}, resolve: async () => ({ text }), eligibleForReseed };
  const run = async (second: boolean) => {
    const descriptor = { kind: "host" as const, ownerKey: "fiction", historyBucket: "fiction:bucket", handleId: handle,
      turnId: second ? "resumed-turn" : "initial-turn", baseRevision: second ? 1 : 0,
      reconciliation: { version: 1 as const, purpose: "execution" as const, fenceDigest: "c".repeat(64), initialInputId: second ? "resumed-input" : "initial-input" } };
    const options = { model: { provider: "faux", model: "fixture", reference: "faux:fixture" }, piResolvedModel: faux.getModel(), piResolvedModels: models,
      effort: "none", allowedTools: [], sessionsRoot: root, compaction: { enabled: false },
      ...(second ? { retainedSummaryAccess: access, ...(quotation ? { coldContext } : {}) } : {}),
      messages: [{ role: "user", content: second ? "Fictional forbidden second seed." : "Fictional initial seed." },
        { role: "assistant", content: "Fictional earlier answer." }, { role: "user", content: "Continue." }] };
    const dispatch = { sessionId: handle, providerSessionId: handle, sessionKeepAlive: true, sessionTurn: descriptor,
      ...(prepared ? { nativeSessionAuthority: authority } : {}) };
    if (!prepared) return generateEngineTurnResponse("Fictional rules", { ...options, ...dispatch });
    // A prepared lease is single-use: the second lease dispatches into the same
    // journal already used by the first, rather than replaying an idle initializer.
    const lease = await preparePiNativeDispatch("Fictional rules", options);
    try { return await lease.run(dispatch); } finally { await lease.close(); }
  };
  try {
    if (prepared) {
      const raw = await repo.create({ id: handle, hostAuthority, assertOwned: async () => {} });
      await raw.close();
    }
    expect((await run(false)).error).toBeNull();
    await refreshProviderSession(handle); // No registry hit can disguise a disk reopen.
    expect(nativeSessionRegistry.get(handle)).toBeUndefined();
    const used = await repo.open(await repo.find(handle));
    expect(used.seq).toBeGreaterThan(4); expect((await used.getEntries()).length).toBeGreaterThan(0);
    expect(used.validator.retainedSummaryAdmission).toBeFalsy(); await used.close();
    const result = await run(true);
    expect(result.error).toBeNull(); expect(faux.state.callCount).toBe(2);
    expect(eligibleForReseed).not.toHaveBeenCalled(); expect(coldContext).not.toHaveBeenCalled();
    expect(result.runtimeWarnings).not.toContainEqual(expect.objectContaining({ warning_kind: "retained_summary_admission_skipped" }));
    await refreshProviderSession(handle);
    const reopened = await repo.open(await repo.find(handle));
    try {
      expect(reopened.validator.retainedSummaryAdmission).toBeFalsy();
      const entries = JSON.stringify(await reopened.getEntries());
      expect(entries).toContain("Fictional first reply."); expect(entries).toContain("Fictional resumed reply.");
      expect(entries).not.toContain("Fictional forbidden second seed.");
    } finally { await reopened.close(); }
  } finally { await refreshProviderSession(handle); await repo.close(); await rm(root, { recursive: true, force: true }); }
});
