import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  captureEvidence: vi.fn(), createBudget: vi.fn(), prepareHandoff: vi.fn(), buildHandoff: vi.fn(),
  createEpoch: vi.fn(), freeze: vi.fn(), deletionBlocked: vi.fn(), deleteJournals: vi.fn(),
  inspectCurrentJournal: vi.fn(), inventory: vi.fn(),
}));
const inherited = vi.hoisted(() => vi.fn());
vi.mock("@mono-agent/engine/sessions.js", () => ({ createManagedNativeJournalStorage: () => native, NativeEvidenceCapacityError: class extends Error {} }));
vi.mock("../../ai/providers/engine-turn/handoff-producer.js", () => ({ checkNativeInheritedPrefix: inherited }));
import { createManagedNativeJournalStorage } from "../../ai/providers/engine-turn/native-journal-storage.js";

it("keeps one storage factory with readonly copies and exact coordinate normalization", async () => {
  const storage = createManagedNativeJournalStorage({ sessionsRoot: "/fictional/sessions" });
  const journals = Object.freeze([{ handleId: "fixture", journalId: "journal" }]);
  await storage.deletionBlocked(journals, {});
  await storage.deleteJournals(journals, {});
  for (const method of [native.deletionBlocked, native.deleteJournals]) {
    expect(method.mock.calls[0][0]).toEqual(journals);
    expect(method.mock.calls[0][0]).not.toBe(journals);
  }
  const ids = Object.freeze(["journal"]), owners = Object.freeze({ rootId: "root", conversationKeys: Object.freeze(["conversation"]) });
  await storage.inventory(ids, owners);
  expect(native.inventory.mock.calls[0]).toEqual([ids, owners]);
  expect(native.inventory.mock.calls[0][0]).not.toBe(ids);
  expect(native.inventory.mock.calls[0][1]).not.toBe(owners);
  expect(native.inventory.mock.calls[0][1].conversationKeys).not.toBe(owners.conversationKeys);
  await storage.inventory();
  expect(native.inventory).toHaveBeenLastCalledWith(undefined, undefined);
  await storage.inspectCurrentJournal({ handleId: "fixture", journalId: undefined, extra: "discard" });
  expect(native.inspectCurrentJournal).toHaveBeenLastCalledWith({ handleId: "fixture" });
  await storage.inspectCurrentJournal({ handleId: "fixture", journalId: "journal" });
  expect(native.inspectCurrentJournal).toHaveBeenLastCalledWith({ handleId: "fixture", journalId: "journal" });
  const messages = Object.freeze([{ role: "user", content: "fictional" }]);
  await storage.checkInheritedPrefix(messages, {}, {}, 10);
  expect(inherited.mock.calls[0][0]).toEqual(messages);
  expect(inherited.mock.calls[0][0]).not.toBe(messages);
  for (const method of ["captureEvidence", "createBudget", "prepareHandoff", "buildHandoff", "createEpoch", "freeze"]) {
    expect(storage[method]).toBe(native[method]);
  }
});
