// Private answer recovery, never a qualification/gate result.
import { mkdir, open, readdir, rename, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { scoreE2 } from "./continuity-e2-score.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("E2_ANSWER_PROGRESS_INVALID"), { code: "E2_ANSWER_PROGRESS_INVALID" }); };
async function privateDirectory(path) {
  const s = await lstat(path); need(s.isDirectory() && !s.isSymbolicLink() && s.uid === userInfo().uid && (s.mode & 0o077) === 0);
}
async function syncDirectory(path) { const dir = await open(path, "r"); try { await dir.sync(); } finally { await dir.close(); } }
async function atomicJSON(directory, name, value) {
  await privateDirectory(directory);
  const temporary = join(directory, `.pending-${randomUUID()}`), file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); await file.close();
    await rename(temporary, join(directory, name)); await syncDirectory(directory);
  } finally { await file.close(); await unlink(temporary).catch(() => {}); }
}
async function exclusiveJSON(directory, name, value) {
  await privateDirectory(directory);
  await mkdir(join(directory, `.claim-${name}`), { mode: 0o700 });
  let existing; try { existing = await lstat(join(directory, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  if (existing) throw Object.assign(Error("EEXIST"), { code: "EEXIST" });
  await atomicJSON(directory, name, value);
}
export async function writeE2Progress(output, ordinal, binding, answer) {
  need(Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal <= 4096);
  const directory = join(output, "answer-progress"); await mkdir(directory, { recursive: true, mode: 0o700 });
  await exclusiveJSON(directory, `${String(ordinal).padStart(6, "0")}.json`, { schema: "continuity-e2-answer-progress-v1", ...binding, answer });
  await syncDirectory(output);
}
export async function readE2Progress(output, state, index, readArtifact, registered) {
  let names; try { names = await readdir(join(output, "answer-progress")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  await privateDirectory(join(output, "answer-progress"));
  need(typeof readArtifact === "function" && registered?.protocol?.branches && registered?.questions?.questions && names.length <= 12288);
  const checkpoints = registered.protocol.branches.flatMap(b => b.checkpoints), pairs = new Set();
  const answers = { schema: "continuity-e2-answers-v1", answers: [] }, seen = new Set();
  for (const name of names.sort()) {
    if (/^\.claim-\d{6}\.json$/u.test(name) || /^\.pending-[a-f0-9-]{36}$/u.test(name)) continue; // unpublished/torn entry after a killed writer
    need(/^\d{6}\.json$/u.test(name));
    const bytes = await readArtifact(join(output, "answer-progress", name), "e2_receipt_invalid", 4 * 1024 * 1024); need(bytes.length <= 4 * 1024 * 1024);
    const entry = JSON.parse(bytes), h = state.slots[index].holds.find(h => h.round === entry.round);
    need(entry.schema === "continuity-e2-answer-progress-v1" && entry.registrationSha256 === state.binding && entry.slotId === state.slots[index].slotId
      && h?.consumed && h.settlement?.kind === "settled" && h.checkpoint === entry.checkpoint && h.payloadDigest === entry.payloadDigest
      && ["probe", "continuation"].includes(h.paidRole) && !seen.has(entry.payloadDigest));
    const checkpoint = checkpoints[h.checkpoint]?.name, answer = entry.answer, pair = `${answer?.id}\0${answer?.repeat}`;
    need(typeof checkpoint === "string" && registered.questions.questions.some(q => q.id === answer?.id && q.checkpoint === checkpoint)
      && [1, 2].includes(answer?.repeat) && !pairs.has(pair));
    pairs.add(pair); seen.add(entry.payloadDigest); answers.answers.push(answer);
  }
  return answers;
}
export async function writeE2PartialScore(output, answers, evaluator, readArtifact, progressGap = 0) {
  need(typeof readArtifact === "function" && Number.isSafeInteger(progressGap) && progressGap >= 0);
  const scored = scoreE2(answers, evaluator).report;
  const partial = { schema: "continuity-e2-informational-partial-score-v1", informational: true, qualityMeasured: false,
    progressGap, completedAnswers: answers.answers.length, plannedAnswers: scored.planned, totals: scored.totals, byCheckpointAndRepeat: scored.byCheckpointAndRepeat };
  try { await exclusiveJSON(output, "partial-score.json", partial); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Controller-only reconstruction: never follow a child-left symlink/FIFO or
    // trust an orphan. A mkdir-only claim is recoverable under its serial lock.
    try { if (JSON.stringify(JSON.parse(await readArtifact(join(output, "partial-score.json"), "e2_receipt_invalid", 4 * 1024 * 1024))) === JSON.stringify(partial)) return partial; }
    catch { /* Missing/unsafe/stale child output has no authority. */ }
    await atomicJSON(output, "partial-score.json", partial);
  }
  return partial;
}
