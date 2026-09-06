import { afterEach, describe, expect, it } from "vitest";
import {
  forgetComposerDraft,
  hasUnsentComposerDraft,
  noteComposerAttachments,
  readComposerDraft,
  resetComposerDraft,
  transferComposerDraft,
  writeComposerDraft,
} from "./composer-draft";

afterEach(() => { resetComposerDraft(); });

describe("composer draft registry", () => {
  it("keeps exact text independently per agent and conversation", () => {
    writeComposerDraft("alpha", "one", "  Alpha draft\n");
    writeComposerDraft("alpha", "two", "Beta draft");
    writeComposerDraft("beta", "one", "Other agent");

    expect(readComposerDraft("alpha", "one")).toBe("  Alpha draft\n");
    expect(readComposerDraft("alpha", "two")).toBe("Beta draft");
    expect(readComposerDraft("beta", "one")).toBe("Other agent");
    expect(hasUnsentComposerDraft()).toBe(true);
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
    expect(hasUnsentComposerDraft()).toBe(false);
  });

  it("counts visible attachments in the reload guard without making them restorable", () => {
    noteComposerAttachments(true);
    expect(hasUnsentComposerDraft()).toBe(true);
    expect(readComposerDraft("alpha", "one")).toBe("");

    noteComposerAttachments(false);
    expect(hasUnsentComposerDraft()).toBe(false);
  });

  it("resets all tab-memory state", () => {
    writeComposerDraft("alpha", "one", "draft");
    noteComposerAttachments(true);

    resetComposerDraft();

    expect(readComposerDraft("alpha", "one")).toBe("");
    expect(hasUnsentComposerDraft()).toBe(false);
  });
});
