import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompleteAttachment } from "@assistant-ui/react";
import type { AttachmentSubmissionSession } from "./console-store";
import type { WebUploadAttachmentAdapter } from "./attachment-adapter";
import { AUDIO_PREPARATION_TIMEOUT_MS, RecordedSubmissionAttempt } from "./recorded-submission";
const item: CompleteAttachment = { id: "immutable-upload", type: "document", name: "recording.webm", contentType: "audio/webm", status: { type: "complete" }, content: [] };
function setup() {
  const owner: AttachmentSubmissionSession = { submissionId: "frozen-attempt", isCurrent: vi.fn(() => true), prepare: vi.fn(async () => "owned-thread"), submit: vi.fn(async () => undefined), assertCanSendAttachments: vi.fn() };
  const prepare = vi.fn(async () => "Typed text\n\nAudio transcript 1: Synthetic words");
  const adapter = { prepareRecordedText: prepare } as unknown as WebUploadAttachmentAdapter;
  return { owner, adapter, prepare };
}
afterEach(() => vi.useRealTimers());
describe("immutable ordinary recorded-attachment attempts", () => {
  it("freezes input/order/quote before preparation and reuses composed content on exact retry", async () => {
    const { owner, adapter, prepare } = setup();
    vi.mocked(owner.submit).mockRejectedValueOnce(new Error("unknown acknowledgement"));
    const input = { text: "Typed text", attachments: [{ ...item }], quote: { messageId: "fictional-message", text: "Original quote" }, threadId: "owned-thread" };
    const attempt = new RecordedSubmissionAttempt(owner, adapter, input);
    input.text = "Newer text"; input.attachments[0]!.id = "newer-upload"; input.quote.text = "Newer quote";
    await expect(attempt.send()).rejects.toThrow("acknowledgement");
    await attempt.send();
    expect(prepare).toHaveBeenCalledTimes(1); expect(owner.prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith("Typed text", [item], "owned-thread", expect.any(AbortSignal), expect.any(Function));
    expect(vi.mocked(owner.submit).mock.calls[0]!.slice(0, 3)).toEqual(vi.mocked(owner.submit).mock.calls[1]!.slice(0, 3));
    expect(owner.submit).toHaveBeenCalledWith(expect.stringContaining("Typed text"), ["immutable-upload"], { messageId: "fictional-message", text: "Original quote" }, expect.any(Function));
  });
  it("cancels a hung preparation without dispatch, rather than waiting for an ignored signal", async () => {
    const { owner, adapter } = setup();
    vi.mocked(owner.prepare).mockImplementationOnce(() => new Promise(() => undefined));
    const attempt = new RecordedSubmissionAttempt(owner, adapter, { text: "", attachments: [item], threadId: null });
    const pending = attempt.send(); attempt.cancelPreparation();
    await expect(pending).rejects.toThrow(); expect(owner.submit).not.toHaveBeenCalled();
  });
  it("marks dispatch only at the actual POST boundary, not while waiting for thread writes", async () => {
    const { owner, adapter } = setup();
    let dispatch!: () => void; let finish!: () => void;
    vi.mocked(owner.submit).mockImplementationOnce((_text, _ids, _quote, notify) => { dispatch = notify!; return new Promise((resolve) => { finish = resolve; }); });
    const attempt = new RecordedSubmissionAttempt(owner, adapter, { text: "", attachments: [item], threadId: "owned-thread" });
    const pending = attempt.send(); await vi.waitFor(() => expect(owner.submit).toHaveBeenCalled());
    expect(attempt.dispatched).toBe(false); dispatch(); expect(attempt.dispatched).toBe(true);
    attempt.cancelPreparation(); expect(attempt.controller.signal.aborted).toBe(false);
    finish(); await pending;
  });
  it("enforces one total preparation deadline including thread resolution", async () => {
    vi.useFakeTimers();
    const { owner, adapter } = setup();
    vi.mocked(owner.prepare).mockImplementationOnce(() => new Promise(() => undefined));
    const attempt = new RecordedSubmissionAttempt(owner, adapter, { text: "", attachments: [item], threadId: null });
    const assertion = expect(attempt.send()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(AUDIO_PREPARATION_TIMEOUT_MS); await assertion;
    expect(owner.submit).not.toHaveBeenCalled(); expect(attempt.dispatched).toBe(false);
  });
  it("rejects an already oversized authored draft before any preparation/provider work", async () => {
    const { owner, adapter, prepare } = setup();
    await expect(new RecordedSubmissionAttempt(owner, adapter, { text: "x".repeat(200_001), attachments: [item], threadId: "owned-thread" }).send()).rejects.toThrow("text limit");
    expect(owner.prepare).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(owner.submit).not.toHaveBeenCalled();
  });
  it("gates running-turn attachment admission before provider work", async () => {
    const { owner, adapter, prepare } = setup();
    vi.mocked(owner.assertCanSendAttachments).mockImplementation(() => { throw new Error("Wait for the running response"); });
    await expect(new RecordedSubmissionAttempt(owner, adapter, { text: "", attachments: [item], threadId: "owned-thread" }).send()).rejects.toThrow("running response");
    expect(prepare).not.toHaveBeenCalled(); expect(owner.submit).not.toHaveBeenCalled();
  });
  it("does not retain invalid composed text as an executable retry payload", async () => {
    const { owner, adapter, prepare } = setup(); prepare.mockResolvedValue("x".repeat(200_000));
    const attempt = new RecordedSubmissionAttempt(owner, adapter, { text: "", attachments: [item], quote: { messageId: "fictional", text: "quote" }, threadId: "owned-thread" });
    await expect(attempt.send()).rejects.toThrow("text limit"); await expect(attempt.send()).rejects.toThrow("text limit");
    expect(owner.submit).not.toHaveBeenCalled(); expect(prepare).toHaveBeenCalledTimes(2);
  });
});
