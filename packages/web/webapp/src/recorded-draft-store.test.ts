import "fake-indexeddb/auto";
import { Blob as NativeBlob } from "node:buffer";
import { beforeEach, expect, it } from "vitest";
import { loadRecordedDrafts, removeRecordedDraft, saveRecordedDraft, type RecordedDraft } from "./recorded-draft-store";
const draft = (id: string): RecordedDraft => ({
  owner: { sourceId: "synthetic-agent", threadId: "synthetic-thread", submissionId: id, settings: { model: "synthetic-model", inheritRunSettings: false } },
  text: "A synthetic request", attachments: [], dispatched: false,
  files: [{ id: "synthetic-upload", name: "recording.webm", recorded: true, duration: 37,
    file: new NativeBlob(["synthetic audio"], { type: "audio/webm" }) as unknown as Blob }],
});
beforeEach(async () => { for (const value of await loadRecordedDrafts()) await removeRecordedDraft(value.owner.submissionId); });
it("retains audio bytes and exact prepared identity across reopening, and clears explicitly", async () => {
  await saveRecordedDraft(draft("synthetic-attempt"));
  await saveRecordedDraft({ ...draft("synthetic-attempt"), composed: "Synthetic transcript", dispatched: true });
  const values = await loadRecordedDrafts();
  expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({ owner: { submissionId: "synthetic-attempt", settings: { model: "synthetic-model" } }, composed: "Synthetic transcript", dispatched: true });
  expect(await values[0]!.files[0]!.file.text()).toBe("synthetic audio");
  await removeRecordedDraft("synthetic-attempt"); expect(await loadRecordedDrafts()).toEqual([]);
});
it("refuses additional attempts instead of evicting recoverable recordings", async () => {
  for (let index = 0; index < 8; index++) await saveRecordedDraft(draft(`synthetic-${index}`));
  await expect(saveRecordedDraft(draft("overflow"))).rejects.toThrow();
  expect(await loadRecordedDrafts()).toHaveLength(8);
  await saveRecordedDraft({ ...draft("synthetic-0"), dispatched: true });
  expect(await loadRecordedDrafts()).toHaveLength(8);
});
it("bounds total stored audio bytes without changing previous drafts", async () => {
  await saveRecordedDraft(draft("kept"));
  await expect(saveRecordedDraft({ ...draft("too-large"), files: [{ ...draft("too-large").files[0]!, file: new NativeBlob([new Uint8Array(80 * 1024 * 1024)]) as unknown as Blob }] })).rejects.toThrow();
  expect((await loadRecordedDrafts()).map(value => value.owner.submissionId)).toEqual(["kept"]);
});

it("atomically replaces a definitively rejected identity without retaining a stale recovery", async () => {
  await saveRecordedDraft({ ...draft("old-rejected"), dispatched: true, composed: "Synthetic old transcript" });
  await saveRecordedDraft(draft("new-unsent"), "old-rejected");
  const values = await loadRecordedDrafts();
  expect(values.map(value => value.owner.submissionId)).toEqual(["new-unsent"]);
  expect(values[0]!.dispatched).toBe(false);
});
