import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  flushComposerDrafts,
  forgetComposerDraft,
  hasUnrecoverableComposerContent,
  hasUnsentComposerDraft,
  noteComposerAttachments,
  readComposerDraft,
  resetComposerDraft,
  transferComposerDraft,
  writeComposerDraft,
} from "./composer-draft";

/** A fresh module instance reads the device exactly as a reopened app does. */
const reopenApp = async (): Promise<typeof import("./composer-draft")> => {
  vi.resetModules();
  return import("./composer-draft");
};

const storedDocument = (): { version: number; drafts: { key: string; text: string; updatedAt: number }[] } =>
  JSON.parse(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY) ?? "null");

afterEach(() => {
  resetComposerDraft();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("composer draft registry", () => {
  it("keeps exact text independently per agent and conversation", () => {
    writeComposerDraft("alpha", "one", "  Alpha draft\n");
    writeComposerDraft("alpha", "two", "Beta draft");
    writeComposerDraft("beta", "one", "Other agent");

    expect(readComposerDraft("alpha", "one")).toBe("  Alpha draft\n");
    expect(readComposerDraft("alpha", "two")).toBe("Beta draft");
    expect(readComposerDraft("beta", "one")).toBe("Other agent");
  });

  it("keeps the new-conversation bucket agent-specific and moves it to the created thread", () => {
    writeComposerDraft("alpha", null, "Alpha new thread");
    writeComposerDraft("beta", null, "Beta new thread");

    transferComposerDraft("alpha", null, "created");

    expect(readComposerDraft("alpha", null)).toBe("");
    expect(readComposerDraft("alpha", "created")).toBe("Alpha new thread");
    expect(readComposerDraft("beta", null)).toBe("Beta new thread");
  });

  it("prunes empty text and forgets only the requested confirmed deletion", () => {
    writeComposerDraft("alpha", "one", "keep one");
    writeComposerDraft("alpha", "two", "keep two");
    writeComposerDraft("alpha", "one", " \n\t ");

    expect(readComposerDraft("alpha", "one")).toBe("");
    forgetComposerDraft("alpha", "two");
    expect(readComposerDraft("alpha", "two")).toBe("");
  });

  it("counts visible attachments in the reload guard without making them restorable", () => {
    noteComposerAttachments(true);
    expect(hasUnsentComposerDraft()).toBe(true);
    expect(hasUnrecoverableComposerContent()).toBe(true);
    expect(readComposerDraft("alpha", "one")).toBe("");

    noteComposerAttachments(false);
    expect(hasUnsentComposerDraft()).toBe(false);
    expect(hasUnrecoverableComposerContent()).toBe(false);
  });

  it("resets all state, on the device as well as in the tab", () => {
    writeComposerDraft("alpha", "one", "draft");
    noteComposerAttachments(true);
    flushComposerDrafts();

    resetComposerDraft();

    expect(readComposerDraft("alpha", "one")).toBe("");
    expect(hasUnsentComposerDraft()).toBe(false);
    expect(hasUnrecoverableComposerContent()).toBe(false);
    expect(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBeNull();
  });
});

describe("composer drafts across app restarts", () => {
  it("restores every conversation's unsent text in a reopened app", async () => {
    writeComposerDraft("alpha", "one", "half-written thought");
    writeComposerDraft("alpha", null, "new conversation opener");
    writeComposerDraft("beta", "two", "other agent");
    flushComposerDrafts();

    const reopened = await reopenApp();

    expect(reopened.readComposerDraft("alpha", "one")).toBe("half-written thought");
    expect(reopened.readComposerDraft("alpha", null)).toBe("new conversation opener");
    expect(reopened.readComposerDraft("beta", "two")).toBe("other agent");
    reopened.resetComposerDraft();
  });

  it("writes on a debounce and flushes when the page is hidden", async () => {
    vi.useFakeTimers();
    writeComposerDraft("alpha", "one", "typed but not idle yet");
    expect(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBeNull();

    vi.advanceTimersByTime(500);
    expect(storedDocument().drafts[0]?.text).toBe("typed but not idle yet");

    writeComposerDraft("alpha", "one", "typed but not idle yet, plus more");
    window.dispatchEvent(new Event("pagehide"));
    expect(storedDocument().drafts[0]?.text).toBe("typed but not idle yet, plus more");
  });

  it("does not restore text that was sent or whose conversation was deleted", async () => {
    writeComposerDraft("alpha", "one", "sent");
    writeComposerDraft("alpha", "two", "deleted with the conversation");
    flushComposerDrafts();

    writeComposerDraft("alpha", "one", "");
    forgetComposerDraft("alpha", "two");
    flushComposerDrafts();

    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "one")).toBe("");
    expect(reopened.readComposerDraft("alpha", "two")).toBe("");
    reopened.resetComposerDraft();
  });

  it("keeps another tab's drafts while applying this tab's own edits and deletions", async () => {
    writeComposerDraft("alpha", "one", "this tab");
    writeComposerDraft("alpha", "two", "to be sent here");
    flushComposerDrafts();

    // A second tab adds a draft this instance has never seen.
    const document = storedDocument();
    document.drafts.push({ key: JSON.stringify(["beta", "three"]), text: "other tab", updatedAt: Date.now() });
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify(document));

    writeComposerDraft("alpha", "one", "this tab, edited");
    writeComposerDraft("alpha", "two", "");
    flushComposerDrafts();

    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "one")).toBe("this tab, edited");
    expect(reopened.readComposerDraft("alpha", "two")).toBe("");
    expect(reopened.readComposerDraft("beta", "three")).toBe("other tab");
    reopened.resetComposerDraft();
  });

  it("removes a sent draft from the device immediately, without waiting for the debounce", async () => {
    vi.useFakeTimers();
    writeComposerDraft("alpha", "one", "about to be sent");
    vi.advanceTimersByTime(500);
    expect(storedDocument().drafts).toHaveLength(1);

    // No timer advance and no page-hide event: a send is written through.
    writeComposerDraft("alpha", "one", "");
    expect(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBeNull();
  });

  it("keeps a draft typed after the device clock moved backwards", async () => {
    const drafts = [{
      key: JSON.stringify(["alpha", "wrong-clock"]),
      text: "written while the clock was ahead",
      updatedAt: Date.now() + 60 * 60 * 1_000,
    }];
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts }));

    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "wrong-clock")).toBe("written while the clock was ahead");
    for (let index = 0; index < 40; index += 1) {
      reopened.writeComposerDraft("alpha", `thread-${index}`, `draft ${index}`);
    }
    // The flush merges with what is stored, a while after the app hydrated
    // from it. The future stamp is still on the device; read as a fresher
    // "now" than the edits, it would outrank all forty of them.
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    reopened.flushComposerDrafts();
    vi.useRealTimers();

    // The future-stamped draft is the one evicted, not the newest real edit.
    const reopenedAgain = await reopenApp();
    expect(reopenedAgain.readComposerDraft("alpha", "thread-39")).toBe("draft 39");
    expect(reopenedAgain.readComposerDraft("alpha", "wrong-clock")).toBe("");
    reopenedAgain.resetComposerDraft();
  });

  it("does not let a clock correction overwrite what another tab typed or sent since", async () => {
    const key = JSON.stringify(["alpha", "wrong-clock"]);
    const ahead = Date.now() + 60 * 60 * 1_000;
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      drafts: [{ key, text: "written while the clock was ahead", updatedAt: ahead }],
    }));

    // Between this tab's hydration and its flush, another tab edits the draft.
    const edited = await reopenApp();
    expect(edited.readComposerDraft("alpha", "wrong-clock")).toBe("written while the clock was ahead");
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      drafts: [{ key, text: "retyped in the other tab", updatedAt: Date.now() }],
    }));
    edited.writeComposerDraft("alpha", "elsewhere", "an unrelated draft");
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    edited.flushComposerDrafts();
    vi.useRealTimers();
    expect(storedDocument().drafts.find((draft) => draft.key === key)?.text).toBe("retyped in the other tab");
    edited.resetComposerDraft();

    // ...or sends it.
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      drafts: [{ key, text: "written while the clock was ahead", updatedAt: ahead }],
    }));
    const sent = await reopenApp();
    expect(sent.readComposerDraft("alpha", "wrong-clock")).toBe("written while the clock was ahead");
    localStorage.removeItem(COMPOSER_DRAFTS_STORAGE_KEY);
    sent.writeComposerDraft("alpha", "elsewhere", "an unrelated draft");
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    sent.flushComposerDrafts();
    vi.useRealTimers();
    expect(storedDocument().drafts.map((draft) => draft.key)).toEqual([JSON.stringify(["alpha", "elsewhere"])]);
    sent.resetComposerDraft();

    // ...or retypes the very same words, with a real stamp: that edit's time
    // is the other tab's to keep, not this tab's to roll back.
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      drafts: [{ key, text: "written while the clock was ahead", updatedAt: ahead }],
    }));
    const retyped = await reopenApp();
    expect(retyped.readComposerDraft("alpha", "wrong-clock")).toBe("written while the clock was ahead");
    const realStamp = Date.now() + 1_000;
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      version: 1,
      drafts: [{ key, text: "written while the clock was ahead", updatedAt: realStamp }],
    }));
    retyped.writeComposerDraft("alpha", "elsewhere", "an unrelated draft");
    vi.useFakeTimers({ now: Date.now() + 60_000 });
    retyped.flushComposerDrafts();
    vi.useRealTimers();
    expect(storedDocument().drafts.find((draft) => draft.key === key)).toEqual({
      key, text: "written while the clock was ahead", updatedAt: realStamp,
    });
    retyped.resetComposerDraft();
  });

  it("keeps the stored draft when the device refuses a clock correction alone", async () => {
    const key = JSON.stringify(["alpha", "wrong-clock"]);
    const document = JSON.stringify({
      version: 1,
      drafts: [{ key, text: "written while the clock was ahead", updatedAt: Date.now() + 60 * 60 * 1_000 }],
    });
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, document);
    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "wrong-clock")).toBe("written while the clock was ahead");

    // Nothing was typed here; only the stamp would change. A full device says
    // no to that write, and the answer must not be to remove the draft.
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded.", "QuotaExceededError");
    });
    reopened.flushComposerDrafts();
    setItem.mockRestore();
    expect(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBe(document);
    expect(reopened.hasUnrecoverableComposerContent()).toBe(false);
    reopened.resetComposerDraft();
  });

  it("discards a malformed stored document instead of failing to start", async () => {
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, '{"version":1,"drafts":[{"key":5}]}');

    const reopened = await reopenApp();

    expect(reopened.readComposerDraft("alpha", "one")).toBe("");
    expect(localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)).toBeNull();
    reopened.resetComposerDraft();
  });

  it("forgets drafts older than a month and keeps the newest when the cap is reached", async () => {
    const now = Date.now();
    const drafts = [
      { key: JSON.stringify(["alpha", "stale"]), text: "abandoned", updatedAt: now - 31 * 24 * 60 * 60 * 1_000 },
      { key: JSON.stringify(["alpha", "fresh"]), text: "still wanted", updatedAt: now - 60_000 },
    ];
    localStorage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({ version: 1, drafts }));

    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "stale")).toBe("");
    expect(reopened.readComposerDraft("alpha", "fresh")).toBe("still wanted");

    for (let index = 0; index < 45; index += 1) {
      reopened.writeComposerDraft("alpha", `thread-${index}`, `draft ${index}`);
    }
    reopened.flushComposerDrafts();
    const persisted: { drafts: { key: string }[] } = JSON.parse(
      localStorage.getItem(COMPOSER_DRAFTS_STORAGE_KEY) ?? "null",
    );
    expect(persisted.drafts).toHaveLength(40);
    expect(persisted.drafts.some((draft) => draft.key === JSON.stringify(["alpha", "thread-44"]))).toBe(true);

    const reopenedAgain = await reopenApp();
    expect(reopenedAgain.readComposerDraft("alpha", "thread-44")).toBe("draft 44");
    reopenedAgain.resetComposerDraft();
  });

  it("truncates an oversized draft rather than losing the whole thought", async () => {
    writeComposerDraft("alpha", "one", "x".repeat(40_000));
    flushComposerDrafts();

    const reopened = await reopenApp();
    expect(reopened.readComposerDraft("alpha", "one")).toHaveLength(32_768);
    reopened.resetComposerDraft();
  });

  it("still defers a staged reload when the device refuses to keep the text", async () => {
    writeComposerDraft("alpha", "one", "persisted fine");
    flushComposerDrafts();
    expect(hasUnsentComposerDraft()).toBe(true);
    expect(hasUnrecoverableComposerContent()).toBe(false);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    writeComposerDraft("alpha", "one", "persisted fine, plus a refused edit");
    flushComposerDrafts();

    expect(hasUnrecoverableComposerContent()).toBe(true);
    expect(readComposerDraft("alpha", "one")).toBe("persisted fine, plus a refused edit");
  });
});
