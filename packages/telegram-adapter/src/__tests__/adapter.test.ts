import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST,
} from "@mono-agent/agent-contracts";

import {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
  buildAgentRequest,
  downloadTelegramAttachments,
  normalizeTelegramMessageInput,
  type TelegramAttachment,
  type TelegramFileDownloader,
} from "../adapter.js";
import type { TelegramTranscriber } from "../transcription.js";
import type { TelegramMessage } from "../types.js";

/** Fake downloader: file paths encode the file_id; bytes are looked up by file_id. */
function fakeDownloader(bytesByFileId: Record<string, Uint8Array>): TelegramFileDownloader {
  return {
    async resolveFilePath(fileId: string): Promise<string | undefined> {
      return `path/${fileId}`;
    },
    async download(filePath: string): Promise<Uint8Array> {
      const fileId = filePath.slice("path/".length);
      const bytes = bytesByFileId[fileId];
      if (bytes === undefined) {
        throw new Error(`no bytes for ${fileId}`);
      }
      return bytes;
    },
  };
}

const TRANSCRIPTION_UNAVAILABLE_NOTE =
  "[automatic transcription unavailable — audio saved at the path above]";

describe("shared attachment policy", () => {
  it("retains the Telegram exports as exact aliases of the neutral contract", () => {
    expect(DEFAULT_ATTACHMENT_MAX_BYTES).toBe(DEFAULT_AGENT_ATTACHMENT_MAX_BYTES);
    expect(DEFAULT_ATTACHMENT_MIME_ALLOWLIST).toBe(DEFAULT_AGENT_ATTACHMENT_MIME_ALLOWLIST);
  });
});

describe("video_note extraction", () => {
  it("extracts a video_note and downloads it as video/mp4", async () => {
    const message = {
      message_id: 1,
      date: 1234,
      chat: { id: 42, type: "private" },
      video_note: {
        file_id: "vn-file",
        file_unique_id: "vn-unique",
        duration: 5,
        length: 240,
        file_size: 1000,
      },
    } as unknown as TelegramMessage;

    const input = normalizeTelegramMessageInput(message);
    expect(input).toBeDefined();
    expect(input?.attachments).toEqual([
      {
        kind: "video_note",
        fileId: "vn-file",
        fileUniqueId: "vn-unique",
        duration: 5,
        length: 240,
        fileSize: 1000,
      },
    ]);

    const bytes = new TextEncoder().encode("video-note-bytes");
    const resolved = await downloadTelegramAttachments(
      input!.attachments,
      fakeDownloader({ "vn-file": bytes }),
      new AbortController().signal,
    );

    expect(resolved).toEqual([
      {
        kind: "document",
        mimeType: "video/mp4",
        data: Buffer.from(bytes).toString("base64"),
        sizeBytes: bytes.byteLength,
        durationSeconds: 5,
      },
    ]);
  });
});

describe("downloadTelegramAttachments transcription", () => {
  const voiceAttachment: TelegramAttachment = {
    kind: "voice",
    fileId: "voice-file",
    fileUniqueId: "voice-unique",
    duration: 3,
    mimeType: "audio/ogg",
  };

  it("fills attachment.text with the transcript for voice messages", async () => {
    const transcriber: TelegramTranscriber = {
      async transcribe(inputArg) {
        return `transcript of ${inputArg.mimeType} (${inputArg.bytes.byteLength} bytes)`;
      },
    };
    const bytes = new TextEncoder().encode("ogg-bytes");

    const resolved = await downloadTelegramAttachments(
      [voiceAttachment],
      fakeDownloader({ "voice-file": bytes }),
      new AbortController().signal,
      { transcriber },
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.mimeType).toBe("audio/ogg");
    expect(resolved[0]?.text).toBe(`transcript of audio/ogg (${bytes.byteLength} bytes)`);
  });

  it("falls back to the unavailable note when transcription fails", async () => {
    const transcriber: TelegramTranscriber = {
      async transcribe() {
        throw new Error("whisper server unreachable");
      },
    };
    const warnings: string[] = [];

    const resolved = await downloadTelegramAttachments(
      [voiceAttachment],
      fakeDownloader({ "voice-file": new TextEncoder().encode("x") }),
      new AbortController().signal,
      { transcriber, logger: { warn: (message: string) => warnings.push(message) } },
    );

    expect(resolved[0]?.text).toBe(TRANSCRIPTION_UNAVAILABLE_NOTE);
    expect(warnings).toHaveLength(1);
  });

  it("never transcribes a non-audio attachment", async () => {
    const documentAttachment: TelegramAttachment = {
      kind: "document",
      fileId: "doc-file",
      fileUniqueId: "doc-unique",
      fileName: "brief.pdf",
      mimeType: "application/pdf",
    };
    let called = false;
    const transcriber: TelegramTranscriber = {
      async transcribe() {
        called = true;
        return "should never run";
      },
    };

    const resolved = await downloadTelegramAttachments(
      [documentAttachment],
      fakeDownloader({ "doc-file": new TextEncoder().encode("pdf") }),
      new AbortController().signal,
      { transcriber },
    );

    expect(called).toBe(false);
    expect(resolved[0]?.text).toBeUndefined();
  });
});

describe("buildAgentRequest sender identity", () => {
  function update(from: TelegramMessage["from"], chatType = "supergroup") {
    const message: TelegramMessage = {
      message_id: 7,
      chat: { id: -100_42, type: chatType },
      text: "status?",
      ...(from === undefined ? {} : { from }),
    };
    return { update: { update_id: 1, message }, message };
  }

  it("prefers the first+last name group members actually see, keeping the handle alongside", () => {
    const { update: u, message } = update({ id: 55, first_name: "Alice", last_name: "Chen", username: "alice" });
    const request = buildAgentRequest(u, message, { text: "status?", attachments: [] }, new AbortController().signal);

    expect(request.sender).toEqual({
      id: "55",
      displayName: "Alice Chen",
      handle: "alice",
    });
  });

  it("falls back to the handle alone and marks transport-asserted bots", () => {
    const { update: u, message } = update({ id: 56, username: "solo", is_bot: true });
    const request = buildAgentRequest(u, message, { text: "status?", attachments: [] }, new AbortController().signal);

    expect(request.sender).toEqual({ id: "56", handle: "solo", isBot: true });
  });

  it("carries the numeric id as a string even with no name at all", () => {
    const { update: u, message } = update({ id: 57 });
    const request = buildAgentRequest(u, message, { text: "status?", attachments: [] }, new AbortController().signal);

    // Id only: the harness renders no label from this, so the turn stays anonymous.
    expect(request.sender).toEqual({ id: "57" });
  });

  it("omits sender entirely for a message with no author", () => {
    const { update: u, message } = update(undefined);
    const request = buildAgentRequest(u, message, { text: "status?", attachments: [] }, new AbortController().signal);

    expect(request.sender).toBeUndefined();
  });

  it("attributes a private chat too, so a DM knows who it is talking to", () => {
    const { update: u, message } = update({ id: 58, first_name: "Robert" }, "private");
    const request = buildAgentRequest(u, message, { text: "hi", attachments: [] }, new AbortController().signal);

    expect(request.sender).toEqual({ id: "58", displayName: "Robert" });
  });
});
