import { describe, expect, it } from "vitest";
import { isLegacySilentCronMessage, sanitizeCronTranscript } from "./cron-visibility";
import { convertWebMessage } from "./runtime";
import { thread } from "./test/fixtures";
import type { WebMessage } from "./types";

const silent: WebMessage = { id: "silent", threadId: "cron", role: "assistant", status: "complete", attachments: [],
  createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", parts: [
    { type: "text", text: "Completed silently (no message was reported)." },
    { type: "telemetry", event: "cron_run", data: { status: "succeeded", silent: true, runId: "silent" } },
  ] };

describe("legacy silent projections", () => {
  it("hides only synthetic-only successful rows and repairs the cached count and preview", () => {
    const summary = { ...thread("cron", "alpha"), messageCount: 2, lastMessagePreview: "Completed silently (no message was reported)." };
    const real = { ...silent, id: "real", parts: [...silent.parts, { type: "text" as const, text: "Delivered answer" }] };
    expect(isLegacySilentCronMessage(silent)).toBe(true);
    expect(isLegacySilentCronMessage(real)).toBe(false);
    const clean = sanitizeCronTranscript(summary, [real, silent]);
    expect(clean.messages).toEqual([real]);
    expect(clean.thread.messageCount).toBe(1);
    expect(clean.thread.lastMessagePreview).toContain("Delivered answer");
    expect(sanitizeCronTranscript(clean.thread, clean.messages).changed).toBe(false);
    expect(convertWebMessage(real).content).toContainEqual(expect.objectContaining({ type: "data-cron-run", data: expect.objectContaining({ hasVisibleContent: true }) }));
  });
  it("preserves rich reply content and failures despite an old silent flag", () => {
    expect(isLegacySilentCronMessage({ ...silent, attachments: [{ id: "retained" } as WebMessage["attachments"][number]] })).toBe(false);
    expect(isLegacySilentCronMessage({ ...silent, parts: [silent.parts[0]!, { type: "telemetry", event: "cron_run", data: { status: "failed", silent: true } }] })).toBe(false);
  });
});
