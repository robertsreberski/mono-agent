// Private answer recovery, never a qualification/gate result.
import { mkdir, open, readdir, readFile, rename, unlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import { scoreE2 } from "./continuity-e2-score.mjs";
const need = ok => { if (!ok) throw Object.assign(Error("E2_ANSWER_PROGRESS_INVALID"), { code: "E2_ANSWER_PROGRESS_INVALID" }); };
async function privateDirectory(path) {
  const s = await lstat(path); need(s.isDirectory() && !s.isSymbolicLink() && s.uid === userInfo().uid && (s.mode & 0o077) === 0);
}
async function syncDirectory(path) { const dir = await open(path, "r"); try { await dir.sync(); } finally { await dir.close(); } }
async function exclusiveJSON(directory, name, value) {
  await privateDirectory(directory);
  // An exclusive claim serializes publication without hardlinks (private readers
  // intentionally refuse nlink > 1, including after an interrupted writer).
  await mkdir(join(directory, `.claim-${name}`), { mode: 0o700 });
  let existing; try { existing = await lstat(join(directory, name)); } catch (e) { if (e.code !== "ENOENT") throw e; }
  need(!existing);
  const temporary = join(directory, `.pending-${randomUUID()}`), target = join(directory, name), file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); await file.close();
    await rename(temporary, target); await syncDirectory(directory);
  } finally { await file.close(); await unlink(temporary).catch(() => {}); }
  await syncDirectory(directory);
}
export async function writeE2Progress(output, ordinal, binding, answer) {
  need(Number.isSafeInteger(ordinal) && ordinal > 0 && ordinal <= 4096);
  const directory = join(output, "answer-progress"); await mkdir(directory, { recursive: true, mode: 0o700 });
  await exclusiveJSON(directory, `${String(ordinal).padStart(6, "0")}.json`, { schema: "continuity-e2-answer-progress-v1", ...binding, answer });
  await syncDirectory(output);
}
export async function readE2Progress(output, state, index, readArtifact = path => readFile(path)) {
  let names; try { names = await readdir(join(output, "answer-progress")); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  await privateDirectory(join(output, "answer-progress"));
  need(names.length <= 12288); const answers = { schema: "continuity-e2-answers-v1", answers: [] }, seen = new Set();
  for (const name of names.sort()) {
    if (/^\.claim-\d{6}\.json$/u.test(name) || /^\.pending-[a-f0-9-]{36}$/u.test(name)) continue; // unpublished/torn entry after a killed writer
    need(/^\d{6}\.json$/u.test(name));
    const bytes = await readArtifact(join(output, "answer-progress", name), "e2_receipt_invalid", 4 * 1024 * 1024); need(bytes.length <= 4 * 1024 * 1024);
    const entry = JSON.parse(bytes), h = state.slots[index].holds.find(h => h.round === entry.round);
    need(entry.schema === "continuity-e2-answer-progress-v1" && entry.registrationSha256 === state.binding && entry.slotId === state.slots[index].slotId
      && h?.consumed && h.settlement?.kind === "settled" && h.checkpoint === entry.checkpoint && h.payloadDigest === entry.payloadDigest
      && ["probe", "continuation"].includes(h.paidRole) && !seen.has(entry.payloadDigest));
    seen.add(entry.payloadDigest); answers.answers.push(entry.answer);
  }
  return answers;
}
export async function writeE2PartialScore(output, answers, evaluator) {
  const scored = scoreE2(answers, evaluator).report;
  const partial = { schema: "continuity-e2-informational-partial-score-v1", informational: true, qualityMeasured: false,
    completedAnswers: answers.answers.length, plannedAnswers: scored.planned, totals: scored.totals, byCheckpointAndRepeat: scored.byCheckpointAndRepeat };
  try { await exclusiveJSON(output, "partial-score.json", partial); }
  catch (error) { if (error.code !== "EEXIST") throw error; need(JSON.stringify(JSON.parse(await readFile(join(output, "partial-score.json")))) === JSON.stringify(partial)); }
  return partial;
}
