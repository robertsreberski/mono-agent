import { describe, expect, it } from "vitest";
import { finalReplyText, isReplyPresentationTool } from "../../ai/providers/pi-native/reply-text.js";

const assistant = (text, ...names) => ({
  role: "assistant",
  content: [
    { type: "text", text },
    ...names.map((name) => ({ type: "toolCall", name })),
  ],
});

const select = (messages) => finalReplyText(messages, ["Unrelated narration", "Approve option A", "Saved."]);

describe("final reply text", () => {
  it("keeps text before SuggestReplies followed by final text in order", () => {
    expect(select([assistant("Approve option A", "SuggestReplies"), assistant("Saved.")]))
      .toBe("Approve option A\n\nSaved.");
  });

  it("uses presentation prose for an empty final message, not earlier narration", () => {
    expect(select([
      assistant("Unrelated narration", "Bash"),
      assistant("Approve option A", "SuggestReplies"),
      assistant(""),
    ])).toBe("Approve option A");
  });

  it("does not promote ordinary tool narration", () => {
    expect(select([assistant("Unrelated narration", "Bash"), assistant("Saved.")])).toBe("Saved.");
  });

  it("stops the chain at a non-presentation tool message", () => {
    expect(select([
      assistant("Excluded", "SuggestReplies"),
      assistant("Unrelated narration", "Read"),
      assistant("Approve option A", "PublishReplyFile"),
      assistant("Restart proposed", "ProposeRestart", "SuggestReplies"),
      assistant("Saved."),
    ])).toBe("Approve option A\n\nRestart proposed\n\nSaved.");
  });

  it.each(["SuggestReplies", "PublishReplyFile", "ProposeRestart"])("accepts MCP-qualified %s", (name) => {
    expect(select([assistant("Approve option A", `mcp__reply_server__${name}`), assistant("Saved.")]))
      .toBe("Approve option A\n\nSaved.");
  });

  it("stops at a mixed tool message", () => {
    expect(select([assistant("Excluded", "SuggestReplies", "Bash"), assistant("Saved.")])).toBe("Saved.");
  });

  it("does not extend a terminal message that calls an ordinary tool", () => {
    expect(select([assistant("Excluded", "SuggestReplies"), assistant("Saved.", "Bash")])).toBe("Saved.");
  });

  it("extends a terminal message that only calls presentation tools", () => {
    expect(select([assistant("Approve option A", "SuggestReplies"), assistant("Saved.", "PublishReplyFile")]))
      .toBe("Approve option A\n\nSaved.");
  });

  it("stops at an earlier message without tools", () => {
    expect(select([assistant("Excluded"), assistant("Saved.")])).toBe("Saved.");
  });

  it("skips empty text in a presentation chain", () => {
    expect(select([
      assistant("Approve option A", "SuggestReplies"),
      assistant("", "PublishReplyFile"),
      assistant(""),
    ])).toBe("Approve option A");
  });

  it("preserves the existing stream fallback when the chain has no text", () => {
    expect(select([assistant("Unrelated narration", "Bash"), assistant("")]))
      .toBe("Unrelated narrationApprove option ASaved.");
    expect(finalReplyText([], [])).toBe("");
  });

  it.each(["Bash", "FinishSilently", "StructuredOutput", "AskUser", "other__SuggestReplies", "mcp__reply__SuggestRepliesExtra"])(
    "does not classify %s as presentation", (name) => {
      expect(isReplyPresentationTool(name)).toBe(false);
    },
  );
});
