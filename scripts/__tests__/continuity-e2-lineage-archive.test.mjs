// Fictional fixtures and the actual shipping switch/retention implementations.
import { afterEach, expect, it, vi } from "vitest";
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { bindE2Checkpoint, e2ArchivePath, verifyE2NativeLineage, E2_SUMMARY_PREFIX, E2_SUMMARY_SUFFIX, E2_BRANCH_PREFIX } from "../lib/continuity-e2-lineage.mjs";
import { retainContinuityText } from "../../packages/conversation/dist/tool-history/continuity-payload.js";
import { coldSwitchFixture } from "./fixtures/e2-lineage-cold-switch.mjs";
import { lineageFixture as fixture } from "./fixtures/e2-lineage-fixture.mjs";
import { e2ExecutionPolicy } from "../lib/continuity-e2-execution-policy.mjs";
const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const make = async (...args) => { const f = await fixture(...args); roots.push(f.root); vi.stubEnv("HOME", f.root); return f; };
const body = (...texts) => Buffer.from(JSON.stringify({ model: "gpt-6.1-sol", stream: true, store: false, input: texts.map(text => ({ role: "user", content: [{ type: "input_text", text }] })) }));
const native = text => E2_SUMMARY_PREFIX + text + E2_SUMMARY_SUFFIX;
const branch = text => E2_BRANCH_PREFIX + text + "</summary>";
const pack = (text, sha256) => `### Conversation continuity pack (historical evidence)\nGenerated summary evidence id="chr1_${"a".repeat(43)}" sha256="${sha256}": ${JSON.stringify(text)}\n`;
const check = (f, lineage, bytes, scope = lineage?.scope ?? "proof") => verifyE2NativeLineage(bytes, { lineageScope: scope, ...(lineage ? { lineage } : {}) }, f.state, { outputRoot: f.root, index: 0 }, f.readArtifact);
it("archives two generated halves before a genuine shipping cold switch retires their journal", async () => {
  const f = await make(["Fictional previous history.", "Fictional active turn."]);
  let lineage;
  const cold = await coldSwitchFixture(f.work, f.assembled, async reference => {
    lineage = await bindE2Checkpoint({ ...f.options, reference }); f.slot.lineages = { proof: lineage };
    const path = e2ArchivePath(f.root, lineage.archiveSha256);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(await readFile(path));
    expect(artifact).toMatchObject({ summary: f.assembled, operationId: "fictional-compaction", slotId: f.slot.slotId });
    expect(artifact.lineage.generated).toHaveLength(2);
  });
  await expect(stat(cold.path)).rejects.toMatchObject({ code: "ENOENT" });
  // Neither the native gate nor historical assembly may read this native file again.
  f.readArtifact = async (...args) => { expect(args[0]).not.toContain("/sessions/"); return f.options.readArtifact(...args); };
  await expect(check(f, lineage, body(native(f.assembled)))).resolves.toMatchObject({ native: 1, none: false });
  await expect(check(f, lineage, body("Fictional B4 reseed."))).resolves.toEqual({ native: 0, branch: 0, pack: 0, none: true });
});
it.each([[0, "B4"], [0, "END"], [1, "B3"]])("keeps scope %s for %s and repeated pristine probes when summaries are absent", async (scope, label) => {
  const f = await make(undefined, undefined, undefined, { kind: "replay", branch: scope }), lineage = await f.bind();
  f.slot.lineages = { [scope]: lineage };
  await rm(f.journalPath);
  for (let i = 0; i < 3; i++) await expect(check(f, lineage, body(`Fictional ${label} probe.`))).resolves.toMatchObject({ none: true });
  await expect(check(f, lineage, body(), 1 - scope)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("allows exact current/predecessor native and branch wrappers, never a forged extra representation", async () => {
  const f = await make(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  await expect(check(f, lineage, body(native(f.assembled), branch(f.assembled)))).resolves.toMatchObject({ native: 1, branch: 1, none: false });
  for (const bytes of [body(native(f.assembled + " altered")), body(native(f.assembled), branch("Fictional forgery.")),
    body(native(f.assembled), pack("Fictional forgery.", "a".repeat(64))), body(native(f.assembled), native("Fictional forgery."))])
    await expect(check(f, lineage, bytes)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("calls shipping retention exactly, and checks both pack text and recorded sha", async () => {
  const f = await make(["Fictional evidence at /home/example/private/file.txt"], undefined), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  const retained = retainContinuityText(f.assembled); expect(retained.redacted).toBe(true); expect(retained.text).not.toBe(f.assembled);
  await expect(check(f, lineage, body(pack(retained.text, retained.sha256)))).resolves.toMatchObject({ pack: 1, none: false });
  for (const bytes of [body(pack(retained.text + " changed", retained.sha256)), body(pack(retained.text, "a".repeat(64))),
    body(pack(f.assembled, lineage.textSha256)), body(native(f.assembled), pack(retained.text + " changed", retained.sha256))])
    await expect(check(f, lineage, bytes)).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
it("refuses smuggled wrappers and pack claims in a no-lineage baseline", async () => {
  const f = await make(), retained = retainContinuityText(f.assembled);
  for (const text of [native(f.assembled), branch(f.assembled), pack(retained.text, retained.sha256)])
    await expect(check(f, null, body(text))).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await expect(check(f, null, Buffer.from(JSON.stringify({ input: [], instructions: native(f.assembled) })))).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await expect(check(f, null, body())).resolves.toMatchObject({ none: true });
});
it("fails closed on tampered, missing or v1 lineage even when the body has no summary", async () => {
  const f = await make(), lineage = await f.bind(); f.slot.lineages = { proof: lineage };
  const path = e2ArchivePath(f.root, lineage.archiveSha256); await writeFile(path, "{}\n", { mode: 0o600 });
  await expect(check(f, lineage, body())).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  await rm(path); await expect(check(f, lineage, body())).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  for (const invalid of [{ ...lineage, version: 1 }, { ...lineage, archiveSha256: undefined }]) {
    f.slot.lineages.proof = invalid;
    await expect(check(f, invalid, body())).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
  }
});
it("records content-free none at the controller and binds observation to the consumed payload", async () => {
  const f = await make(), bytes = body("Fictional ordinary request."), hold = { model: "openai-codex:gpt-6.1-sol", tools: [], lineageScope: "proof", payloadDigest: f.digest(bytes) };
  await e2ExecutionPolicy.verifyBody(f.root, hold, f.state, 0, { permit: { epoch: "fictional", permitId: "fictional" }, body: bytes.toString("base64") });
  expect(hold.summaryPresence).toEqual({ native: 0, branch: 0, pack: 0, none: true });
  expect(JSON.stringify(hold.summaryPresence)).not.toContain("Fictional");
  await expect(e2ExecutionPolicy.verifyBody(f.root, hold, f.state, 0, { permit: { epoch: "fictional", permitId: "fictional" }, body: body(native(f.assembled)).toString("base64") })).rejects.toMatchObject({ code: "e2_summary_receipt_invalid" });
});
